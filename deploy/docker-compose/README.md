# OSH GitHub Manager Docker Compose

1. Copy `.env.example` to `.env`.
2. Create a GitHub OAuth App with callback URL:

```text
http://43.242.200.25:4173/auth/github/callback
```

3. Fill `GITHUB_TOKEN`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `SESSION_SECRET`.
4. Start:

```bash
docker compose up -d --build
```
