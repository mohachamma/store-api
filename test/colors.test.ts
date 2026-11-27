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

describe("color swatches (public)", () => {
  it("every product card gets its colors as dots, one per color, with a hex", async () => {
    const list = (await api("GET", "/catalog/products?limit=100")).body as { slug: string; colors: { name: string; hex: string | null }[] }[];
    expect(list.every((p) => Array.isArray(p.colors) && p.colors.length >= 1)).toBe(true);
    const tee = list.find((p) => p.slug === "heavy-tee-cream")!;
    expect(tee.colors.map((c) => c.name).sort()).toEqual(["black", "cream"]);
    expect(tee.colors.find((c) => c.name === "black")!.hex).toBe("#111111");
    expect(tee.colors.find((c) => c.name === "cream")!.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("the product page has swatch hex per variant and photos linked to colors", async () => {
    const p = (await api("GET", "/catalog/products/heavy-tee-cream")).body;
    expect(p.variants.filter((v: { color: string }) => v.color === "black").every((v: { colorHex: string }) => v.colorHex === "#111111")).toBe(true);
    const colors = new Set(p.images.map((i: { color: string | null }) => i.color));
    expect(colors).toEqual(new Set(["cream", "black"]));
  });
  it("filter options carry swatches too", async () => {
    const f = (await api("GET", "/catalog/filters")).body;
    expect(f.colorSwatches.length).toBe(f.colors.length);
    expect(f.colorSwatches.find((c: { name: string }) => c.name === "black").hex).toBe("#111111");
  });
});

describe("choosing colors in the dashboard", () => {
  it("the owner's exact color wins over the guessed one, and unknown names get a null hex until chosen", async () => {
    const id = await idOf("denim-track-jacket");
    const cur = (await admin("GET", `/admin/products/${id}`)).body;
    const body = (variants: unknown[], imageColors?: (string | null)[]) => ({ name: cur.name, description: cur.description, categoryId: cur.categoryId, brandId: cur.brandId, isPublished: cur.isPublished, isNew: cur.isNew, audience: cur.audience, images: cur.images.map((i: { url: string }) => i.url), imageColors, variants });
    const v0 = cur.variants[0];
    const put = await admin("PUT", `/admin/products/${id}`, body([{ ...v0, colorHex: "#C9AD82" }, { size: "XL", color: "Terracotta", sku: null, stock: 3, price: 6900, compareAtPrice: null, colorHex: null }], cur.images.map((_: unknown, i: number) => (i === 0 ? v0.color : null))));
    expect(put.status).toBe(200);
    const pub = (await api("GET", "/catalog/products/denim-track-jacket")).body;
    expect(pub.variants.find((v: { id: string }) => v.id === v0.id).colorHex).toBe("#c9ad82"); // stored lowercase
    expect(pub.variants.find((v: { size: string }) => v.size === "XL").colorHex).toBeNull();
    expect(pub.images[0].color).toBe(v0.color);
    expect(pub.images[1]?.color ?? null).toBeNull();
    const card = (await api("GET", "/catalog/products?q=denim")).body.find((p: { slug: string }) => p.slug === "denim-track-jacket");
    expect(card.colors).toEqual([{ name: v0.color, hex: "#c9ad82" }, { name: "Terracotta", hex: null }]);
    expect((await admin("GET", `/admin/products/${id}`)).body.images[0].color).toBe(v0.color);
  });
  it("refuses a color that is not #rrggbb", async () => {
    const id = await idOf("denim-track-jacket");
    const cur = (await admin("GET", `/admin/products/${id}`)).body;
    const r = await admin("PUT", `/admin/products/${id}`, { name: cur.name, description: cur.description, categoryId: cur.categoryId, brandId: cur.brandId, isPublished: cur.isPublished, isNew: cur.isNew, audience: cur.audience, images: cur.images.map((i: { url: string }) => i.url), variants: [{ ...cur.variants[0], colorHex: "red" }] });
    expect(r.status).toBe(422);
  });
});
