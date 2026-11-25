import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];

const get = async <T = any>(path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
};

beforeAll(async () => {
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db });
}, 60_000);
afterAll(() => pg.close());

describe("GET /catalog/home", () => {
  it("returns hero, looks, rows, brands, brand strip settings and offers", async () => {
    const { status, body } = await get("/catalog/home?locale=en");
    expect(status).toBe(200);
    expect(body.announcement).toMatch(/Free delivery/);
    expect(body.hero).toMatchObject({ title: "Winter Collection", href: "/collections/winter", collectionSlug: "winter" });
    expect(body.looks).toHaveLength(4);
    expect(body.rows.map((r: any) => r.category.slug)).toEqual(["outerwear", "tops", "footwear", "bottoms"]);
    expect(body.rows[0].products.length).toBeLessThanOrEqual(10);
    expect(body.brands).toHaveLength(8);
    expect(body.brandsStrip).toEqual({ enabled: true, animated: true, speed: 30, pauseOnHover: true, title: "Our brands" });
    expect(body.offers[0]).toMatchObject({ title: "35% off only this Friday", theme: "dark", href: "/sale" });
    expect(new Date(body.offers[0].countdownEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("falls back to Arabic and is cacheable", async () => {
    const { body, headers } = await get("/catalog/home");
    expect(body.hero.title).toBe("تشكيلة الشتاء");
    expect(headers.get("cache-control")).toContain("s-maxage");
  });

  it("hides unpublished products and inactive brands", async () => {
    await pg.exec(`update products set is_published = false where slug = 'nylon-zip-hoodie'; update brands set is_active = false where slug = 'atlas'`);
    const { body } = await get("/catalog/home");
    const slugs = body.rows.flatMap((r: any) => r.products.map((p: any) => p.slug));
    expect(slugs).not.toContain("nylon-zip-hoodie");
    expect(body.brands.map((b: any) => b.slug)).not.toContain("atlas");
    await pg.exec(`update products set is_published = true where slug = 'nylon-zip-hoodie'; update brands set is_active = true where slug = 'atlas'`);
  });
});

describe("GET /catalog/products", () => {
  it("lists published products with the cheapest price and a discount only when real", async () => {
    const { body } = await get("/catalog/products?locale=en&limit=100");
    expect(body).toHaveLength(16);
    const denim = body.find((p: any) => p.slug === "denim-track-jacket");
    expect(denim).toMatchObject({ name: "Denim Track Jacket", price: 6900, compareAtPrice: 8500, isNew: false });
    expect(denim.image.url).toBe("/placeholders/jacket-denim-1.svg");
    expect(body.find((p: any) => p.slug === "nylon-zip-hoodie").compareAtPrice).toBeNull();
  });

  it("filters by category, search (any language), price and in-stock size", async () => {
    expect((await get("/catalog/products?category=footwear")).body).toHaveLength(4);
    expect((await get("/catalog/products?q=hoodie")).body.map((p: any) => p.slug).sort()).toEqual(["essential-hoodie-black", "nylon-zip-hoodie"]);
    expect((await get(`/catalog/products?q=${encodeURIComponent("جينز")}`)).body.map((p: any) => p.slug).sort()).toEqual(["denim-track-jacket", "slim-denim-jean"]);
    expect((await get("/catalog/products?minPrice=10000")).body.every((p: any) => p.price >= 10000)).toBe(true);
    // chelsea boot size 40 is sold out, 41 is not
    const s40 = (await get("/catalog/products?category=footwear&size=40")).body.map((p: any) => p.slug);
    expect(s40).not.toContain("chelsea-boot");
    expect((await get("/catalog/products?category=footwear&size=41")).body.map((p: any) => p.slug)).toContain("chelsea-boot");
  });

  it("treats % and _ in the search text literally", async () => {
    expect((await get("/catalog/products?q=%25")).body).toEqual([]);
  });

  it("sorts and pages", async () => {
    const asc = (await get("/catalog/products?sort=price_asc&limit=3")).body.map((p: any) => p.price);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    const page2 = (await get("/catalog/products?sort=price_asc&limit=3&offset=3")).body;
    expect(page2).toHaveLength(3);
    expect(page2[0].price).toBeGreaterThanOrEqual(asc[2]);
    expect((await get("/catalog/products?limit=1000")).status).toBe(422);
  });
});

describe("GET /catalog/products/{slug}", () => {
  it("returns images and variants in garment size order", async () => {
    const { status, body } = await get("/catalog/products/nylon-zip-hoodie?locale=fr");
    expect(status).toBe(200);
    expect(body.name).toBe("Hoodie zippé en nylon");
    expect(body.images).toHaveLength(3);
    expect(body.sizes).toEqual(["XS", "S", "M", "L", "XL"]);
    expect(body.variants[0]).toMatchObject({ size: "XS", price: 7900, compareAtPrice: null });
    const shoes = (await get("/catalog/products/chelsea-boot")).body;
    expect(shoes.sizes).toEqual(["40", "41", "42", "43", "44"]);
    expect(shoes.variants.find((v: any) => v.size === "40").stock).toBe(0);
  });
  it("404s for unknown or unpublished products", async () => {
    expect((await get("/catalog/products/nope")).status).toBe(404);
    await pg.exec(`update products set is_published = false where slug = 'heavy-tee-black'`);
    const r = await get("/catalog/products/heavy-tee-black");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "not_found", message: "Product not found" } });
    await pg.exec(`update products set is_published = true where slug = 'heavy-tee-black'`);
  });
  it("returns related products from the same category, excluding itself", async () => {
    const { body } = await get("/catalog/products/nylon-zip-hoodie/related");
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((p: any) => p.category.slug === "outerwear" && p.slug !== "nylon-zip-hoodie")).toBe(true);
  });
});

describe("collections, sale, categories, brands, site", () => {
  it("returns a collection with looks and rows", async () => {
    const { status, body } = await get("/catalog/collections/winter?locale=en");
    expect(status).toBe(200);
    expect(body).toMatchObject({ slug: "winter", title: "Winter Collection" });
    expect(body.looks).toHaveLength(4);
    expect(body.looks[0].productSlugs).toEqual(["utility-jacket", "quilted-pant"]);
    expect(body.rows.reduce((n: number, r: any) => n + r.products.length, 0)).toBe(16);
    expect((await get("/catalog/collections/unknown")).status).toBe(404);
  });

  it("lists only discounted products, biggest discount first", async () => {
    const { body } = await get("/catalog/sale?locale=en");
    expect(body).toMatchObject({ enabled: true, title: "Sale" });
    expect(body.products.map((p: any) => p.slug)).toEqual(["denim-track-jacket", "tear-away-sneaker"]); // 19% then 18%
    expect(body.products.every((p: any) => p.compareAtPrice > p.price)).toBe(true);
    expect(body.products).toHaveLength(2);
    const pct = body.products.map((p: any) => 1 - p.price / p.compareAtPrice);
    expect(pct[0]).toBeGreaterThanOrEqual(pct[1]);
  });

  it("lists categories with counts and brands", async () => {
    const cats = (await get("/catalog/categories?locale=en")).body;
    expect(cats.map((c: any) => [c.slug, c.productCount])).toEqual([["outerwear", 6], ["tops", 4], ["footwear", 4], ["bottoms", 2]]);
    expect((await get("/catalog/brands")).body).toHaveLength(8);
  });

  it("serves the announcement and hides it when empty", async () => {
    expect((await get("/catalog/site?locale=fr")).body.announcement).toMatch(/Livraison gratuite/);
    await pg.exec(`update site_settings set value = '{"ar": ""}'::jsonb where key = 'announcement'`);
    expect((await get("/catalog/site")).body.announcement).toBeNull();
  });
});

describe("shipping", () => {
  it("lists wilayas with fees and their communes", async () => {
    const w = (await get("/shipping/wilayas?locale=fr")).body;
    expect(w).toHaveLength(58);
    expect(w[15]).toMatchObject({ code: 16, name: "Alger" });
    expect(w[15].homeFee).toBeGreaterThan(w[15].deskFee);
    const communes = (await get("/shipping/wilayas/16/communes?locale=ar")).body;
    expect(communes.length).toBeGreaterThan(20);
    expect((await get("/shipping/wilayas/99/communes")).status).toBe(422);
  });
});

describe("openapi", () => {
  it("documents every public route", async () => {
    const { body } = await get("/openapi.json");
    for (const p of ["/catalog/home", "/catalog/products", "/catalog/products/{slug}", "/catalog/sale", "/catalog/site", "/shipping/wilayas", "/auth/login"]) {
      expect(body.paths[p], p).toBeDefined();
    }
    expect(Object.keys(body.components.schemas)).toEqual(expect.arrayContaining(["Home", "Product", "ProductSummary", "Offer", "BrandsStrip", "Sale"]));
  });
});
