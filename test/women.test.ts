import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;

async function api(method: string, path: string, json?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m: string, p: string, j?: unknown) => api(m, p, j, adminToken);
const slugs = (list: { slug: string }[]) => list.map((p) => p.slug).sort();
const idOf = async (slug: string) => (await pg.query<{ id: string }>(`select id from products where slug = $1`, [slug])).rows[0]!.id;

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  adminToken = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("products for women", () => {
  it("the women list has women's and unisex products, never men's; men's list the opposite", async () => {
    const women = (await api("GET", "/catalog/products?audience=women&limit=100")).body;
    const men = (await api("GET", "/catalog/products?audience=men&limit=100")).body;
    const all = (await api("GET", "/catalog/products?limit=100")).body;
    expect(slugs(women)).toContain("hooded-deck-coat");
    expect(slugs(women)).not.toContain("nylon-zip-hoodie");
    expect(slugs(men)).toContain("nylon-zip-hoodie");
    expect(slugs(men)).not.toContain("hooded-deck-coat");
    // unisex products are in both
    const unisex = (await pg.query<{ slug: string }>(`select slug from products where audience = 'unisex'`)).rows.map((r) => r.slug);
    expect(unisex.length).toBeGreaterThan(0);
    for (const s of unisex) { expect(slugs(women)).toContain(s); expect(slugs(men)).toContain(s); }
    expect(all.length).toBe(16);
  });

  it("filter options and totals follow the audience", async () => {
    const f = (await api("GET", "/catalog/filters?audience=women")).body;
    const list = (await api("GET", "/catalog/products?audience=women&limit=100")).body;
    expect(f.total).toBe(list.length);
    expect(f.total).toBeLessThan(16);
    expect(f.categories.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(list.length);
    const sized = (await api("GET", "/catalog/products?audience=women&size=M&limit=100")).body;
    expect((await api("GET", "/catalog/filters?audience=women&size=M")).body.total).toBe(sized.length);
    expect((await api("GET", "/catalog/products?audience=kids")).status).toBe(422);
  });
});

describe("women's page content (dashboard)", () => {
  it("has default texts in three languages and no cover image yet", async () => {
    expect((await api("GET", "/catalog/women?locale=fr")).body).toEqual({ enabled: true, title: "Femme", subtitle: "Les dernières nouveautés pour elle", heroImage: null });
    expect((await api("GET", "/catalog/women?locale=ar")).body.title).toBe("نساء");
  });
  it("is edited from the dashboard: title, cover image and hiding the page", async () => {
    const put = await admin("PUT", "/admin/women-page", { enabled: true, title: { ar: "للنساء", fr: "", en: "For her" }, subtitle: { ar: "", fr: "", en: "" }, heroUrl: "https://img.example.com/uploads/women.webp" });
    expect(put.status).toBe(200);
    expect((await api("GET", "/catalog/women?locale=en")).body).toEqual({ enabled: true, title: "For her", subtitle: null, heroImage: { url: "https://img.example.com/uploads/women.webp", alt: "For her" } });
    expect((await admin("GET", "/admin/women-page")).body).toMatchObject({ enabled: true, heroUrl: "https://img.example.com/uploads/women.webp" });
    await admin("PUT", "/admin/women-page", { enabled: false, title: { ar: "للنساء", fr: "", en: "" }, subtitle: { ar: "", fr: "", en: "" }, heroUrl: null });
    expect((await api("GET", "/catalog/women")).body.enabled).toBe(false);
  });
  it("refuses French text without Arabic, inline images and visitors", async () => {
    const ok = { enabled: true, title: { ar: "x", fr: "", en: "" }, subtitle: { ar: "", fr: "", en: "" }, heroUrl: null };
    expect((await admin("PUT", "/admin/women-page", { ...ok, subtitle: { ar: "", fr: "sous-titre", en: "" } })).status).toBe(422);
    expect((await admin("PUT", "/admin/women-page", { ...ok, heroUrl: "data:image/png;base64,AAAA" })).status).toBe(422);
    expect((await api("PUT", "/admin/women-page", ok)).status).toBe(401);
  });
});

describe("choosing who a product is for (dashboard)", () => {
  it("a product's audience is saved and listed, and can be filtered", async () => {
    const id = await idOf("denim-track-jacket");
    const p = (await admin("GET", `/admin/products/${id}`)).body;
    expect(p.audience).toBe("unisex");
    const body = { name: p.name, description: p.description, categoryId: p.categoryId, brandId: p.brandId, isPublished: p.isPublished, isNew: p.isNew, images: p.images.map((i: { url: string }) => i.url), variants: p.variants, audience: "women" };
    expect((await admin("PUT", `/admin/products/${id}`, body)).status).toBe(200);
    expect((await admin("GET", `/admin/products/${id}`)).body.audience).toBe("women");
    expect(slugs((await api("GET", "/catalog/products?audience=women&limit=100")).body)).toContain("denim-track-jacket");
    expect(slugs((await api("GET", "/catalog/products?audience=men&limit=100")).body)).not.toContain("denim-track-jacket");
    const rows = (await admin("GET", "/admin/products?audience=women&limit=100")).body;
    expect(rows.items.every((r: { audience: string }) => r.audience === "women")).toBe(true);
    expect(rows.items.map((r: { slug: string }) => r.slug)).toContain("denim-track-jacket");
  });
  it("several products can be moved at once", async () => {
    const ids = await Promise.all(["charcoal-overcoat", "henley-pullover"].map(idOf));
    const r = await admin("POST", "/admin/products/audience", { ids, audience: "women" });
    expect(r.body).toEqual({ updated: 2 });
    expect(slugs((await api("GET", "/catalog/products?audience=women&limit=100")).body)).toEqual(expect.arrayContaining(["charcoal-overcoat", "henley-pullover"]));
    expect((await admin("POST", "/admin/products/audience", { ids, audience: "kids" })).status).toBe(422);
    expect((await api("POST", "/admin/products/audience", { ids, audience: "men" })).status).toBe(401);
  });
});

describe("men's page (same as women's)", () => {
  it("has default texts and shows men's and unisex products only", async () => {
    expect((await api("GET", "/catalog/men?locale=fr")).body).toEqual({ enabled: true, title: "Homme", subtitle: "Les dernières nouveautés pour lui", heroImage: null });
    expect((await api("GET", "/catalog/men?locale=ar")).body.title).toBe("رجال");
    const men = (await api("GET", "/catalog/products?audience=men&limit=100")).body;
    expect(slugs(men)).toContain("black-skate-mid");
    expect(slugs(men)).not.toContain("chelsea-boot");
  });
  it("is edited from the dashboard (texts, cover, hiding) and is protected", async () => {
    const put = await admin("PUT", "/admin/men-page", { enabled: true, title: { ar: "للرجال", fr: "", en: "For him" }, subtitle: { ar: "", fr: "", en: "" }, heroUrl: "https://img.example.com/uploads/men.webp" });
    expect(put.status).toBe(200);
    expect((await api("GET", "/catalog/men?locale=en")).body).toEqual({ enabled: true, title: "For him", subtitle: null, heroImage: { url: "https://img.example.com/uploads/men.webp", alt: "For him" } });
    expect((await admin("GET", "/admin/men-page")).body).toMatchObject({ enabled: true, heroUrl: "https://img.example.com/uploads/men.webp" });
    await admin("PUT", "/admin/men-page", { enabled: false, title: { ar: "للرجال", fr: "", en: "" }, subtitle: { ar: "", fr: "", en: "" }, heroUrl: null });
    expect((await api("GET", "/catalog/men")).body.enabled).toBe(false);
    expect((await api("PUT", "/admin/men-page", { enabled: true, title: { ar: "x", fr: "", en: "" }, subtitle: { ar: "", fr: "", en: "" }, heroUrl: null })).status).toBe(401);
    expect((await admin("PUT", "/admin/men-page", { enabled: true, title: { ar: "x", fr: "", en: "" }, subtitle: { ar: "", fr: "sous", en: "" }, heroUrl: null })).status).toBe(422);
  });
  it("women's and men's settings are independent", async () => {
    await admin("PUT", "/admin/women-page", { enabled: true, title: { ar: "نساء", fr: "", en: "" }, subtitle: { ar: "", fr: "", en: "" }, heroUrl: null });
    expect((await api("GET", "/catalog/women")).body.enabled).toBe(true);
    expect((await api("GET", "/catalog/men")).body.enabled).toBe(false);
  });
});
