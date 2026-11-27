import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getBrands, getBrandsStrip, getCategoryCards, getLooks, getNewsletter, getOffers, getWhyUs, getSale, getSetting, groupRows, SIZE_RANK, SUMMARY_SQL, toSummary, type SummaryRow } from "../lib/catalog.js";
import { swatchHex } from "../lib/colors.js";
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

export const ProductSummarySchema = z
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
    /** One entry per color of the product, for the small round swatches (hex null = unknown, show a neutral dot). */
    colors: z.array(z.object({ name: z.string(), hex: z.string().nullable() })),
  })
  .openapi("ProductSummary");

const VariantSchema = z
  .object({
    id: z.string().uuid(),
    size: z.string(),
    color: z.string(),
    colorHex: z.string().nullable(),
    stock: z.number().int(),
    price: z.number().int(),
    compareAtPrice: z.number().int().nullable(),
  })
  .openapi("Variant");

const ProductSchema = ProductSummarySchema.extend({
  description: z.string(),
  /** `color` links a photo to a color name: tapping that color shows its photos (null = shown for every color). */
  images: z.array(ImageSchema.extend({ color: z.string().nullable() })),
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

const WhyUsSchema = z
  .object({ title: z.string(), items: z.array(z.object({ icon: z.string(), title: z.string(), text: z.string().nullable() })) })
  .openapi("WhyUs");
const CategoryCardSchema = z
  .object({ id: z.string().uuid(), title: z.string(), subtitle: z.string().nullable(), image: ImageSchema, href: z.string().nullable() })
  .openapi("CategoryCard");
const NewsletterBlockSchema = z.object({ title: z.string(), subtitle: z.string().nullable(), button: z.string() }).openapi("NewsletterBlock");

const HomeSchema = z
  .object({
    announcement: z.string().nullable(),
    hero: orNull(HeroSchema),
    looks: z.array(LookSchema),
    rows: z.array(CategoryRowSchema),
    brands: z.array(BrandSchema),
    brandsStrip: BrandsStripSchema,
    offers: z.array(OfferSchema),
    /** "Why us" features; null when switched off in the dashboard. */
    whyUs: orNull(WhyUsSchema),
    categoryCards: z.array(CategoryCardSchema),
    /** Newsletter sign-up block; null when switched off. */
    newsletter: orNull(NewsletterBlockSchema),
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
    const [announcement, heroRows, looks, productRows, brands, brandsStrip, offers, whyUs, categoryCards, newsletter] = await Promise.all([
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
      getWhyUs(db, locale),
      getCategoryCards(db, locale),
      getNewsletter(db, locale),
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
        whyUs,
        categoryCards,
        newsletter,
      },
      200,
    );
  },
);

catalogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/collections",
    tags: ["Catalog"],
    summary: "Published collections in display order (for menus)",
    request: { query: Q },
    responses: { 200: json(z.array(z.object({ slug: z.string(), title: z.string() })).openapi("CollectionLinks"), "OK") },
  }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const rows = await c.get("db").query<{ slug: string; title: unknown }>(`select slug, title from public.collections where is_published order by sort_order, created_at, id`);
    return c.json(rows.map((r) => ({ slug: r.slug, title: pick(r.title, locale) })), 200);
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
  audience: z.enum(["women", "men"]).optional().openapi({ description: "Products for women (or men); unisex products appear in both" }),
  color: z.string().max(40).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc", "discount"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(48),
  offset: z.coerce.number().int().min(0).default(0),
});

type ListFilters = Pick<z.infer<typeof ListQuery>, "q" | "category" | "size" | "color" | "minPrice" | "maxPrice" | "audience">;

/** WHERE clauses shared by the product list and the filter options. `skip` leaves a dimension out (so its own options stay visible). */
function listWhere(q: ListFilters, skip: Array<keyof ListFilters> = []) {
  const where: string[] = ["p.is_published"];
  const params: unknown[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  const use = (k: keyof ListFilters) => !skip.includes(k);

  if (q.audience) where.push(`p.audience in ('unisex', ${add(q.audience)})`);
  if (q.category && use("category")) where.push(`c.slug = ${add(q.category)}`);
  if (q.q && use("q")) {
    const like = add(`%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(p.name->>'ar' ilike ${like} or p.name->>'fr' ilike ${like} or p.name->>'en' ilike ${like} or c.name->>'ar' ilike ${like} or c.name->>'fr' ilike ${like} or c.name->>'en' ilike ${like})`);
  }
  if (q.minPrice !== undefined && use("minPrice")) where.push(`mv.price >= ${add(q.minPrice)}`);
  if (q.maxPrice !== undefined && use("maxPrice")) where.push(`mv.price <= ${add(q.maxPrice)}`);
  const size = use("size") ? q.size : undefined;
  const color = use("color") ? q.color : undefined;
  if (size || color) {
    const conds = ["v.product_id = p.id", "v.stock > 0"];
    if (size) conds.push(`v.size = ${add(size)}`);
    if (color) conds.push(`lower(v.color) = lower(${add(color)})`);
    where.push(`exists (select 1 from public.product_variants v where ${conds.join(" and ")})`);
  }
  return { where: where.join(" and "), params, add };
}

catalogRoutes.openapi(
  createRoute({ method: "get", path: "/catalog/products", tags: ["Catalog"], summary: "List / search / filter products", request: { query: ListQuery }, responses: { 200: json(z.array(ProductSummarySchema), "OK") } }),
  async (c) => {
    const q = c.req.valid("query");
    const { where, params, add } = listWhere(q);
    const order = {
      newest: "p.created_at desc, p.id",
      price_asc: "mv.price asc, p.id",
      price_desc: "mv.price desc, p.id",
      discount: "(1 - mv.price::numeric / nullif(mv.compare_at_price, 0)) desc nulls last, p.created_at desc",
    }[q.sort];

    const rows = await c.get("db").query<SummaryRow>(
      `${SUMMARY_SQL} where ${where} order by ${order} limit ${add(q.limit)} offset ${add(q.offset)}`,
      params,
    );
    return c.json(rows.map((r) => toSummary(r, q.locale)), 200);
  },
);

const FiltersSchema = z
  .object({
    /** Products matching ALL the filters (for "N results" and paging). */
    total: z.number().int(),
    /** Categories that have matching products for the search text (ignores the chosen category, so the user can switch). */
    categories: z.array(z.object({ slug: z.string(), name: z.string(), count: z.number().int() })),
    /** Sizes in stock for the products matching the other filters, in garment order. */
    sizes: z.array(z.string()),
    colors: z.array(z.string()),
    /** The same colors with their swatch hex (for round dots in the filter panel). */
    colorSwatches: z.array(z.object({ name: z.string(), hex: z.string().nullable() })),
    /** Cheapest-variant price range of the products matching the other filters; null when nothing matches. */
    priceRange: z.union([z.object({ min: z.number().int(), max: z.number().int() }), z.null()]),
  })
  .openapi("CatalogFilters");

catalogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog/filters",
    tags: ["Catalog"],
    summary: "What the filter panel can offer for a search (categories, sizes, colors, price range) and how many products match",
    request: { query: ListQuery.omit({ sort: true, limit: true, offset: true }) },
    responses: { 200: json(FiltersSchema, "OK") },
  }),
  async (c) => {
    const q = c.req.valid("query");
    const db = c.get("db");
    const all = listWhere(q);
    const cat = listWhere(q, ["category", "size", "color", "minPrice", "maxPrice"]);
    const forSizes = listWhere(q, ["size"]);
    const forColors = listWhere(q, ["color"]);
    const forPrice = listWhere(q, ["minPrice", "maxPrice"]);
    const base = `from public.products p join public.categories c on c.id = p.category_id and c.is_active
      join lateral (select v.price from public.product_variants v where v.product_id = p.id order by v.price, v.id limit 1) mv on true`;
    const [total, categories, sizes, colors, price] = await Promise.all([
      db.query<{ n: number }>(`select count(*)::int as n ${base} where ${all.where}`, all.params),
      db.query<{ slug: string; name: unknown; n: number }>(`select c.slug, c.name, count(*)::int as n ${base} where ${cat.where} group by c.slug, c.name, c.sort_order order by c.sort_order, c.slug`, cat.params),
      db.query<{ size: string }>(
        `select size from (select distinct v.size ${base} join public.product_variants v on v.product_id = p.id and v.stock > 0 where ${forSizes.where}) s
          order by coalesce(array_position(array['XXS','XS','S','M','L','XL','XXL','XXXL'], size), 100), size`,
        forSizes.params,
      ),
      db.query<{ color: string; color_hex: string | null }>(`select distinct on (lower(v.color)) v.color, v.color_hex ${base} join public.product_variants v on v.product_id = p.id and v.stock > 0 where ${forColors.where} order by lower(v.color), v.id`, forColors.params),
      db.query<{ lo: number | null; hi: number | null }>(`select min(mv.price) as lo, max(mv.price) as hi ${base} where ${forPrice.where}`, forPrice.params),
    ]);
    const lo = price[0]?.lo;
    return c.json(
      {
        total: Number(total[0]?.n ?? 0),
        categories: categories.map((r) => ({ slug: r.slug, name: pick(r.name, q.locale), count: Number(r.n) })),
        sizes: sizes.map((r) => r.size),
        colors: colors.map((r) => r.color),
        colorSwatches: colors.map((r) => ({ name: r.color, hex: swatchHex(r.color, r.color_hex) })),
        priceRange: lo === null || lo === undefined ? null : { min: Number(lo), max: Number(price[0]!.hi) },
      },
      200,
    );
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
      db.query<{ path: string; alt: unknown; color: string | null }>(`select path, alt, color from public.product_images where product_id = $1 order by sort_order, id`, [row.id]),
      db.query<{ id: string; size: string; color: string; color_hex: string | null; stock: number; price: number; compare_at_price: number | null }>(
        `select v.id, v.size, v.color, v.color_hex, v.stock, v.price, v.compare_at_price from public.product_variants v where v.product_id = $1 order by ${SIZE_RANK}, v.color`,
        [row.id],
      ),
    ]);
    const summary = toSummary(row, locale);
    const imgs = images.map((i) => ({ url: imageUrl(i.path) ?? "", alt: pickOrNull(i.alt, locale) ?? summary.name, color: i.color }));
    return c.json(
      {
        ...summary,
        description: pick(row.description, locale),
        images: imgs.length ? imgs : [{ ...summary.image, color: null }],
        sizes: [...new Set(variants.map((v) => v.size))],
        variants: variants.map((v) => ({
          id: v.id,
          size: v.size,
          color: v.color,
          colorHex: swatchHex(v.color, v.color_hex),
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
