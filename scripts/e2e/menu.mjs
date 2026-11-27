/**
 * End-to-end check of the side menu (storefront + API running against `npm run dev:local`), phone size:
 * the hamburger is on every kind of page, the drawer slides in from the reading-start side, lists what the dashboard manages,
 * a tap on any link goes there and closes the menu, Escape closes it, and it works from a product page without going back.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/menu.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const WEB = "http://localhost:3000";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

const browser = await chromium.launch();
const p = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
p.on("pageerror", (e) => console.log("PAGEERR", e.message));
const open = async () => { await p.click("button[aria-haspopup=dialog]"); await p.waitForSelector("dialog[open]"); await p.waitForTimeout(350); };
const isOpen = () => p.locator("dialog[open]").count();

await p.goto(`${WEB}/ar`, { waitUntil: "networkidle" });
await open();
const box = await p.locator("dialog[open]").boundingBox();
const vw = p.viewportSize().width;
check("Arabic: the drawer is on the right (reading start) and does not cover the whole screen", box.x + box.width >= vw - 1 && box.width < vw - 20, `x=${Math.round(box.x)} w=${Math.round(box.width)}`);
const links = await p.locator("dialog[open] a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
const has = (h) => links.some((l) => l.endsWith(h));
check("menu has home, women, all products, sale, favorites, cart, account", ["/ar", "/women", "/search", "/sale", "/favorites", "/cart", "/account"].every((h) => has(h) || (h === "/ar" && links.some((l) => l === "/ar" || l === "/ar/"))));
check("menu lists the categories and the collection from the API", has("category=outerwear") && has("category=footwear") && has("/collections/winter"));
check("menu links the five legal pages and contact", ["terms", "privacy", "returns", "shipping", "cod"].every((s) => has(`/legal/${s}`)) && has("/contact"));

// Go to a category from the menu
await p.click("dialog[open] a[href*='category=footwear']");
await p.waitForURL("**category=footwear**");
await p.waitForLoadState("networkidle");
check("tapping a category opens it and closes the menu", (await isOpen()) === 0 && /category=footwear/.test(p.url()));

// From a product page (detail header): open the menu and go to Women without going back
const href = await p.locator("main a[href*='/products/']").first().getAttribute("href");
await p.goto(`${WEB}${href}`, { waitUntil: "networkidle" });
await open();
await p.click("dialog[open] a[href$='/women']");
await p.waitForURL("**/women");
check("from a product page the menu goes straight to Women", /\/women$/.test(p.url()) && (await isOpen()) === 0);

// Escape closes
await open();
await p.keyboard.press("Escape");
await p.waitForTimeout(200);
check("Escape closes the menu", (await isOpen()) === 0);

// Tapping the dark area closes it
await open();
await p.mouse.click(15, 300);
await p.waitForTimeout(200);
check("tapping outside closes the menu", (await isOpen()) === 0);

// Cart page works too, English opens from the left
await p.goto(`${WEB}/en/cart`, { waitUntil: "networkidle" });
await open();
const b2 = await p.locator("dialog[open]").boundingBox();
check("English: the drawer is on the left", b2.x <= 1, `x=${Math.round(b2.x)}`);
await p.click("dialog[open] a[href$='/en/contact']").catch(async () => p.click("dialog[open] a[href$='/contact']"));
await p.waitForURL("**/contact");
check("menu works on the cart page too (to Contact)", /contact$/.test(p.url()));

// Language switch inside the menu
await open();
await p.selectOption("dialog[open] select", "fr");
await p.waitForURL("**/fr/**");
check("language switch inside the menu changes the language", /\/fr\//.test(p.url()));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
