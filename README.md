# Personal Meta Fetcher (Vercel App Server) 🚀

A high-performance, CORS-enabled Vercel Serverless Backend API designed to stream live GitHub user profile activity and real-time Spotify music playback telemetry for `@ishaankor`.

---

## 🌟 Key Features

1. **Authenticated GitHub API Proxy**:
   - Uses personal access token (`GITHUB_TOKEN`) on the server to unlock **5,000 requests/hour** (instead of 60 req/hr unauthenticated client limits).
   - In-memory cache TTL for optimal performance and rate-limit resilience.

2. **Real-Time Spotify Playback Telemetry**:
   - Secure serverless token refresh with Spotify Web API OAuth (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`).
   - Serves currently playing song, artist, album art, duration/progress, and recently played fallback without exposing secrets to client browsers.

3. **CORS Ready**:
   - Out-of-the-box `Access-Control-Allow-Origin: *` headers for seamless integration with `https://ishaankoradia.com`, `https://portfolio.ishaankoradia.com`, and custom domains.

---

## ⚡ Deployment to Vercel

### Step 1: Deploy with Vercel CLI or Web Console
Push this repository to GitHub or run:
```bash
npx vercel
```

### Step 2: Set Environment Variables in Vercel Dashboard
Add the following in your **Vercel Project Settings -> Environment Variables**:

| Variable Name | Description | Example Value |
|---|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token | `ghp_...` |
| `GITHUB_USERNAME` | Target GitHub Username | `ishaankor` |
| `SPOTIFY_CLIENT_ID` | Spotify Web API App Client ID | `0aa52...` |
| `SPOTIFY_CLIENT_SECRET` | Spotify Web API App Client Secret | `01768...` |
| `SPOTIFY_REFRESH_TOKEN` | Spotify Web API Refresh Token | `AQB47...` |

---

## 📡 API Endpoints

### 1. Health Status
`GET /` or `GET /api`
```json
{
  "name": "Personal Meta Fetcher Vercel Server",
  "status": "online",
  "username": "ishaankor",
  "endpoints": {
    "githubData": "/api/github",
    "spotifyData": "/api/spotify"
  }
}
```

### 2. Live GitHub Metadata & Commits
`GET /api/github`
Returns profile summary (`user`), repository array (`repos`), and recent commits across repositories (`commits`).

### 3. Live Spotify Telemetry
`GET /api/spotify`
Returns real-time playback state (`isPlaying`, `title`, `artist`, `album`, `albumImageUrl`, `songUrl`).
