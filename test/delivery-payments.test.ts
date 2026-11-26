import { createHmac } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { buildProviders, manualProvider } from "../src/lib/delivery/index.js";
import type { DeliveryProvider, ParcelInput } from "../src/lib/delivery/types.js";
import { yalidine } from "../src/lib/delivery/yalidine.js";
import { chargily } from "../src/lib/payments/chargily.js";
import type { PaymentProvider } from "../src/lib/payments/types.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const CHARGILY_KEY = "test_sk_0123456789";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;
const parcels: ParcelInput[] = [];
const cancelled: string[] = [];
let failParcel = false;

const fakeCompany: DeliveryProvider = {
  id: "fakeco", name: "FakeCo", configured: () => true,
  async createParcel(i) { if (failParcel) throw new Error("boom"); parcels.push(i); return { trackingNumber: `FAKE-${i.orderNumber}`, status: "created" }; },
  async getTracking() { return { status: "in_transit" }; },
  async cancelParcel(t) { cancelled.push(t); },
};
const unconfigured: DeliveryProvider = { ...fakeCompany, id: "nokeys", name: "NoKeys", configured: () => false };
let payConfigured = true;
let failCheckout = false;
const fakePay: PaymentProvider = {
  id: "chargily",
  configured: () => payConfigured,
  async createCheckout(i) { if (failCheckout) throw new Error("down"); return { ref: `chk_${i.orderNumber}`, checkoutUrl: `https://pay.example/${i.orderNumber}` }; },
  parseWebhook: chargily().parseWebhook,
};

const variant = async (sku: string) => (await pg.query<{ id: string; stock: number }>(`select id, stock from product_variants where sku = $1`, [sku])).rows[0]!;
const communeOf = async (w: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [w])).rows[0]!.id);
let seq = 0;
async function api(method: string, path: string, json?: unknown, token?: string, raw?: { body: string; headers: Record<string, string> }) {
  const headers: Record<string, string> = { ...(raw?.headers ?? {}) };
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: raw ? raw.body : json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m: string, p: string, j?: unknown) => api(m, p, j, adminToken);
async function place(over: Record<string, unknown> = {}) {
  return api("POST", "/orders", {
    items: [{ variantId: (await variant("HEAVY-TEE-CREAM-M")).id, quantity: 1 }], wilayaCode: 16, deliveryType: "home",
    customer: { name: "Amine Benali", phone: `055${String(2000000 + ++seq).slice(-7)}`, communeId: await communeOf(16), address: "12 rue des Tests" }, ...over,
  });
}
const orderId = async (n: number) => (await pg.query<{ id: string }>(`select id from orders where order_number = $1`, [n])).rows[0]!.id;
const sign = (raw: string) => createHmac("sha256", CHARGILY_KEY).update(raw).digest("hex");

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  process.env.CHARGILY_SECRET_KEY = CHARGILY_KEY;
  process.env.CRON_SECRET = "cron-secret-cron-secret";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  await pg.query(`update product_variants set stock = 500 where sku = 'HEAVY-TEE-CREAM-M'`);
  app = createApp({ db: t.db, storage: { upload: async () => {} }, delivery: { manual: manualProvider, fakeco: fakeCompany, nokeys: unconfigured }, payment: fakePay });
  adminToken = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("delivery company chosen from the dashboard", () => {
  it("starts on manual and lists what the server can use", async () => {
    const r = await admin("GET", "/admin/delivery");
    expect(r.body.provider).toBe("manual");
    expect(r.body.providers.map((p: { id: string }) => p.id).sort()).toEqual(["fakeco", "manual", "nokeys"]);
  });

  it("manual mode still needs a tracking number", async () => {
    const o = await place();
    const r = await admin("POST", `/admin/orders/${await orderId(o.body.orderNumber)}/confirm`, {});
    expect(r.status).toBe(422);
    const ok = await admin("POST", `/admin/orders/${await orderId(o.body.orderNumber)}/confirm`, { trackingNumber: "MAN-1" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "confirmed", trackingNumber: "MAN-1", customer: null });
  });

  it("refuses unknown companies and ones whose keys are missing", async () => {
    expect((await admin("PUT", "/admin/delivery", { provider: "nope" })).status).toBe(422);
    expect((await admin("PUT", "/admin/delivery", { provider: "nokeys" })).status).toBe(409);
  });

  it("with a company selected, confirming sends the parcel itself and erases the customer's data", async () => {
    expect((await admin("PUT", "/admin/delivery", { provider: "fakeco" })).body.provider).toBe("fakeco");
    const o = await place();
    const r = await admin("POST", `/admin/orders/${await orderId(o.body.orderNumber)}/confirm`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "confirmed", trackingNumber: `FAKE-${o.body.orderNumber}`, deliveryCompany: "fakeco", customer: null });
    // The company received everything it needs; cash on delivery means it collects the full total.
    expect(parcels.at(-1)).toMatchObject({ customerName: "Amine Benali", address: "12 rue des Tests", wilayaName: "Alger", amountToCollect: o.body.total, deliveryType: "home" });
    const row = (await pg.query(`select customer_name, customer_phone, address from orders where order_number = $1`, [o.body.orderNumber])).rows[0];
    expect(row).toEqual({ customer_name: null, customer_phone: null, address: null });
  });

  it("a company failure leaves the order pending and untouched", async () => {
    failParcel = true;
    const o = await place();
    const id = await orderId(o.body.orderNumber);
    const r = await admin("POST", `/admin/orders/${id}/confirm`, {});
    failParcel = false;
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("Amine");
    expect((await pg.query(`select status, customer_name from orders where id = $1`, [id])).rows[0]).toMatchObject({ status: "pending", customer_name: "Amine Benali" });
    // Trying again works.
    expect((await admin("POST", `/admin/orders/${id}/confirm`, {})).status).toBe(200);
  });

  it("refreshes a parcel's status from the company", async () => {
    const o = await place();
    const id = await orderId(o.body.orderNumber);
    await admin("POST", `/admin/orders/${id}/confirm`, {});
    const r = await admin("POST", `/admin/orders/${id}/refresh-tracking`);
    expect(r.body.deliveryStatus).toBe("in_transit");
    expect((await admin("GET", `/admin/orders/${id}`)).body.deliveryStatus).toBe("in_transit");
  });

  it("only admins can change it", async () => {
    expect((await api("PUT", "/admin/delivery", { provider: "manual" })).status).toBe(401);
  });
});

describe("Yalidine adapter (against a fake server)", () => {
  const input: ParcelInput = { orderNumber: 1234, customerName: "Amine Benali", phone: "0550123456", address: "12 rue des Tests", wilayaName: "Alger", communeName: "Bab Ezzouar", deliveryType: "home", amountToCollect: 5300, productList: "Tee x1" };
  it("creates, tracks and cancels a parcel with the right headers and fields", async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : null });
      if (init.method === "POST") return new Response(JSON.stringify({ "1234": { success: true, order_id: "1234", tracking: "yal-AB123" } }));
      if (init.method === "DELETE") return new Response("{}");
      return new Response(JSON.stringify({ data: [{ last_status: "En livraison" }] }));
    }) as unknown as typeof fetch;
    const y = yalidine({ fetch: fake, apiId: "id1", apiToken: "tok1", fromWilaya: "Oran" });
    expect(y.configured()).toBe(true);
    expect(await y.createParcel(input)).toEqual({ trackingNumber: "yal-AB123", status: "created" });
    expect(calls[0]!.headers).toMatchObject({ "X-API-ID": "id1", "X-API-TOKEN": "tok1" });
    expect((calls[0]!.body as Record<string, unknown>[])[0]).toMatchObject({ order_id: "1234", from_wilaya_name: "Oran", firstname: "Amine", familyname: "Benali", to_wilaya_name: "Alger", to_commune_name: "Bab Ezzouar", price: 5300, is_stopdesk: false });
    expect(await y.getTracking("yal-AB123")).toEqual({ status: "En livraison" });
    await y.cancelParcel("yal-AB123");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("reports a refusal without leaking the customer's data", async () => {
    const fake = (async () => new Response(JSON.stringify({ "1234": { success: false, message: "Commune introuvable" } }))) as unknown as typeof fetch;
    const y = yalidine({ fetch: fake, apiId: "a", apiToken: "b", fromWilaya: "Oran" });
    await expect(y.createParcel(input)).rejects.toThrow("Commune introuvable");
    const fail = (async () => new Response("Amine Benali 0550123456", { status: 500 })) as unknown as typeof fetch;
    await expect(yalidine({ fetch: fail, apiId: "a", apiToken: "b", fromWilaya: "Oran" }).createParcel(input)).rejects.toThrow(/^Yalidine answered 500$/);
  });

  it("desk delivery looks up the desk in the commune", async () => {
    const bodies: unknown[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      if (url.includes("/centers/")) return new Response(JSON.stringify({ data: [{ center_id: 77 }] }));
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ "1234": { success: true, tracking: "yal-D1" } }));
    }) as unknown as typeof fetch;
    await yalidine({ fetch: fake, apiId: "a", apiToken: "b", fromWilaya: "Oran" }).createParcel({ ...input, deliveryType: "desk" });
    expect((bodies[0] as Record<string, unknown>[])[0]).toMatchObject({ is_stopdesk: true, stopdesk_id: 77 });
  });

  it("is not configured without keys", () => {
    expect(buildProviders().yalidine!.configured()).toBe(false);
  });
});

describe("card payment (Chargily)", () => {
  it("tells the storefront whether cards are available", async () => {
    expect((await api("GET", "/payments/methods")).body).toEqual({ cod: true, card: true });
    payConfigured = false;
    expect((await api("GET", "/payments/methods")).body).toEqual({ cod: true, card: false });
    expect((await place({ paymentMethod: "chargily" })).status).toBe(422);
    payConfigured = true;
  });

  it("creates the order unpaid-pending and returns the checkout link; the webhook marks it paid", async () => {
    const r = await place({ paymentMethod: "chargily", locale: "fr" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paymentMethod: "chargily", checkoutUrl: `https://pay.example/${r.body.orderNumber}`, total: 2900 });
    const id = await orderId(r.body.orderNumber);
    const get = async () => (await pg.query<{ payment_status: string; payment_ref: string }>(`select payment_status, payment_ref from orders where id = $1`, [id])).rows[0]!;
    expect(await get()).toMatchObject({ payment_status: "pending", payment_ref: `chk_${r.body.orderNumber}` });

    const raw = JSON.stringify({ type: "checkout.paid", data: { id: `chk_${r.body.orderNumber}` } });
    const hook = await api("POST", "/webhooks/chargily", undefined, undefined, { body: raw, headers: { "content-type": "application/json", signature: sign(raw) } });
    expect(hook.status).toBe(200);
    expect((await get()).payment_status).toBe("paid");
    // The customer's page shows it, and a replayed "failed" event cannot undo a payment.
    const rawFail = JSON.stringify({ type: "checkout.failed", data: { id: `chk_${r.body.orderNumber}` } });
    await api("POST", "/webhooks/chargily", undefined, undefined, { body: rawFail, headers: { "content-type": "application/json", signature: sign(rawFail) } });
    expect((await get()).payment_status).toBe("paid");
    expect((await api("GET", `/orders/${r.body.orderNumber}?token=${r.body.token}`)).body.paymentStatus).toBe("paid");
  });

  it("a paid order is sent to the courier with nothing to collect", async () => {
    await admin("PUT", "/admin/delivery", { provider: "fakeco" });
    const r = await place({ paymentMethod: "chargily" });
    const raw = JSON.stringify({ type: "checkout.paid", data: { id: `chk_${r.body.orderNumber}` } });
    await api("POST", "/webhooks/chargily", undefined, undefined, { body: raw, headers: { "content-type": "application/json", signature: sign(raw) } });
    await admin("POST", `/admin/orders/${await orderId(r.body.orderNumber)}/confirm`, {});
    expect(parcels.at(-1)!.amountToCollect).toBe(0);
  });

  it("rejects webhooks with a wrong or missing signature", async () => {
    const r = await place({ paymentMethod: "chargily" });
    const raw = JSON.stringify({ type: "checkout.paid", data: { id: `chk_${r.body.orderNumber}` } });
    expect((await api("POST", "/webhooks/chargily", undefined, undefined, { body: raw, headers: { signature: "deadbeef" } })).status).toBe(401);
    expect((await api("POST", "/webhooks/chargily", undefined, undefined, { body: raw, headers: {} })).status).toBe(401);
    expect((await pg.query(`select payment_status from orders where order_number = $1`, [r.body.orderNumber])).rows[0]).toMatchObject({ payment_status: "pending" });
  });

  it("when the payment page cannot be created, the order is cancelled and the stock returns", async () => {
    const before = Number((await variant("HEAVY-TEE-CREAM-M")).stock);
    failCheckout = true;
    const r = await place({ paymentMethod: "chargily" });
    failCheckout = false;
    expect(r.status).toBe(502);
    expect(Number((await variant("HEAVY-TEE-CREAM-M")).stock)).toBe(before);
    expect((await pg.query(`select status, customer_name from orders order by order_number desc limit 1`)).rows[0]).toMatchObject({ status: "cancelled", customer_name: null });
  });
});

describe("daily cleanup", () => {
  it("needs the secret", async () => {
    expect((await api("GET", "/cron/cleanup")).status).toBe(401);
    expect((await api("GET", "/cron/cleanup", undefined, "wrong")).status).toBe(401);
  });

  it("cancels orders pending for too long, deletes old notifications, refreshes parcel statuses", async () => {
    const o = await place();
    const old = await place();
    await pg.query(`update orders set created_at = now() - interval '20 days' where order_number = $1`, [old.body.orderNumber]);
    await pg.query(`update admin_events set created_at = now() - interval '90 days' where id = (select min(id) from admin_events)`);
    const shipped = await place();
    await admin("POST", `/admin/orders/${await orderId(shipped.body.orderNumber)}/confirm`, {});
    const r = await api("GET", "/cron/cleanup", undefined, "cron-secret-cron-secret");
    expect(r.status).toBe(200);
    expect(r.body.expiredOrders).toBeGreaterThanOrEqual(1);
    expect(r.body.deletedEvents).toBeGreaterThanOrEqual(1);
    expect(r.body.trackingUpdated).toBeGreaterThanOrEqual(1);
    expect((await pg.query(`select status from orders where order_number = $1`, [old.body.orderNumber])).rows[0]).toMatchObject({ status: "cancelled" });
    expect((await pg.query(`select status from orders where order_number = $1`, [o.body.orderNumber])).rows[0]).toMatchObject({ status: "pending" });
  });
});
