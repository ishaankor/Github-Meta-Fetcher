# GitHub Meta Fetcher (Vercel App Server) 🚀

A high-performance, CORS-enabled Vercel Serverless Backend API designed to stream live GitHub user profile data, public repository matrices, and recent commits across projects for `@ishaankor`.

---

## 🌟 Key Features

1. **Authenticated GitHub API Proxy**:
   - Uses your personal access token (`GITHUB_TOKEN`) on the server to unlock **5,000 requests/hour** (instead of 60 req/hr unauthenticated client limits).

2. **1-Minute Server In-Memory Cache**:
   - Implements a 60-second in-memory cache TTL (`CACHE_DURATION_MS = 60 * 1000`).
   - Even under heavy traffic, the server makes a **maximum of 60 calls per hour** to GitHub REST API (**1.2% of your quota**).

3. **CORS Ready**:
   - Out-of-the-box `Access-Control-Allow-Origin: *` headers for seamless integration with `https://portfolio.ishaankoradia.com` or custom domains.

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

---

## 📡 API Endpoints

### 1. Health Status
`GET /` or `GET /api`
```json
{
  "name": "GitHub Meta Fetcher Vercel Server",
  "status": "online",
  "username": "ishaankor",
  "endpoints": {
    "githubData": "/api/github"
  }
}
```

### 2. Live GitHub Metadata & Commits
`GET /api/github`
Returns profile summary (`user`), repository array (`repos`), and the 5 most recent commits across repositories (`commits`).
