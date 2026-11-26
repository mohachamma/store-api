import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getBrands, getBrandsStrip, getLooks, getOffers, getSale, getSetting, groupRows, SIZE_RANK, SUMMARY_SQL, toSummary, type SummaryRow } from "../lib/catalog.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { LocaleQuery, pick, pickOrNull } from "../lib/i18n.js";
import { imageUrl } from "../lib/media.js";
import type { AppEnv } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Schemas (names are what the front-ends get in their generated types)
// ---------------------------------------------------------------------------
/** `.nullable()` on a named (referenced) schema is documented wrongly by the OpenAPI generator, so use an explicit union. */
const orNull = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, z.null()]);

const ImageSchema = z.object({ url: z.string(), alt: z.string() }).openapi("Image");
const CategorySchema = z.object({ slug: z.string(), name: z.string() }).openapi("CategoryRef");

const ProductSummarySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    /** Price of the cheapest variant, integer DZD. */
    price: z.number().int(),
    compareAtPrice: z.number().int().nullable(),
    image: ImageSchema,
    category: CategorySchema,
    isNew: z.boolean(),
  })
  .openapi("ProductSummary");

const VariantSchema = z
  .object({
    id: z.string().uuid(),
    size: z.string(),
    color: z.string(),
    stock: z.number().int(),
    price: z.number().int(),
    compareAtPrice: z.number().int().nullable(),
  })
  .openapi("Variant");

const ProductSchema = ProductSummarySchema.extend({
  description: z.string(),
  images: z.array(ImageSchema),
  sizes: z.array(z.string()),
  variants: z.array(VariantSchema),
}).openapi("Product");

const LookSchema = z.object({ id: z.string().uuid(), image: ImageSchema, productSlugs: z.array(z.string()) }).openapi("Look");
const CategoryRowSchema = z.object({ category: CategorySchema, products: z.array(ProductSummarySchema) }).openapi("CategoryRow");

const BrandSchema = z
  .object({ id: z.string().uuid(), slug: z.string(), name: z.string(), logo: ImageSchema, href: z.string().nullable() })
  .openapi("Brand");

const BrandsStripSchema = z
  .object({
    enabled: z.boolean(),
    animated: z.boolean(),
    /** Seconds per full loop (higher = slower). */
    speed: z.number(),
    pauseOnHover: z.boolean(),
    title: z.string(),
  })
  .openapi("BrandsStrip");

const OfferSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    title: z.string(),
    subtitle: z.string().nullable(),
    ctaLabel: z.string().nullable(),
    href: z.string().nullable(),
    image: orNull(ImageSchema),
    theme: z.enum(["dark", "light"]),
    /** ISO date; when set the storefront shows a countdown. */
    countdownEndsAt: z.string().nullable(),
  })
  .openapi("Offer");

const HeroSchema = z
  .object({ title: z.string(), subtitle: z.string().nullable(), image: ImageSchema, href: z.string().nullable(), collectionSlug: z.string().nullable() })
  .openapi("Hero");

const HomeSchema = z
  .object({
    announcement: z.string().nullable(),
    hero: orNull(HeroSchema),
    looks: z.array(LookSchema),
    rows: z.array(CategoryRowSchema),
    brands: z.array(BrandSchema),
    brandsStrip: BrandsStripSchema,
    offers: z.array(OfferSchema),
  })
  .openapi("Home");

const CollectionSchema = z
  .object({ slug: z.string(), title: z.string(), heroImage: ImageSchema, looks: z.array(LookSchema), rows: z.array(CategoryRowSchema) })
  .openapi("Collection");

const SaleSchema = z
  .object({ enabled: z.boolean(), title: z.string(), subtitle: z.string().nullable(), products: z.array(ProductSummarySchema) })
  .openapi("Sale");

const SiteSchema = z.object({ announcement: z.string().nullable() }).openapi("Site");

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const notFound = { 404: json(ErrorSchema, "Not found") };
const Q = z.object({ locale: LocaleQuery });

export const catalogRoutes = new OpenAPIHono<AppEnv>();

// Public data: let the CDN cache it briefly.
catalogRoutes.use("*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && c.res.status === 200) c.header("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
});

// ---------------------------------------------------------------------------
// GET /catalog/site
// ---------------------------------------------------------------------------
catalogRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/site", tags: ["Catalog"], summary: "Site-wide texts (announcement bar)", request: { query: Q }, responses: { 200: json(SiteSchema, "OK") } }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const a = await getSetting(c.get("db"), "announcement");
    return c.json({ announcement: pickOrNull(a, locale) }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /catalog/home
// ---------------------------------------------------------------------------
catalogRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/home", tags: ["Catalog"], summary: "Everything the home page shows", request: { query: Q }, responses: { 200: json(HomeSchema, "OK") } }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const db = c.get("db");
    const [announcement, heroRows, looks, productRows, brands, brandsStrip, offers] = await Promise.all([
      getSetting(db, "announcement"),
      db.query<{ title: unknown; subtitle: unknown; image_path: string; link_url: string | null; collection_slug: string | null }>(
        `select s.title, s.subtitle, s.image_path, s.link_url, c.slug as collection_slug
           from public.slides s left join public.collections c on c.id = s.collection_id and c.is_published
          where s.kind = 'hero' and s.is_active and (s.starts_at is null or s.starts_at <= now()) and (s.ends_at is null or s.ends_at > now())
          order by s.sort_order, s.id limit 1`,
      ),
      getLooks(db, locale, null),
      db.query<SummaryRow>(`${SUMMARY_SQL} where p.is_published order by c.sort_order, c.slug, p.is_new desc, p.created_at desc, p.id`),
      getBrands(db),
      getBrandsStrip(db, locale),
      getOffers(db, locale),
    ]);
    const h = heroRows[0];
    return c.json(
      {
        announcement: pickOrNull(announcement, locale),
        hero: h
          ? {
              title: pick(h.title, locale),
              subtitle: pickOrNull(h.subtitle, locale),
              image: { url: imageUrl(h.image_path) ?? "", alt: "" },
              href: h.collection_slug ? `/collections/${h.collection_slug}` : h.link_url,
              collectionSlug: h.collection_slug,
            }
          : null,
        looks,
        rows: groupRows(productRows, locale, 10),
        brands,
        brandsStrip,
        offers,
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /catalog/collections/{slug}
// ---------------------------------------------------------------------------
catalogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/collections/{slug}",
    tags: ["Catalog"],
    summary: "A collection with its looks and products grouped by category",
    request: { params: z.object({ slug: z.string() }), query: Q },
    responses: { 200: json(CollectionSchema, "OK"), ...notFound },
  }),
  async (c) => {
    const { slug } = c.req.valid("param");
    const { locale } = c.req.valid("query");
    const db = c.get("db");
    const col = (
      await db.query<{ id: string; slug: string; title: unknown; hero_path: string | null }>(
        `select id, slug, title, hero_path from public.collections where slug = $1 and is_published`,
        [slug],
      )
    )[0];
    if (!col) throw new ApiError(404, "not_found", "Collection not found");
    const [looks, rows] = await Promise.all([
      getLooks(db, locale, col.id),
      db.query<SummaryRow>(
        `${SUMMARY_SQL} join public.collection_products cp on cp.product_id = p.id and cp.collection_id = $1
          where p.is_published order by c.sort_order, c.slug, cp.sort_order, p.id`,
        [col.id],
      ),
    ]);
    return c.json({ slug: col.slug, title: pick(col.title, locale), heroImage: { url: imageUrl(col.hero_path) ?? "", alt: "" }, looks, rows: groupRows(rows, locale) }, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /catalog/products  (search, filters, sort, paging)
// ---------------------------------------------------------------------------
const ListQuery = z.object({
  locale: LocaleQuery,
  q: z.string().trim().max(100).optional().openapi({ description: "Search in product names (any language)" }),
  category: z.string().optional().openapi({ description: "Category slug" }),
  size: z.string().max(10).optional(),
  color: z.string().max(40).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc", "discount"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(48),
  offset: z.coerce.number().int().min(0).default(0),
});

catalogRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/products", tags: ["Catalog"], summary: "List / search / filter products", request: { query: ListQuery }, responses: { 200: json(z.array(ProductSummarySchema), "OK") } }),
  async (c) => {
    const q = c.req.valid("query");
    const where: string[] = ["p.is_published"];
    const params: unknown[] = [];
    const add = (v: unknown) => (params.push(v), `$${params.length}`);

    if (q.category) where.push(`c.slug = ${add(q.category)}`);
    if (q.q) {
      const like = add(`%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`(p.name->>'ar' ilike ${like} or p.name->>'fr' ilike ${like} or p.name->>'en' ilike ${like} or c.name->>'ar' ilike ${like} or c.name->>'fr' ilike ${like} or c.name->>'en' ilike ${like})`);
    }
    if (q.minPrice !== undefined) where.push(`mv.price >= ${add(q.minPrice)}`);
    if (q.maxPrice !== undefined) where.push(`mv.price <= ${add(q.maxPrice)}`);
    if (q.size || q.color) {
      const conds = ["v.product_id = p.id", "v.stock > 0"];
      if (q.size) conds.push(`v.size = ${add(q.size)}`);
      if (q.color) conds.push(`lower(v.color) = lower(${add(q.color)})`);
      where.push(`exists (select 1 from public.product_variants v where ${conds.join(" and ")})`);
    }
    const order = {
      newest: "p.created_at desc, p.id",
      price_asc: "mv.price asc, p.id",
      price_desc: "mv.price desc, p.id",
      discount: "(1 - mv.price::numeric / nullif(mv.compare_at_price, 0)) desc nulls last, p.created_at desc",
    }[q.sort];

    const rows = await c.get("db").query<SummaryRow>(
      `${SUMMARY_SQL} where ${where.join(" and ")} order by ${order} limit ${add(q.limit)} offset ${add(q.offset)}`,
      params,
    );
    return c.json(rows.map((r) => toSummary(r, q.locale)), 200);
  },
);

// ---------------------------------------------------------------------------
// GET /catalog/products/{slug}  and  /related
// ---------------------------------------------------------------------------
catalogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/products/{slug}",
    tags: ["Catalog"],
    summary: "Product detail with images and variants",
    request: { params: z.object({ slug: z.string() }), query: Q },
    responses: { 200: json(ProductSchema, "OK"), ...notFound },
  }),
  async (c) => {
    const { slug } = c.req.valid("param");
    const { locale } = c.req.valid("query");
    const db = c.get("db");
    const row = (await db.query<SummaryRow & { description: unknown }>(`${SUMMARY_SQL.replace("select p.id,", "select p.description, p.id,")} where p.slug = $1 and p.is_published`, [slug]))[0];
    if (!row) throw new ApiError(404, "not_found", "Product not found");
    const [images, variants] = await Promise.all([
      db.query<{ path: string; alt: unknown }>(`select path, alt from public.product_images where product_id = $1 order by sort_order, id`, [row.id]),
      db.query<{ id: string; size: string; color: string; stock: number; price: number; compare_at_price: number | null }>(
        `select v.id, v.size, v.color, v.stock, v.price, v.compare_at_price from public.product_variants v where v.product_id = $1 order by ${SIZE_RANK}, v.color`,
        [row.id],
      ),
    ]);
    const summary = toSummary(row, locale);
    const imgs = images.map((i) => ({ url: imageUrl(i.path) ?? "", alt: pickOrNull(i.alt, locale) ?? summary.name }));
    return c.json(
      {
        ...summary,
        description: pick(row.description, locale),
        images: imgs.length ? imgs : [summary.image],
        sizes: [...new Set(variants.map((v) => v.size))],
        variants: variants.map((v) => ({
          id: v.id,
          size: v.size,
          color: v.color,
          stock: Number(v.stock),
          price: Number(v.price),
          compareAtPrice: v.compare_at_price && Number(v.compare_at_price) > Number(v.price) ? Number(v.compare_at_price) : null,
        })),
      },
      200,
    );
  },
);

catalogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/products/{slug}/related",
    tags: ["Catalog"],
    summary: "Other products from the same category",
    request: { params: z.object({ slug: z.string() }), query: Q },
    responses: { 200: json(z.array(ProductSummarySchema), "OK") },
  }),
  async (c) => {
    const { slug } = c.req.valid("param");
    const { locale } = c.req.valid("query");
    const rows = await c.get("db").query<SummaryRow>(
      `${SUMMARY_SQL}
        where p.is_published and p.slug <> $1
          and p.category_id = (select category_id from public.products where slug = $1)
        order by p.created_at desc, p.id limit 8`,
      [slug],
    );
    return c.json(rows.map((r) => toSummary(r, locale)), 200);
  },
);

// ---------------------------------------------------------------------------
// GET /catalog/sale, /catalog/categories, /catalog/brands
// ---------------------------------------------------------------------------
catalogRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/sale", tags: ["Catalog"], summary: "Discounted products (biggest discount first)", request: { query: Q }, responses: { 200: json(SaleSchema, "OK") } }),
  async (c) => c.json(await getSale(c.get("db"), c.req.valid("query").locale), 200),
);

catalogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/categories",
    tags: ["Catalog"],
    summary: "Active categories that have at least one published product",
    request: { query: Q },
    responses: { 200: json(z.array(CategorySchema.extend({ image: orNull(ImageSchema), productCount: z.number().int() })), "OK") },
  }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const rows = await c.get("db").query<{ slug: string; name: unknown; image_path: string | null; n: number }>(
      `select c.slug, c.name, c.image_path, count(p.id)::int as n
         from public.categories c join public.products p on p.category_id = c.id and p.is_published
        where c.is_active group by c.id order by c.sort_order, c.slug`,
    );
    return c.json(rows.map((r) => ({ slug: r.slug, name: pick(r.name, locale), image: r.image_path ? { url: imageUrl(r.image_path) ?? "", alt: pick(r.name, locale) } : null, productCount: Number(r.n) })), 200);
  },
);

catalogRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/brands", tags: ["Catalog"], summary: "Active brands in display order", responses: { 200: json(z.array(BrandSchema), "OK") } }),
  async (c) => c.json(await getBrands(c.get("db")), 200),
);
