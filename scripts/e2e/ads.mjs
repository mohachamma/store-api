/**
 * End-to-end check of ad attribution, in a real browser (storefront + dashboard + API running, see connect.mjs):
 * a visitor arrives through an ad link → browses (links without tags) → buys → the order remembers the ad,
 * the dashboard shows it on the order and in the ads report, and the link builder makes the same kind of link.
 * Run: WEB=http://localhost:3103 ADMIN=http://localhost:3102 NODE_PATH=$(npm root -g) node scripts/e2e/ads.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = process.env.WEB ?? "http://localhost:3000", ADMIN = process.env.ADMIN ?? "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

const browser = await chromium.launch();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
for (const p of [shop, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));

// 1) The visitor arrives through the ad link (the bare address redirects to a language: the tags must survive that)
await shop.goto(`${WEB}/?utm_source=Facebook&utm_medium=Paid&utm_campaign=Eid_Sale&utm_content=Video%201`, { waitUntil: "networkidle" });
const saved = JSON.parse((await shop.evaluate(() => localStorage.getItem("store.attribution"))) ?? "null");
check("ad tags are kept when the visitor arrives", saved?.source === "Facebook" && saved?.campaign === "Eid_Sale", JSON.stringify(saved));
await shop.goto(`${WEB}/ar`, { waitUntil: "networkidle" }); // a later visit without tags does not erase them
check("a visit without tags keeps the previous ad", JSON.parse((await shop.evaluate(() => localStorage.getItem("store.attribution"))) ?? "null")?.campaign === "Eid_Sale");

// 2) He buys
const coat = await (await fetch(`${API}/catalog/products/hooded-deck-coat?locale=ar`)).json();
const coatL = coat.variants.find((v) => v.size === "L");
await shop.evaluate((line) => localStorage.setItem("store.cart.v1", JSON.stringify([line])), { key: `${coat.id}:L`, productId: coat.id, variantId: coatL.id, slug: coat.slug, name: coat.name, image: coat.image.url, size: "L", price: coatL.price, qty: 1 });
await shop.goto(`${WEB}/ar/checkout`, { waitUntil: "networkidle" });
await shop.fill("#name", "ياسين حمدي"); await shop.fill("#phone", "+213 661 77 88 99");
await shop.selectOption("#wilaya", "31");
await shop.waitForFunction(() => document.querySelector("#commune").options.length > 1);
await shop.selectOption("#commune", { index: 2 });
await shop.fill("#address", "حي الصنوبر، شارع 5");
await shop.click("button[type=submit]:has-text('تأكيد الطلب')");
await shop.waitForURL("**/order/**");
const number = Number(/order\/(\d+)/.exec(shop.url())[1]);

// 3) The dashboard knows the ad
const token = (await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@store.test", password: "admin1234" }) })).json()).accessToken;
const list = await (await fetch(`${API}/admin/orders?q=${number}`, { headers: { authorization: `Bearer ${token}` } })).json();
const row = list.items.find((o) => o.orderNumber === number);
check("the order remembers its ad (cleaned)", row?.ad?.source === "facebook" && row?.ad?.campaign === "eid_sale" && row?.ad?.content === "video 1", JSON.stringify(row?.ad));
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
await admin.goto(`${ADMIN}/orders/${row.id}`, { waitUntil: "networkidle" });
check("the order page shows the ad", /facebook · eid_sale/.test(await admin.locator("main").innerText()));

// 4) Ad spend + report + link builder
await fetch(`${API}/admin/expenses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ spentOn: new Date().toISOString().slice(0, 10), category: "ads", platform: "Facebook", campaign: "Eid_Sale", amount: 4000 }) });
await admin.goto(`${ADMIN}/ads`, { waitUntil: "networkidle" });
const page = (await admin.locator("main").innerText()).replace(/[\s  ]+/g, " ");
check("the ads report lists the campaign with its spend", /facebook · eid_sale/.test(page) && /4 ?000/.test(page), page.slice(0, 0));
await admin.click("button:has-text('Facebook')");
await admin.fill("#lb-campaign", "Eid Sale 2");
await admin.fill("#lb-content", "Video 1");
const link = await admin.locator("p[dir=ltr]").first().innerText();
check("link builder makes a tagged link", /utm_source=facebook/.test(link) && /utm_medium=paid/.test(link) && /utm_campaign=eid_sale_2/.test(link) && /utm_content=video_1/.test(link), link);

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
