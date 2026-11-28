# Going live: Supabase + Vercel (API)

Order: **1) Supabase project → 2) Vercel project for this repo (the API) → 3) check → 4) front-ends → 5) secrets for the buyer fingerprints**.
Never paste a key into a chat, an issue or the repo: keys live only in Vercel's environment variables.

## 1. Supabase
1. supabase.com → New project. Name, a strong database password (save it in a password manager), region **Frankfurt (eu-central-1)** (the API runs in Vercel's `fra1`, see `vercel.json`; if you pick Paris, change `regions` to `cdg1`).
2. Values needed (Project Settings):
   - **Project URL** and **anon key**, **service_role key** (Settings → API Keys / API). The service_role key is a secret: only in Vercel.
   - **JWT**: Supabase signs logins with a JWT secret or with signing keys (JWKS). If the project shows a "JWT Secret" copy it to `SUPABASE_JWT_SECRET`; if it uses the new signing keys, leave `SUPABASE_JWT_SECRET` empty (the API then verifies with the project's JWKS).
   - **Database connection strings** (Connect → "Transaction pooler" and "Session pooler"): replace `[YOUR-PASSWORD]` with the database password.
     `DATABASE_URL` = Transaction pooler (port 6543). `MIGRATIONS_DATABASE_URL` = Session pooler (port 5432).
3. Authentication → Providers → Email: keep it on. For customers, "Confirm email" can stay on or off (the storefront handles both).
4. No SQL to paste: the database tables are created by the API itself on every deploy (`npm run db:migrate`, see below).

## 2. Vercel (the API)
1. vercel.com → Add New → Project → import the GitHub repo **store-api** → Framework: it detects Hono. Root directory: the repo root.
2. Environment variables (Production), see `.env.example`:

| Variable | Value |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | from Supabase |
| `SUPABASE_JWT_SECRET` | only if Supabase gives one |
| `DATABASE_URL` | Transaction pooler string |
| `MIGRATIONS_DATABASE_URL` | Session pooler string |
| `WEB_ORIGIN`, `ADMIN_ORIGIN` | the https addresses of the storefront and the dashboard (comma separated for several). Set them once those exist. |
| `CRON_SECRET` | a long random value (16+ characters). Vercel sends it to the daily cleanup |
| `PUBLIC_API_URL` | the API's own https address (needed for card payments) |
| `R2_*`, `CHARGILY_*`, `YALIDINE_*` | later, when those accounts exist |
| `FINGERPRINT_SECRET` | **last step (section 5)** |
| `STOREFRONT_SECRET` | **last step (section 5)**, same value in store-web |

3. Deploy. The build runs `npm run build && npm run db:migrate`: it creates/updates the tables (remembered in `public.app_migrations`, so each file runs once). If a migration fails, the deploy fails and the previous version keeps running.
4. Open `https://<your-api>/health`: it must say `"databaseConnection":"ok"` (`not_configured` = `DATABASE_URL` is missing; `unreachable` = wrong string or password).

## 3. The first admin account
Supabase → Authentication → Users → Add user → email + password (tick "Auto Confirm User"). Then SQL Editor, run (your email):
```sql
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
 where email = 'you@example.com';
```
After that you can sign in to the dashboard and invite other admins from Settings.

## 4. Front-ends
store-web and store-admin: import each repo in Vercel, set `NEXT_PUBLIC_API_URL` = the API address and `NEXT_PUBLIC_USE_MOCK=false`. store-web also: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_IMAGE_HOST` (images), and `STOREFRONT_SECRET`.
Then put their addresses in the API's `WEB_ORIGIN` / `ADMIN_ORIGIN` and redeploy the API.

## 5. Buyer fingerprints (the "encryption" step)
- `FINGERPRINT_SECRET` (API only): 32+ random characters. **Set it once and never change it**, or old buyers are no longer recognised. Keep a copy in a password manager.
- `STOREFRONT_SECRET` (API **and** store-web, same value): 16+ random characters.
- Add a sentence about the fingerprints to the privacy policy (Pages & contact).

## Notes
- The daily cleanup (`/cron/cleanup`) runs at 03:00 UTC from `vercel.json`. Vercel's free plan allows daily crons.
- Local development does not need any of this: `npm run dev:local` runs everything in memory.
