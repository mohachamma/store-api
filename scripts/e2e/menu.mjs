/* global getComputedStyle, window */
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
const barTop = (await p.locator("nav[aria-label] > div").last().boundingBox()).y;
check("the menu covers the full page width", box.x <= 1 && box.width >= vw - 1, `x=${Math.round(box.x)} w=${Math.round(box.width)}`);
check("the menu ends exactly at the top of the tab bar (no gap, bar not covered)", Math.abs(box.y + box.height - barTop) <= 2, `menu bottom=${Math.round(box.y + box.height)} bar top=${Math.round(barTop)}`);
const links = await p.locator("dialog[open] a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
const has = (h) => links.some((l) => l.endsWith(h));
check("menu has home, women, men, all products and sale", ["/women", "/men", "/search", "/sale"].every(has) && links.some((l) => l === "/ar" || l === "/ar/"));
check("menu lists the categories and the collection from the API", has("category=outerwear") && has("category=footwear") && has("/collections/winter"));
check("menu no longer repeats favorites/cart/account or the legal pages (they are in the tab bar and footer)", !has("/favorites") && !has("/cart") && !has("/account") && !["terms", "privacy", "returns", "shipping", "cod"].some((x) => has(`/legal/${x}`)));
check("menu keeps only Contact under information", has("/contact"));
const catText = await p.locator("dialog[open] a[href*='category=outerwear']").innerText();
check("categories show names only, no numbers", !/\d/.test(catText), JSON.stringify(catText));
const glass = await p.locator("dialog[open] .menu-glass").evaluate((el) => ({ f: getComputedStyle(el).backdropFilter, bg: getComputedStyle(el).backgroundImage, m: "" }));
check("the glass blurs the page and its tint is graded top to bottom (gradient)", /blur/.test(glass.f) && /linear-gradient/.test(glass.bg), glass.f);

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

// The close button works
await open();
await p.click("dialog[open] button[aria-label]");
await p.waitForTimeout(200);
check("the close button closes the menu", (await isOpen()) === 0);

// Nothing jumps behind the menu: scroll position and layout stay the same while it is open
await p.goto(`${WEB}/en`, { waitUntil: "networkidle" });
await p.evaluate(() => window.scrollTo(0, 400));
await p.waitForTimeout(200);
const before = await p.evaluate(() => ({ y: window.scrollY, w: document.documentElement.clientWidth, h: document.body.getBoundingClientRect().height }));
await open();
const during = await p.evaluate(() => ({ y: window.scrollY, w: document.documentElement.clientWidth, h: document.body.getBoundingClientRect().height }));
await p.keyboard.press("Escape");
await p.waitForTimeout(250);
const after = await p.evaluate(() => ({ y: window.scrollY, w: document.documentElement.clientWidth }));
check("the page behind does not shift while the menu is open (scroll and width unchanged)", before.y === during.y && before.w === during.w && Math.abs(before.h - during.h) < 1 && after.y === before.y, JSON.stringify({ before, during, after }));

await p.goto(`${WEB}/en/cart`, { waitUntil: "networkidle" });
await open();
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
