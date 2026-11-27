import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getSetting } from "../lib/catalog.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { LocaleQuery, pick, pickOrNull } from "../lib/i18n.js";
import { imageUrl } from "../lib/media.js";
import { toWhatsappNumber } from "../lib/orders.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const Q = z.object({ locale: LocaleQuery });

export const pagesRoutes = new OpenAPIHono<AppEnv>();

pagesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/pages",
    tags: ["Pages"],
    summary: "Published information pages (terms, privacy, returns, shipping, cash on delivery) for the footer links",
    request: { query: Q },
    responses: { 200: json(z.array(z.object({ slug: z.string(), title: z.string() })).openapi("PageLinks"), "OK") },
  }),
  async (c) => {
    const rows = await c.get("db").query<{ slug: string; title: unknown }>(`select slug, title from public.pages where is_published order by sort_order, slug`);
    return c.json(rows.map((r) => ({ slug: r.slug, title: pick(r.title, c.req.valid("query").locale) })), 200);
  },
);

const PageSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    /** Plain text with a tiny Markdown subset: `## Heading`, `- item`, `**bold**`, blank line = new paragraph. */
    body: z.string(),
    /** True while the text is still a draft that a lawyer has not reviewed: the storefront shows `draftNotice`. */
    isDraft: z.boolean(),
    draftNotice: z.string().nullable(),
    updatedAt: z.string(),
  })
  .openapi("InfoPage");

pagesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/pages/{slug}",
    tags: ["Pages"],
    summary: "One information page",
    request: { params: z.object({ slug: z.string() }), query: Q },
    responses: { 200: json(PageSchema, "OK"), 404: json(ErrorSchema, "Not found") },
  }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const db = c.get("db");
    const r = (await db.query<{ slug: string; title: unknown; body: unknown; is_draft: boolean; updated_at: unknown }>(`select slug, title, body, is_draft, updated_at from public.pages where slug = $1 and is_published`, [c.req.valid("param").slug]))[0];
    if (!r) throw new ApiError(404, "not_found", "Page not found");
    const notice = r.is_draft ? pickOrNull(await getSetting(db, "draft_notice"), locale) : null;
    return c.json({ slug: r.slug, title: pick(r.title, locale), body: pick(r.body, locale), isDraft: r.is_draft, draftNotice: notice, updatedAt: new Date(r.updated_at as string).toISOString() }, 200);
  },
);

const StoreInfoSchema = z
  .object({
    phone: z.string().nullable(),
    email: z.string().nullable(),
    address: z.string().nullable(),
    hours: z.string().nullable(),
    /** https://wa.me link built from the WhatsApp number; null when none is set. */
    whatsappUrl: z.string().nullable(),
    /** Title and description of the shop for search engines and social cards (edited in the dashboard); null = use the defaults. */
    siteTitle: z.string().nullable(),
    siteDescription: z.string().nullable(),
  })
  .openapi("StoreInfo");

pagesRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/store-info", tags: ["Pages"], summary: "Contact details of the store (phone, WhatsApp, email, address, opening hours)", request: { query: Q }, responses: { 200: json(StoreInfoSchema, "OK") } }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const v = ((await getSetting(c.get("db"), "store_info")) ?? {}) as { phone?: string; whatsapp?: string; email?: string; address?: unknown; hours?: unknown; site_title?: unknown; site_description?: unknown };
    const wa = v.whatsapp?.trim();
    return c.json(
      {
        phone: v.phone?.trim() || null,
        email: v.email?.trim() || null,
        address: pickOrNull(v.address, locale),
        hours: pickOrNull(v.hours, locale),
        whatsappUrl: wa ? `https://wa.me/${toWhatsappNumber(wa)}` : null,
        siteTitle: pickOrNull(v.site_title, locale),
        siteDescription: pickOrNull(v.site_description, locale),
      },
      200,
    );
  },
);

const WomenPageSchema = z
  .object({
    enabled: z.boolean(),
    title: z.string(),
    subtitle: z.string().nullable(),
    heroImage: z.union([z.object({ url: z.string(), alt: z.string() }), z.null()]),
  })
  .openapi("WomenPage");

pagesRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/women", tags: ["Pages"], summary: "Texts and cover image of the Women's page (its products come from GET /catalog/products?audience=women)", request: { query: Q }, responses: { 200: json(WomenPageSchema, "OK") } }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const v = ((await getSetting(c.get("db"), "women_page")) ?? {}) as { enabled?: boolean; title?: unknown; subtitle?: unknown; hero_path?: string | null };
    const title = pick(v.title, locale) || "Women";
    return c.json({ enabled: v.enabled !== false, title, subtitle: pickOrNull(v.subtitle, locale), heroImage: v.hero_path ? { url: imageUrl(v.hero_path) ?? "", alt: title } : null }, 200);
  },
);

const MenPageSchema = z
  .object({
    enabled: z.boolean(),
    title: z.string(),
    subtitle: z.string().nullable(),
    heroImage: z.union([z.object({ url: z.string(), alt: z.string() }), z.null()]),
  })
  .openapi("MenPage");

pagesRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/men", tags: ["Pages"], summary: "Texts and cover image of the Men's page (its products come from GET /catalog/products?audience=men)", request: { query: Q }, responses: { 200: json(MenPageSchema, "OK") } }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const v = ((await getSetting(c.get("db"), "men_page")) ?? {}) as { enabled?: boolean; title?: unknown; subtitle?: unknown; hero_path?: string | null };
    const title = pick(v.title, locale) || "Men";
    return c.json({ enabled: v.enabled !== false, title, subtitle: pickOrNull(v.subtitle, locale), heroImage: v.hero_path ? { url: imageUrl(v.hero_path) ?? "", alt: title } : null }, 200);
  },
);
