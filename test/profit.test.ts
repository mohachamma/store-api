import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;

const variant = async (sku: string) => (await pg.query<{ id: string; price: number }>(`select id, price from product_variants where sku = $1`, [sku])).rows[0]!;
const communeOf = async (wilaya: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [wilaya])).rows[0]!.id);
let phoneSeq = 0;
const nextPhone = () => `066${String(2000000 + ++phoneSeq).slice(-7)}`;

async function api(method: string, path: string, json?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (method: string, path: string, json?: unknown) => api(method, path, json, adminToken);

async function place(sku: string, qty: number, over: Record<string, unknown> = {}) {
  return api("POST", "/orders", {
    items: [{ variantId: (await variant(sku)).id, quantity: qty }], wilayaCode: 16, deliveryType: "home",
    customer: { name: "Test Customer", phone: nextPhone(), communeId: await communeOf(16), address: "12 rue des Tests" }, ...over,
  });
}
const orderId = async (n: number) => (await pg.query<{ id: string }>(`select id from orders where order_number = $1`, [n])).rows[0]!.id;
async function deliver(n: number) {
  const id = await orderId(n);
  await admin("POST", `/admin/orders/${id}/confirm`, { trackingNumber: `TRK-${n}` });
  await admin("POST", `/admin/orders/${id}/status`, { status: "shipped" });
  return id;
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  await pg.query(`update product_variants set stock = 100 where sku in ('HEAVY-TEE-BLACK-XL', 'HEAVY-TEE-BLACK-L')`);
  adminToken = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("net profit", () => {
  it("needs the admin token", async () => {
    expect((await api("GET", "/admin/profit")).status).toBe(401);
    expect((await api("GET", "/admin/expenses")).status).toBe(401);
  });

  it("stores costs, expenses and settings", async () => {
    const v = await variant("HEAVY-TEE-BLACK-XL");
    expect((await admin("POST", "/admin/variants/bulk", { updates: [{ variantId: v.id, costPrice: 1500 }] })).status).toBe(200);
    expect(Number((await pg.query(`select cost_price from product_variants where id = $1`, [v.id])).rows[0]!.cost_price)).toBe(1500);
    expect((await admin("PUT", "/admin/shipping/wilayas", { updates: [{ code: 16, homeCost: 400, deskCost: 300 }] })).body).toEqual({ updated: 1 });
    expect((await admin("GET", "/admin/shipping")).body.wilayas.find((w: { code: number }) => w.code === 16)).toMatchObject({ homeCost: 400, deskCost: 300 });
    expect((await admin("PUT", "/admin/profit-settings", { returnFee: 200, returnedItemsLost: false, cardFeePercent: 0 })).status).toBe(200);
    expect((await admin("GET", "/admin/profit-settings")).body).toEqual({ returnFee: 200, returnedItemsLost: false, cardFeePercent: 0 });
  });

  it("an empty period is zero", async () => {
    const r = await admin("GET", "/admin/profit?from=2020-01-01&to=2020-01-31");
    expect(r.status).toBe(200);
    expect(r.body.netProfit).toBe(0);
    expect((await admin("GET", "/admin/profit?from=2020-02-01&to=2020-01-01")).status).toBe(422);
  });

  it("counts delivered orders, returns and expenses", async () => {
    const delivered = await place("HEAVY-TEE-BLACK-XL", 2);
    const returned = await place("HEAVY-TEE-BLACK-XL", 1);
    const pending = await place("HEAVY-TEE-BLACK-XL", 1); // never delivered: not counted
    expect(delivered.status).toBe(200);
    expect(pending.status).toBe(200);
    const price = Number((await variant("HEAVY-TEE-BLACK-XL")).price);
    // The order snapshots what the goods and the delivery cost us at that moment.
    expect(Number((await pg.query(`select delivery_cost from orders where order_number = $1`, [delivered.body.orderNumber])).rows[0]!.delivery_cost)).toBe(400);
    await admin("POST", "/admin/variants/bulk", { updates: [{ variantId: (await variant("HEAVY-TEE-BLACK-XL")).id, costPrice: 9999 }] }); // later cost changes do not rewrite history

    await admin("POST", `/admin/orders/${await deliver(delivered.body.orderNumber)}/status`, { status: "delivered" });
    await admin("POST", `/admin/orders/${await deliver(returned.body.orderNumber)}/status`, { status: "returned" });
    const fee = Number(delivered.body.shippingFee);

    expect((await admin("POST", "/admin/expenses", { spentOn: "2000-01-01", category: "ads", amount: 100, note: "old" })).status).toBe(201); // outside the period
    const today = new Date().toISOString().slice(0, 10);
    const ad = await admin("POST", "/admin/expenses", { spentOn: today, category: "ads", platform: "facebook", amount: 1000 });
    expect(ad.status).toBe(201);
    await admin("POST", "/admin/expenses", { spentOn: today, category: "packaging", amount: 300 });

    const r = (await admin("GET", `/admin/profit?from=${today}&to=${today}`)).body;
    expect(r.delivered).toMatchObject({ orders: 1, sales: price * 2, shippingCollected: fee, productCost: 3000, deliveryCost: 400, cardFees: 0 });
    expect(r.returned).toMatchObject({ orders: 1, deliveryLoss: 400, returnFees: 200, lostGoods: 0 });
    expect(r.expenses.total).toBe(1300);
    expect(r.expenses.byCategory).toEqual([{ category: "ads", amount: 1000 }, { category: "packaging", amount: 300 }]);
    expect(r.netProfit).toBe(price * 2 + fee - 3000 - 400 - 400 - 200 - 1300);
    expect(r.returnRatePercent).toBe(50);
    expect(r.warnings.activeWilayasWithoutDeliveryCost).toBeGreaterThan(0);
  });

  it("can count returned goods as lost and card fees", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const before = (await admin("GET", `/admin/profit?from=${today}&to=${today}`)).body;
    await admin("PUT", "/admin/profit-settings", { returnFee: 200, returnedItemsLost: true, cardFeePercent: 2 });
    const after = (await admin("GET", `/admin/profit?from=${today}&to=${today}`)).body;
    expect(after.returned.lostGoods).toBe(1500);
    expect(after.netProfit).toBe(before.netProfit - 1500);
  });

  it("warns about goods without a cost price", async () => {
    const o = await place("HEAVY-TEE-BLACK-L", 1);
    await admin("POST", `/admin/orders/${await deliver(o.body.orderNumber)}/status`, { status: "delivered" });
    const today = new Date().toISOString().slice(0, 10);
    expect((await admin("GET", `/admin/profit?from=${today}&to=${today}`)).body.warnings.itemsWithoutCost).toBe(1);
  });

  it("edits and deletes expenses", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const e = await admin("POST", "/admin/expenses", { spentOn: today, category: "other", amount: 50 });
    const id = e.body.id;
    expect((await admin("PUT", `/admin/expenses/${id}`, { spentOn: today, category: "rent", amount: 75, platform: null, note: "x" })).body).toMatchObject({ category: "rent", amount: 75, note: "x" });
    expect((await admin("GET", `/admin/expenses?from=${today}&to=${today}`)).body.some((x: { id: string }) => x.id === id)).toBe(true);
    expect((await admin("DELETE", `/admin/expenses/${id}`)).status).toBe(200);
    expect((await admin("DELETE", `/admin/expenses/${id}`)).status).toBe(404);
    expect((await admin("POST", "/admin/expenses", { spentOn: today, category: "nope", amount: 5 })).status).toBe(422);
  });
});
