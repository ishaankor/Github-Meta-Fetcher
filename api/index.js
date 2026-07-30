export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    name: 'GitHub Meta Fetcher Vercel Server',
    status: 'online',
    username: process.env.GITHUB_USERNAME || 'ishaankor',
    endpoints: {
      githubData: '/api/github'
    },
    documentation: 'https://github.com/ishaankor/Github-Meta-Fetcher'
  });
}
