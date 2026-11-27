/**
 * End-to-end check of the Women's page (API + dashboard + storefront against `npm run dev:local`):
 * the page lists exactly the women's + unisex products (same as the API), filters work on it, a product moved to
 * "women" from the dashboard appears there, the title/subtitle edited in the dashboard show up (and the desktop menu link),
 * and the home page card leads to it.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/women.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const list = async (qs = "") => (await fetch(`${API}/catalog/products?locale=ar&limit=100&audience=women${qs}`)).json();
const stamp = Date.now() % 100000;

const browser = await chromium.launch();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
const desktop = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
for (const p of [shop, desktop, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));
const cards = (p) => p.locator("main a[href*='/products/']");

// 1) The page shows exactly the women's + unisex products
const women = await list();
await shop.goto(`${WEB}/ar/women`, { waitUntil: "networkidle" });
check("Women's page lists the same products as the API", (await cards(shop).count()) === women.length && women.length > 0 && women.length < 16, `${women.length} of 16`);
check("a men's product is not there", (await shop.locator("a[href*='nylon-zip-hoodie']").count()) === 0);
check("title and subtitle shown", /نساء/.test(await shop.locator("main h1").first().innerText()) && /أحدث ملابس النساء/.test(await shop.locator("main").innerText()));

// 2) Filters work inside the page and stay on /women
await shop.click("button:has-text('تصفية')");
await shop.waitForSelector("dialog[open]");
await shop.locator("dialog label:has(input[name=size][value='M'])").click();
await shop.click("dialog button[type=submit]");
await shop.waitForURL("**/women?**size=M**");
await shop.waitForLoadState("networkidle");
const m = await list("&size=M");
check("size filter keeps the page on /women and matches the API", (await cards(shop).count()) === m.length && /\/women\?/.test(shop.url()), `${m.length}`);

// 3) Home page card leads to it
await shop.goto(`${WEB}/ar`, { waitUntil: "networkidle" });
check("home page has a card linking to /women", (await shop.locator("a[href$='/women']").count()) >= 1);

// 4) Dashboard: move a product to women, edit the page texts
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
await admin.goto(`${ADMIN}/products`, { waitUntil: "networkidle" });
const row = admin.locator("li:has-text('هودي بسحاب نايلون')");
await row.locator("select").selectOption("women");
await admin.waitForTimeout(1500);
const after = await list();
check("product moved to women from the product list appears in the API list", after.some((p) => p.slug === "nylon-zip-hoodie"));

await admin.goto(`${ADMIN}/content`, { waitUntil: "networkidle" });
const form = admin.locator("form:has(input[name='hero'])");
await form.locator("input[name='title.ar']").fill(`للنساء ${stamp}`);
await form.locator("input[name='subtitle.ar']").fill(`تشكيلة ${stamp}`);
await form.locator("button[type=submit]").click();
await admin.waitForSelector("text=تم الحفظ");
const wp = await (await fetch(`${API}/catalog/women?locale=ar`)).json();
check("page texts saved from the dashboard are public", wp.title === `للنساء ${stamp}` && wp.subtitle === `تشكيلة ${stamp}`);

// 5) Storefront shows the new texts, the moved product, and the menu link (after its 60 s cache)
console.log("…waiting 65 s for the storefront cache");
await new Promise((r) => setTimeout(r, 65000));
for (let i = 0; i < 2; i++) { await desktop.goto(`${WEB}/ar/women`, { waitUntil: "networkidle" }); await desktop.waitForTimeout(2500); }
const txt = await desktop.locator("main").innerText();
check("storefront shows the new title, subtitle and the moved product", txt.includes(`للنساء ${stamp}`) && txt.includes(`تشكيلة ${stamp}`) && (await desktop.locator("a[href*='nylon-zip-hoodie']").count()) === 1);
check("desktop menu has the Women link with the dashboard's title", (await desktop.locator(`header nav a[href$='/women']:has-text('للنساء ${stamp}')`).count()) === 1);

// restore the sample data
await admin.goto(`${ADMIN}/products`, { waitUntil: "networkidle" });
await admin.locator("li:has-text('هودي بسحاب نايلون')").locator("select").selectOption("men");
await admin.waitForTimeout(1000);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
