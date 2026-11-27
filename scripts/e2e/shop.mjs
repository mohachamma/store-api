/**
 * End-to-end check of the shop page filters (storefront + API running against `npm run dev:local`), on a phone-size screen:
 * category chips, size + price filters in the panel, sort, active-filter chips, clearing, and that the page always
 * shows exactly what the API returns for the same filters.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/shop.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const api = async (qs) => (await fetch(`${API}/catalog/products?locale=ar&limit=100&${qs}`)).json();
const cards = (p) => p.locator("main a[href*='/products/']");

const browser = await chromium.launch();
const p = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
p.on("pageerror", (e) => console.log("PAGEERR", e.message));

await p.goto(`${WEB}/ar/search`, { waitUntil: "networkidle" });
const all = await api("");
check("all products listed", (await cards(p).count()) === all.length, `${all.length}`);

// Category chip
const footwear = await api("category=footwear");
await p.click("button:has-text('أحذية')");
await p.waitForURL("**category=footwear**");
await p.waitForLoadState("networkidle");
check("category chip filters (URL + results)", (await cards(p).count()) === footwear.length && /category=footwear/.test(p.url()), `${footwear.length}`);

// Size filter from the panel
await p.click("button:has-text('تصفية')");
await p.waitForSelector("dialog[open]");
const sizes = await p.locator("dialog input[name=size]").evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
check("size options come from the footwear products only", sizes.includes("42") && !sizes.includes("XL"), sizes.join(","));
await p.locator("dialog label:has(input[name=size][value='42'])").click();
await p.click("dialog button[type=submit]");
await p.waitForURL("**size=42**");
await p.waitForLoadState("networkidle");
const s42 = await api("category=footwear&size=42");
check("size filter applied", (await cards(p).count()) === s42.length, `${s42.length}`);
check("active filter chip is shown", (await p.locator("text=المقاس: 42").count()) === 1);

// Price filter
await p.click("button:has-text('تصفية')");
await p.fill("dialog input[name=maxPrice]", "9000");
await p.click("dialog button[type=submit]");
await p.waitForURL("**maxPrice=9000**");
await p.waitForLoadState("networkidle");
const priced = await api("category=footwear&size=42&maxPrice=9000");
check("price filter applied together with size", (await cards(p).count()) === priced.length, `${priced.length}`);

// Sort
await p.selectOption("main select", "price_desc");
await p.waitForURL("**sort=price_desc**");
await p.waitForLoadState("networkidle");
const sorted = await api("category=footwear&size=42&maxPrice=9000&sort=price_desc");
const hrefs = await cards(p).evaluateAll((els) => els.map((e) => e.getAttribute("href")));
check("sorted by price, high to low, same order as the API", sorted.length > 0 && hrefs.every((h, i) => h.includes(sorted[i].slug)), sorted.map((x) => x.price).join(">"));

// Remove one chip, then clear all
await p.click("button[aria-label*='المقاس: 42']");
await p.waitForFunction("!location.search.includes('size=')");
await p.waitForLoadState("networkidle");
check("removing the size chip keeps the other filters", /maxPrice=9000/.test(p.url()) && !/size=/.test(p.url()));
await p.click("button:has-text('مسح الكل')");
await p.waitForFunction("!location.search.includes('maxPrice')");
await p.waitForLoadState("networkidle");
const back = await api("category=footwear&sort=price_desc");
check("clear all returns to the category", (await cards(p).count()) === back.length);

// No match message
await p.goto(`${WEB}/ar/search?minPrice=999999`, { waitUntil: "networkidle" });
check("a filter with no match explains it", /لا توجد منتجات بهذه المواصفات/.test(await p.locator("main").innerText()));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
