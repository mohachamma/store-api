/**
 * End-to-end check of the order journey, in a real browser, with the three apps running (see connect.mjs):
 * the customer buys on the storefront → the admin sees it, calls (contact details visible), confirms (personal data erased),
 * ships and delivers it → the customer's order page and the dashboard statistics follow.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/orders.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

const browser = await chromium.launch();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
for (const p of [shop, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));

// 1) Customer buys on the storefront. The cart is filled from the API's current data (the storefront's page cache can lag
//    behind a restarted test API by a couple of minutes, which would put stale variant ids in the cart).
const coat = await (await fetch(`${API}/catalog/products/hooded-deck-coat?locale=ar`)).json();
const coatL = coat.variants.find((v) => v.size === "L");
await shop.goto(`${WEB}/ar`, { waitUntil: "domcontentloaded" });
await shop.evaluate((line) => localStorage.setItem("store.cart.v1", JSON.stringify([line])), {
  key: `${coat.id}:L`, productId: coat.id, variantId: coatL.id, slug: coat.slug, name: coat.name, image: coat.image.url, size: "L", price: coatL.price, qty: 1,
});
await shop.goto(`${WEB}/ar/checkout`, { waitUntil: "networkidle" });
await shop.fill("#name", "ياسين حمدي"); await shop.fill("#phone", "+213 661 55 44 33");
await shop.selectOption("#wilaya", "31");
await shop.waitForFunction(() => document.querySelector("#commune").options.length > 1);
await shop.selectOption("#commune", { index: 2 });
await shop.fill("#address", "حي الصنوبر، شارع 5");
await shop.fill("#code", "WELCOME10"); await shop.click("button:has-text('تطبيق')");
await shop.waitForSelector("text=تم تطبيق الكود");
const summary = await shop.locator("aside dl").innerText();
check("12 900 DA coat: free delivery over 10 000 and 10% promo (-1 290) → 11 610", /11\s?610/.test(summary) && /مجاني/.test(summary), summary.replace(/\n/g, " | "));
await shop.click("button[type=submit]:has-text('تأكيد الطلب')");
await shop.waitForURL("**/order/**");
const orderUrl = shop.url();
const number = Number(/order\/(\d+)/.exec(orderUrl)[1]);
check("customer sees the order page (pending)", /بانتظار التأكيد/.test(await shop.content()) && !/ياسين|661554433|الصنوبر/.test(await shop.content()), `#${number}`);

// 2) Admin handles it
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
await admin.goto(`${ADMIN}/orders?status=pending`, { waitUntil: "networkidle" });
check("pending list shows the new order with the customer's name", await admin.locator(`a:has-text("#${number}")`).count() === 1 && /ياسين حمدي/.test(await admin.locator(`a:has-text("#${number}")`).innerText()));
await admin.click(`a:has-text("#${number}")`);
await admin.waitForSelector("text=ياسين حمدي");
const wa = await admin.locator("a:has-text('واتساب')").getAttribute("href");
check("customer contact visible while pending (call + WhatsApp links)", /^https:\/\/wa\.me\/213661554433$/.test(wa) && (await admin.locator("a[href^='tel:0661554433']").count()) === 1, wa);
check("address and commune shown", /الصنوبر/.test(await admin.content()));
await admin.fill("#trackingNumber", "YAL-E2E-001");
await admin.click("main form button[type=submit]");
await admin.waitForSelector("text=محذوفة بعد التأكيد");
// Check what the admin actually SEES (visible text; the page source still holds the data loaded before the confirmation)
// and what the API returns for this order.
const visible = await admin.locator("main").innerText();
const token = (await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@store.test", password: "admin1234" }) })).json()).accessToken;
const orderId = /orders\/([0-9a-f-]{36})/.exec(admin.url())[1];
const detail = await (await fetch(`${API}/admin/orders/${orderId}`, { headers: { authorization: `Bearer ${token}` } })).json();
check("after confirming: tracking saved, personal data gone (screen and API)",
  /YAL-E2E-001/.test(visible) && !/ياسين حمدي|661554433|الصنوبر/.test(visible) && detail.customer === null && detail.customerName === null && detail.customerPhone === null && detail.trackingNumber === "YAL-E2E-001");
await admin.click("button:has-text('تم الشحن')"); await admin.waitForSelector("text=تم التسليم");
await admin.click("button:has-text('تم التسليم')"); await admin.waitForSelector("text=غير مدفوع", { state: "detached" }).catch(() => {});
await admin.waitForTimeout(800);
check("delivered: cash on delivery marked as paid", /مدفوع/.test(await admin.locator("main").innerText()) && !/غير مدفوع/.test(await admin.locator("main").innerText()));

// 3) The customer's page and the statistics follow
await shop.goto(orderUrl, { waitUntil: "networkidle" });
const page = await shop.content();
check("customer page now shows 'delivered' and the tracking number", /تم التسليم/.test(page) && /YAL-E2E-001/.test(page));
await admin.goto(`${ADMIN}/`, { waitUntil: "networkidle" });
const overview = (await admin.locator("main").innerText()).replace(/[\s\u202f\u00a0]/g, "");
const stats = await (await fetch(`${API}/admin/stats/overview`, { headers: { authorization: `Bearer ${token}` } })).json();
check("dashboard overview shows today's revenue (same number as the API) and the delivered order", stats.revenue.today >= 11610 && overview.includes(String(stats.revenue.today)) && stats.ordersByStatus.delivered >= 1, `today=${stats.revenue.today}`);

// 4) Live notification: a new order arrives while the dashboard is open
await admin.goto(`${ADMIN}/orders`, { waitUntil: "networkidle" });
await admin.waitForTimeout(1500);
const variant = (await (await fetch(`${API}/catalog/products/heavy-tee-black?locale=en`)).json()).variants.find((v) => v.size === "XL");
const communes = await (await fetch(`${API}/shipping/wilayas/16/communes`)).json();
const placed = await fetch(`${API}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ variantId: variant.id, quantity: 1 }], wilayaCode: 16, deliveryType: "desk", customer: { name: "Live Test", phone: "0770112233", communeId: communes[0].id, address: "Rue du Test 1" } }) });
check("API accepted a second order placed behind the dashboard's back", placed.ok);
await admin.waitForFunction(() => /^\d+$|9\+/.test(document.querySelector("header button[aria-label]")?.textContent?.trim() ?? ""), null, { timeout: 40_000 }).catch(() => {});
const badge = await admin.locator("header button span").first().innerText().catch(() => "");
check("the bell shows a new-order badge within ~20 s", /\d/.test(badge), `badge=${badge}`);
await admin.click("header button[aria-label]");
await admin.waitForSelector("text=طلب جديد");
check("the notification lists the new order", (await admin.locator("[role=dialog] li").count()) >= 1);

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
