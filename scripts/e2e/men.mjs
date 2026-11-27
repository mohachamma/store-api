/**
 * End-to-end check of the Men's page (API + dashboard + storefront against `npm run dev:local`):
 * the page lists exactly the men's + unisex products, the menu and the desktop nav link to it, the home page card leads to it,
 * and the dashboard's "Men's page" settings are saved and public.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/men.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const list = async (aud) => (await fetch(`${API}/catalog/products?locale=ar&limit=100&audience=${aud}`)).json();
const stamp = Date.now() % 100000;

const browser = await chromium.launch();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
const desktop = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
for (const p of [shop, desktop, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));
const cards = (p) => p.locator("main a[href*='/products/']");

const men = await list("men");
await shop.goto(`${WEB}/ar/men`, { waitUntil: "networkidle" });
check("Men's page lists the same products as the API", (await cards(shop).count()) === men.length && men.length > 0 && men.length < 16, `${men.length} of 16`);
check("a women's-only product is not there", (await shop.locator("a[href*='chelsea-boot']").count()) === 0);
check("title and subtitle shown", /رجال/.test(await shop.locator("main h1").first().innerText()) && /أحدث ملابس الرجال/.test(await shop.locator("main").innerText()));

await shop.goto(`${WEB}/ar`, { waitUntil: "networkidle" });
check("home page has a card linking to /men", (await shop.locator("a[href$='/men']").count()) >= 1);
await shop.click("button[aria-haspopup=dialog]");
await shop.waitForSelector("dialog[open]");
check("side menu has both Women and Men", (await shop.locator("dialog[open] a[href$='/men']").count()) === 1 && (await shop.locator("dialog[open] a[href$='/women']").count()) === 1);
await shop.click("dialog[open] a[href$='/men']");
await shop.waitForURL("**/men");
check("menu link opens the Men's page", /\/men$/.test(shop.url()));

await desktop.goto(`${WEB}/ar`, { waitUntil: "networkidle" });
check("desktop nav has the Men link", (await desktop.locator("header nav a[href$='/men']:visible").count()) === 1);

// Dashboard: edit the Men's page
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
await admin.goto(`${ADMIN}/content`, { waitUntil: "networkidle" });
const forms = admin.locator("form:has(input[name='hero'])");
check("dashboard shows two audience forms (women and men)", (await forms.count()) === 2);
const menForm = forms.nth(1);
await menForm.locator("input[name='title.ar']").fill(`للرجال ${stamp}`);
await menForm.locator("input[name='subtitle.ar']").fill(`جديد ${stamp}`);
await menForm.locator("button[type=submit]").click();
await menForm.locator("text=تم الحفظ").waitFor();
const wp = await (await fetch(`${API}/catalog/men?locale=ar`)).json();
check("saved men page texts are public", wp.title === `للرجال ${stamp}` && wp.subtitle === `جديد ${stamp}`);
const women = await (await fetch(`${API}/catalog/women?locale=ar`)).json();
check("the women's page was not touched", !women.title.includes(String(stamp)));
// restore
await admin.fill("input[name='title.ar'] >> nth=1", "رجال");
await admin.fill("input[name='subtitle.ar'] >> nth=1", "أحدث ملابس الرجال");
await forms.nth(1).locator("button[type=submit]").click();
await admin.waitForTimeout(1200);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
