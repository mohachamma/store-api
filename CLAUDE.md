# store-api — Server (API) of the clothing store

Online clothing store for the Algerian market. The system is split into **three independent repositories**, all in **TypeScript**:

| Repo | Role |
|---|---|
| `store-api` (this one) | Server: database, business rules, payments, delivery company, notifications |
| `store-web` | Customer storefront (Next.js) |
| `store-admin` | Admin dashboard (Next.js) |

The owner speaks Arabic — reply to him in Arabic. Code, comments and commit messages in English.

## How the three repos are connected (contract)
- **This API is the only part that touches Supabase (DB + Storage with the service key), Chargily and the delivery company.** `store-web` and `store-admin` talk to the database only through this API over HTTPS.
- The API publishes an **OpenAPI document at `/openapi.json`**. The two front-ends generate their TypeScript types from it (`openapi-typescript`). Never hand-write API types in the front-ends, so the three parts cannot drift apart.
- Auth: Supabase Auth issues the JWT; the API verifies it. Roles live in `app_metadata.role`: `customer` or `admin`. Everything under `/admin/*` requires `admin`.
- CORS: allow only the origins in `WEB_ORIGIN` and `ADMIN_ORIGIN` (env). Nothing else.
- **Keep API changes backward compatible** until both front-ends are updated. Record every breaking or new endpoint in `## API changelog` at the end of this file so the owner can open the other two repos and update them.

## Stack
- **TypeScript (strict)**, **Hono** + **@hono/zod-openapi** (routes validated with Zod, OpenAPI generated from the same schemas), deployed on **Vercel**.
- **Supabase**: Postgres, Auth, Storage (product images). SQL migrations in `supabase/migrations/`. **Row Level Security on every table**, even though the API uses the service key.
- Money: integers in DZD (no decimals). Never trust prices from the client — recompute totals on the server.
- Secrets only in environment variables. Provide `.env.example`. Never commit keys.
- Scheduled jobs with **Vercel Cron** (cleanup of old data).

## Domain
- Products, variants (size, color, stock, price, compare-at price), images, categories, collections, brands, hero slides/banners, discount codes.
- Orders: statuses `pending → confirmed → shipped → delivered / cancelled / returned`.
- Shipping: fee per wilaya (58 wilayas + communes data), delivery type home / desk.
- Customers: optional accounts (order history), favorites.

## Payments
- **Cash on delivery** (default) and **CIB / Edahabia via Chargily Pay v2** (`@chargily/chargily-pay`), with webhook signature verification to confirm payment.
- **No Stripe** (Stripe does not support Algerian businesses).
- Put payments behind a `PaymentProvider` interface so another provider can be added later.

## Delivery company (privacy-minimal design)
- `src/lib/delivery/` with a common interface (`createParcel`, `getTracking`, `cancelParcel`) and one adapter per company. Start with **Yalidine** — ask the owner which company he uses and for the API keys when this phase starts.
- The delivery company's dashboard already stores parcels and customer details. Do not duplicate it.
- Customer name, phone, wilaya, commune and address are kept in our DB **only until the admin confirms the order** (the owner phones the customer first). On confirmation: send them directly to the delivery company's API, store only the returned **tracking number + status**, then **delete** the personal fields from our DB.
- After confirmation we keep only: order number, items, totals, payment method/status, wilaya, tracking number, status. No name, phone or address.
- The admin can open the parcel in the delivery company's dashboard by tracking number (or the API fetches it on demand). **Never log personal data.**

## Notifications
- `notify()` function with swappable channels. New order → in-app event for the admin dashboard (Supabase Realtime). WhatsApp comes later: first just a `wa.me` link in the admin, then optionally WhatsApp Business Cloud API.

## Build order (commit after each phase)
1. Setup: Hono + zod-openapi, `/health`, `/openapi.json`, Supabase client, env validation, CORS, error format.
2. Database: migrations, RLS, wilayas/communes data, seed with sample products (placeholder images).
3. Public endpoints: catalog (list/filter/sort/search), product detail, categories, brands, home content, shipping fees.
4. Orders + cash on delivery, customer accounts, favorites.
5. Admin endpoints: products/variants/images upload, categories, orders + status, stats, shipping fees, discount codes, slides.
6. Chargily payments + delivery company integration + cleanup cron.
7. Polish: tests for price/stock/order logic, rate limiting, logging without personal data.

## Things the owner must do himself (ask him step by step, when a phase needs it)
- Create a **Supabase** project and give the URL + keys (put them in Vercel env, never in the repo).
- Connect this repo to **Vercel** once.
- Create a **Chargily Pay** account (test keys first, live keys at launch).
- Give the **delivery company** API keys.

## Rules
- Run `npm run build`, `npm run lint` and the tests before every push; fix all errors.
- Small, clear commits on `main` unless the owner asks for branches.
- Keep `## Progress` and `## API changelog` below up to date.

## Progress
- [x] Phase 1 — setup: Hono + zod-openapi, `/health`, `/openapi.json`, env validation (`src/env.ts`), Supabase admin client (`src/lib/supabase.ts`), CORS allow-list, unified error format, Vitest tests
- [ ] Phase 2 — database

## API changelog
- 0.1.0 — `GET /health`, `GET /openapi.json`. Error format: `{ error: { code, message, details? } }`. Front-ends can now run `npm run gen:api`.
