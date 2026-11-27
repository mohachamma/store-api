import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getSetting } from "../lib/catalog.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { full, I18nSchema, OptionalI18nSchema, toJson } from "../lib/i18n.js";
import { normalizePhone } from "../lib/orders.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const iso = (v: unknown) => new Date(v as string | number | Date).toISOString();

/** Long text per language (pages can be long); Arabic is required, the others optional. */
const LongI18n = z.object({ ar: z.string().min(1).max(30000), fr: z.string().max(30000).default(""), en: z.string().max(30000).default("") }).openapi("LongI18n");

const AdminPage = z
  .object({ slug: z.string(), title: I18nSchema, body: LongI18n, isPublished: z.boolean(), isDraft: z.boolean(), updatedAt: z.string() })
  .openapi("AdminInfoPage");
const PageInput = z.object({ title: I18nSchema, body: LongI18n, isPublished: z.boolean(), isDraft: z.boolean() }).openapi("InfoPageInput");

export const adminPagesRoutes = new OpenAPIHono<AppEnv>();

type Row = { slug: string; title: unknown; body: unknown; is_published: boolean; is_draft: boolean; updated_at: unknown };
const out = (r: Row) => ({ slug: r.slug, title: full(r.title), body: full(r.body), isPublished: r.is_published, isDraft: r.is_draft, updatedAt: iso(r.updated_at) });

adminPagesRoutes.openapi(
  createRoute({ method: "get", path: "/admin/pages", tags: ["Admin"], security, summary: "The information pages (terms, privacy, returns, shipping, cash on delivery) with all translations", responses: { 200: json(z.array(AdminPage), "OK"), ...errors } }),
  async (c) => c.json((await c.get("db").query<Row>(`select slug, title, body, is_published, is_draft, updated_at from public.pages order by sort_order, slug`)).map(out), 200),
);

adminPagesRoutes.openapi(
  createRoute({
    method: "put",
    path: "/admin/pages/{slug}",
    tags: ["Admin"],
    security,
    summary: "Edit a page. Switch `isDraft` off once a lawyer has reviewed the text (removes the draft notice).",
    request: { params: z.object({ slug: z.string() }), body: body(PageInput) },
    responses: { 200: json(AdminPage, "Saved"), ...errors },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const rows = await c.get("db").query<Row>(
      `update public.pages set title = $2::jsonb, body = $3::jsonb, is_published = $4, is_draft = $5 where slug = $1 returning slug, title, body, is_published, is_draft, updated_at`,
      [c.req.valid("param").slug, toJson(b.title), toJson(b.body), b.isPublished, b.isDraft],
    );
    if (!rows[0]) throw new ApiError(404, "not_found", "Page not found");
    return c.json(out(rows[0]), 200);
  },
);

const AdminStoreInfo = z
  .object({
    phone: z.string().trim().max(30),
    /** Local format 05XXXXXXXX (or +213…). Used for the WhatsApp button. */
    whatsapp: z.string().trim().max(30),
    email: z.union([z.literal(""), z.string().trim().email().max(200)]),
    address: OptionalI18nSchema,
    hours: OptionalI18nSchema,
    /** Shop title / description for Google and social cards. */
    siteTitle: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    siteDescription: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
  })
  .superRefine((o, ctx) => {
    if (o.whatsapp && !normalizePhone(o.whatsapp)) ctx.addIssue({ code: "custom", path: ["whatsapp"], message: "Enter a valid Algerian phone number" });
    for (const k of ["address", "hours", "siteTitle", "siteDescription"] as const) if ((o[k].fr.trim() || o[k].en.trim()) && !o[k].ar.trim()) ctx.addIssue({ code: "custom", path: [k, "ar"], message: "Arabic text is required when another language is filled" });
  })
  .openapi("AdminStoreInfo");

adminPagesRoutes.openapi(
  createRoute({ method: "get", path: "/admin/store-info", tags: ["Admin"], security, summary: "Contact details shown on the Contact page", responses: { 200: json(AdminStoreInfo, "OK"), ...errors } }),
  async (c) => {
    const v = ((await getSetting(c.get("db"), "store_info")) ?? {}) as { phone?: string; whatsapp?: string; email?: string; address?: unknown; hours?: unknown; site_title?: unknown; site_description?: unknown };
    return c.json({ phone: v.phone ?? "", whatsapp: v.whatsapp ?? "", email: v.email ?? "", address: full(v.address), hours: full(v.hours), siteTitle: full(v.site_title), siteDescription: full(v.site_description) }, 200);
  },
);
adminPagesRoutes.openapi(
  createRoute({ method: "put", path: "/admin/store-info", tags: ["Admin"], security, summary: "Save the contact details", request: { body: body(AdminStoreInfo) }, responses: { 200: json(Ok, "Saved"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    const value = { phone: b.phone, whatsapp: b.whatsapp ? normalizePhone(b.whatsapp) : "", email: b.email, address: JSON.parse(toJson(b.address) ?? "{}"), hours: JSON.parse(toJson(b.hours) ?? "{}"), site_title: JSON.parse(toJson(b.siteTitle) ?? "{}"), site_description: JSON.parse(toJson(b.siteDescription) ?? "{}") };
    await c.get("db").query(`insert into public.site_settings (key, value) values ('store_info', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify(value)]);
    return c.json({ ok: true as const }, 200);
  },
);
