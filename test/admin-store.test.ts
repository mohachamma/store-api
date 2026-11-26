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
const variantId = async (sku: string) => (await pg.query<{ id: string }>(`select id from product_variants where sku = $1`, [sku])).rows[0]!.id;
const quote = async (sku: string, qty: number, over: Record<string, unknown> = {}) =>
  (await app.request("/orders/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ variantId: await variantId(sku), quantity: qty }], wilayaCode: 16, deliveryType: "home", ...over }) })).json() as Promise<any>;

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

describe("shipping fees", () => {
  it("lists the 58 wilayas and the free-delivery threshold", async () => {
    const r = await call("GET", "/admin/shipping");
    expect(r.status).toBe(200);
    expect(r.body.wilayas).toHaveLength(58);
    expect(r.body.freeShippingOver).toBe(10000);
    expect(r.body.wilayas[15]).toMatchObject({ code: 16, nameFr: "Alger", homeFee: 500, deskFee: 350, active: true });
  });

  it("new fees apply immediately to the public list and to order pricing", async () => {
    const r = await call("PUT", "/admin/shipping/wilayas", { updates: [{ code: 16, homeFee: 650, deskFee: 400 }, { code: 31, homeFee: 900 }] });
    expect(r.body.updated).toBe(2);
    expect((await pub("/shipping/wilayas?locale=fr"))[15]).toMatchObject({ code: 16, homeFee: 650, deskFee: 400 });
    expect((await quote("HEAVY-TEE-CREAM-M", 1)).shippingFee).toBe(650);
    expect((await quote("HEAVY-TEE-CREAM-M", 1, { deliveryType: "desk" })).shippingFee).toBe(400);
    expect((await quote("HEAVY-TEE-CREAM-M", 1, { wilayaCode: 31 })).shippingFee).toBe(900);
  });

  it("a wilaya switched off disappears from checkout and refuses orders", async () => {
    await call("PUT", "/admin/shipping/wilayas", { updates: [{ code: 30, active: false }] });
    expect((await pub("/shipping/wilayas")).map((w: any) => w.code)).not.toContain(30);
    expect((await quote("HEAVY-TEE-CREAM-M", 1, { wilayaCode: 30 })).error.code).toBe("invalid_wilaya");
    expect((await call("GET", "/admin/shipping")).body.wilayas.find((w: any) => w.code === 30).active).toBe(false); // still visible to the admin
    await call("PUT", "/admin/shipping/wilayas", { updates: [{ code: 30, active: true }] });
  });

  it("is all or nothing and validates the amounts", async () => {
    const bad = await call("PUT", "/admin/shipping/wilayas", { updates: [{ code: 5, homeFee: 1234 }, { code: 99, homeFee: 1 }] });
    expect(bad.status).toBe(422); // code 99 is outside 1..58
    expect((await call("GET", "/admin/shipping")).body.wilayas.find((w: any) => w.code === 5).homeFee).not.toBe(1234);
    expect((await call("PUT", "/admin/shipping/wilayas", { updates: [{ code: 5, homeFee: -1 }] })).status).toBe(422);
    expect((await call("PUT", "/admin/shipping/wilayas", { updates: [{ code: 5, homeFee: 1_000_000 }] })).status).toBe(422);
    expect((await call("PUT", "/admin/shipping/wilayas", { updates: [] })).status).toBe(422);
  });

  it("the free-delivery threshold can be changed or removed", async () => {
    expect((await call("PUT", "/admin/shipping/rules", { freeShippingOver: 2000 })).status).toBe(200);
    expect((await pub("/shipping/rules")).freeShippingOver).toBe(2000);
    expect(await quote("HEAVY-TEE-CREAM-M", 1)).toMatchObject({ freeShipping: true, shippingFee: 0, total: 2400 }); // 2 400 ≥ 2 000
    await call("PUT", "/admin/shipping/rules", { freeShippingOver: null });
    expect(await quote("NYLON-ZIP-HOODIE-L", 2)).toMatchObject({ freeShipping: false, shippingFee: 650 }); // 15 800 but never free
    expect((await pub("/shipping/rules")).freeShippingOver).toBeNull();
    expect((await call("PUT", "/admin/shipping/rules", { freeShippingOver: 0 })).status).toBe(422);
    await call("PUT", "/admin/shipping/rules", { freeShippingOver: 10000 });
  });
});

describe("discount codes", () => {
  const base = { code: "summer20", kind: "percent", value: 20, minSubtotal: 2000 };
  let id: string;

  it("creates a code (upper-cased) that customers can use right away", async () => {
    const r = await call("POST", "/admin/discount-codes", base);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ code: "SUMMER20", kind: "percent", value: 20, minSubtotal: 2000, maxUses: null, usedCount: 0, isActive: true });
    id = r.body.id;
    expect(await quote("HEAVY-TEE-CREAM-M", 1, { discountCode: "Summer20" })).toMatchObject({ discountTotal: 480, discount: { code: "SUMMER20", amount: 480 } }); // 20% of 2 400
  });

  it("validates input and refuses duplicates", async () => {
    expect((await call("POST", "/admin/discount-codes", base)).status).toBe(409);
    expect((await call("POST", "/admin/discount-codes", { ...base, code: "X" })).status).toBe(422);
    expect((await call("POST", "/admin/discount-codes", { ...base, code: "has space" })).status).toBe(422);
    expect((await call("POST", "/admin/discount-codes", { ...base, code: "BIG", value: 150 })).status).toBe(422);
    expect((await call("POST", "/admin/discount-codes", { ...base, code: "FIXED500", kind: "fixed", value: 500 })).status).toBe(200); // fixed amounts may exceed 100
    const a = new Date(Date.now() + 86400_000).toISOString(), b = new Date(Date.now() + 3600_000).toISOString();
    expect((await call("POST", "/admin/discount-codes", { ...base, code: "BACKWARDS", startsAt: a, endsAt: b })).status).toBe(422);
  });

  it("limits uses, expires and can be switched off — and the counter survives edits", async () => {
    const commune = (await pg.query<{ id: number }>(`select id from communes where wilaya_code = 16 limit 1`)).rows[0]!.id;
    const place = async (code: string, n: number) => (await app.request("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ variantId: await variantId("HEAVY-TEE-BLACK-M"), quantity: 1 }], wilayaCode: 16, deliveryType: "home", discountCode: code, customer: { name: "Code Test", phone: `066100000${n}`, communeId: commune, address: "Rue du Code 1" } }) })).json() as Promise<any>;
    expect((await place("SUMMER20", 1)).total).toBe(2400 + 650 - 480);
    expect((await call("GET", "/admin/discount-codes")).body.find((c: any) => c.id === id).usedCount).toBe(1);

    const edit = await call("PUT", `/admin/discount-codes/${id}`, { ...base, maxUses: 1 });
    expect(edit.body).toMatchObject({ usedCount: 1, maxUses: 1 });
    expect((await place("SUMMER20", 2)).error.code).toBe("invalid_code"); // used up

    await call("PUT", `/admin/discount-codes/${id}`, { ...base, maxUses: null, endsAt: new Date(Date.now() - 3600_000).toISOString(), startsAt: new Date(Date.now() - 86400_000).toISOString() });
    expect((await quote("HEAVY-TEE-CREAM-M", 1, { discountCode: "SUMMER20" })).error.code).toBe("invalid_code"); // expired
    await call("PUT", `/admin/discount-codes/${id}`, { ...base, isActive: false });
    expect((await quote("HEAVY-TEE-CREAM-M", 1, { discountCode: "SUMMER20" })).error.code).toBe("invalid_code"); // switched off
    expect((await call("PUT", `/admin/discount-codes/${id}`, { ...base, code: "FIXED500" })).status).toBe(409); // another code's name
  });

  it("deleting a code keeps the discount already given on past orders", async () => {
    expect((await call("DELETE", `/admin/discount-codes/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/discount-codes/${id}`)).status).toBe(404);
    expect((await quote("HEAVY-TEE-CREAM-M", 1, { discountCode: "SUMMER20" })).error.code).toBe("invalid_code");
    expect(Number((await pg.query<{ n: number }>(`select count(*)::int as n from orders where discount_total = 480`)).rows[0]!.n)).toBe(1);
    expect((await call("PUT", `/admin/discount-codes/${id}`, base)).status).toBe(404);
  });
});

describe("hero slides", () => {
  const slide = (over: Record<string, unknown> = {}) => ({ title: { ar: "شريحة", fr: "Slide", en: "" }, subtitle: { ar: "", fr: "", en: "" }, imageUrl: "/placeholders/hero-1.svg", linkUrl: "/sale", ...over });
  const hero = async () => (await pub("/catalog/home?locale=fr")).hero;
  let a: any, b: any;

  it("the storefront shows the first active slide; order and switches are editable", async () => {
    const seeded = (await call("GET", "/admin/slides")).body;
    expect(seeded).toHaveLength(1); // the seed's winter slide
    a = (await call("POST", "/admin/slides", slide({ title: { ar: "الأولى", fr: "Première", en: "" } }))).body;
    b = (await call("POST", "/admin/slides", slide({ title: { ar: "الثانية", fr: "Deuxième", en: "" } }))).body;
    expect((await call("GET", "/admin/slides")).body.map((s: any) => s.title.fr)).toEqual(["Collection hiver".replace("Collection hiver", seeded[0].title.fr), "Première", "Deuxième"]);

    for (let i = 0; i < 2; i++) await call("POST", `/admin/slides/${seeded[0].id}/move`, { direction: 1 }); // seed slide goes last
    expect((await hero()).title).toBe("Première");
    await call("POST", `/admin/slides/${b.id}/move`, { direction: -1 });
    expect((await hero()).title).toBe("Deuxième");

    await call("PUT", `/admin/slides/${b.id}`, slide({ title: b.title, isActive: false }));
    expect((await hero()).title).toBe("Première"); // switched off
    const future = new Date(Date.now() + 86400_000).toISOString();
    await call("PUT", `/admin/slides/${a.id}`, slide({ title: a.title, startsAt: future }));
    expect((await hero()).title).toBe("Collection hiver"); // scheduled for later → falls through to the seeded one
  });

  it("links to a published collection or to a custom URL, and refuses unsafe ones", async () => {
    const col = (await call("POST", "/admin/collections", { title: { ar: "تجربة", fr: "Essai", en: "" }, isPublished: true, productIds: [] })).body;
    await call("PUT", `/admin/slides/${a.id}`, slide({ title: a.title, collectionId: col.id, linkUrl: null }));
    expect((await hero()).title).toBe("Première");
    expect((await hero()).href).toBe(`/collections/${col.slug}`);
    await call("PUT", `/admin/slides/${a.id}`, slide({ title: a.title, collectionId: null, linkUrl: "https://example.com/promo" }));
    expect((await hero()).href).toBe("https://example.com/promo");
    expect((await call("PUT", `/admin/slides/${a.id}`, slide({ linkUrl: "javascript:alert(1)" }))).status).toBe(422);
    expect((await call("PUT", `/admin/slides/${a.id}`, slide({ imageUrl: "data:image/png;base64,AAAA" }))).status).toBe(422);
    expect((await call("PUT", `/admin/slides/${a.id}`, slide({ title: { ar: "", fr: "Seulement", en: "" } }))).status).toBe(422);
    expect((await call("POST", "/admin/slides", slide({ imageUrl: "" }))).status).toBe(422);
  });

  it("deleting slides leaves the storefront without a hero rather than crashing", async () => {
    for (const s of (await call("GET", "/admin/slides")).body) expect((await call("DELETE", `/admin/slides/${s.id}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/slides/${a.id}`)).status).toBe(404);
    expect((await pub("/catalog/home")).hero).toBeNull();
  });
});

describe("security", () => {
  it("requires an admin token", async () => {
    for (const [m, p] of [["GET", "/admin/shipping"], ["PUT", "/admin/shipping/wilayas"], ["PUT", "/admin/shipping/rules"], ["GET", "/admin/discount-codes"], ["POST", "/admin/discount-codes"], ["GET", "/admin/slides"], ["POST", "/admin/slides"]]) {
      expect((await call(m!, p!, m === "GET" ? undefined : {}, false)).status, `${m} ${p}`).toBe(401);
    }
  });
});
