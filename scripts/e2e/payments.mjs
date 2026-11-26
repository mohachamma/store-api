/**
 * End-to-end check of phase 6 with the three apps running against `npm run dev:local` (fake Chargily page, fake delivery company):
 * 1) the admin picks the delivery company in the dashboard,
 * 2) a customer pays by card (redirect → fake payment page → back on the order page, marked paid),
 * 3) the admin confirms with ONE click: the server sends the parcel, stores the tracking number, erases personal data.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/payments.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

const browser = await chromium.launch();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
for (const p of [shop, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));

// 1) Choose the delivery company in the dashboard
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
await admin.goto(`${ADMIN}/shipping`, { waitUntil: "networkidle" });
await admin.check("input[name=provider][value=yalidine]");
await admin.click("button:has-text('حفظ'):not(:has-text('الأسعار')):near(input[name=provider])").catch(() => {});
await admin.waitForSelector("text=تم الحفظ", { timeout: 8000 }).catch(() => {});
const token = (await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@store.test", password: "admin1234" }) })).json()).accessToken;
const settings = await (await fetch(`${API}/admin/delivery`, { headers: { authorization: `Bearer ${token}` } })).json();
check("delivery company saved from the dashboard", settings.provider === "yalidine", settings.provider);

// 2) Customer pays by card
const tee = await (await fetch(`${API}/catalog/products/hooded-deck-coat?locale=ar`)).json();
const v = tee.variants.find((x) => x.size === "L");
await shop.goto(`${WEB}/ar`, { waitUntil: "domcontentloaded" });
await shop.evaluate((line) => localStorage.setItem("store.cart.v1", JSON.stringify([line])), { key: `${tee.id}:L`, productId: tee.id, variantId: v.id, slug: tee.slug, name: tee.name, image: tee.image.url, size: "L", price: v.price, qty: 1 });
await shop.goto(`${WEB}/ar/checkout`, { waitUntil: "networkidle" });
check("card option is offered", await shop.locator("input[name=method][value=chargily]").count() === 1);
await shop.fill("#name", "سمير بوعلام"); await shop.fill("#phone", "0770 11 22 33");
await shop.selectOption("#wilaya", "16");
await shop.waitForFunction(() => document.querySelector("#commune").options.length > 1);
await shop.selectOption("#commune", { index: 1 });
await shop.fill("#address", "شارع الاستقلال 7");
await shop.check("input[name=method][value=chargily]");
await shop.waitForSelector("aside dl >> text=الإجمالي");
await shop.click("button[type=submit]:has-text('ادفع الآن')");
await shop.waitForURL("**/order/**", { timeout: 20000 });
const orderUrl = shop.url();
const number = Number(/order\/(\d+)/.exec(orderUrl)[1]);
await shop.waitForLoadState("networkidle");
check("after paying on the (fake) payment page the order page says paid", /تم الدفع بنجاح/.test(await shop.locator("main").innerText()), `#${number}`);

// 3) One-click confirmation
await admin.goto(`${ADMIN}/orders?status=pending`, { waitUntil: "networkidle" });
await admin.click(`a:has-text("#${number}")`);
await admin.waitForSelector("text=سمير بوعلام");
await admin.waitForSelector("text=تلقائياً");
check("dashboard shows it is paid by card", /Chargily|chargily|بطاقة/.test(await admin.locator("main").innerText()) && /مدفوع/.test(await admin.locator("main").innerText()));
check("confirm form has no tracking field (automatic)", (await admin.locator("#trackingNumber").count()) === 0 && /تلقائياً/.test(await admin.locator("main").innerText()));
await admin.click("main form button[type=submit]");
await admin.waitForSelector(`text=YAL-LOCAL-${number}`, { timeout: 15000 });
const orderId = /orders\/([0-9a-f-]{36})/.exec(admin.url())[1];
const detail = await (await fetch(`${API}/admin/orders/${orderId}`, { headers: { authorization: `Bearer ${token}` } })).json();
check("parcel created by the server; tracking stored; personal data erased", detail.trackingNumber === `YAL-LOCAL-${number}` && detail.deliveryCompany === "yalidine" && detail.customer === null && detail.customerName === null && detail.customerPhone === null, JSON.stringify({ t: detail.trackingNumber, c: detail.deliveryCompany }));
await admin.click("button:has-text('تحديث حالة الطرد')");
await admin.waitForSelector("text=in_transit", { timeout: 8000 });
check("parcel status refreshed from the company", true);

// 4) Switch back to manual from the dashboard (the company can be changed any time)
await admin.goto(`${ADMIN}/shipping`, { waitUntil: "networkidle" });
await admin.check("input[name=provider][value=manual]");
await admin.click("button:has-text('حفظ'):not(:has-text('الأسعار')):near(input[name=provider])").catch(() => {});
await admin.waitForSelector("text=تم الحفظ", { timeout: 8000 }).catch(() => {});
check("changed back to manual", (await (await fetch(`${API}/admin/delivery`, { headers: { authorization: `Bearer ${token}` } })).json()).provider === "manual");

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
