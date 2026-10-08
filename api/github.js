let memoryCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 120 * 1000;

function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (isNaN(seconds) || seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const username = process.env.GITHUB_USERNAME?.trim() || 'ishaankor';
  const now = Date.now();

  if (memoryCache && now - lastFetchTime < CACHE_DURATION_MS) {
    const updatedCommits = (memoryCache.commits || []).map((c) => ({
      ...c,
      timeAgo: formatTimeAgo(c.date),
    }));

    const updatedLatestCommit = memoryCache.latestCommit
      ? {
          ...memoryCache.latestCommit,
          timeAgo: formatTimeAgo(memoryCache.latestCommit.date),
        }
      : updatedCommits[0] || null;

    return res.status(200).json({
      ...memoryCache,
      commits: updatedCommits,
      latestCommit: updatedLatestCommit,
      cached: true,
      servedAt: new Date().toISOString(),
    });
  }

  const token = process.env.GITHUB_TOKEN?.trim();
  const headers = {
    'User-Agent': 'Vercel-GitHub-Meta-Fetcher-App',
    Accept: 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = token.startsWith('github_pat_') ? `Bearer ${token}` : `token ${token}`;
  }

  try {
    const reposUrl = token
      ? `https://api.github.com/user/repos?per_page=100&sort=pushed&type=all`
      : `https://api.github.com/users/${username}/repos?per_page=100&sort=pushed`;

    const [userRes, reposRes, eventsRes, locRes] = await Promise.all([
      fetch(`https://api.github.com/users/${username}`, { headers, cache: 'no-store' }),
      fetch(reposUrl, { headers, cache: 'no-store' }),
      fetch(`https://api.github.com/users/${username}/events?per_page=30`, { headers, cache: 'no-store' }),
      fetch('https://raw.githubusercontent.com/ishaankor/my-data-science-portfolio/main/data/loc-static.json', { cache: 'no-store' }).catch(() => null),
    ]);

    let userData = null;
    let reposData = [];
    let commitsData = [];
    let contributionCalendar = null;
    let metaTelemetry = {
      metaPageUrl: 'https://portfolio.ishaankoradia.com/meta',
      promotionCallout: "Explore Ishaan's live Meta telemetry dashboard at https://portfolio.ishaankoradia.com/meta for interactive Codebase Evolution (LOC charts), Developer Habits Matrix, and repository constellation.",
      totalHistoricalCommits: 146,
      totalLinesTracked: 46796,
      totalAdditions: 35245,
      totalDeletions: 11551,
      totalFilesTracked: 87,
      topLanguages: [
        { language: 'TypeScript/TSX', count: 254 },
        { language: 'JSON', count: 52 },
        { language: 'HTML', count: 48 },
        { language: 'JavaScript', count: 38 },
        { language: 'CSS', count: 30 },
      ],
    };

    // Parse LOC telemetry dataset from portfolio /meta page
    if (locRes && locRes.ok) {
      try {
        const records = await locRes.json();
        if (Array.isArray(records) && records.length > 0) {
          const commitsSet = new Set();
          const filesSet = new Set();
          let additions = 0;
          let deletions = 0;
          const langMap = {};

          records.forEach((r) => {
            if (r.commit) commitsSet.add(r.commit);
            if (r.added) additions += r.added;
            if (r.deleted) deletions += r.deleted;
            if (r.file) filesSet.add(r.file);
            if (r.type) langMap[r.type] = (langMap[r.type] || 0) + 1;
          });

          const topLangs = Object.entries(langMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([language, count]) => ({ language, count }));

          metaTelemetry = {
            ...metaTelemetry,
            totalHistoricalCommits: commitsSet.size,
            totalRecords: records.length,
            totalLinesTracked: additions + deletions,
            totalAdditions: additions,
            totalDeletions: deletions,
            totalFilesTracked: filesSet.size,
            topLanguages: topLangs,
          };
        }
      } catch (locErr) {
        console.warn('Meta LOC dataset parse warning:', locErr);
      }
    }

    if (token) {
      try {
        const graphqlQuery = {
          query: `
            query {
              user(login: "${username}") {
                contributionsCollection {
                  contributionCalendar {
                    totalContributions
                    weeks {
                      contributionDays {
                        date
                        contributionCount
                        color
                      }
                    }
                  }
                }
              }
            }
          `,
        };

        const gqlRes = await fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(graphqlQuery),
          cache: 'no-store',
        });

        if (gqlRes.ok) {
          const gqlJson = await gqlRes.json();
          contributionCalendar = gqlJson.data?.user?.contributionsCollection?.contributionCalendar || null;
        }
      } catch (gqlErr) {
        console.error('GraphQL Contribution Calendar Fetch Error:', gqlErr);
      }
    }

    if (userRes.ok) {
      const u = await userRes.json();
      userData = {
        login: u.login,
        avatar_url: u.avatar_url || `https://github.com/${username}.png`,
        html_url: u.html_url,
        name: u.name || 'Ishaan Koradia',
        bio: u.bio || '',
        public_repos: u.public_repos || 23,
        created_at: u.created_at || '2022-01-01T00:00:00Z',
      };
    }

    if (reposRes.ok) {
      const fetchedRepos = await reposRes.json();
      if (Array.isArray(fetchedRepos) && fetchedRepos.length > 0) {
        reposData = fetchedRepos
          .filter((r) => !r.fork && (r.owner?.login === username || r.owner?.login === undefined))
          .map((r) => ({
            id: r.id,
            name: r.name,
            language: r.language,
            html_url: r.html_url,
            description: r.description,
            created_at: r.created_at,
            pushed_at: r.pushed_at,
            updated_at: r.updated_at,
          }));
      }
    }

    // 1. Primary: Parse live PushEvents from GitHub Events API
    if (eventsRes.ok) {
      const events = await eventsRes.json();
      if (Array.isArray(events)) {
        const pushEvents = events.filter((e) => e.type === 'PushEvent');
        const eventCommits = [];

        pushEvents.forEach((ev) => {
          const repoFullName = ev.repo?.name || '';
          const repoShortName = repoFullName.split('/')[1] || repoFullName;
          const repoUrl = `https://github.com/${repoFullName}`;
          const payloadCommits = ev.payload?.commits || [];

          payloadCommits.forEach((c) => {
            const authorName = (c.author?.name || ev.actor?.login || '').toLowerCase();
            const authorEmail = (c.author?.email || '').toLowerCase();
            const msg = (c.message || '').toLowerCase();

            // Strictly filter out bot commits, workflow runs, and loc.csv maintenance commits
            const isBot = authorName.includes('bot') || authorName.includes('action') || authorEmail.includes('bot') || authorEmail.includes('action');
            const isWorkflowMsg = msg.includes('loc.csv') || msg.includes('[skip ci]') || msg.includes('auto-update');

            if (isBot || isWorkflowMsg) return;

            const sha = c.sha;
            const shortSha = sha ? sha.substring(0, 7) : 'head';
            eventCommits.push({
              sha,
              shortSha,
              message: c.message?.split('\n')[0] || 'Update repository',
              repoName: repoShortName,
              repoFullName,
              repoUrl,
              commitUrl: `https://github.com/${repoFullName}/commit/${sha}`,
              date: ev.created_at,
              timeAgo: formatTimeAgo(ev.created_at),
            });
          });
        });

        if (eventCommits.length > 0) {
          const commitMap = new Map();
          eventCommits.forEach((item) => commitMap.set(item.sha, item));
          commitsData = Array.from(commitMap.values())
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 8);
        }
      }
    }

    // 2. Fallback: Query individual repository commit endpoints filtered by user author
    if (commitsData.length === 0 && Array.isArray(reposData) && reposData.length > 0) {
      const topPushed = [...reposData]
        .sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime())
        .slice(0, 5);

      const commitPromises = topPushed.map(async (repo) => {
        try {
          const resCommit = await fetch(
            `https://api.github.com/repos/${username}/${repo.name}/commits?author=${username}&per_page=10`,
            { headers, cache: 'no-store' }
          );
          if (resCommit.ok) {
            const data = await resCommit.json();
            if (Array.isArray(data)) {
              return data
                .filter((c) => {
                  const authorName = (c.commit?.author?.name || c.author?.login || '').toLowerCase();
                  const authorEmail = (c.commit?.author?.email || '').toLowerCase();
                  const msg = (c.commit?.message || '').toLowerCase();
                  const isBot = authorName.includes('bot') || authorName.includes('action') || authorEmail.includes('bot') || authorEmail.includes('action');
                  const isWorkflowMsg = msg.includes('loc.csv') || msg.includes('[skip ci]') || msg.includes('auto-update');
                  return !isBot && !isWorkflowMsg;
                })
                .map((c) => {
                  const commitDate = c.commit?.committer?.date || c.commit?.author?.date || repo.pushed_at;
                  return {
                    sha: c.sha,
                    shortSha: c.sha.substring(0, 7),
                    message: c.commit?.message?.split('\n')[0] || 'Update repository',
                    repoName: repo.name,
                    repoFullName: `${username}/${repo.name}`,
                    repoUrl: repo.html_url,
                    commitUrl: c.html_url || `${repo.html_url}/commit/${c.sha}`,
                    date: commitDate,
                    timeAgo: formatTimeAgo(commitDate),
                  };
                });
            }
          }
        } catch (e) {
          console.error(`Commit fetch error for ${repo.name}:`, e);
        }
        return [];
      });

      const nestedCommits = await Promise.all(commitPromises);
      const allFetchedCommits = nestedCommits.flat().filter(Boolean);

      if (allFetchedCommits.length > 0) {
        const commitMap = new Map();
        allFetchedCommits.forEach((item) => commitMap.set(item.sha, item));

        commitsData = Array.from(commitMap.values())
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
          .slice(0, 8);
      }
    }

    // 3. Deep Commit Telemetry: Enrich recent commits with exact line diff stats and modified files
    let enrichedCommits = [];
    if (commitsData.length > 0) {
      enrichedCommits = await Promise.all(
        commitsData.slice(0, 6).map(async (commit) => {
          try {
            const targetRepo = commit.repoFullName || `${username}/${commit.repoName}`;
            const commitDetailRes = await fetch(
              `https://api.github.com/repos/${targetRepo}/commits/${commit.sha}`,
              { headers, cache: 'no-store' }
            );

            if (commitDetailRes.ok) {
              const detail = await commitDetailRes.json();
              const stats = detail.stats || { total: 0, additions: 0, deletions: 0 };
              const files = (detail.files || []).map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions || 0,
                deletions: f.deletions || 0,
                changes: f.changes || 0,
              }));

              return {
                ...commit,
                stats: {
                  total: stats.total || 0,
                  additions: stats.additions || 0,
                  deletions: stats.deletions || 0,
                },
                linesChanged: stats.total || 0,
                additions: stats.additions || 0,
                deletions: stats.deletions || 0,
                filesCount: files.length,
                files: files.slice(0, 10),
                author: {
                  name: detail.commit?.author?.name || detail.author?.login || username,
                  date: detail.commit?.author?.date || commit.date,
                },
              };
            }
          } catch (detailErr) {
            console.error(`Failed to fetch commit detail for ${commit.sha}:`, detailErr);
          }

          return {
            ...commit,
            stats: { total: 0, additions: 0, deletions: 0 },
            linesChanged: 0,
            additions: 0,
            deletions: 0,
            filesCount: 0,
            files: [],
          };
        })
      );
    }

    const latestCommit = enrichedCommits.length > 0 ? enrichedCommits[0] : null;

    memoryCache = {
      status: 'online',
      username,
      user: userData,
      repos: reposData,
      commits: enrichedCommits,
      latestCommit,
      metaTelemetry,
      contributionCalendar,
      totalRepos: reposData.length,
      fetchedAt: new Date().toISOString(),
    };
    lastFetchTime = now;

    return res.status(200).json({ ...memoryCache, cached: false });
  } catch (error) {
    console.error('Vercel GitHub Meta Fetcher Handler Error:', error);

    const fallbackResponse = memoryCache || {
      status: 'degraded',
      username,
      user: {
        login: username,
        avatar_url: `https://github.com/${username}.png`,
        name: 'Ishaan Koradia',
        bio: 'AI Engineer & self-taught developer',
        public_repos: 23,
      },
      repos: [],
      commits: [],
      latestCommit: null,
      metaTelemetry: {
        metaPageUrl: 'https://portfolio.ishaankoradia.com/meta',
        promotionCallout: "Explore Ishaan's live Meta telemetry dashboard at https://portfolio.ishaankoradia.com/meta",
      },
      error: error.message,
    };

    return res.status(200).json({ ...fallbackResponse, cached: true });
  }
}
