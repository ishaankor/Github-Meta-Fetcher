// Vercel Serverless Function: High-Performance Real-Time Commit Stream Endpoint
// Decoupled from the monolithic /api/github metadata handler for sub-second live streaming

let memoryCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 15 * 1000; // 15 seconds memory cache

function formatTimeAgo(dateString) {
  if (!dateString) return 'recently';
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

function isExcludedCommit(authorName = '', authorEmail = '', message = '') {
  const an = authorName.toLowerCase();
  const ae = authorEmail.toLowerCase();
  const msg = message.toLowerCase();

  const isBot =
    an.includes('bot') ||
    an.includes('action') ||
    an.includes('github-actions') ||
    ae.includes('bot') ||
    ae.includes('action');

  const isWorkflowMsg =
    msg.includes('loc.csv') ||
    msg.includes('[skip ci]') ||
    msg.includes('auto-update');

  return isBot || isWorkflowMsg;
}

export default async function handler(req, res) {
  // Ultra-fresh edge cache: 10s fresh, 30s stale-while-revalidate
  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, Cache-Control, Pragma'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const now = Date.now();
  const force = req.query?.force === 'true' || req.query?._t !== undefined;
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 6, 1), 20);
  const repoFilter = req.query?.repo ? String(req.query.repo).trim() : null;

  // Serve fast memory cache if fresh and not explicitly forced
  if (!force && memoryCache && (now - lastFetchTime < CACHE_DURATION_MS) && !repoFilter) {
    return res.status(200).json({
      ...memoryCache,
      cached: true,
      cachedAt: new Date(lastFetchTime).toISOString(),
    });
  }

  const username = process.env.GITHUB_USERNAME?.trim() || 'ishaankor';
  const token = process.env.GITHUB_TOKEN?.trim();

  const headers = {
    'User-Agent': 'Personal-Meta-Fetcher-CommitStream',
    Accept: 'application/vnd.github.v3+json',
  };

  if (token) {
    headers['Authorization'] = token.startsWith('github_pat_') ? `Bearer ${token}` : `token ${token}`;
  }

  try {
    let targetRepos = [];

    if (repoFilter) {
      const cleanRepo = repoFilter.includes('/') ? repoFilter.split('/')[1] : repoFilter;
      targetRepos = [{ name: cleanRepo, html_url: `https://github.com/${username}/${cleanRepo}` }];
    } else {
      // 1. Fetch top 5 most recently pushed repositories
      const reposRes = await fetch(
        `https://api.github.com/users/${username}/repos?sort=pushed&per_page=6`,
        { headers, cache: 'no-store' }
      );

      if (reposRes.ok) {
        const reposData = await reposRes.json();
        if (Array.isArray(reposData)) {
          targetRepos = reposData.slice(0, 5).map((r) => ({
            name: r.name,
            html_url: r.html_url,
            pushed_at: r.pushed_at,
          }));
        }
      }
    }

    // 2. Concurrently fetch recent commits authored by user for each target repository
    const commitPromises = targetRepos.map(async (repo) => {
      try {
        const commitRes = await fetch(
          `https://api.github.com/repos/${username}/${repo.name}/commits?author=${username}&per_page=6`,
          { headers, cache: 'no-store' }
        );

        if (commitRes.ok) {
          const list = await commitRes.json();
          if (Array.isArray(list)) {
            return list
              .filter((c) => {
                const authorName = c.commit?.author?.name || c.author?.login || '';
                const authorEmail = c.commit?.author?.email || '';
                const msg = c.commit?.message || '';
                return !isExcludedCommit(authorName, authorEmail, msg);
              })
              .map((c) => {
                const commitDate = c.commit?.committer?.date || c.commit?.author?.date || c.commit?.date;
                return {
                  sha: c.sha,
                  shortSha: c.sha ? c.sha.substring(0, 7) : 'head',
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
      } catch (err) {
        console.error(`Error querying commits for repo ${repo.name}:`, err);
      }
      return [];
    });

    const commitResults = await Promise.allSettled(commitPromises);
    const rawCommits = commitResults
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    // 3. Fallback: If repo commits are empty, check user's public Events API
    if (rawCommits.length === 0 && !repoFilter) {
      try {
        const eventsRes = await fetch(
          `https://api.github.com/users/${username}/events/public?per_page=20`,
          { headers, cache: 'no-store' }
        );
        if (eventsRes.ok) {
          const events = await eventsRes.json();
          if (Array.isArray(events)) {
            const pushEvents = events.filter((e) => e.type === 'PushEvent');
            pushEvents.forEach((ev) => {
              const repoFullName = ev.repo?.name || '';
              const repoShortName = repoFullName.split('/')[1] || repoFullName;
              const repoUrl = `https://github.com/${repoFullName}`;
              const payloadCommits = ev.payload?.commits || [];

              payloadCommits.forEach((c) => {
                const authorName = c.author?.name || ev.actor?.login || '';
                const authorEmail = c.author?.email || '';
                const msg = c.message || '';

                if (isExcludedCommit(authorName, authorEmail, msg)) return;

                const sha = c.sha;
                rawCommits.push({
                  sha,
                  shortSha: sha ? sha.substring(0, 7) : 'head',
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
          }
        }
      } catch (eventErr) {
        console.error('Error querying events fallback:', eventErr);
      }
    }

    // 4. Deduplicate commits by SHA and sort descending (newest first)
    const commitMap = new Map();
    rawCommits.forEach((item) => {
      if (item.sha && !commitMap.has(item.sha)) {
        commitMap.set(item.sha, item);
      }
    });

    const sortedCommits = Array.from(commitMap.values())
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    // 5. Deep detail enrichment (additions, deletions, files modified) for the top 5 commits
    const enrichedCommits = await Promise.all(
      sortedCommits.slice(0, 5).map(async (commit) => {
        try {
          const targetRepo = commit.repoFullName || `${username}/${commit.repoName}`;
          const detailRes = await fetch(
            `https://api.github.com/repos/${targetRepo}/commits/${commit.sha}`,
            { headers, cache: 'no-store' }
          );

          if (detailRes.ok) {
            const detail = await detailRes.json();
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
          console.error(`Failed to enrich commit ${commit.sha}:`, detailErr);
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

    // Append remaining unenriched commits if limit > 5
    const remainingCommits = sortedCommits.slice(5).map((commit) => ({
      ...commit,
      stats: { total: 0, additions: 0, deletions: 0 },
      linesChanged: 0,
      additions: 0,
      deletions: 0,
      filesCount: 0,
      files: [],
    }));

    const finalCommits = [...enrichedCommits, ...remainingCommits];
    const latestCommit = finalCommits[0] || null;

    const payload = {
      status: 'online',
      username,
      commits: finalCommits,
      latestCommit,
      total: finalCommits.length,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };

    if (!repoFilter) {
      memoryCache = payload;
      lastFetchTime = now;
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error('Personal Meta Fetcher Commit Stream Error:', error);

    if (memoryCache) {
      return res.status(200).json({
        ...memoryCache,
        cached: true,
        degraded: true,
        error: error.message,
      });
    }

    return res.status(200).json({
      status: 'degraded',
      username,
      commits: [],
      latestCommit: null,
      total: 0,
      error: error.message,
      fetchedAt: new Date().toISOString(),
    });
  }
}
