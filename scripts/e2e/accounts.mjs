/**
 * End-to-end check of customer accounts (storefront + API running against `npm run dev:local`):
 * a guest hearts a product → registers → the favorite is copied to the account → orders while signed in (name/phone pre-filled)
 * → the order is in "my orders" without personal data → signs out → signs in on a NEW device → favorites and orders are back.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/accounts.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const email = `e2e${Date.now()}@store.test`;

const browser = await chromium.launch();
const newDevice = async () => (await (await browser.newContext({ ...devices["iPhone 13"] })).newPage());
const a = await newDevice();
a.on("pageerror", (e) => console.log("PAGEERR", e.message));

// 1) Guest hearts a product (stored on the device)
const coat = await (await fetch(`${API}/catalog/products/hooded-deck-coat?locale=ar`)).json();
await a.goto(`${WEB}/ar/products/${coat.slug}`, { waitUntil: "networkidle" });
await a.click("button[aria-pressed]");
await a.waitForSelector("button[aria-pressed=true]");
check("guest favorite is kept on the device", (await a.evaluate(() => JSON.parse(localStorage.getItem("store.favorites.v1") || "[]").length)) === 1);

// 2) Registers on the storefront
await a.goto(`${WEB}/ar/account`, { waitUntil: "networkidle" });
check("signed-out account page shows the forms", (await a.locator("#a-email").count()) === 1);
await a.click("button[role=tab]:has-text('إنشاء حساب')");
await a.fill("#a-name", "نادية حداد"); await a.fill("#a-email", email); await a.fill("#a-password", "motdepasse123");
await a.click("form button[type=submit]");
await a.waitForSelector("text=طلباتي", { timeout: 15000 });
check("account page shows the profile after registering", (await a.inputValue("#p-name")) === "نادية حداد");
const cookies = await a.context().cookies();
const sess = cookies.find((c) => c.name === "store_session");
check("session cookie is httpOnly", !!sess && sess.httpOnly === true);

// 3) The guest favorite was copied to the account
const token = sess.value;
const favs = await (await fetch(`${API}/me/favorites`, { headers: { authorization: `Bearer ${token}` } })).json();
check("favorite copied to the account", favs.ids.length === 1 && favs.ids[0] === coat.id);

// 4) Orders while signed in: name pre-filled, order lands in history
const v = coat.variants.find((x) => x.size === "L");
await a.evaluate((line) => localStorage.setItem("store.cart.v1", JSON.stringify([line])), { key: `${coat.id}:L`, productId: coat.id, variantId: v.id, slug: coat.slug, name: coat.name, image: coat.image.url, size: "L", price: v.price, qty: 1 });
await a.goto(`${WEB}/ar/checkout`, { waitUntil: "networkidle" });
await a.waitForFunction(() => document.querySelector("#name").value.length > 0, null, { timeout: 8000 }).catch(() => {});
check("checkout name is pre-filled from the account", (await a.inputValue("#name")) === "نادية حداد");
await a.fill("#phone", "0661 22 33 44");
await a.selectOption("#wilaya", "16");
await a.waitForFunction(() => document.querySelector("#commune").options.length > 1);
await a.selectOption("#commune", { index: 1 });
await a.fill("#address", "شارع ديدوش مراد 9");
await a.waitForSelector("aside dl >> text=الإجمالي");
await a.click("button[type=submit]:has-text('تأكيد الطلب')");
await a.waitForURL("**/order/**", { timeout: 20000 });
const number = Number(/order\/(\d+)/.exec(a.url())[1]);
await a.goto(`${WEB}/ar/account`, { waitUntil: "networkidle" });
const text = await a.locator("main").innerText();
check("order appears in 'my orders' with no personal data", text.includes(`#${number}`) && !/ديدوش|0661/.test(text), `#${number}`);

// 5) Sign out, then sign in on a brand-new device
await a.click("button:has-text('تسجيل الخروج')");
await a.waitForSelector("#a-email", { timeout: 10000 });
check("signed out: forms again, device favorites cleared", (await a.evaluate(() => JSON.parse(localStorage.getItem("store.favorites.v1") || "[]").length)) === 0);
const b = await newDevice();
await b.goto(`${WEB}/ar/account`, { waitUntil: "networkidle" });
await b.fill("#a-email", email); await b.fill("#a-password", "wrong-password");
await b.click("form button[type=submit]");
await b.waitForSelector("form [role=alert]");
check("wrong password is refused with a clear message", /غير صحيحة/.test(await b.locator("form [role=alert]").innerText()));
await b.fill("#a-password", "motdepasse123");
await b.click("form button[type=submit]");
await b.waitForSelector("text=طلباتي", { timeout: 15000 });
check("new device: order history is back", (await b.locator("main").innerText()).includes(`#${number}`));
await b.goto(`${WEB}/ar/favorites`, { waitUntil: "networkidle" });
await b.waitForSelector(`a[href*="${coat.slug}"]`, { timeout: 10000 }).catch(() => {});
check("new device: favorites come from the account", (await b.locator(`a[href*="${coat.slug}"]`).count()) >= 1);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
