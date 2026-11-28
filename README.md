# store-api

Server for the store: Hono + `@hono/zod-openapi` on Vercel, Supabase (DB, Auth, Storage).

## Develop

```bash
cp .env.example .env   # fill values locally, never commit them
npm install
npm run dev            # http://localhost:8787/health and /openapi.json
```

| Script | What it does |
|---|---|
| `npm run dev` | Local server with reload |
| `npm run build` | Type-check and compile to `dist/` |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run openapi:dump` | Write `openapi.json` locally |

## Contract
- `GET /openapi.json` is the source of truth for `store-web` and `store-admin` types (`npm run gen:api` there).
- Errors always look like `{ "error": { "code": "not_found", "message": "…", "details"?: … } }`.
- CORS allows only `WEB_ORIGIN` and `ADMIN_ORIGIN` (comma-separated lists).

## Deploy
Vercel detects the Hono app from `src/index.ts`. Set the variables from `.env.example` in the Vercel project.

## Going live
See [docs/DEPLOY.md](docs/DEPLOY.md) (Supabase, Vercel, first admin, secrets).
