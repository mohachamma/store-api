import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;

const variant = async (sku: string) => (await pg.query<{ id: string; stock: number }>(`select id, stock from product_variants where sku = $1`, [sku])).rows[0]!;
const stock = async (sku: string) => Number((await variant(sku)).stock);
const communeOf = async (wilaya: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [wilaya])).rows[0]!.id);
let phoneSeq = 0;
const nextPhone = () => `055${String(1000000 + ++phoneSeq).slice(-7)}`;

async function api(method: string, path: string, json?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (method: string, path: string, json?: unknown) => api(method, path, json, adminToken);

async function place(items: { sku: string; qty: number }[], over: Record<string, unknown> = {}) {
  const lines = await Promise.all(items.map(async (i) => ({ variantId: (await variant(i.sku)).id, quantity: i.qty })));
  return api("POST", "/orders", {
    items: lines, wilayaCode: 16, deliveryType: "home",
    customer: { name: "Test Customer", phone: nextPhone(), communeId: await communeOf(16), address: "12 rue des Tests" },
    ...over,
  });
}

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

describe("placing an order", () => {
  it("prices everything on the server, reserves stock and notifies the admin", async () => {
    const before = await stock("HEAVY-TEE-CREAM-M");
    const r = await place([{ sku: "HEAVY-TEE-CREAM-M", qty: 2 }]);
    expect(r.status).toBe(200);
    // 2 × 2400 = 4800 + home delivery to Alger (500, below the 10 000 free-delivery threshold)
    expect(r.body).toMatchObject({ status: "pending", paymentMethod: "cod", subtotal: 4800, shippingFee: 500, discountTotal: 0, total: 5300 });
    expect(r.body.orderNumber).toBeGreaterThanOrEqual(1001);
    expect(await stock("HEAVY-TEE-CREAM-M")).toBe(before - 2);
    const ev = await pg.query<{ payload: { order_number: number; total: number } }>(`select payload from admin_events order by id desc limit 1`);
    expect(ev.rows[0]?.payload).toMatchObject({ order_number: r.body.orderNumber, total: 5300 });
  });

  it("ignores any price the client tries to send", async () => {
    const r = await place([{ sku: "HEAVY-TEE-CREAM-S", qty: 1 }], { total: 1, subtotal: 1, shippingFee: 0, items: [{ variantId: (await variant("HEAVY-TEE-CREAM-S")).id, quantity: 1, price: 1, unitPrice: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.subtotal).toBe(2400);
  });

  it("uses the desk fee for desk delivery and free delivery over the threshold", async () => {
    expect((await place([{ sku: "HEAVY-TEE-CREAM-L", qty: 1 }], { deliveryType: "desk" })).body.shippingFee).toBe(350);
    const big = await place([{ sku: "NYLON-ZIP-HOODIE-L", qty: 2 }]); // 15 800 ≥ 10 000
    expect(big.body).toMatchObject({ subtotal: 15800, shippingFee: 0, total: 15800 });
  });

  it("shows a customer their own order without any personal data, only with the right token", async () => {
    const r = await place([{ sku: "HEAVY-TEE-BLACK-M", qty: 1 }]);
    const ok = await api("GET", `/orders/${r.body.orderNumber}?token=${r.body.token}&locale=fr`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ orderNumber: r.body.orderNumber, status: "pending", paymentMethod: "cod", wilaya: "Alger", total: 2900 });
    expect(ok.body.items).toEqual([{ name: "تيشرت سميك أسود", size: "M", color: "black", unitPrice: 2400, quantity: 1, lineTotal: 2400 }]);
    expect(JSON.stringify(ok.body)).not.toMatch(/Test Customer|0550|rue des Tests/);
    expect((await api("GET", `/orders/${r.body.orderNumber}?token=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await api("GET", `/orders/${r.body.orderNumber}`)).status).toBe(422); // token is required
  });

  it("normalises Algerian phone numbers and rejects bad ones", async () => {
    const lines = [{ variantId: (await variant("HEAVY-TEE-CREAM-XL")).id, quantity: 1 }];
    const base = { items: lines, wilayaCode: 16, deliveryType: "home", customer: { name: "Ali", phone: "+213 550 12 34 56", communeId: await communeOf(16), address: "Rue 1, Alger" } };
    const r = await api("POST", "/orders", base);
    expect(r.status).toBe(200);
    const row = await pg.query<{ customer_phone: string }>(`select customer_phone from orders where order_number = $1`, [r.body.orderNumber]);
    expect(row.rows[0]?.customer_phone).toBe("0550123456");
    expect((await api("POST", "/orders", { ...base, customer: { ...base.customer, phone: "0123456789" } })).body.error.code).toBe("invalid_phone");
    expect((await api("POST", "/orders", { ...base, customer: { ...base.customer, phone: "12345" } })).status).toBe(422);
  });

  it("rejects a commune from another wilaya, unknown/unpublished items and unavailable wilayas", async () => {
    expect((await place([{ sku: "HEAVY-TEE-CREAM-M", qty: 1 }], { wilayaCode: 31 })).body.error.code).toBe("invalid_commune"); // commune is in wilaya 16
    expect((await api("POST", "/orders", { items: [{ variantId: "00000000-0000-4000-8000-000000000001", quantity: 1 }], wilayaCode: 16, deliveryType: "home", customer: { name: "Ali", phone: "0550000001", communeId: await communeOf(16), address: "Rue 1, Alger" } })).body.error.code).toBe("item_unavailable");
    await pg.exec(`update products set is_published = false where slug = 'heavy-tee-black'`);
    expect((await place([{ sku: "HEAVY-TEE-BLACK-S", qty: 1 }])).body.error.code).toBe("item_unavailable");
    await pg.exec(`update products set is_published = true where slug = 'heavy-tee-black'`);
    await pg.exec(`update wilayas set active = false where code = 16`);
    expect((await place([{ sku: "HEAVY-TEE-CREAM-M", qty: 1 }])).body.error.code).toBe("invalid_wilaya");
    await pg.exec(`update wilayas set active = true where code = 16`);
  });

  it("validates the body", async () => {
    expect((await api("POST", "/orders", { items: [], wilayaCode: 16, deliveryType: "home", customer: { name: "A", phone: "1", communeId: 1, address: "x" } })).status).toBe(422);
    expect((await place([{ sku: "HEAVY-TEE-CREAM-M", qty: 11 }])).status).toBe(422);
    expect((await place([{ sku: "HEAVY-TEE-CREAM-M", qty: 1 }], { paymentMethod: "chargily" })).status).toBe(422);
  });
});

describe("stock safety", () => {
  it("refuses more than the available stock and changes nothing", async () => {
    const before = await stock("QUILTED-PANT-XL");
    const r = await place([{ sku: "QUILTED-PANT-XL", qty: before + 1 > 10 ? 10 : before + 1 }]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("out_of_stock");
    expect(await stock("QUILTED-PANT-XL")).toBe(before);
  });

  it("is atomic: a failing line rolls back the other lines", async () => {
    const okBefore = await stock("QUILTED-PANT-M");
    const soldOut = await variant("ESSENTIAL-HOODIE-BLACK-XS"); // seeded with stock 0
    expect(Number(soldOut.stock)).toBe(0);
    const ordersBefore = Number((await pg.query<{ n: number }>(`select count(*)::int as n from orders`)).rows[0]!.n);
    const r = await place([{ sku: "QUILTED-PANT-M", qty: 1 }, { sku: "ESSENTIAL-HOODIE-BLACK-XS", qty: 1 }]);
    expect(r.status).toBe(409);
    expect(await stock("QUILTED-PANT-M")).toBe(okBefore);
    expect(Number((await pg.query<{ n: number }>(`select count(*)::int as n from orders`)).rows[0]!.n)).toBe(ordersBefore);
  });

  it("never oversells the last unit when two customers order at the same time", async () => {
    await pg.exec(`update product_variants set stock = 1 where sku = 'SLIM-DENIM-JEAN-S'`);
    const results = await Promise.all([place([{ sku: "SLIM-DENIM-JEAN-S", qty: 1 }]), place([{ sku: "SLIM-DENIM-JEAN-S", qty: 1 }])]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stock("SLIM-DENIM-JEAN-S")).toBe(0);
  });
});

describe("discount codes", () => {
  it("applies a percentage code (min order, counted once per order)", async () => {
    const r = await place([{ sku: "SLIM-DENIM-JEAN-M", qty: 1 }], { discountCode: " welcome10 " }); // 5 400 → -540, +500 shipping
    expect(r.body).toMatchObject({ subtotal: 5400, discountTotal: 540, shippingFee: 500, total: 5360 });
    expect(Number((await pg.query<{ used_count: number }>(`select used_count from discount_codes where code = 'WELCOME10'`)).rows[0]!.used_count)).toBe(1);
  });
  it("rejects unknown codes, orders below the minimum, expired and used-up codes — without side effects", async () => {
    expect((await place([{ sku: "HEAVY-TEE-CREAM-M", qty: 1 }], { discountCode: "NOPE" })).body.error.code).toBe("invalid_code");
    expect((await place([{ sku: "HEAVY-TEE-CREAM-M", qty: 1 }], { discountCode: "WELCOME10" })).body.error.code).toBe("code_min_subtotal"); // 2 400 < 3 000
    await pg.exec(`update discount_codes set max_uses = 1 where code = 'WELCOME10'`); // already used once
    const stockBefore = await stock("SLIM-DENIM-JEAN-L");
    expect((await place([{ sku: "SLIM-DENIM-JEAN-L", qty: 1 }], { discountCode: "WELCOME10" })).body.error.code).toBe("invalid_code");
    expect(await stock("SLIM-DENIM-JEAN-L")).toBe(stockBefore);
    await pg.exec(`update discount_codes set max_uses = null, expires_at = now() - interval '1 day' where code = 'WELCOME10'`);
    expect((await place([{ sku: "SLIM-DENIM-JEAN-L", qty: 1 }], { discountCode: "WELCOME10" })).body.error.code).toBe("invalid_code");
    await pg.exec(`update discount_codes set expires_at = null where code = 'WELCOME10'`);
  });
  it("quote matches the real order and touches nothing", async () => {
    const items = [{ variantId: (await variant("SLIM-DENIM-JEAN-XL")).id, quantity: 1 }];
    const before = await stock("SLIM-DENIM-JEAN-XL");
    const q = await api("POST", "/orders/quote", { items, wilayaCode: 16, deliveryType: "home", discountCode: "WELCOME10" });
    expect(q.body).toMatchObject({ subtotal: 5400, discountTotal: 540, shippingFee: 500, total: 5360, freeShipping: false, discount: { code: "WELCOME10", amount: 540 } });
    expect(q.body.items[0]).toMatchObject({ unitPrice: 5400, quantity: 1 });
    expect(await stock("SLIM-DENIM-JEAN-XL")).toBe(before);
    const real = await place([{ sku: "SLIM-DENIM-JEAN-XL", qty: 1 }], { discountCode: "WELCOME10" });
    expect(real.body.total).toBe(q.body.total);
  });
});

describe("abuse protection", () => {
  it("allows at most 3 pending orders per phone per hour", async () => {
    const phone = "0661234567";
    const mk = async () => place([{ sku: "HEAVY-TEE-BLACK-XL", qty: 1 }], { customer: { name: "Spam", phone, communeId: await communeOf(16), address: "Rue 1, Alger" } });
    expect((await mk()).status).toBe(200);
    expect((await mk()).status).toBe(200);
    expect((await mk()).status).toBe(200);
    expect((await mk()).status).toBe(429);
  });
});

describe("shipping rules", () => {
  it("exposes the free delivery threshold", async () => {
    expect((await api("GET", "/shipping/rules")).body).toEqual({ freeShippingOver: 10000 });
  });
});

describe("admin: orders", () => {
  let id: string;
  let number: number;

  it("lists orders with filters and shows customer contact only while pending", async () => {
    const r = await place([{ sku: "HEAVY-TEE-CREAM-XS", qty: 1 }]);
    number = r.body.orderNumber;
    const list = await admin("GET", `/admin/orders?q=${number}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    id = list.body.items[0].id;
    expect(list.body.items[0]).toMatchObject({ orderNumber: number, status: "pending", wilayaCode: 16, itemCount: 1, customerName: "Test Customer" });
    expect((await admin("GET", "/admin/orders?status=pending&wilayaCode=16&paymentMethod=cod")).body.total).toBeGreaterThan(5);
    expect((await admin("GET", "/admin/orders?status=delivered")).body.total).toBe(0);
    expect((await admin("GET", "/admin/orders?limit=2")).body.items).toHaveLength(2);
    expect((await admin("GET", "/admin/orders?q=%25")).body.total).toBe(0);

    const d = await admin("GET", `/admin/orders/${id}?locale=fr`);
    expect(d.body.customer).toMatchObject({ name: "Test Customer", address: "12 rue des Tests" });
    expect(d.body.customer.whatsappUrl).toMatch(/^https:\/\/wa\.me\/2135\d{8}$/);
    expect(d.body.customer.telUrl).toMatch(/^tel:05/);
    expect(d.body.items).toHaveLength(1);
  });

  it("confirming stores the tracking number and erases the personal data (response included)", async () => {
    const r = await admin("POST", `/admin/orders/${id}/confirm`, { company: "yalidine", trackingNumber: "YAL-777" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "confirmed", trackingNumber: "YAL-777", deliveryCompany: "yalidine", customer: null, customerName: null, customerPhone: null });
    const row = (await pg.query<Record<string, unknown>>(`select customer_name, customer_phone, commune_id, address from orders where id = $1`, [id])).rows[0]!;
    expect(Object.values(row)).toEqual([null, null, null, null]);
    expect((await admin("POST", `/admin/orders/${id}/confirm`, { trackingNumber: "X" })).status).toBe(409); // already confirmed
    expect((await admin("GET", `/admin/orders?q=YAL-777`)).body.total).toBe(1);
  });

  it("moves forward only in the allowed order and marks cash on delivery as paid when delivered", async () => {
    expect((await admin("POST", `/admin/orders/${id}/status`, { status: "delivered" })).status).toBe(409); // must ship first
    expect((await admin("POST", `/admin/orders/${id}/status`, { status: "shipped" })).body.status).toBe("shipped");
    const delivered = await admin("POST", `/admin/orders/${id}/status`, { status: "delivered" });
    expect(delivered.body).toMatchObject({ status: "delivered", paymentStatus: "paid" });
    expect((await admin("POST", `/admin/orders/${id}/status`, { status: "cancelled" })).status).toBe(409);
    expect((await admin("POST", `/admin/orders/${id}/status`, { status: "returned" })).body).toMatchObject({ status: "returned", paymentStatus: "refunded" });
    expect((await admin("POST", `/admin/orders/${id}/status`, { status: "shipped" })).status).toBe(409);
  });

  it("cancelling puts the stock back and erases the personal data", async () => {
    const before = await stock("HEAVY-TEE-CREAM-S");
    const r = await place([{ sku: "HEAVY-TEE-CREAM-S", qty: 2 }]);
    const oid = (await pg.query<{ id: string }>(`select id from orders where order_number = $1`, [r.body.orderNumber])).rows[0]!.id;
    expect(await stock("HEAVY-TEE-CREAM-S")).toBe(before - 2);
    const c = await admin("POST", `/admin/orders/${oid}/status`, { status: "cancelled" });
    expect(c.body).toMatchObject({ status: "cancelled", customer: null });
    expect(await stock("HEAVY-TEE-CREAM-S")).toBe(before);
  });

  it("answers 404 for unknown orders and 422 for bad input", async () => {
    const none = "00000000-0000-4000-8000-000000000099";
    expect((await admin("GET", `/admin/orders/${none}`)).status).toBe(404);
    expect((await admin("POST", `/admin/orders/${none}/confirm`, { trackingNumber: "X" })).status).toBe(404);
    expect((await admin("POST", `/admin/orders/${none}/status`, { status: "shipped" })).status).toBe(404);
    expect((await admin("POST", `/admin/orders/${id}/status`, { status: "pending" })).status).toBe(422);
    expect((await admin("GET", "/admin/orders?status=bogus")).status).toBe(422);
  });

  it("requires an admin token", async () => {
    expect((await api("GET", "/admin/orders")).status).toBe(401);
    expect((await api("GET", "/admin/stats/overview")).status).toBe(401);
    expect((await api("GET", "/admin/events")).status).toBe(401);
  });
});

describe("admin: statistics and notifications", () => {
  it("summarises the day, excluding cancelled and returned orders from revenue", async () => {
    const s = (await admin("GET", "/admin/stats/overview?locale=en")).body;
    const orders = (await pg.query<{ status: string; total: number }>(`select status, total from orders`)).rows;
    const expected = orders.filter((o) => !["cancelled", "returned"].includes(o.status)).reduce((n, o) => n + Number(o.total), 0);
    expect(s.newOrdersToday).toBe(orders.length);
    expect(s.revenue.today).toBe(expected);
    expect(s.revenue.week).toBe(expected);
    expect(s.revenue.month).toBeGreaterThanOrEqual(expected);
    expect(s.revenueLast7Days).toHaveLength(7);
    expect(s.revenueLast7Days.at(-1)).toBe(expected);
    expect(s.ordersByStatus.pending + s.ordersByStatus.returned + s.ordersByStatus.cancelled).toBe(orders.length);
    expect(s.ordersByStatus.returned).toBe(1);
    expect(s.ordersByStatus.cancelled).toBe(1);
    expect(s.topProducts[0].unitsSold).toBeGreaterThanOrEqual(s.topProducts.at(-1).unitsSold);
    expect(s.topProducts[0]).toHaveProperty("name");
    expect(s.lowStock.every((v: { stock: number }) => v.stock <= 3)).toBe(true);
    expect(s.lowStock.some((v: { productName: string; stock: number }) => v.productName === "Chelsea Boot" && v.stock === 0)).toBe(true);
  });

  it("lists new-order notifications and marks them read", async () => {
    const e = (await admin("GET", "/admin/events")).body;
    expect(e.unreadCount).toBeGreaterThan(5);
    expect(e.items[0]).toMatchObject({ type: "order_created", read: false });
    expect(e.items[0].orderNumber).toBeGreaterThanOrEqual(1001);
    expect((await admin("POST", "/admin/events/read")).status).toBe(200);
    const after = (await admin("GET", "/admin/events")).body;
    expect(after.unreadCount).toBe(0);
    await place([{ sku: "HEAVY-TEE-BLACK-L", qty: 1 }]);
    expect((await admin("GET", "/admin/events")).body.unreadCount).toBe(1);
  });
});
