import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { buildProviders } from "../src/lib/delivery/index.js";
import type { DeliveryProvider } from "../src/lib/delivery/types.js";
import { classifyStatus } from "../src/lib/tracking.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const CRON = "cron-secret-cron-secret-123456";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;
let companyStatus = "Pas encore expédié";
let calls = 0;
const fakeCompany: DeliveryProvider = {
  id: "fakeco", name: "FakeCo", configured: () => true,
  async createParcel(i) { return { trackingNumber: `FAKE-${i.orderNumber}`, status: "created" }; },
  async getTracking() { calls++; return { status: companyStatus }; },
  async cancelParcel() {},
};

const variant = async (sku: string) => (await pg.query<{ id: string }>(`select id from product_variants where sku = $1`, [sku])).rows[0]!;
const stockOf = async (sku: string) => Number((await pg.query(`select stock from product_variants where sku = $1`, [sku])).rows[0]!.stock);
const communeOf = async (w: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [w])).rows[0]!.id);
let seq = 0;
async function api(method: string, path: string, json?: unknown, token?: string, headers: Record<string, string> = {}) {
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m: string, p: string, j?: unknown) => api(m, p, j, adminToken);
async function place(over: Record<string, unknown> = {}) {
  const r = await api("POST", "/orders", {
    items: [{ variantId: (await variant("HEAVY-TEE-CREAM-M")).id, quantity: 1 }], wilayaCode: 16, deliveryType: "home",
    customer: { name: "Amine Benali", phone: `055${String(3000000 + ++seq).slice(-7)}`, communeId: await communeOf(16), address: "12 rue des Tests" }, ...over,
  });
  const id = (await pg.query<{ id: string }>(`select id from orders where order_number = $1`, [r.body.orderNumber])).rows[0]!.id;
  return { ...r.body, id };
}
const cron = () => api("GET", "/cron/cleanup", undefined, undefined, { authorization: `Bearer ${CRON}` });

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  process.env.CRON_SECRET = CRON;
  process.env.WEB_ORIGIN = "https://shop.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} }, delivery: { ...buildProviders(), fakeco: fakeCompany } });
  await pg.query(`update product_variants set stock = 50 where sku = 'HEAVY-TEE-CREAM-M'`);
  adminToken = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
  await admin("PUT", "/admin/delivery", { provider: "fakeco" });
}, 60_000);
afterAll(() => pg.close());

describe("reading the delivery company's status", () => {
  it("understands the company's words", () => {
    expect(classifyStatus("Livré")).toBe("delivered");
    expect(classifyStatus("Sorti en livraison")).toBe("shipped");
    expect(classifyStatus("Ramassé")).toBe("shipped");
    expect(classifyStatus("Retourné au vendeur")).toBe("returned");
    expect(classifyStatus("Pas encore expédié")).toBeNull(); // still at the shop
    expect(classifyStatus("Prêt à expédier")).toBeNull();
    expect(classifyStatus("created")).toBeNull();
  });
});

describe("WhatsApp confirmation", () => {
  it("gives the owner a ready message to ask the customer, in the customer's language", async () => {
    const o = await place({ locale: "fr" });
    const d = (await admin("GET", `/admin/orders/${o.id}`)).body;
    const url = new URL(d.customer.whatsappAskUrl);
    expect(url.pathname).toMatch(/^\/213553/);
    const text = url.searchParams.get("text")!;
    expect(text).toContain("Amine Benali");
    expect(text).toContain(`n°${o.orderNumber}`);
    expect(text).toContain("DA");
  });

  it("lets the owner change the texts", async () => {
    const msgs = (await admin("GET", "/admin/whatsapp-messages")).body;
    expect(msgs.ask.ar).toContain("{name}");
    const put = await admin("PUT", "/admin/whatsapp-messages", { ...msgs, ask: { ...msgs.ask, ar: "أهلاً {name}، طلب {number}؟" } });
    expect(put.status).toBe(200);
    const o = await place();
    const text = new URL((await admin("GET", `/admin/orders/${o.id}`)).body.customer.whatsappAskUrl).searchParams.get("text");
    expect(text).toBe(`أهلاً Amine Benali، طلب ${o.orderNumber}؟`);
    await admin("PUT", "/admin/whatsapp-messages", { ...msgs, ask: { ar: "", fr: "", en: "" } }); // empty = default again
    expect((await admin("GET", "/admin/whatsapp-messages")).body.ask.ar).toContain("هل تؤكد الطلب");
  });

  it("shows the customer a button to confirm on the store's WhatsApp", async () => {
    const o = await place();
    expect((await api("GET", `/orders/${o.orderNumber}?token=${o.token}`)).body.whatsappConfirmUrl).toBeNull(); // no store number yet
    expect((await admin("PUT", "/admin/store-info", { phone: "", whatsapp: "0550123456", email: "", address: {}, hours: {} })).status).toBe(200);
    const view = (await api("GET", `/orders/${o.orderNumber}?token=${o.token}&locale=ar`)).body;
    const url = new URL(view.whatsappConfirmUrl);
    expect(url.pathname).toBe("/213550123456");
    expect(url.searchParams.get("text")).toContain(`#${o.orderNumber}`);
    expect(JSON.stringify(view)).not.toContain("Amine"); // still no personal data
  });

  it("after approval, gives the owner the tracking message once (the customer's phone is erased)", async () => {
    const o = await place({ locale: "ar" });
    const c = await admin("POST", `/admin/orders/${o.id}/confirm`, { company: "manual", trackingNumber: "TRK-77" });
    expect(c.status).toBe(200);
    expect(c.body.customer).toBeNull();
    const url = new URL(c.body.whatsappTrackingUrl);
    expect(url.pathname).toMatch(/^\/213553/);
    const text = url.searchParams.get("text")!;
    expect(text).toContain("TRK-77");
    expect(text).toContain(`https://shop.example.com/ar/order/${o.orderNumber}?t=${o.token}`);
    expect((await admin("GET", `/admin/orders/${o.id}`)).body.whatsappTrackingUrl).toBeNull();
  });
});

describe("automatic tracking", () => {
  async function confirmed() {
    const o = await place();
    expect((await admin("POST", `/admin/orders/${o.id}/confirm`, {})).status).toBe(200); // fakeco creates the parcel
    return o;
  }
  const status = async (id: string) => (await pg.query<{ status: string; payment_status: string; delivery_status: string }>(`select status, payment_status, delivery_status from orders where id = $1`, [id])).rows[0]!;

  it("moves confirmed → shipped → delivered by itself (cash on delivery becomes paid)", async () => {
    const o = await confirmed();
    companyStatus = "Ramassé";
    await cron();
    expect(await status(o.id)).toMatchObject({ status: "shipped", delivery_status: "Ramassé" });
    companyStatus = "Livré";
    await cron();
    expect(await status(o.id)).toMatchObject({ status: "delivered", payment_status: "paid", delivery_status: "Livré" });
    const row = (await pg.query(`select delivered_at from orders where id = $1`, [o.id])).rows[0] as { delivered_at: unknown };
    expect(row.delivered_at).not.toBeNull();
  });

  it("a parcel that comes back returns to stock by itself", async () => {
    const before = await stockOf("HEAVY-TEE-CREAM-M");
    const o = await confirmed();
    expect(await stockOf("HEAVY-TEE-CREAM-M")).toBe(before - 1);
    companyStatus = "Retourné au vendeur";
    await cron();
    expect(await status(o.id)).toMatchObject({ status: "returned" });
    expect(await stockOf("HEAVY-TEE-CREAM-M")).toBe(before);
  });

  it("the customer's page refreshes the status itself (at most every 30 minutes)", async () => {
    const o = await confirmed();
    companyStatus = "Sorti en livraison";
    calls = 0;
    const first = await api("GET", `/orders/${o.orderNumber}?token=${o.token}`);
    expect(first.body).toMatchObject({ status: "shipped", deliveryStatus: "Sorti en livraison" });
    expect(calls).toBe(1);
    companyStatus = "Livré";
    await api("GET", `/orders/${o.orderNumber}?token=${o.token}`);
    expect(calls).toBe(1); // asked less than 30 minutes ago: no new call
    await pg.query(`update orders set tracking_checked_at = now() - interval '31 minutes' where id = $1`, [o.id]);
    expect((await api("GET", `/orders/${o.orderNumber}?token=${o.token}`)).body.status).toBe("delivered");
  });

  it("the owner can refresh one parcel by hand", async () => {
    const o = await confirmed();
    companyStatus = "Transfert";
    const r = await admin("POST", `/admin/orders/${o.id}/refresh-tracking`);
    expect(r.body.deliveryStatus).toBe("Transfert");
    expect((await status(o.id)).status).toBe("shipped");
  });
});

describe("the delivery company's own tracking page", () => {
  it("the owner saves the company's link once; customer and owner get it with the parcel code", async () => {
    expect((await admin("PUT", "/admin/delivery", { trackingUrls: { fakeco: "http://insecure.example/{tracking}" } })).status).toBe(422); // https only
    expect((await admin("PUT", "/admin/delivery", { trackingUrls: { fakeco: "https://fakeco.example/track" } })).status).toBe(422); // needs {tracking}
    const saved = await admin("PUT", "/admin/delivery", { trackingUrls: { fakeco: "https://fakeco.example/track?code={tracking}" } });
    expect(saved.status).toBe(200);
    expect(saved.body.provider).toBe("fakeco"); // saving the link does not change the company
    expect(saved.body.trackingUrls.fakeco).toContain("{tracking}");

    const o = await place();
    expect((await admin("POST", `/admin/orders/${o.id}/confirm`, {})).status).toBe(200);
    const view = (await api("GET", `/orders/${o.orderNumber}?token=${o.token}`)).body;
    expect(view.carrierTrackingUrl).toBe(`https://fakeco.example/track?code=FAKE-${o.orderNumber}`);
    expect((await admin("GET", `/admin/orders/${o.id}`)).body.carrierTrackingUrl).toBe(view.carrierTrackingUrl);

    // A link can be removed again, and an order without a saved link has none.
    expect((await admin("PUT", "/admin/delivery", { trackingUrls: { fakeco: "" } })).body.trackingUrls).toEqual({});
    expect((await api("GET", `/orders/${o.orderNumber}?token=${o.token}`)).body.carrierTrackingUrl).toBeNull();
  });
});
