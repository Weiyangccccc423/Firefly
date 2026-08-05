# Firefly Admin API

The admin API runs in a Node 22 Docker container on the ECS host at
`127.0.0.1:4322`. Nginx exposes it only under `/admin-api/`.

It provides:

- GitHub OAuth restricted to `ADMIN_GITHUB_USER`.
- Markdown file CRUD through the GitHub Contents API.
- `src/config/adminOverrides.json` feature-toggle commits.
- Allowlisted site-config forms with validation and SHA conflict checks.
- Structured music-player settings backed by `src/config/musicSettings.json`.
- GitHub Actions deployment status and manual dispatch.
- Optional Umami statistics proxy.
- Optional OpenAI-compatible Markdown rewriting with explicit human approval.

Required OAuth callback URL:

```text
https://wiyac5.xyz/admin-api/auth/callback
```

Copy `.env.admin.example` to a server-only environment file. Never put the
GitHub client secret, OAuth token, session secret, AI API key, or Umami API
token in the static site or browser bundle.

The AI endpoint is authenticated, separately rate-limited, and has no tools or
repository write access. It returns a suggestion only; applying and saving are
separate administrator actions.

Configuration access is limited to the registry in `config-files.mjs`. The API
never accepts a repository path from the browser. It parses TypeScript with the
compiler AST and returns a field tree without source text or computed
expressions. Saves accept only typed `{ path, value }` updates, then preserve
the surrounding source, reparse it, and run the existing file validators. JSON
files are parsed and schema-checked, and Footer HTML rejects active content.
Updates require the latest GitHub blob SHA, so stale browser sessions cannot
silently overwrite newer changes.

Run the focused validation suite with:

```sh
pnpm test:admin
```

Build the dependency-free Node 22 deployment artifact with:

```sh
pnpm build:admin-api
```

Upload `admin-api/dist/server.cjs` to `/opt/firefly-admin/server.cjs`. The
systemd unit mounts this CommonJS bundle read-only into the Node container;
production does not install npm packages at runtime. CommonJS is intentional:
the TypeScript compiler used for the field tree loads Node modules dynamically.
