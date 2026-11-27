# store-api — Server (API) of the clothing store

Online clothing store for the Algerian market. The system is split into **three independent repositories**, all in **TypeScript**:

| Repo | Role |
|---|---|
| `store-api` (this one) | Server: database, business rules, payments, delivery company, notifications |
| `store-web` | Customer storefront (Next.js) |
| `store-admin` | Admin dashboard (Next.js) |

The owner speaks Arabic — reply to him in Arabic. Code, comments and commit messages in English.

## How the three repos are connected (contract)
- **This API is the only part that touches Supabase (DB + Auth), Cloudflare R2 (images), Chargily and the delivery company.** `store-web` and `store-admin` talk to the database only through this API over HTTPS.
- The API publishes an **OpenAPI document at `/openapi.json`**. The two front-ends generate their TypeScript types from it (`openapi-typescript`). Never hand-write API types in the front-ends, so the three parts cannot drift apart.
- Auth: Supabase Auth issues the JWT; the API verifies it. Roles live in `app_metadata.role`: `customer` or `admin`. Everything under `/admin/*` requires `admin`.
- CORS: allow only the origins in `WEB_ORIGIN` and `ADMIN_ORIGIN` (env). Nothing else.
- **Keep API changes backward compatible** until both front-ends are updated. Record every breaking or new endpoint in `## API changelog` at the end of this file so the owner can open the other two repos and update them.

## Stack
- **TypeScript (strict)**, **Hono** + **@hono/zod-openapi** (routes validated with Zod, OpenAPI generated from the same schemas), deployed on **Vercel**.
- **Supabase**: Postgres and Auth. **Images: Cloudflare R2** (S3-compatible API via `aws4fetch`, public bucket/domain in `R2_PUBLIC_URL`). SQL migrations in `supabase/migrations/`. **Row Level Security on every table**, even though the API uses the service key.
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

## Everything editable (owner's rule)
Any content shown in the storefront must be editable from the admin dashboard. For every new storefront element: (1) a field/table here with RLS, (2) a public endpoint (and `/admin/*` endpoints to change it), (3) a screen in `store-admin`. Never leave editable content hard-coded in the front-ends. Record each addition in `## API changelog` so the other two repos follow.

## Owner journal (owner's rule)
After every piece of work, update `docs/PROJECT_STATUS.md` (Arabic, for the owner): what was done in plain words, the progress tables, decisions, what the owner must do, next tasks. In the chat reply, explain to the owner in Arabic what you did. The other repos point here; if a session cannot reach this repo, it adds the entry to its own `docs/WORK_LOG.md` and tells the owner.

## Rules
- Run `npm run build`, `npm run lint` and the tests before every push; fix all errors.
- Small, clear commits on `main` unless the owner asks for branches.
- Keep `## Progress` and `## API changelog` below up to date.

## Progress
- [x] Phase 1 — setup: Hono + zod-openapi, `/health`, `/openapi.json`, env validation (`src/env.ts`), Supabase admin client (`src/lib/supabase.ts`), CORS allow-list, unified error format, Vitest tests
- [x] Phase 2 — database (no Supabase project yet — written and tested locally with PGlite): `supabase/migrations/` (core schema + RLS on every table, 58 wilayas / 1541 communes), `supabase/seed.sql` (16 sample products), order functions `confirm_order` / `cancel_order` / `expire_pending_orders`, admin event trigger. See `supabase/README.md`.
- [x] Brands strip + offers/sale content in the database (`supabase/migrations/…_brands_offers.sql`): `brands.is_active/link_url`, `offers` table (label, title, subtitle, button, link, image, dark/light theme, countdown, schedule, active), settings `brands_strip` (enabled, animated, speed, pause_on_hover, title) and `sale_page` (enabled, title, subtitle)
- [x] Phase 3 — public endpoints (`/catalog/*`, `/shipping/*`), `POST /auth/login`, JWT admin guard, and `/admin/*` for brands, brands-strip, offers, site (announcement), sale-page, uploads. Data access = direct Postgres (`DATABASE_URL`) behind `Db` (`src/lib/db.ts`); tests run the real SQL on PGlite (`test/helpers/db.ts`); Supabase is used for Auth only; images are stored on Cloudflare R2 (`src/lib/storage.ts`, `src/lib/media.ts`).
- [x] Phase 4 (orders part, 2026-11-26) — `POST /orders/quote`, `POST /orders` (cash on delivery; prices, shipping, promo code and stock are computed/reserved on the server in one transaction; per-phone throttle), `GET /orders/{number}?token=` (customer view, never contains personal data), `GET /shipping/rules`; admin: `/admin/orders` (+ filters), `/admin/orders/{id}`, `/confirm` (tracking number, erases personal data), `/status` (shipped → delivered/returned, cancel restores stock), `/admin/stats/overview`, `/admin/events`. `Db.tx` for transactions. Migration `…_orders_public.sql` (`orders.public_token`).
- [x] Phase 4b (2026-11-29) — customer accounts: `POST /auth/register` (Supabase sign-up, role always `customer`), `/me` (profile), `/me/favorites` (+ merge, add, remove), `/me/orders` (history, no personal data); `POST /orders` links the order to the account when a valid Bearer token is sent (an invalid token never blocks checkout). `requireUser` guard in `src/lib/auth.ts`; profile row created on first use (`customers`).
- [x] Phase 5a (2026-11-27) — admin catalog: `/admin/products` (list/search/filters, create, edit with image + variant sync, delete, bulk publish), `/admin/categories` and `/admin/collections` (CRUD + move + product membership), `/admin/variants` + `/admin/variants/bulk` (inventory: price / compare-at / stock for many variants, all or nothing). Slugs are generated once from the French/English name (accents stripped) and never change. A published product needs ≥1 variant and ≥1 image.
- [x] Phase 5b (2026-11-27) — `/admin/shipping` (+ `PUT /admin/shipping/wilayas` bulk, `PUT /admin/shipping/rules` free-delivery threshold), `/admin/discount-codes` CRUD (usage counter kept), `/admin/slides` CRUD + move (hero slides; the storefront shows the first active one; a collection link or a custom URL). Migration `…_slides_created_at.sql`.
- [x] Phase 6 (2026-11-28) — payments + delivery + cleanup: `PaymentProvider` (`src/lib/payments/`, Chargily Pay v2 with signed webhook), `DeliveryProvider` (`src/lib/delivery/`, `manual` + `yalidine`; the active company is chosen from the dashboard and stored in `site_settings.delivery`), confirm sends the parcel itself then erases personal data, daily Vercel Cron `/cron/cleanup` (`vercel.json`, `CRON_SECRET`). Yalidine adapter is written from its public docs and tested against a fake server — **verify once with real keys**.
- [x] Home sections (2026-11-29) — editable "why us" (`site_settings.why_us`), category cards (`home_cards` table), newsletter block (`site_settings.newsletter`) + subscribers (`newsletter_subscribers`, admin-only). Migration `…_home_sections.sql`.
- [x] Shop filters (2026-11-29) — `GET /catalog/filters` (options + total for a search); list filters/sort were already in `GET /catalog/products`. Shared `listWhere()` keeps the list and the options consistent.
- [x] Information pages (2026-11-30) — `pages` table (terms, privacy, returns, shipping, cod; ar/fr/en drafts generated by `scripts/gen-legal.py`, `is_draft` flag shows the lawyer-review notice), `store_info` contact details; migration `…_pages.sql`.
- [x] Women's page (2026-12-01) — `products.audience` (women / men / unisex; the Women's page shows women + unisex), `site_settings.women_page` (enabled, title, subtitle, cover image). Migration `…_audience.sql`.
- [x] Men's page (2026-12-02) — `site_settings.men_page` (same shape as `women_page`); products choose with `audience`. Migration `…_men_page.sql`.

## API changelog
- **0.14.0 (SEO texts)** `GET /catalog/store-info` also returns `siteTitle` and `siteDescription` (nullable, localized: the shop's title/description for Google and social cards); `GET/PUT /admin/store-info` gain `siteTitle` / `siteDescription` (OptionalI18n, default empty). Additive. Front-ends: run `npm run gen:api`.
- **0.13.0 (Men's page)** New: `GET /catalog/men?locale` → `{enabled,title,subtitle,heroImage}`; admin: `GET/PUT /admin/men-page` `{enabled,title,subtitle,heroUrl}`. Products already carry `audience`, and `audience=men` already filters the list (unisex included). Additive. Front-ends: run `npm run gen:api`.
- **0.12.0 (menu)** New public: `GET /catalog/collections?locale` → `[{slug,title}]` (published collections in order, for menus). Additive. Front-ends: run `npm run gen:api`.
- **0.11.0 (Women's page)** New: `GET /catalog/women?locale` → `{enabled,title,subtitle,heroImage}`; `audience=women|men` filter on `GET /catalog/products` and `GET /catalog/filters` (unisex products are included in both). Admin (Bearer, role admin): `GET/PUT /admin/women-page` `{enabled,title,subtitle,heroUrl}`; products gain `audience: women|men|unisex` (in `AdminProduct`, `ProductInput` — default `unisex`, `AdminProductRow`; `GET /admin/products?audience=` filter); `POST /admin/products/audience` `{ids, audience}` (bulk). Additive. Front-ends: run `npm run gen:api`.
- **0.10.0 (information pages)** New public: `GET /catalog/pages` → `[{slug,title}]`, `GET /catalog/pages/{slug}` → `{slug,title,body,isDraft,draftNotice,updatedAt}` (body = text with `## heading`, `- item`, `**bold**`; 404 if unpublished), `GET /catalog/store-info` → `{phone,email,address,hours,whatsappUrl}` (nullable). Admin (Bearer, role admin): `GET /admin/pages`, `PUT /admin/pages/{slug}` `{title,body,isPublished,isDraft}`, `GET/PUT /admin/store-info` `{phone,whatsapp,email,address,hours}`. Additive. Front-ends: run `npm run gen:api`.
- **0.9.0 (shop filters)** New: `GET /catalog/filters?locale&q&category&size&color&minPrice&maxPrice` → `{ total, categories:[{slug,name,count}], sizes[], colors[], priceRange:{min,max}|null }` (category options ignore the chosen category; size/color/price options ignore their own filter). `GET /catalog/products` unchanged. Additive. Front-ends: run `npm run gen:api`.
- **0.8.0 (home sections)** `GET /catalog/home` now also returns `whyUs` ({title, items:[{icon,title,text}]} or null), `categoryCards` ([{id,title,subtitle,image,href}]) and `newsletter` ({title,subtitle,button} or null). New: `POST /newsletter` `{email}` (always 200 for a valid email); admin (Bearer, role admin): `GET/PUT /admin/why-us` `{enabled,title,items[≤8]:{icon: truck|shield|refresh|headset|card|gift|star|heart, title, text}}`, `GET/POST /admin/home-cards`, `PUT/DELETE /admin/home-cards/{id}`, `POST /admin/home-cards/{id}/move`, `GET/PUT /admin/newsletter` `{enabled,title,subtitle,button}`, `GET /admin/newsletter/subscribers`, `DELETE /admin/newsletter/subscribers/{id}`. Additive. Front-ends: run `npm run gen:api`.
- **0.7.0 (phase 4b, accounts)** New: `POST /auth/register` `{email, password (≥8), name?}` → `{confirmationRequired, session: LoginResult|null}` (409 `email_taken`, 422 weak password); Bearer (any signed-in user): `GET/PUT /me` `{name, phone}`, `GET /me/favorites?locale=` → `{ids, products}`, `POST /me/favorites/merge` `{productIds}`, `PUT/DELETE /me/favorites/{productId}`, `GET /me/orders` → `[{orderNumber, token, status, paymentMethod, paymentStatus, total, itemCount, createdAt}]`. `POST /orders` accepts an optional `Authorization: Bearer` to attach the order to the account. Backward compatible. Front-ends: run `npm run gen:api`.
- **0.6.0 (phase 6)** New: `GET /payments/methods` → `{cod: true, card: boolean}`; `POST /orders` accepts `paymentMethod: "chargily"` (+ optional `locale`) and now returns `checkoutUrl` (null for cash on delivery) — redirect the customer there; `POST /webhooks/chargily` (Chargily only, signature checked); `GET /cron/cleanup` (Vercel Cron, `Authorization: Bearer CRON_SECRET`); admin (Bearer, role admin): `GET/PUT /admin/delivery` `{provider}` (list of companies with `configured`), `POST /admin/orders/{id}/refresh-tracking`. **Changed (backward compatible):** `POST /admin/orders/{id}/confirm` — `trackingNumber` is now optional: with a delivery company selected and configured the server creates the parcel and stores the tracking number itself (502 `delivery_failed` if the company refuses; the order stays pending). Env: `CHARGILY_SECRET_KEY`, `CHARGILY_MODE`, `PUBLIC_API_URL`, `YALIDINE_API_ID`, `YALIDINE_API_TOKEN`, `DELIVERY_FROM_WILAYA`, `CRON_SECRET`. Front-ends: run `npm run gen:api`.
- **0.5.0 (phase 5b, store settings)** New (Bearer, role admin): `GET /admin/shipping`, `PUT /admin/shipping/wilayas` `{updates:[{code, homeFee?, deskFee?, active?}]}`, `PUT /admin/shipping/rules` `{freeShippingOver: number|null}`, `GET/POST /admin/discount-codes`, `PUT/DELETE /admin/discount-codes/{id}`, `GET/POST /admin/slides`, `PUT/DELETE /admin/slides/{id}`, `POST /admin/slides/{id}/move`. A wilaya switched off disappears from checkout; new fees and thresholds apply to orders immediately. Front-ends: run `npm run gen:api`.
- **0.4.0 (phase 5a, catalog admin)** New (Bearer, role admin): `GET/POST /admin/products`, `GET/PUT/DELETE /admin/products/{id}` (PUT synchronises `images: string[]` and `variants` — send existing variant `id`s to keep them), `POST /admin/products/publish`, `GET/POST /admin/categories`, `PUT/DELETE /admin/categories/{id}`, `POST /admin/categories/{id}/move`, `GET/POST /admin/collections`, `PUT/DELETE /admin/collections/{id}`, `POST /admin/collections/{id}/move`, `GET /admin/variants`, `POST /admin/variants/bulk`. Deleting a category that still has products → 409. Front-ends: run `npm run gen:api`.
- **0.3.0 (phase 4, orders)** New: `POST /orders/quote`, `POST /orders`, `GET /orders/{orderNumber}?token=`, `GET /shipping/rules`; admin (Bearer, role admin): `GET /admin/orders`, `GET /admin/orders/{id}`, `POST /admin/orders/{id}/confirm` `{company?, trackingNumber}`, `POST /admin/orders/{id}/status` `{status}`, `GET /admin/stats/overview`, `GET /admin/events`, `POST /admin/events/read`. The storefront sends only variant ids and quantities; totals always come from the server. Only `paymentMethod: "cod"` is accepted until Chargily is added. Front-ends: run `npm run gen:api`.
- **0.2.0 (phase 3)** New endpoints: `GET /catalog/{site,home,collections/{slug},products,products/{slug},products/{slug}/related,sale,categories,brands}`, `GET /shipping/wilayas`, `GET /shipping/wilayas/{code}/communes`, `POST /auth/login`, and `/admin/{brands,brands/{id},brands/{id}/move,brands-strip,offers,offers/{id},site,sale-page,uploads}` (Bearer token, role admin). `GET /catalog/home` returns `hero` (nullable, with `href`), `looks`, `rows`, `brands`, `brandsStrip`, `offers`, `announcement`. Env: new `SUPABASE_JWT_SECRET`, `DATABASE_URL`, and the R2 image settings `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`. `POST /admin/uploads` accepts PNG/JPEG/WebP/GIF only (the real file content is checked; **SVG is refused**), stores on Cloudflare R2 and returns `{ url }` (an `R2_PUBLIC_URL` link); the front-ends must allow that host in `next/image` (`remotePatterns`). Front-ends: run `npm run gen:api` and replace the temporary mock types.
- (was planned) Home content gains `brands[]`, `brandsStrip{enabled,animated,speed,pause_on_hover,title}`, `offers[]`; new `GET /catalog/sale` (products with a compare-at price above the price) and `/admin/brands`, `/admin/brands-strip`, `/admin/offers` (CRUD). Storefront and dashboard already use these shapes on mock data.
- (no endpoint changes in phase 2) Database schema defined in `supabase/migrations/`. **Shipping fees in the geo migration are placeholders** — the owner must set the real rates (admin dashboard, phase 4/5).
- 0.1.0 — `GET /health`, `GET /openapi.json`. Error format: `{ error: { code, message, details? } }`. Front-ends can now run `npm run gen:api`.
