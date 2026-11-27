import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let token: string;

async function call(method: string, path: string, json?: unknown, auth = true) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (auth) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const pub = async (path: string) => (await app.request(path)).json() as Promise<any>;

/** The dashboard turns a product it read ({images: [{url}]}) back into the input shape ({images: [url]}). */
const inputOf = (p: any) => ({ ...p, images: p.images.map((i: { url: string }) => i.url) });

const variant = (over: Record<string, unknown> = {}) => ({ size: "M", color: "black", sku: null, stock: 5, price: 4000, compareAtPrice: null, ...over });
async function newProduct(over: Record<string, unknown> = {}) {
  const cat = (await call("GET", "/admin/categories")).body[0].id;
  return call("POST", "/admin/products", {
    name: { ar: "قميص تجريبي", fr: "Chemise test", en: "Test Shirt" }, description: { ar: "وصف", fr: "", en: "Description" }, categoryId: cat,
    isPublished: false, isNew: true, images: ["/placeholders/shirt-white-1.svg"], variants: [variant({ size: "S" }), variant({ size: "M" })], ...over,
  });
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  token = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("categories", () => {
  it("lists, creates (slug from the French name), edits, reorders and protects non-empty categories", async () => {
    const list = await call("GET", "/admin/categories");
    expect(list.body.map((c: any) => c.slug)).toEqual(["outerwear", "tops", "footwear", "bottoms"]);
    expect(list.body[0]).toMatchObject({ productCount: 6, isActive: true });

    const created = await call("POST", "/admin/categories", { name: { ar: "إكسسوارات", fr: "Accessoires", en: "Accessories" } });
    expect(created.body).toMatchObject({ slug: "accessoires", productCount: 0, isActive: true });
    const id = created.body.id as string;
    expect((await call("POST", "/admin/categories", { name: { ar: "إكسسوارات 2", fr: "Accessoires" } })).body.slug).toMatch(/^accessoires-[a-z0-9]{4}$/); // slug already taken
    const arabicOnly = await call("POST", "/admin/categories", { name: { ar: "أحزمة" } });
    expect(arabicOnly.body.slug).toMatch(/^category(-[a-z0-9]+)?$/); // Arabic only → generic slug

    await call("POST", `/admin/categories/${id}/move`, { direction: -1 });
    const order = (await call("GET", "/admin/categories")).body.map((c: any) => c.slug);
    expect(order.indexOf("accessoires")).toBeLessThan(order.indexOf(arabicOnly.body.slug));

    const edited = await call("PUT", `/admin/categories/${id}`, { name: { ar: "ملحقات", fr: "Accessoires", en: "" }, isActive: false });
    expect(edited.body).toMatchObject({ slug: "accessoires", isActive: false });
    // hidden categories disappear from the storefront
    expect((await pub("/catalog/categories")).map((c: any) => c.slug)).not.toContain("accessoires");

    const refused = await call("DELETE", `/admin/categories/${(await call("GET", "/admin/categories")).body[0].id}`);
    expect(refused.status).toBe(409);
    expect((await call("DELETE", `/admin/categories/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/categories/${id}`)).status).toBe(404);
    expect((await call("POST", "/admin/categories", { name: { ar: "" } })).status).toBe(422);
  });
});

describe("products", () => {
  let id: string;
  let slug: string;

  it("creates a draft that visitors cannot see, with a clean slug and sorted variants", async () => {
    const r = await newProduct({ variants: [variant({ size: "XL" }), variant({ size: "S", sku: "tee-s" }), variant({ size: "M" })] });
    expect(r.status).toBe(200);
    id = r.body.id; slug = r.body.slug;
    expect(slug).toBe("chemise-test");
    expect(r.body).toMatchObject({ isPublished: false, isNew: true, name: { ar: "قميص تجريبي", fr: "Chemise test", en: "Test Shirt" } });
    expect(r.body.variants.map((v: any) => v.size)).toEqual(["S", "M", "XL"]);
    expect(r.body.variants[0].sku).toBe("TEE-S"); // upper-cased
    expect(r.body.images).toEqual([{ url: "/placeholders/shirt-white-1.svg", color: null }]);
    expect((await app.request(`/catalog/products/${slug}`)).status).toBe(404);
    expect((await pub("/catalog/products?limit=100")).map((p: any) => p.slug)).not.toContain(slug);
  });

  it("publishing makes it public with the right price, cover and sizes", async () => {
    const cur = (await call("GET", `/admin/products/${id}`)).body;
    const put = await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), isPublished: true, variants: cur.variants.map((v: any) => (v.size === "S" ? { ...v, price: 3500, compareAtPrice: 4500 } : v)) });
    expect(put.status).toBe(200);
    const page = await pub(`/catalog/products/${slug}?locale=fr`);
    expect(page).toMatchObject({ name: "Chemise test", price: 3500, compareAtPrice: 4500, sizes: ["S", "M", "XL"], isNew: true });
    expect(page.image.url).toBe("/placeholders/shirt-white-1.svg");
    expect((await pub("/catalog/sale?locale=en")).products.map((p: any) => p.slug)).toContain(slug);
  });

  it("keeps variant ids when editing, adds and removes variants, and reorders images", async () => {
    const cur = (await call("GET", `/admin/products/${id}`)).body;
    const m = cur.variants.find((v: any) => v.size === "M");
    const put = await call("PUT", `/admin/products/${id}`, {
      ...cur,
      images: ["/placeholders/shirt-white-2.svg", "https://img.example.com/uploads/2026/11/a.webp"],
      variants: [{ ...m, stock: 9 }, variant({ size: "L" })], // S and XL removed, L added
    });
    expect(put.body.variants.map((v: any) => v.size)).toEqual(["M", "L"]);
    expect(put.body.variants[0]).toMatchObject({ id: m.id, stock: 9 });
    expect(put.body.images.map((i: any) => i.url)).toEqual(["/placeholders/shirt-white-2.svg", "https://img.example.com/uploads/2026/11/a.webp"]);
    const stored = (await pg.query<{ path: string }>(`select path from product_images where product_id = $1 order by sort_order`, [id])).rows.map((r) => r.path);
    expect(stored[1]).toBe("uploads/2026/11/a.webp"); // only the R2 key is stored
  });

  it("validates input: compare-at price, duplicates, empty variants when publishing, foreign variant ids", async () => {
    const cur = (await call("GET", `/admin/products/${id}`)).body;
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), variants: [variant({ price: 5000, compareAtPrice: 4000 })] })).status).toBe(422);
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), variants: [variant(), variant({ size: "m", color: "BLACK" })] })).status).toBe(422);
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), variants: [] })).status).toBe(422); // published product needs a variant
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), images: [] })).status).toBe(422); // ... and an image
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), variants: [{ ...variant(), id: "00000000-0000-4000-8000-000000000001" }] })).body.error.code).toBe("unknown_variant");
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), categoryId: "00000000-0000-4000-8000-000000000001" })).body.error.code).toBe("unknown_category");
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), images: ["data:image/png;base64,AAAA"] })).status).toBe(422);
    expect((await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), variants: [variant({ price: 0 })] })).status).toBe(422);
    expect((await call("PUT", `/admin/products/00000000-0000-4000-8000-000000000001`, inputOf(cur))).status).toBe(404);
    // a failed edit changes nothing
    expect((await call("GET", `/admin/products/${id}`)).body.variants).toHaveLength(2);
  });

  it("a duplicate SKU is a 409, and the whole edit is rolled back", async () => {
    const other = (await newProduct({ name: { ar: "منتج ثان", fr: "Second", en: "" }, variants: [variant({ sku: "SKU-1" })] })).body;
    const cur = (await call("GET", `/admin/products/${id}`)).body;
    const r = await call("PUT", `/admin/products/${id}`, { ...inputOf(cur), name: { ...cur.name, en: "Changed" }, variants: [{ ...cur.variants[0], sku: "sku-1" }] });
    expect(r.status).toBe(409);
    expect((await call("GET", `/admin/products/${id}`)).body.name.en).toBe("Test Shirt");
    await call("DELETE", `/admin/products/${other.id}`);
  });

  it("lists products with search, status and category filters", async () => {
    const all = await call("GET", "/admin/products?limit=100&locale=en");
    expect(all.body.total).toBe(17);
    const row = all.body.items.find((p: any) => p.slug === slug);
    expect(row).toMatchObject({ name: "Test Shirt", isPublished: true, variantCount: 2, categoryName: "Outerwear" });
    expect((await call("GET", "/admin/products?q=chemise")).body.total).toBe(3); // two seeded shirts + ours (French name)
    expect((await call("GET", "/admin/products?q=test%20shirt")).body.items.map((p: any) => p.slug)).toEqual([slug]);
    expect((await call("GET", "/admin/products?q=tee-s")).body.total).toBe(0); // the SKU was removed with its variant
    expect((await call("GET", "/admin/products?status=draft")).body.total).toBe(0);
    expect((await call("GET", "/admin/products?status=published&limit=5")).body.items).toHaveLength(5);
    expect((await call("GET", "/admin/products?q=%25")).body.total).toBe(0);
  });

  it("bulk publish skips products that are not ready; hide / publish toggles visibility", async () => {
    const empty = (await newProduct({ name: { ar: "فارغ", fr: "Vide", en: "" }, images: [], variants: [] })).body;
    const r = await call("POST", "/admin/products/publish", { ids: [empty.id, id], isPublished: true });
    expect(r.body.updated).toBe(1); // only the product that has images and variants
    expect((await call("GET", `/admin/products/${empty.id}`)).body.isPublished).toBe(false);
    expect((await call("POST", "/admin/products/publish", { ids: [id], isPublished: false })).body.updated).toBe(1);
    expect((await app.request(`/catalog/products/${slug}`)).status).toBe(404);
    await call("POST", "/admin/products/publish", { ids: [id], isPublished: true });
    await call("DELETE", `/admin/products/${empty.id}`);
  });

  it("deleting a product keeps the history of past orders", async () => {
    const v = (await call("GET", `/admin/products/${id}`)).body.variants[0];
    const commune = (await pg.query<{ id: number }>(`select id from communes where wilaya_code = 16 limit 1`)).rows[0]!.id;
    const order = await (await app.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ variantId: v.id, quantity: 1 }], wilayaCode: 16, deliveryType: "home", customer: { name: "Hist Test", phone: "0550999888", communeId: commune, address: "Rue Historique 1" } }) })).json() as any;
    expect(order.orderNumber).toBeGreaterThan(1000);
    expect((await call("DELETE", `/admin/products/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/products/${id}`)).status).toBe(404);
    expect((await app.request(`/catalog/products/${slug}`)).status).toBe(404);
    const item = (await pg.query<{ product_name: string; variant_id: string | null }>(`select product_name, variant_id from order_items where order_id = (select id from orders where order_number = $1)`, [order.orderNumber])).rows[0]!;
    expect(item).toEqual({ product_name: "قميص تجريبي", variant_id: null });
  });
});

describe("inventory", () => {
  it("lists variants, filters low stock and updates many at once (all or nothing)", async () => {
    const list = await call("GET", "/admin/variants?limit=200&locale=en");
    expect(list.body.total).toBeGreaterThan(70);
    const low = await call("GET", "/admin/variants?lowStock=true&limit=200");
    expect(low.body.items.every((v: any) => v.stock <= 3)).toBe(true);
    expect(low.body.items.length).toBeGreaterThan(2);
    const hoodie = (await call("GET", "/admin/variants?q=nylon&limit=200&locale=en")).body.items;
    expect(hoodie).toHaveLength(5);
    expect(hoodie[0]).toMatchObject({ productName: "Nylon Full Zip Hoodie", size: "XS" });

    const ok = await call("POST", "/admin/variants/bulk", { updates: hoodie.map((v: any) => ({ variantId: v.variantId, price: 7000, compareAtPrice: 8000, stock: 11 })) });
    expect(ok.body.updated).toBe(5);
    expect((await pub("/catalog/products/nylon-zip-hoodie")).variants.every((v: any) => v.price === 7000 && v.compareAtPrice === 8000 && v.stock === 11)).toBe(true);
    expect((await pub("/catalog/sale")).products.map((p: any) => p.slug)).toContain("nylon-zip-hoodie");
    // remove the compare-at price with null
    await call("POST", "/admin/variants/bulk", { updates: [{ variantId: hoodie[0].variantId, compareAtPrice: null }] });

    // one bad row cancels everything
    const before = (await call("GET", "/admin/variants?q=nylon&limit=200")).body.items.map((v: any) => v.stock);
    const bad = await call("POST", "/admin/variants/bulk", { updates: [{ variantId: hoodie[1].variantId, stock: 1 }, { variantId: hoodie[2].variantId, price: 100, compareAtPrice: 50 }] });
    expect(bad.status).toBe(422);
    expect((await call("GET", "/admin/variants?q=nylon&limit=200")).body.items.map((v: any) => v.stock)).toEqual(before);
    expect((await call("POST", "/admin/variants/bulk", { updates: [{ variantId: "00000000-0000-4000-8000-000000000001", stock: 1 }] })).status).toBe(404);
    expect((await call("POST", "/admin/variants/bulk", { updates: [] })).status).toBe(422);
  });
});

describe("collections", () => {
  it("creates a collection with products in order, publishes it, and the storefront follows", async () => {
    const ids = (await call("GET", "/admin/products?limit=3")).body.items.map((p: any) => p.id);
    const created = await call("POST", "/admin/collections", { title: { ar: "تشكيلة الصيف", fr: "Collection été", en: "Summer" }, productIds: ids.slice().reverse(), isPublished: false });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ slug: "collection-ete", isPublished: false, productIds: ids.slice().reverse() });
    expect((await app.request("/catalog/collections/collection-ete")).status).toBe(404); // not published yet
    const cid = created.body.id as string;
    await call("PUT", `/admin/collections/${cid}`, { title: created.body.title, subtitle: { ar: "أجمل القطع", fr: "", en: "" }, heroUrl: "/placeholders/hero-1.svg", isPublished: true, productIds: ids.slice(0, 2) });
    const page = await pub("/catalog/collections/collection-ete?locale=ar");
    expect(page).toMatchObject({ slug: "collection-ete", title: "تشكيلة الصيف" });
    expect(page.rows.reduce((n: number, r: any) => n + r.products.length, 0)).toBe(2);
    expect((await call("PUT", `/admin/collections/${cid}`, { title: created.body.title, productIds: ["00000000-0000-4000-8000-000000000001"] })).body.error.code).toBe("unknown_product");
    expect((await call("GET", "/admin/collections")).body.some((c: any) => c.id === cid)).toBe(true);
    await call("POST", `/admin/collections/${cid}/move`, { direction: -1 });
    expect((await call("DELETE", `/admin/collections/${cid}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/collections/${cid}`)).status).toBe(404);
    expect((await call("GET", "/admin/products?limit=100")).body.total).toBeGreaterThanOrEqual(16); // products stay
  });
});

describe("security", () => {
  it("requires an admin token on every catalog admin route", async () => {
    for (const [m, p] of [["GET", "/admin/products"], ["POST", "/admin/products"], ["GET", "/admin/categories"], ["GET", "/admin/collections"], ["GET", "/admin/variants"], ["POST", "/admin/variants/bulk"], ["POST", "/admin/products/publish"]]) {
      expect((await call(m!, p!, m === "POST" ? {} : undefined, false)).status, `${m} ${p}`).toBe(401);
    }
  });
});
