let memoryCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 60 * 1000;

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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
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
    const updatedCommits = memoryCache.commits.map((c) => ({
      ...c,
      timeAgo: formatTimeAgo(c.date),
    }));

    return res.status(200).json({
      ...memoryCache,
      commits: updatedCommits,
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

    const [userRes, reposRes, eventsRes] = await Promise.all([
      fetch(`https://api.github.com/users/${username}`, { headers, cache: 'no-store' }),
      fetch(reposUrl, { headers, cache: 'no-store' }),
      fetch(`https://api.github.com/users/${username}/events?per_page=30`, { headers, cache: 'no-store' }),
    ]);

    let userData = null;
    let reposData = [];
    let commitsData = [];
    let contributionCalendar = null;

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
            .slice(0, 5);
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
          .slice(0, 5);
      }
    }

    memoryCache = {
      status: 'online',
      username,
      user: userData,
      repos: reposData,
      commits: commitsData,
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
      error: error.message,
    };

    return res.status(200).json({ ...fallbackResponse, cached: true });
  }
}
