import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { full, I18nSchema, LocaleQuery, OptionalI18nSchema, pick, toJson, type Locale } from "../lib/i18n.js";
import { imageUrl, toStoredPath } from "../lib/media.js";
import { moveRow } from "../lib/reorder.js";
import { slugify, slugSource, uniqueSlug } from "../lib/slug.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 409: json(ErrorSchema, "Conflict"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const Id = z.object({ id: z.string().uuid() });
const ImageRef = z.string().min(1).max(1000).refine((v) => !v.startsWith("data:"), "Inline images are not allowed; upload the file");
const NullableImage = z.string().max(1000).refine((v) => !v.startsWith("data:"), "Inline images are not allowed; upload the file").nullable();
const like = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

export const adminCatalogRoutes = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
const AdminCategory = z
  .object({ id: z.string().uuid(), slug: z.string(), name: OptionalI18nSchema, imageUrl: z.string().nullable(), isActive: z.boolean(), productCount: z.number().int() })
  .openapi("AdminCategory");
const CategoryInput = z.object({ name: I18nSchema, imageUrl: NullableImage.default(null), isActive: z.boolean().default(true) }).openapi("CategoryInput");
type CatRow = { id: string; slug: string; name: unknown; image_path: string | null; is_active: boolean; n: number };
const catOut = (r: CatRow) => ({ id: r.id, slug: r.slug, name: full(r.name), imageUrl: imageUrl(r.image_path), isActive: r.is_active, productCount: Number(r.n) });
const CAT_SELECT = `select c.id, c.slug, c.name, c.image_path, c.is_active, (select count(*)::int from public.products p where p.category_id = c.id) as n from public.categories c`;

adminCatalogRoutes.openapi(
  createRoute({ method: "get", path: "/admin/categories", tags: ["Admin"], security, summary: "All categories (including hidden) in display order", responses: { 200: json(z.array(AdminCategory), "OK"), ...errors } }),
  async (c) => c.json((await c.get("db").query<CatRow>(`${CAT_SELECT} order by c.sort_order, c.created_at, c.id`)).map(catOut), 200),
);
adminCatalogRoutes.openapi(
  createRoute({ method: "post", path: "/admin/categories", tags: ["Admin"], security, summary: "Add a category (appended at the end)", request: { body: body(CategoryInput) }, responses: { 200: json(AdminCategory, "Created"), ...errors } }),
  async (c) => {
    const b = c.req.valid("json");
    const db = c.get("db");
    const id = await db.tx(async (q) => {
      const slug = await uniqueSlug(q, "categories", slugify(slugSource(b.name), "category"));
      const r = await q.query<{ id: string }>(
        `insert into public.categories (slug, name, image_path, is_active, sort_order)
         values ($1, $2::jsonb, $3, $4, coalesce((select max(sort_order) + 1 from public.categories), 0)) returning id`,
        [slug, toJson(b.name), toStoredPath(b.imageUrl), b.isActive],
      );
      return r[0]!.id;
    });
    return c.json(catOut((await db.query<CatRow>(`${CAT_SELECT} where c.id = $1`, [id]))[0]!), 200);
  },
);
adminCatalogRoutes.openapi(
  createRoute({ method: "put", path: "/admin/categories/{id}", tags: ["Admin"], security, summary: "Edit a category (its URL slug never changes)", request: { params: Id, body: body(CategoryInput) }, responses: { 200: json(AdminCategory, "Updated"), ...errors } }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = c.get("db");
    const r = await db.query(`update public.categories set name = $2::jsonb, image_path = $3, is_active = $4 where id = $1 returning id`, [id, toJson(b.name), toStoredPath(b.imageUrl), b.isActive]);
    if (!r.length) throw new ApiError(404, "not_found", "Category not found");
    return c.json(catOut((await db.query<CatRow>(`${CAT_SELECT} where c.id = $1`, [id]))[0]!), 200);
  },
);
adminCatalogRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/categories/{id}", tags: ["Admin"], security, summary: "Delete an empty category (refused while it still has products)", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const n = (await db.query<{ n: number }>(`select count(*)::int as n from public.products where category_id = $1`, [id]))[0]?.n ?? 0;
    if (Number(n) > 0) throw new ApiError(409, "category_not_empty", "Move or delete the category's products first");
    const r = await db.query(`delete from public.categories where id = $1 returning id`, [id]);
    if (!r.length) throw new ApiError(404, "not_found", "Category not found");
    return c.json({ ok: true as const }, 200);
  },
);
adminCatalogRoutes.openapi(
  createRoute({ method: "post", path: "/admin/categories/{id}/move", tags: ["Admin"], security, summary: "Move a category one step earlier (-1) or later (+1)", request: { params: Id, body: body(z.object({ direction: z.union([z.literal(-1), z.literal(1)]) })) }, responses: { 200: json(Ok, "Moved"), ...errors } }),
  async (c) => {
    await moveRow(c.get("db"), "categories", c.req.valid("param").id, c.req.valid("json").direction);
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
const AdminCollection = z
  .object({ id: z.string().uuid(), slug: z.string(), title: OptionalI18nSchema, subtitle: OptionalI18nSchema, heroUrl: z.string().nullable(), isPublished: z.boolean(), productIds: z.array(z.string().uuid()) })
  .openapi("AdminCollection");
const CollectionInput = z
  .object({ title: I18nSchema, subtitle: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }), heroUrl: NullableImage.default(null), isPublished: z.boolean().default(false), productIds: z.array(z.string().uuid()).max(500).default([]) })
  .openapi("CollectionInput");
type ColRow = { id: string; slug: string; title: unknown; subtitle: unknown; hero_path: string | null; is_published: boolean; product_ids: string[] | null };
const colOut = (r: ColRow) => ({ id: r.id, slug: r.slug, title: full(r.title), subtitle: full(r.subtitle), heroUrl: imageUrl(r.hero_path), isPublished: r.is_published, productIds: r.product_ids ?? [] });
const COL_SELECT = `select c.id, c.slug, c.title, c.subtitle, c.hero_path, c.is_published,
  (select array_agg(cp.product_id order by cp.sort_order) from public.collection_products cp where cp.collection_id = c.id) as product_ids
  from public.collections c`;

adminCatalogRoutes.openapi(
  createRoute({ method: "get", path: "/admin/collections", tags: ["Admin"], security, summary: "All collections with their product ids", responses: { 200: json(z.array(AdminCollection), "OK"), ...errors } }),
  async (c) => c.json((await c.get("db").query<ColRow>(`${COL_SELECT} order by c.sort_order, c.created_at, c.id`)).map(colOut), 200),
);

const saveCollection = async (db: import("../lib/db.js").Db, id: string | null, b: z.infer<typeof CollectionInput>) =>
  db.tx(async (q) => {
    let cid = id;
    if (cid) {
      const r = await q.query(`update public.collections set title = $2::jsonb, subtitle = $3::jsonb, hero_path = $4, is_published = $5 where id = $1 returning id`, [cid, toJson(b.title), toJson(b.subtitle), toStoredPath(b.heroUrl), b.isPublished]);
      if (!r.length) throw new ApiError(404, "not_found", "Collection not found");
    } else {
      const slug = await uniqueSlug(q, "collections", slugify(slugSource(b.title), "collection"));
      cid = (await q.query<{ id: string }>(
        `insert into public.collections (slug, title, subtitle, hero_path, is_published, sort_order)
         values ($1, $2::jsonb, $3::jsonb, $4, $5, coalesce((select max(sort_order) + 1 from public.collections), 0)) returning id`,
        [slug, toJson(b.title), toJson(b.subtitle), toStoredPath(b.heroUrl), b.isPublished],
      ))[0]!.id;
    }
    await q.query(`delete from public.collection_products where collection_id = $1`, [cid]);
    const ids = [...new Set(b.productIds)];
    if (ids.length) {
      const ok = await q.query<{ id: string }>(`select id from public.products where id = any($1::uuid[])`, [ids]);
      if (ok.length !== ids.length) throw new ApiError(422, "unknown_product", "One of the products does not exist");
      await q.query(`insert into public.collection_products (collection_id, product_id, sort_order) select $1, x.id, x.ord - 1 from unnest($2::uuid[]) with ordinality as x(id, ord)`, [cid, ids]);
    }
    return (await q.query<ColRow>(`${COL_SELECT} where c.id = $1`, [cid]))[0]!;
  });

adminCatalogRoutes.openapi(
  createRoute({ method: "post", path: "/admin/collections", tags: ["Admin"], security, summary: "Create a collection with its products (in the given order)", request: { body: body(CollectionInput) }, responses: { 200: json(AdminCollection, "Created"), ...errors } }),
  async (c) => c.json(colOut(await saveCollection(c.get("db"), null, c.req.valid("json"))), 200),
);
adminCatalogRoutes.openapi(
  createRoute({ method: "put", path: "/admin/collections/{id}", tags: ["Admin"], security, summary: "Edit a collection (the product list is replaced)", request: { params: Id, body: body(CollectionInput) }, responses: { 200: json(AdminCollection, "Updated"), ...errors } }),
  async (c) => c.json(colOut(await saveCollection(c.get("db"), c.req.valid("param").id, c.req.valid("json"))), 200),
);
adminCatalogRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/collections/{id}", tags: ["Admin"], security, summary: "Delete a collection (its products stay)", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const r = await c.get("db").query(`delete from public.collections where id = $1 returning id`, [c.req.valid("param").id]);
    if (!r.length) throw new ApiError(404, "not_found", "Collection not found");
    return c.json({ ok: true as const }, 200);
  },
);
adminCatalogRoutes.openapi(
  createRoute({ method: "post", path: "/admin/collections/{id}/move", tags: ["Admin"], security, summary: "Move a collection one step earlier (-1) or later (+1)", request: { params: Id, body: body(z.object({ direction: z.union([z.literal(-1), z.literal(1)]) })) }, responses: { 200: json(Ok, "Moved"), ...errors } }),
  async (c) => {
    await moveRow(c.get("db"), "collections", c.req.valid("param").id, c.req.valid("json").direction);
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
const VariantInput = z
  .object({
    id: z.string().uuid().optional(),
    size: z.string().trim().min(1).max(10),
    color: z.string().trim().max(40).default(""),
    sku: z.string().trim().max(40).nullable().default(null),
    stock: z.number().int().min(0).max(100000),
    price: z.number().int().min(1).max(10_000_000),
    compareAtPrice: z.number().int().min(1).max(10_000_000).nullable().default(null),
  })
  .refine((v) => v.compareAtPrice === null || v.compareAtPrice > v.price, { message: "The compare-at price must be higher than the price", path: ["compareAtPrice"] })
  .openapi("VariantInput");

const ProductInput = z
  .object({
    name: I18nSchema,
    description: OptionalI18nSchema.default({ ar: "", fr: "", en: "" }),
    categoryId: z.string().uuid(),
    brandId: z.string().uuid().nullable().default(null),
    isPublished: z.boolean().default(false),
    isNew: z.boolean().default(false),
    /** Image URLs in display order (the first one is the cover). */
    images: z.array(ImageRef).max(10).default([]),
    variants: z.array(VariantInput).max(60).default([]),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.variants.forEach((v, i) => {
      const k = `${v.size.toLowerCase()}|${v.color.toLowerCase()}`;
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["variants", i, "size"], message: "Two variants have the same size and colour" });
      seen.add(k);
    });
    if (p.isPublished && p.variants.length === 0) ctx.addIssue({ code: "custom", path: ["variants"], message: "A published product needs at least one variant" });
    if (p.isPublished && p.images.length === 0) ctx.addIssue({ code: "custom", path: ["images"], message: "A published product needs at least one image" });
  })
  .openapi("ProductInput");

const ProductDetail = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: OptionalI18nSchema,
    description: OptionalI18nSchema,
    categoryId: z.string().uuid(),
    brandId: z.string().uuid().nullable(),
    isPublished: z.boolean(),
    isNew: z.boolean(),
    images: z.array(z.object({ url: z.string() })),
    variants: z.array(z.object({ id: z.string().uuid(), size: z.string(), color: z.string(), sku: z.string().nullable(), stock: z.number().int(), price: z.number().int(), compareAtPrice: z.number().int().nullable() })),
  })
  .openapi("AdminProduct");

const ProductRow = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    categoryName: z.string(),
    isPublished: z.boolean(),
    isNew: z.boolean(),
    /** Cheapest variant price (null while there is no variant). */
    price: z.number().int().nullable(),
    compareAtPrice: z.number().int().nullable(),
    totalStock: z.number().int(),
    variantCount: z.number().int(),
    image: z.string().nullable(),
  })
  .openapi("AdminProductRow");

async function loadProduct(q: import("../lib/db.js").Query, id: string) {
  const p = (await q.query<{ id: string; slug: string; name: unknown; description: unknown; category_id: string; brand_id: string | null; is_published: boolean; is_new: boolean }>(
    `select id, slug, name, description, category_id, brand_id, is_published, is_new from public.products where id = $1`, [id]))[0];
  if (!p) throw new ApiError(404, "not_found", "Product not found");
  const [images, variants] = await Promise.all([
    q.query<{ path: string }>(`select path from public.product_images where product_id = $1 order by sort_order, id`, [id]),
    q.query<{ id: string; size: string; color: string; sku: string | null; stock: number; price: number; compare_at_price: number | null }>(
      `select v.id, v.size, v.color, v.sku, v.stock, v.price, v.compare_at_price from public.product_variants v where v.product_id = $1
        order by coalesce(array_position(array['XXS','XS','S','M','L','XL','XXL','XXXL'], v.size), 100), v.size, v.color`, [id]),
  ]);
  return {
    id: p.id, slug: p.slug, name: full(p.name), description: full(p.description), categoryId: p.category_id, brandId: p.brand_id, isPublished: p.is_published, isNew: p.is_new,
    images: images.map((i) => ({ url: imageUrl(i.path) ?? "" })),
    variants: variants.map((v) => ({ id: v.id, size: v.size, color: v.color, sku: v.sku, stock: Number(v.stock), price: Number(v.price), compareAtPrice: v.compare_at_price ? Number(v.compare_at_price) : null })),
  };
}

async function saveProduct(db: import("../lib/db.js").Db, id: string | null, b: z.infer<typeof ProductInput>) {
  const pid = await db.tx(async (q) => {
    if (!(await q.query(`select 1 from public.categories where id = $1`, [b.categoryId])).length) throw new ApiError(422, "unknown_category", "The category does not exist");
    if (b.brandId && !(await q.query(`select 1 from public.brands where id = $1`, [b.brandId])).length) throw new ApiError(422, "unknown_brand", "The brand does not exist");
    let productId = id;
    if (productId) {
      const r = await q.query(
        `update public.products set name = $2::jsonb, description = $3::jsonb, category_id = $4, brand_id = $5, is_published = $6, is_new = $7 where id = $1 returning id`,
        [productId, toJson(b.name), toJson(b.description), b.categoryId, b.brandId, b.isPublished, b.isNew],
      );
      if (!r.length) throw new ApiError(404, "not_found", "Product not found");
    } else {
      const slug = await uniqueSlug(q, "products", slugify(slugSource(b.name), "product"));
      productId = (await q.query<{ id: string }>(
        `insert into public.products (slug, name, description, category_id, brand_id, is_published, is_new) values ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7) returning id`,
        [slug, toJson(b.name), toJson(b.description), b.categoryId, b.brandId, b.isPublished, b.isNew],
      ))[0]!.id;
    }
    // Images: replaced in the given order.
    await q.query(`delete from public.product_images where product_id = $1`, [productId]);
    for (const [i, url] of b.images.entries()) {
      await q.query(`insert into public.product_images (product_id, path, sort_order) values ($1, $2, $3)`, [productId, toStoredPath(url), i]);
    }
    // Variants: update the known ones, insert the new ones, remove the ones that disappeared.
    const keep = b.variants.filter((v) => v.id).map((v) => v.id!);
    const existing = await q.query<{ id: string }>(`select id from public.product_variants where product_id = $1`, [productId]);
    const owned = new Set(existing.map((e) => e.id));
    if (keep.some((k) => !owned.has(k))) throw new ApiError(422, "unknown_variant", "A variant does not belong to this product");
    await q.query(`delete from public.product_variants where product_id = $1 and not (id = any($2::uuid[]))`, [productId, keep]);
    for (const v of b.variants) {
      const sku = v.sku?.trim() ? v.sku.trim().toUpperCase() : null;
      if (v.id) {
        await q.query(`update public.product_variants set size = $2, color = $3, sku = $4, stock = $5, price = $6, compare_at_price = $7 where id = $1`, [v.id, v.size, v.color, sku, v.stock, v.price, v.compareAtPrice]);
      } else {
        await q.query(`insert into public.product_variants (product_id, size, color, sku, stock, price, compare_at_price) values ($1, $2, $3, $4, $5, $6, $7)`, [productId, v.size, v.color, sku, v.stock, v.price, v.compareAtPrice]);
      }
    }
    return productId;
  });
  return loadProduct(db, pid);
}

adminCatalogRoutes.openapi(
  createRoute({
    method: "get", path: "/admin/products", tags: ["Admin"], security, summary: "Products (published and drafts) with search and filters",
    request: { query: z.object({ locale: LocaleQuery, q: z.string().trim().max(80).optional(), categoryId: z.string().uuid().optional(), status: z.enum(["published", "draft"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }) },
    responses: { 200: json(z.object({ items: z.array(ProductRow), total: z.number().int() }).openapi("AdminProductList"), "OK"), ...errors },
  }),
  async (c) => {
    const f = c.req.valid("query");
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown) => (params.push(v), `$${params.length}`);
    if (f.categoryId) where.push(`p.category_id = ${add(f.categoryId)}`);
    if (f.status) where.push(f.status === "published" ? "p.is_published" : "not p.is_published");
    if (f.q) {
      const l = add(like(f.q));
      where.push(`(p.name->>'ar' ilike ${l} or p.name->>'fr' ilike ${l} or p.name->>'en' ilike ${l} or p.slug ilike ${l} or exists (select 1 from public.product_variants v where v.product_id = p.id and v.sku ilike ${l}))`);
    }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const db = c.get("db");
    const [rows, count] = await Promise.all([
      db.query<{ id: string; slug: string; name: unknown; cat: unknown; is_published: boolean; is_new: boolean; price: number | null; compare: number | null; stock: number; n: number; path: string | null }>(
        `select p.id, p.slug, p.name, c.name as cat, p.is_published, p.is_new, mv.price, mv.compare_at_price as compare,
                (select coalesce(sum(v.stock), 0)::int from public.product_variants v where v.product_id = p.id) as stock,
                (select count(*)::int from public.product_variants v where v.product_id = p.id) as n,
                (select i.path from public.product_images i where i.product_id = p.id order by i.sort_order, i.id limit 1) as path
           from public.products p join public.categories c on c.id = p.category_id
           left join lateral (select v.price, v.compare_at_price from public.product_variants v where v.product_id = p.id order by v.price, v.id limit 1) mv on true
           ${w} order by p.created_at desc, p.id limit ${add(f.limit)} offset ${add(f.offset)}`, params),
      db.query<{ n: number }>(`select count(*)::int as n from public.products p ${w}`, params.slice(0, params.length - 2)),
    ]);
    return c.json({
      items: rows.map((r) => ({ id: r.id, slug: r.slug, name: pick(r.name, f.locale as Locale), categoryName: pick(r.cat, f.locale as Locale), isPublished: r.is_published, isNew: r.is_new, price: r.price === null ? null : Number(r.price), compareAtPrice: r.compare ? Number(r.compare) : null, totalStock: Number(r.stock), variantCount: Number(r.n), image: imageUrl(r.path) })),
      total: Number(count[0]?.n ?? 0),
    }, 200);
  },
);
adminCatalogRoutes.openapi(
  createRoute({ method: "get", path: "/admin/products/{id}", tags: ["Admin"], security, summary: "One product with all its translations, images and variants", request: { params: Id }, responses: { 200: json(ProductDetail, "OK"), ...errors } }),
  async (c) => c.json(await loadProduct(c.get("db"), c.req.valid("param").id), 200),
);
adminCatalogRoutes.openapi(
  createRoute({ method: "post", path: "/admin/products", tags: ["Admin"], security, summary: "Create a product with its images and variants", request: { body: body(ProductInput) }, responses: { 200: json(ProductDetail, "Created"), ...errors } }),
  async (c) => c.json(await saveProduct(c.get("db"), null, c.req.valid("json")), 200),
);
adminCatalogRoutes.openapi(
  createRoute({ method: "put", path: "/admin/products/{id}", tags: ["Admin"], security, summary: "Edit a product: images and variants are synchronised with the given lists (its URL slug never changes)", request: { params: Id, body: body(ProductInput) }, responses: { 200: json(ProductDetail, "Updated"), ...errors } }),
  async (c) => c.json(await saveProduct(c.get("db"), c.req.valid("param").id, c.req.valid("json")), 200),
);
adminCatalogRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/products/{id}", tags: ["Admin"], security, summary: "Delete a product (past orders keep their item snapshots)", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const r = await c.get("db").query(`delete from public.products where id = $1 returning id`, [c.req.valid("param").id]);
    if (!r.length) throw new ApiError(404, "not_found", "Product not found");
    return c.json({ ok: true as const }, 200);
  },
);
adminCatalogRoutes.openapi(
  createRoute({
    method: "post", path: "/admin/products/publish", tags: ["Admin"], security, summary: "Publish or hide several products at once (publishing skips products without a variant or an image)",
    request: { body: body(z.object({ ids: z.array(z.string().uuid()).min(1).max(200), isPublished: z.boolean() })) },
    responses: { 200: json(z.object({ updated: z.number().int() }), "OK"), ...errors },
  }),
  async (c) => {
    const { ids, isPublished } = c.req.valid("json");
    const r = await c.get("db").query(
      `update public.products p set is_published = $2 where p.id = any($1::uuid[])
          and ($2 = false or (exists (select 1 from public.product_variants v where v.product_id = p.id) and exists (select 1 from public.product_images i where i.product_id = p.id)))
        returning p.id`,
      [ids, isPublished],
    );
    return c.json({ updated: r.length }, 200);
  },
);

// ---------------------------------------------------------------------------
// Inventory: prices and stock for many variants at once
// ---------------------------------------------------------------------------
const VariantRow = z
  .object({ variantId: z.string().uuid(), productId: z.string().uuid(), productName: z.string(), image: z.string().nullable(), size: z.string(), color: z.string(), stock: z.number().int(), price: z.number().int(), compareAtPrice: z.number().int().nullable() })
  .openapi("AdminVariantRow");

adminCatalogRoutes.openapi(
  createRoute({
    method: "get", path: "/admin/variants", tags: ["Admin"], security, summary: "Every variant with price and stock (search, low stock filter) for bulk editing",
    request: { query: z.object({ locale: LocaleQuery, q: z.string().trim().max(80).optional(), lowStock: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }) },
    responses: { 200: json(z.object({ items: z.array(VariantRow), total: z.number().int() }).openapi("AdminVariantList"), "OK"), ...errors },
  }),
  async (c) => {
    const f = c.req.valid("query");
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown) => (params.push(v), `$${params.length}`);
    if (f.lowStock === "true") where.push("v.stock <= 3");
    if (f.q) {
      const l = add(like(f.q));
      where.push(`(p.name->>'ar' ilike ${l} or p.name->>'fr' ilike ${l} or p.name->>'en' ilike ${l} or v.sku ilike ${l} or v.size ilike ${l})`);
    }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const base = `from public.product_variants v join public.products p on p.id = v.product_id ${w}`;
    const db = c.get("db");
    const [rows, count] = await Promise.all([
      db.query<{ id: string; pid: string; name: unknown; path: string | null; size: string; color: string; stock: number; price: number; compare: number | null }>(
        `select v.id, p.id as pid, p.name, (select i.path from public.product_images i where i.product_id = p.id order by i.sort_order, i.id limit 1) as path,
                v.size, v.color, v.stock, v.price, v.compare_at_price as compare
           ${base} order by p.created_at desc, p.id, coalesce(array_position(array['XXS','XS','S','M','L','XL','XXL','XXXL'], v.size), 100), v.size limit ${add(f.limit)} offset ${add(f.offset)}`, params),
      db.query<{ n: number }>(`select count(*)::int as n ${base}`, params.slice(0, params.length - 2)),
    ]);
    return c.json({
      items: rows.map((r) => ({ variantId: r.id, productId: r.pid, productName: pick(r.name, f.locale as Locale), image: imageUrl(r.path), size: r.size, color: r.color, stock: Number(r.stock), price: Number(r.price), compareAtPrice: r.compare ? Number(r.compare) : null })),
      total: Number(count[0]?.n ?? 0),
    }, 200);
  },
);

adminCatalogRoutes.openapi(
  createRoute({
    method: "post", path: "/admin/variants/bulk", tags: ["Admin"], security,
    summary: "Change price, compare-at price and/or stock of many variants in one go (all or nothing)",
    request: { body: body(z.object({ updates: z.array(z.object({ variantId: z.string().uuid(), price: z.number().int().min(1).max(10_000_000).optional(), compareAtPrice: z.number().int().min(1).max(10_000_000).nullable().optional(), stock: z.number().int().min(0).max(100000).optional() })).min(1).max(500) })) },
    responses: { 200: json(z.object({ updated: z.number().int() }), "OK"), ...errors },
  }),
  async (c) => {
    const { updates } = c.req.valid("json");
    const n = await c.get("db").tx(async (q) => {
      let count = 0;
      for (const u of updates) {
        const sets: string[] = [];
        const params: unknown[] = [u.variantId];
        const add = (v: unknown) => (params.push(v), `$${params.length}`);
        if (u.price !== undefined) sets.push(`price = ${add(u.price)}`);
        if (u.compareAtPrice !== undefined) sets.push(`compare_at_price = ${add(u.compareAtPrice)}`);
        if (u.stock !== undefined) sets.push(`stock = ${add(u.stock)}`);
        if (!sets.length) continue;
        const r = await q.query(`update public.product_variants set ${sets.join(", ")} where id = $1 returning id`, params);
        if (!r.length) throw new ApiError(404, "not_found", "A variant does not exist");
        count++;
      }
      return count;
    });
    return c.json({ updated: n }, 200);
  },
);
