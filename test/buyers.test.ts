import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getEnv, resetEnvCache } from "../src/env.js";
import { buyerCode, ipKey, phoneKey, trustedClientIp } from "../src/lib/fingerprint.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const FP = "fingerprint-secret-fingerprint-secret-1234567890";
const SF = "storefront-secret-123456";
const CRON = "cron-secret-cron-secret-123456";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;

const variant = async (sku: string) => (await pg.query<{ id: string }>(`select id from product_variants where sku = $1`, [sku])).rows[0]!;
const communeOf = async (w: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [w])).rows[0]!.id);
async function api(method: string, path: string, json?: unknown, token?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m: string, p: string, j?: unknown) => api(m, p, j, adminToken);
async function order(phone: string, name = "Someone", headers: Record<string, string> = {}) {
  const r = await api("POST", "/orders", {
    items: [{ variantId: (await variant("HEAVY-TEE-BLACK-XL")).id, quantity: 1 }], wilayaCode: 16, deliveryType: "home",
    customer: { name, phone, communeId: await communeOf(16), address: "12 rue des Tests" },
  }, undefined, headers);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (await pg.query<{ id: string }>(`select id from orders where order_number = $1`, [r.body.orderNumber])).rows[0]!.id;
}
async function finish(id: string, status: "delivered" | "returned") {
  await admin("POST", `/admin/orders/${id}/confirm`, { company: "manual", trackingNumber: `T-${id.slice(0, 6)}` });
  await admin("POST", `/admin/orders/${id}/status`, { status: "shipped" });
  await admin("POST", `/admin/orders/${id}/status`, { status });
}
const keys = async (id: string) => (await pg.query<{ phone_key: string | null; ip_key: string | null; customer_phone: string | null }>(`select phone_key, ip_key, customer_phone from orders where id = $1`, [id])).rows[0]!;
const detail = async (id: string) => (await admin("GET", `/admin/orders/${id}`)).body;

beforeAll(async () => {
  Object.assign(process.env, { SUPABASE_JWT_SECRET: SECRET, R2_PUBLIC_URL: "https://img.example.com", FINGERPRINT_SECRET: FP, STOREFRONT_SECRET: SF, CRON_SECRET: CRON });
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  await pg.query(`update product_variants set stock = 500 where sku = 'HEAVY-TEE-BLACK-XL'`);
  adminToken = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("fingerprints", () => {
  it("are stable, one-way and depend on the secret", () => {
    const a = phoneKey("0550123456")!;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneKey("0550123456")).toBe(a);
    expect(phoneKey("0550123457")).not.toBe(a);
    expect(a).not.toContain("0550123456");
    expect(ipKey("41.200.1.1")).not.toBe(phoneKey("41.200.1.1")); // a phone and an IP never collide
    expect(buyerCode(a)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    const saved = process.env.FINGERPRINT_SECRET;
    delete process.env.FINGERPRINT_SECRET;
    resetEnvCache();
    expect(phoneKey("0550123456")).toBeNull(); // no secret: nothing is stored
    process.env.FINGERPRINT_SECRET = saved;
    resetEnvCache();
    expect(getEnv().FINGERPRINT_SECRET).toBe(FP);
  });
  it("only believes the forwarded IP from the storefront", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] });
    expect(trustedClientIp(h({ "x-client-ip": "41.200.1.1", "x-storefront-secret": SF }))).toBe("41.200.1.1");
    expect(trustedClientIp(h({ "x-client-ip": "41.200.1.1" }))).toBeNull();
    expect(trustedClientIp(h({ "x-client-ip": "41.200.1.1", "x-storefront-secret": "wrong" }))).toBeNull();
    expect(trustedClientIp(h({ "x-client-ip": "<script>", "x-storefront-secret": SF }))).toBeNull();
  });
});

describe("orders carry fingerprints, not numbers", () => {
  it("the same person is recognised whatever the phone format or name; personal data is still erased", async () => {
    const a = await order("0550 11 22 33", "Amine");
    const b = await order("+213 550 11 22 33", "Another Name");
    const c = await order("0550 99 88 77");
    const ka = await keys(a), kb = await keys(b), kc = await keys(c);
    expect(ka.phone_key).toBe(kb.phone_key);
    expect(ka.phone_key).not.toBe(kc.phone_key);
    expect(ka.phone_key).not.toBeNull();
    await finish(a, "delivered");
    const after = await keys(a);
    expect(after.customer_phone).toBeNull(); // erased on confirmation…
    expect(after.phone_key).toBe(ka.phone_key); // …but the fingerprint stays
  });
  it("stores the connection fingerprint only when the storefront vouches for the address", async () => {
    const withIp = await order("0551 00 00 01", "Aya", { "x-client-ip": "41.200.5.5", "x-storefront-secret": SF });
    const spoof = await order("0551 00 00 02", "Bilal", { "x-client-ip": "41.200.5.5" });
    const wrong = await order("0551 00 00 03", "Chems", { "x-client-ip": "41.200.5.5", "x-storefront-secret": "nope" });
    expect((await keys(withIp)).ip_key).toBe(ipKey("41.200.5.5"));
    expect((await keys(spoof)).ip_key).toBeNull();
    expect((await keys(wrong)).ip_key).toBeNull();
  });
});

describe("what the history says about a new order", () => {
  it("loyal, watch and high", async () => {
    // loyal: two delivered
    for (let i = 0; i < 2; i++) await finish(await order("0660 10 10 10"), "delivered");
    const loyal = await order("0660 10 10 10");
    expect((await detail(loyal)).buyer).toMatchObject({ previousOrders: 2, delivered: 2, returned: 0, risk: "loyal" });
    // watch: one returned
    await finish(await order("0660 20 20 20"), "returned");
    const watch = await order("0660 20 20 20");
    expect((await detail(watch)).buyer).toMatchObject({ previousOrders: 1, returned: 1, risk: "watch" });
    // high: two returned
    for (let i = 0; i < 2; i++) await finish(await order("0660 30 30 30"), "returned");
    const high = await order("0660 30 30 30");
    expect((await detail(high)).buyer).toMatchObject({ previousOrders: 2, returned: 2, risk: "high" });
    // a first-time buyer has no verdict
    const fresh = await order("0660 40 40 40");
    expect((await detail(fresh)).buyer).toMatchObject({ previousOrders: 0, risk: null });
    // the orders list shows the same verdicts (not counting each row's own order)
    const list = (await admin("GET", "/admin/orders?status=pending&limit=100")).body.items;
    const risk = (id: string) => list.find((o: { id: string }) => o.id === id).buyerRisk;
    expect([risk(loyal), risk(watch), risk(high), risk(fresh)]).toEqual(["loyal", "watch", "high", null]);
  });
  it("hints when one connection places orders under several numbers", async () => {
    const h = { "x-client-ip": "105.99.1.1", "x-storefront-secret": SF };
    await order("0661 50 00 01", "Aya", h);
    await order("0661 50 00 02", "Bilal", h);
    const third = await order("0661 50 00 03", "Chems", h);
    expect((await detail(third)).buyer.sameConnectionOthers).toBe(2);
    expect((await detail(await order("0661 50 00 04", "Dina", { "x-client-ip": "105.99.2.2", "x-storefront-secret": SF }))).buyer.sameConnectionOthers).toBe(0);
  });
});

describe("buyers list", () => {
  it("lists repeat buyers and those whose parcels came back, by code", async () => {
    const repeat = (await admin("GET", "/admin/buyers?kind=repeat")).body;
    expect(repeat.counts.repeat).toBeGreaterThanOrEqual(2);
    const loyal = repeat.items.find((b: { risk: string }) => b.risk === "loyal");
    expect(loyal).toMatchObject({ orders: 3, delivered: 2 });
    expect(loyal.code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(loyal.recentOrders.length).toBe(3);
    const returners = (await admin("GET", "/admin/buyers?kind=returners")).body;
    expect(returners.items[0]).toMatchObject({ returned: 2, risk: "high" }); // the worst first
    expect(returners.items.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(repeat)).not.toMatch(/0660|Someone/); // no personal data in the answer
    expect((await api("GET", "/admin/buyers")).status).toBe(401);
  });
});

describe("retention", () => {
  it("the daily cleanup erases connection fingerprints after 90 days but keeps the phone fingerprint", async () => {
    const o = await order("0662 00 00 01", "Old", { "x-client-ip": "41.1.1.1", "x-storefront-secret": SF });
    await pg.query(`update orders set created_at = now() - interval '100 days' where id = $1`, [o]);
    const recent = await order("0662 00 00 02", "New", { "x-client-ip": "41.1.1.2", "x-storefront-secret": SF });
    const r = await api("GET", "/cron/cleanup", undefined, undefined, { authorization: `Bearer ${CRON}` });
    expect(r.body.ipFingerprintsErased).toBeGreaterThanOrEqual(1);
    expect(await keys(o)).toMatchObject({ ip_key: null });
    expect((await keys(o)).phone_key).not.toBeNull();
    expect((await keys(recent)).ip_key).not.toBeNull();
  });
});
