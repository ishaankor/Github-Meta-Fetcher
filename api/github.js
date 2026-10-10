let memoryCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 120 * 1000;
const repoCache = new Map();
const REPO_CACHE_DURATION_MS = 120 * 1000;
const dateCache = new Map();
const DATE_CACHE_DURATION_MS = 300 * 1000;
const timeframeRepoCache = new Map();
const TIMEFRAME_REPO_CACHE_DURATION_MS = 300 * 1000;

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

function resolveTimeframeWindow({ timeframe, days, since, until, date, tzOffset = 'Z' }) {
  const now = new Date();
  let sinceDate = null;
  let untilDate = null;
  let resolvedLabel = timeframe || '';

  // 1. Explicit 'since' timestamp or date string
  if (since) {
    const s = String(since).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      sinceDate = new Date(`${s}T00:00:00${tzOffset}`);
    } else {
      sinceDate = new Date(s);
    }
  }

  // 2. Explicit 'until' timestamp or date string
  if (until) {
    const u = String(until).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(u)) {
      untilDate = new Date(`${u}T23:59:59${tzOffset}`);
    } else {
      untilDate = new Date(u);
    }
  }

  // 3. Explicit numeric days (e.g. days=14)
  if (days) {
    const numDays = parseInt(days, 10);
    if (!isNaN(numDays) && numDays > 0) {
      sinceDate = new Date(now.getTime() - numDays * 24 * 60 * 60 * 1000);
      untilDate = untilDate || now;
      resolvedLabel = resolvedLabel || `past ${numDays} days`;
    }
  }

  // 4. Date range formatted with '..' (e.g. 2026-09-25..2026-10-09)
  if (date && String(date).includes('..')) {
    const [startStr, endStr] = String(date).split('..');
    const s = startStr.trim();
    const e = endStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      sinceDate = new Date(`${s}T00:00:00${tzOffset}`);
    } else {
      sinceDate = new Date(s);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(e)) {
      untilDate = new Date(`${e}T23:59:59${tzOffset}`);
    } else {
      untilDate = new Date(e);
    }
    resolvedLabel = resolvedLabel || `${s} to ${e}`;
  }

  // 5. Single date string in 'date' (e.g. 2026-10-06)
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim()) && !sinceDate) {
    const d = String(date).trim();
    sinceDate = new Date(`${d}T00:00:00${tzOffset}`);
    untilDate = new Date(`${d}T23:59:59${tzOffset}`);
    resolvedLabel = d;
  }

  // 6. Natural language relative timeframe strings
  const tf = (timeframe || (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) && !String(date).includes('..') ? String(date) : '')).toLowerCase().trim();
  if (tf && !sinceDate) {
    const wordToNum = {
      one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
      fourteen: 14, twenty: 20, thirty: 30, sixty: 60, ninety: 90
    };

    const extractUnitCount = (pattern) => {
      const match = tf.match(new RegExp(`(?:last|past|previous)?\\s*(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty|thirty|sixty|ninety|a|an)?\\s*${pattern}`, 'i'));
      if (match) {
        const val = match[1] ? match[1].toLowerCase() : '1';
        return parseInt(val, 10) || wordToNum[val] || 1;
      }
      return null;
    };

    const monthCount = extractUnitCount('months?');
    const weekCount = extractUnitCount('weeks?');
    const dayCount = extractUnitCount('days?');
    const yearCount = extractUnitCount('years?');

    if (tf.includes('today')) {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      sinceDate = startOfDay;
      untilDate = untilDate || now;
      resolvedLabel = 'today';
    } else if (tf.includes('yesterday')) {
      const startOfYesterday = new Date(now);
      startOfYesterday.setDate(startOfYesterday.getDate() - 1);
      startOfYesterday.setHours(0, 0, 0, 0);
      const endOfYesterday = new Date(startOfYesterday);
      endOfYesterday.setHours(23, 59, 59, 999);
      sinceDate = startOfYesterday;
      untilDate = endOfYesterday;
      resolvedLabel = 'yesterday';
    } else if (tf.includes('this week') || tf.includes('current week')) {
      const startOfWeek = new Date(now);
      const day = startOfWeek.getDay();
      startOfWeek.setDate(startOfWeek.getDate() - day);
      startOfWeek.setHours(0, 0, 0, 0);
      sinceDate = startOfWeek;
      untilDate = untilDate || now;
      resolvedLabel = 'this week';
    } else if (monthCount !== null) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - monthCount);
      sinceDate = d;
      untilDate = untilDate || now;
      resolvedLabel = monthCount === 1 ? 'past month' : `past ${monthCount} months`;
    } else if (weekCount !== null) {
      sinceDate = new Date(now.getTime() - weekCount * 7 * 24 * 60 * 60 * 1000);
      untilDate = untilDate || now;
      resolvedLabel = weekCount === 1 ? 'last week' : `last ${weekCount} weeks`;
    } else if (dayCount !== null) {
      sinceDate = new Date(now.getTime() - dayCount * 24 * 60 * 60 * 1000);
      untilDate = untilDate || now;
      resolvedLabel = dayCount === 1 ? 'past day' : `past ${dayCount} days`;
    } else if (yearCount !== null) {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - yearCount);
      sinceDate = d;
      untilDate = untilDate || now;
      resolvedLabel = yearCount === 1 ? 'past year' : `past ${yearCount} years`;
    } else if (tf.includes('fortnight')) {
      sinceDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      untilDate = untilDate || now;
      resolvedLabel = 'last two weeks';
    }
  }

  return {
    sinceDate: sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate.toISOString() : null,
    untilDate: untilDate && !isNaN(untilDate.getTime()) ? untilDate.toISOString() : null,
    resolvedLabel: resolvedLabel || 'specified timeframe'
  };
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

  const repoQuery = req.query?.repo ? String(req.query.repo).trim() : null;
  const dateQuery = req.query?.date ? String(req.query.date).trim() : null;
  const timeframeQuery = req.query?.timeframe ? String(req.query.timeframe).trim() : null;
  const tzOffset = req.query?.tz ? String(req.query.tz).trim() : null;

  // 1. Handle specific repository query parameter (with or without timeframe):
  // e.g. /api/github?repo=Datafy&timeframe=last two weeks OR /api/github?repo=Datafy
  if (repoQuery) {
    const cleanRepo = repoQuery.includes('/') ? repoQuery.split('/')[1] : repoQuery;
    const sinceParam = req.query?.since ? String(req.query.since).trim() : null;
    const untilParam = req.query?.until ? String(req.query.until).trim() : null;
    const daysParam = req.query?.days ? String(req.query.days).trim() : null;

    const tfWindow = resolveTimeframeWindow({
      timeframe: timeframeQuery,
      days: daysParam,
      since: sinceParam,
      until: untilParam,
      date: dateQuery,
      tzOffset: tzOffset || 'Z'
    });

    // 1A. Repository commits over a timeframe / date range
    if (tfWindow.sinceDate) {
      const cacheKey = `${cleanRepo}_tf_${tfWindow.sinceDate}_${tfWindow.untilDate || 'now'}`.toLowerCase();
      const cachedEntry = timeframeRepoCache.get(cacheKey);

      if (cachedEntry && (now - cachedEntry.time < TIMEFRAME_REPO_CACHE_DURATION_MS)) {
        return res.status(200).json({
          ...cachedEntry.data,
          cached: true,
          servedAt: new Date().toISOString(),
        });
      }

      try {
        let fetchUrl = `https://api.github.com/repos/${username}/${cleanRepo}/commits?since=${encodeURIComponent(tfWindow.sinceDate)}&per_page=100`;
        if (tfWindow.untilDate) {
          fetchUrl += `&until=${encodeURIComponent(tfWindow.untilDate)}`;
        }

        const commitsRes = await fetch(fetchUrl, { headers, cache: 'no-store' });
        if (!commitsRes.ok) {
          const errText = await commitsRes.text();
          return res.status(commitsRes.status).json({
            status: 'error',
            repository: cleanRepo,
            error: `GitHub commits API returned status ${commitsRes.status}`,
            details: errText,
            servedAt: new Date().toISOString(),
          });
        }

        const rawCommits = await commitsRes.json();
        const filteredCommits = Array.isArray(rawCommits)
          ? rawCommits.filter((c) => {
              const author = (c.commit?.author?.name || c.author?.login || '').toLowerCase();
              const msg = (c.commit?.message || '').toLowerCase();
              const isBot = author.includes('bot') || author.includes('action');
              const isWf = msg.includes('loc.csv') || msg.includes('[skip ci]') || msg.includes('auto-update');
              return !isBot && !isWf;
            })
          : [];

        // For top commits (up to 50), fetch detailed line diff stats
        const DETAILED_LIMIT = 50;
        const commitsToDetail = filteredCommits.slice(0, DETAILED_LIMIT);
        const remainingCommits = filteredCommits.slice(DETAILED_LIMIT);

        const detailedCommits = await Promise.all(
          commitsToDetail.map(async (c) => {
            const sha = c.sha;
            const shortSha = sha ? sha.substring(0, 7) : '';
            const commitMsg = c.commit?.message?.split('\n')[0] || 'Update repository';
            const commitDate = c.commit?.committer?.date || c.commit?.author?.date;
            const commitUrl = c.html_url || `https://github.com/${username}/${cleanRepo}/commit/${sha}`;
            
            let stats = { total: 0, additions: 0, deletions: 0 };
            let files = [];

            try {
              const detailRes = await fetch(
                `https://api.github.com/repos/${username}/${cleanRepo}/commits/${sha}`,
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
              repoName: cleanRepo,
              repoFullName: `${username}/${cleanRepo}`,
              repoUrl: `https://github.com/${username}/${cleanRepo}`,
              commitUrl,
              date: commitDate,
              timeAgo: formatTimeAgo(commitDate),
              stats,
              linesChanged: stats.total || 0,
              additions: stats.additions || 0,
              deletions: stats.deletions || 0,
              filesCount: files.length,
              files: files.slice(0, 8),
              author: {
                name: c.commit?.author?.name || c.author?.login || username,
                date: commitDate,
              },
            };
          })
        );

        const unDetailedList = remainingCommits.map((c) => {
          const sha = c.sha;
          const shortSha = sha ? sha.substring(0, 7) : '';
          const commitMsg = c.commit?.message?.split('\n')[0] || 'Update repository';
          const commitDate = c.commit?.committer?.date || c.commit?.author?.date;
          return {
            sha,
            shortSha,
            message: commitMsg,
            repoName: cleanRepo,
            repoFullName: `${username}/${cleanRepo}`,
            repoUrl: `https://github.com/${username}/${cleanRepo}`,
            commitUrl: c.html_url || `https://github.com/${username}/${cleanRepo}/commit/${sha}`,
            date: commitDate,
            timeAgo: formatTimeAgo(commitDate),
            stats: { total: 0, additions: 0, deletions: 0 },
            linesChanged: 0,
            additions: 0,
            deletions: 0,
            filesCount: 0,
            files: [],
            author: {
              name: c.commit?.author?.name || c.author?.login || username,
              date: commitDate,
            },
          };
        });

        const allCommitsList = [...detailedCommits, ...unDetailedList];
        const totalAdditions = detailedCommits.reduce((acc, c) => acc + (c.additions || 0), 0);
        const totalDeletions = detailedCommits.reduce((acc, c) => acc + (c.deletions || 0), 0);
        const totalLinesChanged = detailedCommits.reduce((acc, c) => acc + (c.linesChanged || 0), 0);

        const sincePretty = tfWindow.sinceDate.split('T')[0];
        const untilPretty = (tfWindow.untilDate || new Date().toISOString()).split('T')[0];

        let directSummary = '';
        if (filteredCommits.length > 0) {
          directSummary = `Ishaan made ${filteredCommits.length} commit(s) on ${cleanRepo} during ${tfWindow.resolvedLabel} (${sincePretty} to ${untilPretty}), totaling ${totalLinesChanged.toLocaleString()} lines of code changed (+${totalAdditions.toLocaleString()}/-${totalDeletions.toLocaleString()}).`;
        } else {
          directSummary = `Ishaan didn't log any commits for ${cleanRepo} during ${tfWindow.resolvedLabel} (${sincePretty} to ${untilPretty}).`;
        }

        const responseData = {
          status: 'online',
          repository: cleanRepo,
          timeframe: tfWindow.resolvedLabel,
          since: tfWindow.sinceDate,
          until: tfWindow.untilDate,
          totalCommits: filteredCommits.length,
          commits: allCommitsList,
          totalLinesChanged,
          totalAdditions,
          totalDeletions,
          directSummary,
          metaPageUrl: 'https://portfolio.ishaankoradia.com/meta',
          metaPagePromotion: "Explore Ishaan's live Meta telemetry dashboard at https://portfolio.ishaankoradia.com/meta for interactive Codebase Evolution (LOC charts), Developer Habits Matrix, and repository constellation.",
          servedAt: new Date().toISOString(),
        };

        timeframeRepoCache.set(cacheKey, { data: responseData, time: now });
        return res.status(200).json(responseData);
      } catch (err) {
        console.error(`Repository timeframe commit error (${cleanRepo}):`, err);
        return res.status(500).json({
          status: 'error',
          repository: cleanRepo,
          error: err.message,
          servedAt: new Date().toISOString(),
        });
      }
    }

    // 1B. Standard single repository latest commit lookup
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

  // 2. Handle cross-repository date / timeframe queries (without specific repo)
  // e.g. /api/github?date=2026-10-06 or /api/github?timeframe=last two weeks
  const activeDateOrTimeframe = dateQuery || timeframeQuery;
  if (activeDateOrTimeframe) {
    const localTz = tzOffset || '-07:00';
    const tfWindow = resolveTimeframeWindow({
      timeframe: timeframeQuery,
      date: dateQuery,
      tzOffset: localTz
    });

    const cacheKey = `cross_${tfWindow.sinceDate || activeDateOrTimeframe}_${tfWindow.untilDate || 'now'}`.toLowerCase();
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
        Accept: 'application/vnd.cloak-preview+json, application/vnd.github.v3+json',
      };
      
      const isLifetimeQuery = String(activeDateOrTimeframe).trim().toLowerCase() === 'all' || 
                              String(activeDateOrTimeframe).trim().toLowerCase() === 'lifetime';

      let dateSearchParam = null;
      if (!isLifetimeQuery) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(activeDateOrTimeframe)) {
          dateSearchParam = `${activeDateOrTimeframe}T00:00:00${localTz}..${activeDateOrTimeframe}T23:59:59${localTz}`;
        } else if (tfWindow.sinceDate) {
          const startStr = tfWindow.sinceDate.split('T')[0];
          const endStr = (tfWindow.untilDate || new Date().toISOString()).split('T')[0];
          dateSearchParam = `${startStr}..${endStr}`;
        } else {
          dateSearchParam = activeDateOrTimeframe;
        }
      }

      const queryParts = [`author:${username}`];
      if (dateSearchParam) {
        queryParts.push(`committer-date:${dateSearchParam}`);
      }
      const searchQ = queryParts.join('+');
      const baseSearchUrl = `https://api.github.com/search/commits?q=${searchQ}&sort=committer-date&order=desc&per_page=100`;
      
      const searchRes = await fetch(`${baseSearchUrl}&page=1`, { headers: searchHeaders, cache: 'no-store' });
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const totalCount = searchData.total_count ?? 0;
        let allItems = searchData.items || [];

        // Concurrently paginate up to 10 pages (max 1,000 commits) to capture all historical repositories & commit counts
        if (totalCount > 100) {
          const totalPagesToFetch = Math.min(Math.ceil(totalCount / 100), 10);
          const pagePromises = [];
          for (let p = 2; p <= totalPagesToFetch; p++) {
            pagePromises.push(
              fetch(`${baseSearchUrl}&page=${p}`, { headers: searchHeaders, cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : { items: [] }))
                .then((d) => d.items || [])
                .catch((e) => {
                  console.error(`Page ${p} fetch warning:`, e);
                  return [];
                })
            );
          }
          const extraPages = await Promise.all(pagePromises);
          for (const extraItems of extraPages) {
            allItems = allItems.concat(extraItems);
          }
        }
        
        // Filter items strictly for single-day queries if needed
        const getLocalDateStr = (isoStr) => {
          try {
            return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(isoStr));
          } catch (e) {
            return (isoStr || '').split('T')[0];
          }
        };
        const filteredItems = /^\d{4}-\d{2}-\d{2}$/.test(activeDateOrTimeframe)
          ? allItems.filter((item) => {
              const commitDate = item.commit?.committer?.date || item.commit?.author?.date || '';
              return getLocalDateStr(commitDate) === activeDateOrTimeframe;
            })
          : allItems;

        // Group repositories and counts across the complete dataset
        const repoCounts = {};
        filteredItems.forEach((item) => {
          const repoFullName = item.repository?.full_name || '';
          const repoName = item.repository?.name || (repoFullName.includes('/') ? repoFullName.split('/')[1] : repoFullName) || 'unknown';
          repoCounts[repoName] = (repoCounts[repoName] || 0) + 1;
        });

        const activeRepositories = Object.keys(repoCounts).sort();

        // Enrich the top 30 commits for fast Vercel execution (fetch line diffs for top 12)
        const commits = await Promise.all(
          filteredItems.slice(0, 30).map(async (item, idx) => {
            const sha = item.sha;
            const shortSha = sha ? sha.substring(0, 7) : '';
            const repoFullName = item.repository?.full_name || '';
            const repoName = item.repository?.name || (repoFullName.includes('/') ? repoFullName.split('/')[1] : repoFullName) || '';
            const commitMsg = item.commit?.message?.split('\n')[0] || 'Update repository';
            const commitDate = item.commit?.committer?.date || item.commit?.author?.date;
            const commitUrl = item.html_url || `https://github.com/${repoFullName}/commit/${sha}`;
            
            let stats = { total: 0, additions: 0, deletions: 0 };
            let files = [];
            
            if (idx < 12) {
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
        
        const breakdownParts = Object.entries(repoCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([r, c]) => `${r} (${c} commit${c !== 1 ? 's' : ''})`);
        const directSummary = activeRepositories.length === 0
          ? `No commits found for ${activeDateOrTimeframe}.`
          : `Worked on ${activeRepositories.length} repositories: ${breakdownParts.join(', ')} (totaling ${totalCount} commits).`;

        const responseData = {
          status: 'online',
          date: activeDateOrTimeframe,
          timeframe: isLifetimeQuery ? 'lifetime (all time)' : tfWindow.resolvedLabel,
          since: tfWindow.sinceDate,
          until: tfWindow.untilDate,
          repository: null,
          totalCommits: totalCount,
          activeRepositories,
          totalRepositoriesWorkedOn: activeRepositories.length,
          repositoryCommitCounts: repoCounts,
          directSummary,
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
          date: activeDateOrTimeframe,
          error: `GitHub search API returned status ${searchRes.status}`,
          details: errText,
          servedAt: new Date().toISOString(),
        });
      }
    } catch (dateErr) {
      console.error(`Date commit search error (${activeDateOrTimeframe}):`, dateErr);
      return res.status(500).json({
        status: 'error',
        date: activeDateOrTimeframe,
        error: dateErr.message,
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

    // Fetch total lifetime commits across entire GitHub account from start to present
    try {
      const searchHeaders = {
        ...headers,
        Accept: 'application/vnd.cloak-preview+json, application/vnd.github.v3+json',
      };
      const lifetimeRes = await fetch(`https://api.github.com/search/commits?q=author:${username}`, { headers: searchHeaders, cache: 'no-store' });
      if (lifetimeRes.ok) {
        const lifetimeJson = await lifetimeRes.json();
        if (lifetimeJson.total_count) {
          metaTelemetry.totalHistoricalCommits = lifetimeJson.total_count;
        }
      }
    } catch (lifetimeErr) {
      console.warn('Lifetime commits search error:', lifetimeErr);
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
