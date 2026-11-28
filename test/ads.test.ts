import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { cleanTag } from "../src/lib/attribution.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;
const variant = async (sku: string) => (await pg.query<{ id: string; price: number }>(`select id, price from product_variants where sku = $1`, [sku])).rows[0]!;
const communeOf = async (w: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [w])).rows[0]!.id);
let seq = 0;
async function api(method: string, path: string, json?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m: string, p: string, j?: unknown) => api(m, p, j, adminToken);
async function place(attribution?: Record<string, unknown>) {
  const r = await api("POST", "/orders", {
    items: [{ variantId: (await variant("HEAVY-TEE-BLACK-XL")).id, quantity: 1 }], wilayaCode: 16, deliveryType: "home",
    customer: { name: "Test", phone: `066${String(4000000 + ++seq).slice(-7)}`, communeId: await communeOf(16), address: "12 rue des Tests" },
    ...(attribution ? { attribution } : {}),
  });
  expect(r.status).toBe(200);
  const id = (await pg.query<{ id: string }>(`select id from orders where order_number = $1`, [r.body.orderNumber])).rows[0]!.id;
  return { ...r.body, id };
}
async function finish(id: string, status: "delivered" | "returned") {
  await admin("POST", `/admin/orders/${id}/confirm`, { company: "manual", trackingNumber: `T-${id.slice(0, 6)}` });
  await admin("POST", `/admin/orders/${id}/status`, { status: "shipped" });
  await admin("POST", `/admin/orders/${id}/status`, { status });
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  await pg.query(`update product_variants set stock = 100 where sku = 'HEAVY-TEE-BLACK-XL'`);
  adminToken = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("ad tags", () => {
  it("cleans the labels", () => {
    expect(cleanTag("Eid_Sale ")).toBe("eid_sale");
    expect(cleanTag("  Facebook   Ads ")).toBe("facebook ads");
    expect(cleanTag("<script>alert(1)</script>")).toBe("scriptalert1script");
    expect(cleanTag("")).toBeNull();
    expect(cleanTag(undefined)).toBeNull();
    expect(cleanTag("é ا")).toBe("é ا");
  });

  it("every order remembers its ad, and an order without tags has none", async () => {
    const o = await place({ source: "Facebook", medium: "Paid", campaign: "Eid_Sale ", content: "Video 1" });
    const d = (await admin("GET", `/admin/orders/${o.id}`)).body;
    expect(d.ad).toEqual({ source: "facebook", medium: "paid", campaign: "eid_sale", content: "video 1" });
    expect((await admin("GET", "/admin/orders?limit=50")).body.items.find((x: { id: string }) => x.id === o.id).ad.campaign).toBe("eid_sale");
    const plain = await place();
    expect((await admin("GET", `/admin/orders/${plain.id}`)).body.ad).toBeNull();
    // The customer's own page never carries the tags.
    expect(JSON.stringify((await api("GET", `/orders/${o.orderNumber}?token=${o.token}`)).body)).not.toContain("eid_sale");
  });
});

describe("ads report", () => {
  it("compares ad spend with what each campaign brought", async () => {
    const v = await variant("HEAVY-TEE-BLACK-XL");
    await admin("POST", "/admin/variants/bulk", { updates: [{ variantId: v.id, costPrice: 1500 }] });
    await admin("PUT", "/admin/shipping/wilayas", { updates: [{ code: 16, homeCost: 400 }] });
    await admin("PUT", "/admin/profit-settings", { returnFee: 200, returnedItemsLost: false, cardFeePercent: 0 });
    await pg.query(`delete from orders`); // clean slate for exact numbers

    const a = await place({ source: "facebook", campaign: "eid_sale" });
    const b = await place({ source: "facebook", campaign: "eid_sale" });
    const c = await place({ source: "tiktok", campaign: "promo" });
    const d = await place();
    await finish(a.id, "delivered");
    await finish(b.id, "returned");
    await finish(d.id, "delivered");
    const fee = Number(a.shippingFee);
    const price = Number(v.price);
    const today = new Date().toISOString().slice(0, 10);

    await admin("POST", "/admin/expenses", { spentOn: today, category: "ads", platform: "Facebook", campaign: "Eid_Sale", amount: 1000 });
    await admin("POST", "/admin/expenses", { spentOn: today, category: "ads", platform: "tiktok", campaign: "promo", amount: 500 });
    await admin("POST", "/admin/expenses", { spentOn: today, category: "ads", platform: "google", amount: 300 }); // spend with no orders
    await admin("POST", "/admin/expenses", { spentOn: today, category: "packaging", amount: 999 }); // not an ad

    const r = (await admin("GET", `/admin/ads?from=${today}&to=${today}`)).body;
    const get = (s: string, k: string) => r.campaigns.find((x: { source: string; campaign: string }) => x.source === s && x.campaign === k);

    // facebook / eid_sale: 1 delivered + 1 returned
    const fb = get("facebook", "eid_sale");
    expect(fb).toMatchObject({ orders: 2, delivered: 1, returned: 1, inProgress: 0, sales: price + fee, spend: 1000 });
    expect(fb.profit).toBe(price + fee - 1500 - 400 - (400 + 200));
    expect(fb.netProfit).toBe(fb.profit - 1000);
    expect(fb.roas).toBe(Math.round(((price + fee) / 1000) * 100) / 100);
    expect(fb.costPerOrder).toBe(500);
    // tiktok: still in progress, spend counted
    expect(get("tiktok", "promo")).toMatchObject({ orders: 1, delivered: 0, inProgress: 1, sales: 0, spend: 500, profit: 0, netProfit: -500 });
    // direct orders (no tags)
    expect(get("", "")).toMatchObject({ orders: 1, delivered: 1, spend: 0, roas: null, costPerOrder: null });
    expect(get("", "").profit).toBe(price + fee - 1500 - 400);
    // spend without orders still appears; non-ad expenses do not
    expect(get("google", "")).toMatchObject({ orders: 0, spend: 300 });
    expect(r.totals.spend).toBe(1800);
    expect(r.totals.netProfit).toBe(r.totals.profit - 1800);
    expect(c.status).toBe("pending");
  });

  it("needs the admin token and a sane period", async () => {
    expect((await api("GET", "/admin/ads")).status).toBe(401);
    expect((await admin("GET", "/admin/ads?from=2026-02-01&to=2026-01-01")).status).toBe(422);
  });
});
