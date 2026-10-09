let memoryCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 120 * 1000;
const repoCache = new Map();
const REPO_CACHE_DURATION_MS = 120 * 1000;
const dateCache = new Map();
const DATE_CACHE_DURATION_MS = 120 * 1000;

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

  const now = Date.now();
  const username = process.env.GITHUB_USERNAME?.trim() || 'ishaankor';
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers = {
    'User-Agent': 'Vercel-GitHub-Meta-Fetcher-App',
    Accept: 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = token.startsWith('github_pat_') ? `Bearer ${token}` : `token ${token}`;
  }

  // 1. Handle specific date query parameter: e.g. /api/github?date=2026-10-06 or /api/github?date=2026-10-06&repo=RigScouter-AI
  const dateQuery = req.query?.date ? String(req.query.date).trim() : null;
  if (dateQuery) {
    const repoFilter = req.query?.repo ? String(req.query.repo).trim() : null;
    const cleanRepo = repoFilter ? (repoFilter.includes('/') ? repoFilter.split('/')[1] : repoFilter) : null;
    const cacheKey = `${dateQuery}_${cleanRepo || 'all'}`.toLowerCase();
    const cachedEntry = dateCache.get(cacheKey);

    if (cachedEntry && (now - cachedEntry.time < DATE_CACHE_DURATION_MS)) {
      return res.status(200).json({
        ...cachedEntry.data,
        cached: true,
        servedAt: new Date().toISOString(),
      });
    }

    try {
      const searchHeaders = {
        ...headers,
        Accept: 'application/vnd.github.cloak-preview+json, application/vnd.github.v3+json',
      };
      
      const queryParts = [
        cleanRepo ? `repo:${username}/${cleanRepo}` : `author:${username}`,
        `committer-date:${dateQuery}`,
      ];
      const searchQ = queryParts.join('+');
      const searchUrl = `https://api.github.com/search/commits?q=${searchQ}&sort=committer-date&order=desc&per_page=50`;
      
      const searchRes = await fetch(searchUrl, { headers: searchHeaders, cache: 'no-store' });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const items = searchData.items || [];
        
        const commits = await Promise.all(
          items.slice(0, 30).map(async (item) => {
            const sha = item.sha;
            const shortSha = sha ? sha.substring(0, 7) : '';
            const repoFullName = item.repository?.full_name || '';
            const repoName = item.repository?.name || repoFullName.split('/')[1] || repoFullName;
            const commitMsg = item.commit?.message?.split('\n')[0] || 'Update repository';
            const commitDate = item.commit?.committer?.date || item.commit?.author?.date;
            const commitUrl = item.html_url || `https://github.com/${repoFullName}/commit/${sha}`;
            
            let stats = { total: 0, additions: 0, deletions: 0 };
            let files = [];
            
            try {
              const detailRes = await fetch(
                `https://api.github.com/repos/${repoFullName}/commits/${sha}`,
                { headers, cache: 'no-store' }
              );
              if (detailRes.ok) {
                const detail = await detailRes.json();
                stats = detail.stats || stats;
                files = (detail.files || []).map((f) => ({
                  filename: f.filename,
                  status: f.status,
                  additions: f.additions || 0,
                  deletions: f.deletions || 0,
                  changes: f.changes || 0,
                }));
              }
            } catch (err) {
              console.error(`Detail fetch error for commit ${sha}:`, err);
            }
            
            return {
              sha,
              shortSha,
              message: commitMsg,
              repoName,
              repoFullName,
              repoUrl: item.repository?.html_url || `https://github.com/${repoFullName}`,
              commitUrl,
              date: commitDate,
              timeAgo: formatTimeAgo(commitDate),
              stats,
              linesChanged: stats.total || 0,
              additions: stats.additions || 0,
              deletions: stats.deletions || 0,
              filesCount: files.length,
              files: files.slice(0, 10),
              author: {
                name: item.commit?.author?.name || item.author?.login || username,
                date: commitDate,
              },
            };
          })
        );
        
        const responseData = {
          status: 'online',
          date: dateQuery,
          repository: cleanRepo || null,
          totalCommits: searchData.total_count ?? commits.length,
          commits,
          metaPageUrl: 'https://portfolio.ishaankoradia.com/meta',
          metaPagePromotion: "Explore Ishaan's live Meta telemetry dashboard at https://portfolio.ishaankoradia.com/meta for interactive Codebase Evolution (LOC charts), Developer Habits Matrix, and repository constellation.",
          servedAt: new Date().toISOString(),
        };
        
        dateCache.set(cacheKey, { data: responseData, time: now });
        return res.status(200).json(responseData);
      } else {
        const errText = await searchRes.text();
        console.error('Commit search error from GitHub:', searchRes.status, errText);
        return res.status(searchRes.status).json({
          status: 'error',
          date: dateQuery,
          error: `GitHub search API returned status ${searchRes.status}`,
          details: errText,
          servedAt: new Date().toISOString(),
        });
      }
    } catch (dateErr) {
      console.error(`Date commit search error (${dateQuery}):`, dateErr);
      return res.status(500).json({
        status: 'error',
        date: dateQuery,
        error: dateErr.message,
        servedAt: new Date().toISOString(),
      });
    }
  }

  // 2. Handle specific repository query parameter immediately: e.g. /api/github?repo=my-data-science-portfolio
  const repoQuery = req.query?.repo ? String(req.query.repo).trim() : null;
  if (repoQuery) {
    const cleanRepo = repoQuery.includes('/') ? repoQuery.split('/')[1] : repoQuery;
    const cacheKey = cleanRepo.toLowerCase();
    const cachedEntry = repoCache.get(cacheKey);

    if (cachedEntry && (now - cachedEntry.time < REPO_CACHE_DURATION_MS)) {
      return res.status(200).json({
        ...cachedEntry.data,
        cached: true,
        servedAt: new Date().toISOString(),
      });
    }

    try {
      const resRepoCommits = await fetch(
        `https://api.github.com/repos/${username}/${cleanRepo}/commits?per_page=10`,
        { headers, cache: 'no-store' }
      );
      if (resRepoCommits.ok) {
        const repoCommits = await resRepoCommits.json();
        if (Array.isArray(repoCommits) && repoCommits.length > 0) {
          const chosen = repoCommits.find((c) => {
            const author = (c.commit?.author?.name || c.author?.login || '').toLowerCase();
            const msg = (c.commit?.message || '').toLowerCase();
            const isBot = author.includes('bot') || author.includes('action');
            const isWf = msg.includes('loc.csv') || msg.includes('[skip ci]') || msg.includes('auto-update');
            return !isBot && !isWf;
          }) || repoCommits[0];

          let stats = { total: 0, additions: 0, deletions: 0 };
          let files = [];

          try {
            const detailRes = await fetch(
              `https://api.github.com/repos/${username}/${cleanRepo}/commits/${chosen.sha}`,
              { headers, cache: 'no-store' }
            );
            if (detailRes.ok) {
              const detail = await detailRes.json();
              stats = detail.stats || stats;
              files = (detail.files || []).map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions || 0,
                deletions: f.deletions || 0,
                changes: f.changes || 0,
              }));
            }
          } catch (e) {
            console.error(`Detail fetch error for ${chosen.sha}:`, e);
          }

          const commitDate = chosen.commit?.committer?.date || chosen.commit?.author?.date;
          const repoCommit = {
            sha: chosen.sha,
            shortSha: chosen.sha.substring(0, 7),
            message: chosen.commit?.message?.split('\n')[0] || 'Update repository',
            repoName: cleanRepo,
            repoFullName: `${username}/${cleanRepo}`,
            repoUrl: `https://github.com/${username}/${cleanRepo}`,
            commitUrl: chosen.html_url || `https://github.com/${username}/${cleanRepo}/commit/${chosen.sha}`,
            date: commitDate,
            timeAgo: formatTimeAgo(commitDate),
            stats,
            linesChanged: stats.total || 0,
            additions: stats.additions || 0,
            deletions: stats.deletions || 0,
            filesCount: files.length,
            files: files.slice(0, 10),
            author: {
              name: chosen.commit?.author?.name || username,
              date: commitDate,
            },
          };

          let architectureContext = "";
          if (cleanRepo.toLowerCase().includes("data-science-portfolio")) {
            architectureContext = (
              "Ishaan structures his empirical research and Exploratory Data Analysis (EDA) projects " +
              "(such as his surgery statistics and childhood obesity analyses) across dedicated modular repositories " +
              "rather than a single monolithic data science repo, tracking their specific data notebooks and D3/Pandas pipelines independently. " +
              "Meanwhile, 'my-data-science-portfolio' (https://github.com/ishaankor/my-data-science-portfolio) hosts his interactive 3D WebGL portfolio platform " +
              "and live Codebase Evolution suite at https://portfolio.ishaankoradia.com."
            );
          }

          const responseData = {
            status: 'online',
            repository: cleanRepo,
            architectureContext,
            repoCommit,
            linesChanged: repoCommit.linesChanged,
            additions: repoCommit.additions,
            deletions: repoCommit.deletions,
            filesCount: repoCommit.filesCount,
            metaPageUrl: 'https://portfolio.ishaankoradia.com/meta',
            metaPagePromotion: "Explore Ishaan's live Meta telemetry dashboard at https://portfolio.ishaankoradia.com/meta for interactive Codebase Evolution (LOC charts), Developer Habits Matrix, and repository constellation.",
            servedAt: new Date().toISOString(),
          };

          repoCache.set(cacheKey, { data: responseData, time: now });
          return res.status(200).json(responseData);
        }
      }
      return res.status(404).json({
        status: 'not_found',
        repository: cleanRepo,
        message: `No commits found for repository ${cleanRepo}`,
        servedAt: new Date().toISOString(),
      });
    } catch (repoErr) {
      console.error(`Specific repo fetch error (${repoQuery}):`, repoErr);
      return res.status(500).json({
        status: 'error',
        repository: cleanRepo,
        error: repoErr.message,
        servedAt: new Date().toISOString(),
      });
    }
  }

  // 2. Handle general workbench & telemetry feed with global memoryCache
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
      totalHistoricalCommits: 0,
      totalRecords: 0,
      totalLinesTracked: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      totalFilesTracked: 0,
      topLanguages: [],
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
