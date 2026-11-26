import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../lib/db.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { full, I18nSchema, OptionalI18nSchema, toJson } from "../lib/i18n.js";
import { WHY_ICONS, getSetting } from "../lib/catalog.js";
import { imageUrl, toStoredPath } from "../lib/media.js";
import { moveRow } from "../lib/reorder.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const Id = z.object({ id: z.string().uuid() });
const Href = z.string().max(500).regex(/^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/, "Must be a path starting with / or an https URL").nullable();
const iso = (v: unknown) => new Date(v as string | number | Date).toISOString();

const upsertSetting = (db: Db, key: string, value: unknown) =>
  db.query(`insert into public.site_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);

/** Arabic is required whenever another language is filled (the database requires an Arabic text). */
const needsArabic = (v: { ar: string; fr: string; en: string }) => !v.ar.trim() && !!(v.fr.trim() || v.en.trim());
const compact = (v: { ar: string; fr: string; en: string }) => JSON.parse(toJson(v) ?? "{}") as Record<string, string>;

export const adminHomeRoutes = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// "Why us"
// ---------------------------------------------------------------------------
const WhyItem = z.object({ icon: z.enum(WHY_ICONS), title: I18nSchema, text: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }) });
const WhyUs = z
  .object({ enabled: z.boolean(), title: I18nSchema, items: z.array(WhyItem).max(8) })
  .superRefine((o, ctx) => o.items.forEach((i, k) => { if (needsArabic(i.text)) ctx.addIssue({ code: "custom", path: ["items", k, "text", "ar"], message: "Arabic text is required when another language is filled" }); }))
  .openapi("AdminWhyUs");

adminHomeRoutes.openapi(
  createRoute({ method: "get", path: "/admin/why-us", tags: ["Admin"], security, summary: "The \"why us\" features of the home page", responses: { 200: json(WhyUs, "OK"), ...errors } }),
  async (c) => {
    const v = (await getSetting(c.get("db"), "why_us")) as { enabled?: boolean; title?: unknown; items?: { icon: (typeof WHY_ICONS)[number]; title: unknown; text: unknown }[] } | null;
    return c.json({ enabled: v?.enabled ?? false, title: full(v?.title), items: (v?.items ?? []).map((i) => ({ icon: i.icon, title: full(i.title), text: full(i.text) })) }, 200);
  },
);
adminHomeRoutes.openapi(
  createRoute({ method: "put", path: "/admin/why-us", tags: ["Admin"], security, summary: "Save the \"why us\" features (up to 8)", request: { body: body(WhyUs) }, responses: { 200: json(Ok, "Saved"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    await upsertSetting(c.get("db"), "why_us", { enabled: b.enabled, title: compact(b.title), items: b.items.map((i) => ({ icon: i.icon, title: compact(i.title), text: compact(i.text) })) });
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Category cards
// ---------------------------------------------------------------------------
const AdminCard = z
  .object({ id: z.string().uuid(), title: I18nSchema, subtitle: OptionalI18nSchema, imageUrl: z.string(), href: z.string().nullable(), isActive: z.boolean() })
  .openapi("AdminHomeCard");
const CardInput = z
  .object({
    title: I18nSchema,
    subtitle: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    imageUrl: z.string().min(1).max(1000).refine((v) => !v.startsWith("data:"), "Inline images are not allowed; upload the file"),
    href: Href.default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((o, ctx) => { if (needsArabic(o.subtitle)) ctx.addIssue({ code: "custom", path: ["subtitle", "ar"], message: "Arabic text is required when another language is filled" }); })
  .openapi("HomeCardInput");
type CardRow = { id: string; title: unknown; subtitle: unknown; image_path: string; link_url: string | null; is_active: boolean };
const cardOut = (r: CardRow) => ({ id: r.id, title: full(r.title), subtitle: full(r.subtitle), imageUrl: imageUrl(r.image_path)!, href: r.link_url, isActive: r.is_active });
const COLS = "id, title, subtitle, image_path, link_url, is_active";

adminHomeRoutes.openapi(
  createRoute({ method: "get", path: "/admin/home-cards", tags: ["Admin"], security, summary: "Category cards of the home page, in display order", responses: { 200: json(z.array(AdminCard), "OK"), ...errors } }),
  async (c) => c.json((await c.get("db").query<CardRow>(`select ${COLS} from public.home_cards order by sort_order, created_at, id`)).map(cardOut), 200),
);
adminHomeRoutes.openapi(
  createRoute({ method: "post", path: "/admin/home-cards", tags: ["Admin"], security, summary: "Add a category card (goes last)", request: { body: body(CardInput) }, responses: { 200: json(AdminCard, "Created"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    const rows = await c.get("db").query<CardRow>(
      `insert into public.home_cards (title, subtitle, image_path, link_url, is_active, sort_order)
       values ($1::jsonb, $2::jsonb, $3, $4, $5, (select coalesce(max(sort_order), 0) + 1 from public.home_cards)) returning ${COLS}`,
      [toJson(b.title), toJson(b.subtitle), toStoredPath(b.imageUrl), b.href, b.isActive],
    );
    return c.json(cardOut(rows[0]!), 200);
  },
);
adminHomeRoutes.openapi(
  createRoute({ method: "put", path: "/admin/home-cards/{id}", tags: ["Admin"], security, summary: "Edit a category card", request: { params: Id, body: body(CardInput) }, responses: { 200: json(AdminCard, "Updated"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    const rows = await c.get("db").query<CardRow>(
      `update public.home_cards set title = $2::jsonb, subtitle = $3::jsonb, image_path = $4, link_url = $5, is_active = $6 where id = $1 returning ${COLS}`,
      [c.req.valid("param").id, toJson(b.title), toJson(b.subtitle), toStoredPath(b.imageUrl), b.href, b.isActive],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "Card not found");
    return c.json(cardOut(rows[0]), 200);
  },
);
adminHomeRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/home-cards/{id}", tags: ["Admin"], security, summary: "Delete a category card", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    if (!(await c.get("db").query(`delete from public.home_cards where id = $1 returning id`, [c.req.valid("param").id])).length) throw new ApiError(404, "not_found", "Card not found");
    return c.json({ ok: true as const }, 200);
  },
);
adminHomeRoutes.openapi(
  createRoute({ method: "post", path: "/admin/home-cards/{id}/move", tags: ["Admin"], security, summary: "Move a card one step earlier (-1) or later (1)", request: { params: Id, body: body(z.object({ direction: z.union([z.literal(-1), z.literal(1)]) })) }, responses: { 200: json(Ok, "Moved"), ...errors } }),
  async (c) => {
    await c.get("db").tx((q) => moveRow(q, "home_cards", c.req.valid("param").id, c.req.valid("json").direction));
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Newsletter: block settings + subscribers
// ---------------------------------------------------------------------------
const NewsletterSettings = z.object({ enabled: z.boolean(), title: I18nSchema, subtitle: OptionalI18nSchema, button: I18nSchema })
  .superRefine((o, ctx) => { if (needsArabic(o.subtitle)) ctx.addIssue({ code: "custom", path: ["subtitle", "ar"], message: "Arabic text is required when another language is filled" }); })
  .openapi("AdminNewsletter");
const Subscribers = z.object({ total: z.number().int(), items: z.array(z.object({ id: z.string().uuid(), email: z.string(), createdAt: z.string() })) }).openapi("NewsletterSubscribers");

adminHomeRoutes.openapi(
  createRoute({ method: "get", path: "/admin/newsletter", tags: ["Admin"], security, summary: "Newsletter block texts and visibility", responses: { 200: json(NewsletterSettings, "OK"), ...errors } }),
  async (c) => {
    const v = (await getSetting(c.get("db"), "newsletter")) as { enabled?: boolean; title?: unknown; subtitle?: unknown; button?: unknown } | null;
    return c.json({ enabled: v?.enabled ?? false, title: full(v?.title), subtitle: full(v?.subtitle), button: full(v?.button) }, 200);
  },
);
adminHomeRoutes.openapi(
  createRoute({ method: "put", path: "/admin/newsletter", tags: ["Admin"], security, summary: "Save the newsletter block", request: { body: body(NewsletterSettings) }, responses: { 200: json(Ok, "Saved"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    await upsertSetting(c.get("db"), "newsletter", { enabled: b.enabled, title: compact(b.title), subtitle: compact(b.subtitle), button: compact(b.button) });
    return c.json({ ok: true as const }, 200);
  },
);
adminHomeRoutes.openapi(
  createRoute({ method: "get", path: "/admin/newsletter/subscribers", tags: ["Admin"], security, summary: "Emails collected by the newsletter (newest first, up to 500)", responses: { 200: json(Subscribers, "OK"), ...errors } }),
  async (c) => {
    const db = c.get("db");
    const [rows, n] = await Promise.all([
      db.query<{ id: string; email: string; created_at: unknown }>(`select id, email, created_at from public.newsletter_subscribers order by created_at desc, id limit 500`),
      db.query<{ n: number }>(`select count(*)::int as n from public.newsletter_subscribers`),
    ]);
    return c.json({ total: Number(n[0]?.n ?? 0), items: rows.map((r) => ({ id: r.id, email: r.email, createdAt: iso(r.created_at) })) }, 200);
  },
);
adminHomeRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/newsletter/subscribers/{id}", tags: ["Admin"], security, summary: "Remove a subscriber (e.g. on request)", request: { params: Id }, responses: { 200: json(Ok, "Removed"), ...errors } }),
  async (c) => {
    if (!(await c.get("db").query(`delete from public.newsletter_subscribers where id = $1 returning id`, [c.req.valid("param").id])).length) throw new ApiError(404, "not_found", "Subscriber not found");
    return c.json({ ok: true as const }, 200);
  },
);
