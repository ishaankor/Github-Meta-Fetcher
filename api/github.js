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
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({ ...memoryCache, cached: true });
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
    const [userRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/users/${username}`, { headers }),
      fetch(`https://api.github.com/users/${username}/repos?per_page=100&sort=pushed`, { headers }),
    ]);

    let userData = null;
    let reposData = [];

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
        reposData = fetchedRepos.map((r) => ({
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

    if (userData && reposData.length > 0) {
      userData.public_repos = reposData.length;
    }

    let commitsData = [];
    if (Array.isArray(reposData) && reposData.length > 0) {
      const topPushed = [...reposData]
        .sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime())
        .slice(0, 5);

      const commitPromises = topPushed.map(async (repo) => {
        try {
          const resCommit = await fetch(
            `https://api.github.com/repos/${username}/${repo.name}/commits?per_page=5`,
            { headers }
          );
          if (resCommit.ok) {
            const data = await resCommit.json();
            if (Array.isArray(data)) {
              return data.map((c) => {
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
      totalRepos: reposData.length,
      fetchedAt: new Date().toISOString(),
    };
    lastFetchTime = now;

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
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
