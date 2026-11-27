import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
}, 60_000);
afterAll(() => pg.close());

describe("filter options", () => {
  it("lists categories with counts, sizes in garment order, colors and the price range", async () => {
    const r = await get("/catalog/filters?locale=fr");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(16);
    expect(r.body.categories.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(16);
    const rank = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"];
    const garment = r.body.sizes.filter((s: string) => rank.includes(s));
    expect(garment).toEqual([...garment].sort((a, b) => rank.indexOf(a) - rank.indexOf(b)));
    expect(r.body.colors.length).toBeGreaterThan(0);
    expect(r.body.priceRange.min).toBeLessThan(r.body.priceRange.max);
  });

  it("narrows to a category, and keeps the other categories visible so the user can switch", async () => {
    const all = (await get("/catalog/filters")).body;
    const tops = all.categories.find((c: { slug: string }) => c.slug === "tops");
    const r = (await get("/catalog/filters?category=tops")).body;
    expect(r.total).toBe(tops.count);
    expect(r.categories).toEqual(all.categories); // category options ignore the chosen category
    expect(r.priceRange.max).toBeLessThanOrEqual(all.priceRange.max);
  });

  it("total follows the same filters as the product list", async () => {
    for (const qs of ["size=M", "minPrice=5000", "maxPrice=3000", "category=footwear&size=42", "q=hoodie", "color=black&maxPrice=9000"]) {
      const list = (await get(`/catalog/products?${qs}&limit=100`)).body;
      const f = (await get(`/catalog/filters?${qs}`)).body;
      expect(f.total, qs).toBe(list.length);
    }
  });

  it("size and color options ignore their own filter (so another size can be picked) but respect the others", async () => {
    const withSize = (await get("/catalog/filters?size=M")).body;
    const without = (await get("/catalog/filters")).body;
    expect(withSize.sizes).toEqual(without.sizes);
    const cheap = (await get("/catalog/filters?maxPrice=3000")).body;
    expect(cheap.sizes.length).toBeLessThanOrEqual(without.sizes.length);
    expect(cheap.priceRange.max).toBeLessThanOrEqual(without.priceRange.max);
  });

  it("an empty result has no price range and no options, not an error", async () => {
    const r = (await get("/catalog/filters?q=zzzz-nothing")).body;
    expect(r).toEqual({ total: 0, categories: [], sizes: [], colors: [], colorSwatches: [], priceRange: null });
  });

  it("out-of-stock sizes are not offered", async () => {
    const v = (await pg.query<{ size: string; product_id: string }>(`select size, product_id from product_variants where sku = 'HEAVY-TEE-CREAM-M'`)).rows[0]!;
    await pg.query(`update product_variants set stock = 0 where product_id = $1`, [v.product_id]);
    const f = (await get("/catalog/filters?q=Heavy%20Tee%20Cream")).body;
    expect(f.sizes).toEqual([]);
    await pg.query(`update product_variants set stock = 5 where product_id = $1`, [v.product_id]);
  });
});
