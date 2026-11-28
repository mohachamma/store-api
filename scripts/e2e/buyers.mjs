/**
 * End-to-end check of buyer recognition, in a real browser (storefront + dashboard + API running, see connect.mjs).
 * The API must run with FINGERPRINT_SECRET and STOREFRONT_SECRET, and the storefront with the same STOREFRONT_SECRET:
 *   FINGERPRINT_SECRET=<32+ chars> STOREFRONT_SECRET=local-storefront-secret npm run dev:local
 * Run: WEB=http://localhost:3103 ADMIN=http://localhost:3102 NODE_PATH=$(npm root -g) node scripts/e2e/buyers.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = process.env.WEB ?? "http://localhost:3000", ADMIN = process.env.ADMIN ?? "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

const token = (await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@store.test", password: "admin1234" }) })).json()).accessToken;
const A = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const prod = await (await fetch(`${API}/catalog/products/hooded-deck-coat?locale=ar`)).json();
const variant = prod.variants.find((v) => v.size === "L");
const commune = (await (await fetch(`${API}/shipping/wilayas/16/communes`)).json())[0].id;
const api = async (method, path, body) => (await fetch(`${API}${path}`, { method, headers: A, body: body ? JSON.stringify(body) : undefined })).json();
const place = async (phone, name = "Karim Test") => (await (await fetch(`${API}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ variantId: variant.id, quantity: 1 }], wilayaCode: 16, deliveryType: "home", customer: { name, phone, communeId: commune, address: "12 rue des Tests" } }) })).json());
const idOf = async (number) => (await api("GET", `/admin/orders?q=${number}`)).items.find((o) => o.orderNumber === number).id;
const finish = async (number, status) => { const id = await idOf(number); await api("POST", `/admin/orders/${id}/confirm`, { company: "manual", trackingNumber: `E2E-${number}` }); await api("POST", `/admin/orders/${id}/status`, { status: "shipped" }); await api("POST", `/admin/orders/${id}/status`, { status }); return id; };

await api("POST", "/admin/variants/bulk", { updates: [{ variantId: variant.id, stock: 200 }] }); // plenty of stock for this check

// 1) A buyer whose parcels came back twice (history), then he orders again
const r1 = await place("0661 70 00 01"); await finish(r1.orderNumber, "returned");
const r2 = await place("+213 661 70 00 01", "Same Person"); await finish(r2.orderNumber, "returned");
const again = await place("0661 70 00 01");
const againId = await idOf(again.orderNumber);

// 2) A loyal buyer
for (let i = 0; i < 2; i++) await finish((await place("0661 70 00 02")).orderNumber, "delivered");
await place("0661 70 00 02"); // the loyal buyer's new (pending) order

const browser = await chromium.launch();
const admin = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);

await admin.goto(`${ADMIN}/orders/${againId}`, { waitUntil: "networkidle" });
const page = await admin.locator("main").innerText();
check("the order page warns about the repeat returner (2 returned)", /يُرجع الطرود/.test(page) && /أرجع طرودًا كثيرة/.test(page), "");
check("no phone number or old name shown in the history card", !/0661 ?70 ?00 ?01/.test((await admin.locator("main").innerText()).split("سجل هذا الزبون")[1] ?? "") && !/Same Person/.test((await admin.locator("main").innerText()).split("سجل هذا الزبون")[1] ?? ""));
await admin.goto(`${ADMIN}/orders?status=pending`, { waitUntil: "networkidle" });
const list = await admin.locator("main").innerText();
check("the orders list marks the risky and the loyal buyer", /يُرجع الطرود/.test(list) && /زبون وفيّ/.test(list));
await admin.goto(`${ADMIN}/customers?tab=returners`, { waitUntil: "networkidle" });
check("the returners tab lists the buyer by code with 2 returned", /[0-9A-F]{4}-[0-9A-F]{4}/.test(await admin.locator("main").innerText()) && /2 مرتجع/.test(await admin.locator("main").innerText()));
await admin.goto(`${ADMIN}/customers?tab=repeat`, { waitUntil: "networkidle" });
check("the repeat tab shows the loyal buyer", /زبون وفيّ/.test(await admin.locator("main").innerText()));

// 3) Three different numbers from one connection, through the real storefront (it forwards the visitor's IP)
const shop = await (await browser.newContext({ ...devices["iPhone 13"], extraHTTPHeaders: { "x-forwarded-for": "41.200.9.9" } })).newPage();
const orders = [];
for (const phone of ["0662 11 00 01", "0662 11 00 02", "0662 11 00 03"]) {
  await shop.goto(`${WEB}/ar`, { waitUntil: "domcontentloaded" });
  await shop.evaluate((line) => localStorage.setItem("store.cart.v1", JSON.stringify([line])), { key: `${prod.id}:L`, productId: prod.id, variantId: variant.id, slug: prod.slug, name: prod.name, image: prod.image.url, size: "L", price: variant.price, qty: 1 });
  await shop.goto(`${WEB}/ar/checkout`, { waitUntil: "networkidle" });
  await shop.fill("#name", "Yacine Test"); await shop.fill("#phone", phone);
  await shop.selectOption("#wilaya", "31");
  await shop.waitForFunction(() => document.querySelector("#commune").options.length > 1);
  await shop.selectOption("#commune", { index: 2 });
  await shop.fill("#address", "حي الصنوبر، شارع 5");
  await shop.click("button[type=submit]:has-text('تأكيد الطلب')");
  await shop.waitForURL("**/order/**");
  orders.push(Number(/order\/(\d+)/.exec(shop.url())[1]));
}
const third = await api("GET", `/admin/orders/${await idOf(orders[2])}`);
check("the storefront forwarded the visitor's address: 2 other numbers from the same connection", third.buyer?.sameConnectionOthers === 2, JSON.stringify(third.buyer));

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
