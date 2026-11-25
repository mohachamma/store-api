import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import type { Db } from "../lib/db.js";
import { getSetting, DEFAULT_SALE, DEFAULT_STRIP } from "../lib/catalog.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { full, I18nSchema, OptionalI18nSchema, toJson } from "../lib/i18n.js";
import { imageUrl, toStoredPath } from "../lib/media.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const Id = z.object({ id: z.string().uuid() });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];

/** Link target: a path on the storefront ("/sale") or an https URL. Never "javascript:" etc. */
const Href = z
  .string()
  .max(500)
  .regex(/^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/, "Must be a path starting with / or an https URL")
  .nullable();
/** Image: an R2 key/URL, a storefront placeholder path, or null (inline data: URLs are refused). */
const ImageRef = z.string().max(1000).refine((v) => !v.startsWith("data:"), "Inline images are not allowed; upload the file").nullable();

const upsertSetting = (db: Db, key: string, value: unknown) =>
  db.query(
    `insert into public.site_settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );

export const adminRoutes = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------
const AdminBrand = z
  .object({ id: z.string().uuid(), name: z.string(), logoUrl: z.string().nullable(), href: z.string().nullable(), isActive: z.boolean() })
  .openapi("AdminBrand");
const BrandInput = z
  .object({ name: z.string().trim().min(1).max(80), logoUrl: ImageRef.default(null), href: Href.default(null), isActive: z.boolean().default(true) })
  .openapi("BrandInput");

type BrandRow = { id: string; name: string; logo_path: string | null; link_url: string | null; is_active: boolean };
const brandOut = (b: BrandRow) => ({ id: b.id, name: b.name, logoUrl: imageUrl(b.logo_path), href: b.link_url, isActive: b.is_active });
const BRAND_COLS = "id, name, logo_path, link_url, is_active";

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "brand";

adminRoutes.openapi(
  createRoute({ method: "get", path: "/admin/brands", tags: ["Admin"], security, summary: "All brands (including hidden), in display order", responses: { 200: json(z.array(AdminBrand), "OK"), ...errors } }),
  async (c) => {
    const rows = await c.get("db").query<BrandRow>(`select ${BRAND_COLS} from public.brands order by sort_order, created_at, id`);
    return c.json(rows.map(brandOut), 200);
  },
);

adminRoutes.openapi(
  createRoute({ method: "post", path: "/admin/brands", tags: ["Admin"], security, summary: "Add a brand (appended at the end)", request: { body: body(BrandInput) }, responses: { 200: json(AdminBrand, "Created"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    const rows = await c.get("db").query<BrandRow>(
      `insert into public.brands (slug, name, logo_path, link_url, is_active, sort_order)
       values ($1 || '-' || substr(gen_random_uuid()::text, 1, 6), $2, $3, $4, $5, coalesce((select max(sort_order) + 1 from public.brands), 0))
       returning ${BRAND_COLS}`,
      [slugify(b.name), b.name, toStoredPath(b.logoUrl), b.href, b.isActive],
    );
    return c.json(brandOut(rows[0]!), 200);
  },
);

adminRoutes.openapi(
  createRoute({ method: "put", path: "/admin/brands/{id}", tags: ["Admin"], security, summary: "Edit a brand", request: { params: Id, body: body(BrandInput) }, responses: { 200: json(AdminBrand, "Updated"), ...errors } }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const rows = await c.get("db").query<BrandRow>(
      `update public.brands set name = $2, logo_path = $3, link_url = $4, is_active = $5 where id = $1 returning ${BRAND_COLS}`,
      [id, b.name, toStoredPath(b.logoUrl), b.href, b.isActive],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "Brand not found");
    return c.json(brandOut(rows[0]), 200);
  },
);

adminRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/brands/{id}", tags: ["Admin"], security, summary: "Delete a brand (products keep existing without a brand)", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const rows = await c.get("db").query(`delete from public.brands where id = $1 returning id`, [c.req.valid("param").id]);
    if (!rows.length) throw new ApiError(404, "not_found", "Brand not found");
    return c.json({ ok: true as const }, 200);
  },
);

adminRoutes.openapi(
  createRoute({
    method: "post",
    path: "/admin/brands/{id}/move",
    tags: ["Admin"],
    security,
    summary: "Move a brand one step earlier (-1) or later (+1) in the strip",
    request: { params: Id, body: body(z.object({ direction: z.union([z.literal(-1), z.literal(1)]) })) },
    responses: { 200: json(Ok, "Moved"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { direction } = c.req.valid("json");
    const db = c.get("db");
    if (!(await db.query(`select 1 from public.brands where id = $1`, [id])).length) throw new ApiError(404, "not_found", "Brand not found");
    // Renumber 1..n, then swap the brand with its neighbour (no-op at the ends).
    await db.query(
      `with ordered as (select id, row_number() over (order by sort_order, created_at, id)::int as rn from public.brands),
            me as (select rn from ordered where id = $1),
            tgt as (select o.id from ordered o, me where o.rn = me.rn + $2::int)
       update public.brands b
          set sort_order = case
                when b.id = $1 and exists (select 1 from tgt) then o.rn + $2::int
                when b.id = (select id from tgt) then (select rn from me)
                else o.rn end
         from ordered o where o.id = b.id`,
      [id, direction],
    );
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Brands strip settings
// ---------------------------------------------------------------------------
const StripSettings = z
  .object({ enabled: z.boolean(), animated: z.boolean(), speed: z.number().int().min(5).max(120), pauseOnHover: z.boolean(), title: I18nSchema })
  .openapi("BrandsStripSettings");

const readStrip = async (db: Db) => {
  const s = { ...DEFAULT_STRIP, ...((await getSetting(db, "brands_strip")) ?? {}) } as typeof DEFAULT_STRIP;
  return { enabled: Boolean(s.enabled), animated: Boolean(s.animated), speed: Math.min(120, Math.max(5, Number(s.speed) || 30)), pauseOnHover: Boolean(s.pause_on_hover), title: full(s.title) };
};

adminRoutes.openapi(
  createRoute({ method: "get", path: "/admin/brands-strip", tags: ["Admin"], security, summary: "How the brands strip behaves in the storefront", responses: { 200: json(StripSettings, "OK"), ...errors } }),
  async (c) => c.json(await readStrip(c.get("db")), 200),
);
adminRoutes.openapi(
  createRoute({ method: "put", path: "/admin/brands-strip", tags: ["Admin"], security, summary: "Change the brands strip settings", request: { body: body(StripSettings) }, responses: { 200: json(Ok, "Saved"), ...errors } }),
  async (c) => {
    const s = c.req.valid("json");
    await upsertSetting(c.get("db"), "brands_strip", { enabled: s.enabled, animated: s.animated, speed: s.speed, pause_on_hover: s.pauseOnHover, title: JSON.parse(toJson(s.title) ?? "{}") });
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------
const AdminOffer = z
  .object({
    id: z.string().uuid(),
    label: OptionalI18nSchema,
    title: I18nSchema,
    subtitle: OptionalI18nSchema,
    ctaLabel: OptionalI18nSchema,
    href: z.string().nullable(),
    imageUrl: z.string().nullable(),
    theme: z.enum(["dark", "light"]),
    showCountdown: z.boolean(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    isActive: z.boolean(),
  })
  .openapi("AdminOffer");

const OfferInput = z
  .object({
    label: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    title: I18nSchema,
    subtitle: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    ctaLabel: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    href: Href.default(null),
    imageUrl: ImageRef.default(null),
    theme: z.enum(["dark", "light"]).default("dark"),
    showCountdown: z.boolean().default(false),
    startsAt: z.string().datetime({ offset: true }).nullable().default(null),
    endsAt: z.string().datetime({ offset: true }).nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((o, ctx) => {
    if (o.showCountdown && !o.endsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "A countdown needs an end date" });
    if (o.startsAt && o.endsAt && new Date(o.endsAt) <= new Date(o.startsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start" });
  })
  .openapi("OfferInput");

type OfferRow = { id: string; label: unknown; title: unknown; subtitle: unknown; cta_label: unknown; link_url: string | null; image_path: string | null; theme: "dark" | "light"; show_countdown: boolean; starts_at: unknown; ends_at: unknown; is_active: boolean };
const iso = (v: unknown) => (v ? new Date(v as string | number | Date).toISOString() : null);
const offerOut = (o: OfferRow) => ({
  id: o.id, label: full(o.label), title: full(o.title), subtitle: full(o.subtitle), ctaLabel: full(o.cta_label), href: o.link_url,
  imageUrl: imageUrl(o.image_path), theme: o.theme, showCountdown: o.show_countdown, startsAt: iso(o.starts_at), endsAt: iso(o.ends_at), isActive: o.is_active,
});
const OFFER_COLS = "id, label, title, subtitle, cta_label, link_url, image_path, theme, show_countdown, starts_at, ends_at, is_active";
const offerParams = (o: z.infer<typeof OfferInput>) => [
  toJson(o.label), toJson(o.title), toJson(o.subtitle), toJson(o.ctaLabel), o.href, toStoredPath(o.imageUrl), o.theme, o.showCountdown, o.startsAt, o.endsAt, o.isActive,
];

adminRoutes.openapi(
  createRoute({ method: "get", path: "/admin/offers", tags: ["Admin"], security, summary: "All offers, newest first", responses: { 200: json(z.array(AdminOffer), "OK"), ...errors } }),
  async (c) => c.json((await c.get("db").query<OfferRow>(`select ${OFFER_COLS} from public.offers order by created_at desc, id`)).map(offerOut), 200),
);
adminRoutes.openapi(
  createRoute({ method: "post", path: "/admin/offers", tags: ["Admin"], security, summary: "Create an offer", request: { body: body(OfferInput) }, responses: { 200: json(AdminOffer, "Created"), ...errors } }),
  async (c) => {
    const rows = await c.get("db").query<OfferRow>(
      `insert into public.offers (label, title, subtitle, cta_label, link_url, image_path, theme, show_countdown, starts_at, ends_at, is_active)
       values ($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) returning ${OFFER_COLS}`,
      offerParams(c.req.valid("json")),
    );
    return c.json(offerOut(rows[0]!), 200);
  },
);
adminRoutes.openapi(
  createRoute({ method: "put", path: "/admin/offers/{id}", tags: ["Admin"], security, summary: "Edit an offer", request: { params: Id, body: body(OfferInput) }, responses: { 200: json(AdminOffer, "Updated"), ...errors } }),
  async (c) => {
    const rows = await c.get("db").query<OfferRow>(
      `update public.offers set label = $2::jsonb, title = $3::jsonb, subtitle = $4::jsonb, cta_label = $5::jsonb, link_url = $6, image_path = $7,
              theme = $8, show_countdown = $9, starts_at = $10, ends_at = $11, is_active = $12
        where id = $1 returning ${OFFER_COLS}`,
      [c.req.valid("param").id, ...offerParams(c.req.valid("json"))],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "Offer not found");
    return c.json(offerOut(rows[0]), 200);
  },
);
adminRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/offers/{id}", tags: ["Admin"], security, summary: "Delete an offer", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const rows = await c.get("db").query(`delete from public.offers where id = $1 returning id`, [c.req.valid("param").id]);
    if (!rows.length) throw new ApiError(404, "not_found", "Offer not found");
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Site content: announcement bar, sale page
// ---------------------------------------------------------------------------
const SiteContent = z.object({ announcement: OptionalI18nSchema }).openapi("SiteContent");
adminRoutes.openapi(
  createRoute({ method: "get", path: "/admin/site", tags: ["Admin"], security, summary: "Announcement bar text", responses: { 200: json(SiteContent, "OK"), ...errors } }),
  async (c) => c.json({ announcement: full(await getSetting(c.get("db"), "announcement")) }, 200),
);
adminRoutes.openapi(
  createRoute({ method: "put", path: "/admin/site", tags: ["Admin"], security, summary: "Change the announcement bar text (all empty hides it)", request: { body: body(SiteContent) }, responses: { 200: json(Ok, "Saved"), ...errors } }),
  async (c) => {
    await upsertSetting(c.get("db"), "announcement", JSON.parse(toJson(c.req.valid("json").announcement) ?? "{}"));
    return c.json({ ok: true as const }, 200);
  },
);

const SalePage = z.object({ enabled: z.boolean(), title: I18nSchema, subtitle: OptionalI18nSchema }).openapi("SalePageSettings");
adminRoutes.openapi(
  createRoute({ method: "get", path: "/admin/sale-page", tags: ["Admin"], security, summary: "Sale page title and visibility", responses: { 200: json(SalePage, "OK"), ...errors } }),
  async (c) => {
    const s = { ...DEFAULT_SALE, ...((await getSetting(c.get("db"), "sale_page")) ?? {}) } as typeof DEFAULT_SALE;
    return c.json({ enabled: Boolean(s.enabled), title: full(s.title), subtitle: full(s.subtitle) }, 200);
  },
);
adminRoutes.openapi(
  createRoute({ method: "put", path: "/admin/sale-page", tags: ["Admin"], security, summary: "Change the sale page settings", request: { body: body(SalePage) }, responses: { 200: json(Ok, "Saved"), ...errors } }),
  async (c) => {
    const s = c.req.valid("json");
    await upsertSetting(c.get("db"), "sale_page", { enabled: s.enabled, title: JSON.parse(toJson(s.title) ?? "{}"), subtitle: JSON.parse(toJson(s.subtitle) ?? "{}") });
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------
const MAX_UPLOAD = 3 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };

adminRoutes.openapi(
  createRoute({
    method: "post",
    path: "/admin/uploads",
    tags: ["Admin"],
    security,
    summary: "Upload an image (PNG, JPEG, WebP, GIF or SVG, up to 3 MB); returns its public URL",
    request: { body: { required: true, content: { "multipart/form-data": { schema: z.object({ file: z.any().openapi({ type: "string", format: "binary" }) }) } } } },
    responses: { 200: json(z.object({ url: z.string() }).openapi("UploadResult"), "Stored"), ...errors },
  }),
  async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const file = form["file"];
    if (!(file instanceof File)) throw new ApiError(422, "validation_error", "A file field is required");
    const ext = TYPES[file.type];
    if (!ext) throw new ApiError(422, "validation_error", "Unsupported image type");
    if (file.size === 0 || file.size > MAX_UPLOAD) throw new ApiError(422, "validation_error", "Image must be between 1 byte and 3 MB");
    const d = new Date();
    const path = `uploads/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${ext}`;
    await c.get("storage").upload(path, new Uint8Array(await file.arrayBuffer()), file.type);
    return c.json({ url: imageUrl(path) ?? path }, 200);
  },
);

