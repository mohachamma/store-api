import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { full, OptionalI18nSchema, toJson } from "../lib/i18n.js";
import { imageUrl, toStoredPath } from "../lib/media.js";
import { moveRow } from "../lib/reorder.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 409: json(ErrorSchema, "Conflict"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const Id = z.object({ id: z.string().uuid() });
const iso = (v: unknown) => (v ? new Date(v as string | number | Date).toISOString() : null);
const Href = z.string().max(500).regex(/^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/, "Must be a path starting with / or an https URL").nullable();
const MAX_FEE = 100_000;

export const adminStoreRoutes = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Shipping: fee per wilaya + free-delivery threshold
// ---------------------------------------------------------------------------
const AdminWilaya = z.object({ code: z.number().int(), nameAr: z.string(), nameFr: z.string(), homeFee: z.number().int(), deskFee: z.number().int(), active: z.boolean() }).openapi("AdminWilaya");
const AdminShipping = z.object({ freeShippingOver: z.number().int().nullable(), wilayas: z.array(AdminWilaya) }).openapi("AdminShipping");

adminStoreRoutes.openapi(
  createRoute({ method: "get", path: "/admin/shipping", tags: ["Admin"], security, summary: "Delivery fees of the 58 wilayas and the free-delivery threshold", responses: { 200: json(AdminShipping, "OK"), ...errors } }),
  async (c) => {
    const db = c.get("db");
    const [rows, rules] = await Promise.all([
      db.query<{ code: number; name_ar: string; name_fr: string; home_fee: number; desk_fee: number; active: boolean }>(`select code, name_ar, name_fr, home_fee, desk_fee, active from public.wilayas order by code`),
      db.query<{ value: { free_shipping_over?: number | null } }>(`select value from public.site_settings where key = 'shipping_rules'`),
    ]);
    const v = rules[0]?.value?.free_shipping_over;
    return c.json({ freeShippingOver: typeof v === "number" && v > 0 ? v : null, wilayas: rows.map((w) => ({ code: Number(w.code), nameAr: w.name_ar, nameFr: w.name_fr, homeFee: Number(w.home_fee), deskFee: Number(w.desk_fee), active: w.active })) }, 200);
  },
);

adminStoreRoutes.openapi(
  createRoute({
    method: "put", path: "/admin/shipping/wilayas", tags: ["Admin"], security, summary: "Change the delivery fees and availability of several wilayas at once (all or nothing)",
    request: { body: body(z.object({ updates: z.array(z.object({ code: z.number().int().min(1).max(58), homeFee: z.number().int().min(0).max(MAX_FEE).optional(), deskFee: z.number().int().min(0).max(MAX_FEE).optional(), active: z.boolean().optional() })).min(1).max(58) })) },
    responses: { 200: json(z.object({ updated: z.number().int() }), "OK"), ...errors },
  }),
  async (c) => {
    const { updates } = c.req.valid("json");
    const n = await c.get("db").tx(async (q) => {
      let count = 0;
      for (const u of updates) {
        const sets: string[] = [];
        const params: unknown[] = [u.code];
        const add = (v: unknown) => (params.push(v), `$${params.length}`);
        if (u.homeFee !== undefined) sets.push(`home_fee = ${add(u.homeFee)}`);
        if (u.deskFee !== undefined) sets.push(`desk_fee = ${add(u.deskFee)}`);
        if (u.active !== undefined) sets.push(`active = ${add(u.active)}`);
        if (!sets.length) continue;
        if (!(await q.query(`update public.wilayas set ${sets.join(", ")} where code = $1 returning code`, params)).length) throw new ApiError(404, "not_found", `Wilaya ${u.code} does not exist`);
        count++;
      }
      return count;
    });
    return c.json({ updated: n }, 200);
  },
);

adminStoreRoutes.openapi(
  createRoute({
    method: "put", path: "/admin/shipping/rules", tags: ["Admin"], security, summary: "Set the order amount above which delivery is free (null = never free)",
    request: { body: body(z.object({ freeShippingOver: z.number().int().min(1).max(10_000_000).nullable() })) },
    responses: { 200: json(Ok, "Saved"), ...errors },
  }),
  async (c) => {
    await c.get("db").query(
      `insert into public.site_settings (key, value) values ('shipping_rules', $1::jsonb) on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ free_shipping_over: c.req.valid("json").freeShippingOver })],
    );
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Discount codes
// ---------------------------------------------------------------------------
const AdminCode = z
  .object({ id: z.string().uuid(), code: z.string(), kind: z.enum(["percent", "fixed"]), value: z.number().int(), minSubtotal: z.number().int(), maxUses: z.number().int().nullable(), usedCount: z.number().int(), startsAt: z.string().nullable(), endsAt: z.string().nullable(), isActive: z.boolean() })
  .openapi("AdminDiscountCode");
const CodeInput = z
  .object({
    code: z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9_-]{3,32}$/, "3–32 letters, digits, - or _")),
    kind: z.enum(["percent", "fixed"]),
    value: z.number().int().min(1).max(10_000_000),
    minSubtotal: z.number().int().min(0).max(10_000_000).default(0),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().default(null),
    startsAt: z.string().datetime({ offset: true }).nullable().default(null),
    endsAt: z.string().datetime({ offset: true }).nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    if (c.kind === "percent" && c.value > 100) ctx.addIssue({ code: "custom", path: ["value"], message: "A percentage cannot exceed 100" });
    if (c.startsAt && c.endsAt && new Date(c.endsAt) <= new Date(c.startsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start" });
  })
  .openapi("DiscountCodeInput");
type CodeRow = { id: string; code: string; kind: "percent" | "fixed"; value: number; min_subtotal: number; max_uses: number | null; used_count: number; starts_at: unknown; expires_at: unknown; is_active: boolean };
const codeOut = (r: CodeRow) => ({ id: r.id, code: r.code, kind: r.kind, value: Number(r.value), minSubtotal: Number(r.min_subtotal), maxUses: r.max_uses === null ? null : Number(r.max_uses), usedCount: Number(r.used_count), startsAt: iso(r.starts_at), endsAt: iso(r.expires_at), isActive: r.is_active });
const CODE_COLS = "id, code, kind, value, min_subtotal, max_uses, used_count, starts_at, expires_at, is_active";

adminStoreRoutes.openapi(
  createRoute({ method: "get", path: "/admin/discount-codes", tags: ["Admin"], security, summary: "All discount codes with how many times each was used", responses: { 200: json(z.array(AdminCode), "OK"), ...errors } }),
  async (c) => c.json((await c.get("db").query<CodeRow>(`select ${CODE_COLS} from public.discount_codes order by created_at desc, id`)).map(codeOut), 200),
);
adminStoreRoutes.openapi(
  createRoute({ method: "post", path: "/admin/discount-codes", tags: ["Admin"], security, summary: "Create a discount code (case-insensitive for customers)", request: { body: body(CodeInput) }, responses: { 200: json(AdminCode, "Created"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    const r = await c.get("db").query<CodeRow>(
      `insert into public.discount_codes (code, kind, value, min_subtotal, max_uses, starts_at, expires_at, is_active) values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${CODE_COLS}`,
      [b.code, b.kind, b.value, b.minSubtotal, b.maxUses, b.startsAt, b.endsAt, b.isActive],
    );
    return c.json(codeOut(r[0]!), 200);
  },
);
adminStoreRoutes.openapi(
  createRoute({ method: "put", path: "/admin/discount-codes/{id}", tags: ["Admin"], security, summary: "Edit a discount code (its usage counter is kept)", request: { params: Id, body: body(CodeInput) }, responses: { 200: json(AdminCode, "Updated"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    const r = await c.get("db").query<CodeRow>(
      `update public.discount_codes set code = $2, kind = $3, value = $4, min_subtotal = $5, max_uses = $6, starts_at = $7, expires_at = $8, is_active = $9 where id = $1 returning ${CODE_COLS}`,
      [c.req.valid("param").id, b.code, b.kind, b.value, b.minSubtotal, b.maxUses, b.startsAt, b.endsAt, b.isActive],
    );
    if (!r[0]) throw new ApiError(404, "not_found", "Discount code not found");
    return c.json(codeOut(r[0]), 200);
  },
);
adminStoreRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/discount-codes/{id}", tags: ["Admin"], security, summary: "Delete a discount code (past orders keep their discount amount)", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const r = await c.get("db").query(`delete from public.discount_codes where id = $1 returning id`, [c.req.valid("param").id]);
    if (!r.length) throw new ApiError(404, "not_found", "Discount code not found");
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Home hero slides (the storefront shows the first active one)
// ---------------------------------------------------------------------------
const AdminSlide = z
  .object({ id: z.string().uuid(), title: OptionalI18nSchema, subtitle: OptionalI18nSchema, imageUrl: z.string(), collectionId: z.string().uuid().nullable(), linkUrl: z.string().nullable(), isActive: z.boolean(), startsAt: z.string().nullable(), endsAt: z.string().nullable() })
  .openapi("AdminSlide");
const SlideInput = z
  .object({
    title: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    subtitle: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    imageUrl: z.string().min(1).max(1000).refine((v) => !v.startsWith("data:"), "Inline images are not allowed; upload the file"),
    /** Link to a published collection, or a custom link (a collection wins when both are given). */
    collectionId: z.string().uuid().nullable().default(null),
    linkUrl: Href.default(null),
    isActive: z.boolean().default(true),
    startsAt: z.string().datetime({ offset: true }).nullable().default(null),
    endsAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .superRefine((s, ctx) => {
    for (const k of ["title", "subtitle"] as const) {
      if ((s[k].fr.trim() || s[k].en.trim()) && !s[k].ar.trim()) ctx.addIssue({ code: "custom", path: [k, "ar"], message: "Arabic text is required when another language is filled" });
    }
    if (s.startsAt && s.endsAt && new Date(s.endsAt) <= new Date(s.startsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start" });
  })
  .openapi("SlideInput");
type SlideRow = { id: string; title: unknown; subtitle: unknown; image_path: string; collection_id: string | null; link_url: string | null; is_active: boolean; starts_at: unknown; ends_at: unknown };
const slideOut = (s: SlideRow) => ({ id: s.id, title: full(s.title), subtitle: full(s.subtitle), imageUrl: imageUrl(s.image_path) ?? "", collectionId: s.collection_id, linkUrl: s.link_url, isActive: s.is_active, startsAt: iso(s.starts_at), endsAt: iso(s.ends_at) });
const SLIDE_COLS = "id, title, subtitle, image_path, collection_id, link_url, is_active, starts_at, ends_at";

adminStoreRoutes.openapi(
  createRoute({ method: "get", path: "/admin/slides", tags: ["Admin"], security, summary: "Hero slides in display order (the storefront shows the first active one)", responses: { 200: json(z.array(AdminSlide), "OK"), ...errors } }),
  async (c) => c.json((await c.get("db").query<SlideRow>(`select ${SLIDE_COLS} from public.slides where kind = 'hero' order by sort_order, created_at, id`)).map(slideOut), 200),
);
const slideParams = (b: z.infer<typeof SlideInput>) => [toJson(b.title), toJson(b.subtitle), toStoredPath(b.imageUrl), b.collectionId, b.linkUrl, b.isActive, b.startsAt, b.endsAt];
adminStoreRoutes.openapi(
  createRoute({ method: "post", path: "/admin/slides", tags: ["Admin"], security, summary: "Add a hero slide (appended at the end)", request: { body: body(SlideInput) }, responses: { 200: json(AdminSlide, "Created"), ...errors } }),
  async (c) => {
    const r = await c.get("db").query<SlideRow>(
      `insert into public.slides (kind, title, subtitle, image_path, collection_id, link_url, is_active, starts_at, ends_at, sort_order)
       values ('hero', $1::jsonb, $2::jsonb, $3, $4, $5, $6, $7, $8, coalesce((select max(sort_order) + 1 from public.slides), 0)) returning ${SLIDE_COLS}`,
      slideParams(c.req.valid("json")),
    );
    return c.json(slideOut(r[0]!), 200);
  },
);
adminStoreRoutes.openapi(
  createRoute({ method: "put", path: "/admin/slides/{id}", tags: ["Admin"], security, summary: "Edit a hero slide", request: { params: Id, body: body(SlideInput) }, responses: { 200: json(AdminSlide, "Updated"), ...errors } }),
  async (c) => {
    const r = await c.get("db").query<SlideRow>(
      `update public.slides set title = $2::jsonb, subtitle = $3::jsonb, image_path = $4, collection_id = $5, link_url = $6, is_active = $7, starts_at = $8, ends_at = $9 where id = $1 and kind = 'hero' returning ${SLIDE_COLS}`,
      [c.req.valid("param").id, ...slideParams(c.req.valid("json"))],
    );
    if (!r[0]) throw new ApiError(404, "not_found", "Slide not found");
    return c.json(slideOut(r[0]), 200);
  },
);
adminStoreRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/slides/{id}", tags: ["Admin"], security, summary: "Delete a hero slide", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const r = await c.get("db").query(`delete from public.slides where id = $1 returning id`, [c.req.valid("param").id]);
    if (!r.length) throw new ApiError(404, "not_found", "Slide not found");
    return c.json({ ok: true as const }, 200);
  },
);
adminStoreRoutes.openapi(
  createRoute({ method: "post", path: "/admin/slides/{id}/move", tags: ["Admin"], security, summary: "Move a slide one step earlier (-1) or later (+1)", request: { params: Id, body: body(z.object({ direction: z.union([z.literal(-1), z.literal(1)]) })) }, responses: { 200: json(Ok, "Moved"), ...errors } }),
  async (c) => {
    await moveRow(c.get("db"), "slides", c.req.valid("param").id, c.req.valid("json").direction);
    return c.json({ ok: true as const }, 200);
  },
);
