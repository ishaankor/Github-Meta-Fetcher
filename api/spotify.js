// Vercel Serverless Function: Spotify Real-Time Telemetry for ishaankoradia.com

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getAccessToken(clientId, clientSecret, refreshToken) {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60000) {
    return tokenCache.accessToken;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to refresh Spotify token');
  }

  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = now + (data.expires_in * 1000);
  return tokenCache.accessToken;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=15');
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

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({
      error: 'Spotify credentials are missing. Please configure SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN in your environment variables.',
    });
  }

  try {
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);

    // 1. Check currently playing
    const currentlyPlayingRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (currentlyPlayingRes.status === 200) {
      const data = await currentlyPlayingRes.json();
      if (data && data.item) {
        return res.status(200).json({
          isPlaying: data.is_playing,
          recentlyPlayed: false,
          context: data.is_playing ? 'NOW PLAYING' : 'PAUSED',
          title: data.item.name,
          artist: data.item.artists ? data.item.artists.map((a) => a.name).join(', ') : 'Unknown Artist',
          album: data.item.album ? data.item.album.name : '',
          albumImageUrl: data.item.album && data.item.album.images && data.item.album.images[0] ? data.item.album.images[0].url : null,
          songUrl: data.item.external_urls ? data.item.external_urls.spotify : null,
          progressMs: data.progress_ms,
          durationMs: data.item.duration_ms,
          fetchedAt: new Date().toISOString(),
          source: 'Direct Spotify Web API (Vercel Serverless)'
        });
      }
    }

    // 2. Fallback to recently played
    const recentRes = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (recentRes.ok) {
      const recentData = await recentRes.json();
      const track = recentData.items?.[0]?.track;
      if (track) {
        return res.status(200).json({
          isPlaying: false,
          recentlyPlayed: true,
          context: 'LAST PLAYED SONG',
          title: track.name,
          artist: track.artists ? track.artists.map((a) => a.name).join(', ') : 'Unknown Artist',
          album: track.album ? track.album.name : '',
          albumImageUrl: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
          songUrl: track.external_urls ? track.external_urls.spotify : null,
          playedAt: recentData.items?.[0]?.played_at,
          fetchedAt: new Date().toISOString(),
          source: 'Direct Spotify Web API (Recently Played)'
        });
      }
    }

    return res.status(200).json({
      isPlaying: false,
      message: 'No active or recently played playback found',
    });
  } catch (err) {
    console.error('Spotify API Error:', err);
    return res.status(500).json({
      error: err.message || 'Internal Spotify API error',
    });
  }
}
