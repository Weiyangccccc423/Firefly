# Firefly Admin API

The admin API runs in a Node 22 Docker container on the ECS host at
`127.0.0.1:4322`. Nginx exposes it only under `/admin-api/`.

It provides:

- GitHub OAuth restricted to `ADMIN_GITHUB_USER`.
- Markdown file CRUD through the GitHub Contents API.
- `src/config/adminOverrides.json` feature-toggle commits.
- GitHub Actions deployment status and manual dispatch.
- Optional Umami statistics proxy.

Required OAuth callback URL:

```text
https://wiyac5.xyz/admin-api/auth/callback
```

Copy `.env.admin.example` to a server-only environment file. Never put the
GitHub client secret, OAuth token, session secret, or Umami API token in the
static site or browser bundle.
