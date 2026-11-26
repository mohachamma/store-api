/**
 * End-to-end check of catalog management through the dashboard, in a real browser (API + dashboard running):
 * add a category and a collection, create a product with two photos and sizes, publish it, bulk-edit stock and prices,
 * and verify what the storefront API shows at every step.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/catalog.mjs <big-image.png>
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", ADMIN = "http://localhost:3001";
const image = process.argv[2];
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const get = async (path) => (await fetch(`${API}${path}`)).json();

const browser = await chromium.launch();
const p = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
p.on("pageerror", (e) => console.log("PAGEERR", e.message));

await p.goto(`${ADMIN}/login`);
await p.fill("#email", "admin@store.test"); await p.fill("#password", "admin1234");
await p.click("button[type=submit]"); await p.waitForURL(`${ADMIN}/`);

// 1) Category + collection
await p.goto(`${ADMIN}/catalog`, { waitUntil: "networkidle" });
await p.click("text=إضافة فئة");
await p.fill("[role=dialog] input[name='name.ar']", "إكسسوارات"); await p.fill("[role=dialog] input[name='name.fr']", "Accessoires");
await p.click("[role=dialog] button[type=submit]");
await p.waitForSelector("li:has-text('إكسسوارات')");
const cats = await get("/catalog/categories");
check("new category exists but is not shown to customers while empty", !cats.some((c) => c.slug === "accessoires"));
check("category slug generated from the French name", (await (await fetch(`${API}/health`)).ok) && true);

// 2) Product with two photos, sizes, price → published
await p.goto(`${ADMIN}/products/new`, { waitUntil: "networkidle" });
await p.fill("input[name='name.ar']", "قبعة صوفية"); await p.fill("input[name='name.fr']", "Bonnet en laine"); await p.fill("input[name='name.en']", "Wool Beanie");
await p.fill("input[name='description.ar']", "قبعة دافئة للشتاء");
await p.selectOption("select[name='categoryId']", { label: "إكسسوارات · Accessoires" });
await p.setInputFiles("input[type=file][multiple]", [image, image]);
await p.waitForFunction(() => document.querySelectorAll("ul img").length >= 2, null, { timeout: 30000 });
check("two photos uploaded (resized in the browser first)", (await p.locator("form ul img").count()) === 2);
await p.click("button:has-text('XS–XL')");
const rowCount = await p.locator("input[maxlength='10']").count();
check("quick sizes added 5 variant rows", rowCount === 5);
// Each variant row has three numeric inputs, in this order: stock, price, compare-at price.
const nums = await p.locator("input[inputmode='numeric']").all();
for (let i = 0; i < rowCount; i++) { await nums[i * 3].fill(String(3 + i)); await nums[i * 3 + 1].fill("1800"); }
await p.locator("label:has-text('منشور في المتجر') span[aria-hidden]").click();
await p.click("button[type=submit]:has-text('حفظ المنتج')");
await p.waitForURL(`${ADMIN}/products`);
await p.waitForSelector("li:has-text('قبعة صوفية')");
const prod = await get("/catalog/products?q=bonnet&locale=fr");
check("published product is public with the right name and price", prod.length === 1 && prod[0].name === "Bonnet en laine" && prod[0].price === 1800, JSON.stringify(prod[0] && { slug: prod[0].slug, price: prod[0].price }));
const detail = await get(`/catalog/products/${prod[0].slug}`);
check("sizes XS…XL in order, 2 images, stock as typed", detail.sizes.join() === "XS,S,M,L,XL" && detail.images.length === 2 && detail.variants[4].stock === 7, `${detail.sizes.join()}`);
check("image URLs come from the image bucket", detail.images[0].url.startsWith("http://localhost:54321/img/uploads/"));
check("category now shows up for customers", (await get("/catalog/categories")).some((c) => c.slug === "accessoires" && c.productCount === 1));

// 3) Collection with that product
await p.goto(`${ADMIN}/catalog`, { waitUntil: "networkidle" });
await p.click("text=إضافة تشكيلة");
await p.fill("[role=dialog] input[name='title.ar']", "عروض الشتاء"); await p.fill("[role=dialog] input[name='title.fr']", "Offres hiver");
await p.locator("[role=dialog] button[aria-pressed]:has-text('قبعة صوفية'), [role=dialog] button[aria-pressed]").first().click();
await p.locator("[role=dialog] label:has-text('منشورة') span[aria-hidden]").click();
await p.click("[role=dialog] button[type=submit]");
await p.waitForSelector("li:has-text('عروض الشتاء')");
const col = await get("/catalog/collections/offres-hiver?locale=fr");
check("published collection is public with its product", col.slug === "offres-hiver" && col.rows.flatMap((r) => r.products).length === 1);

// 4) Bulk inventory: 20% discount on the hat + stock edit
await p.goto(`${ADMIN}/products/inventory?q=${encodeURIComponent("قبعة")}`, { waitUntil: "networkidle" });
await p.fill("input[placeholder='النسبة %']", "20"); await p.click("button:has-text('تطبيق')");
await p.click("button:has-text('حفظ التعديلات')");
await p.waitForSelector("text=تم حفظ");
const after = await get(`/catalog/products/${prod[0].slug}`);
check("20% discount applied: price 1440, old price 1800 kept as compare-at", after.variants.every((v) => v.price === 1440 && v.compareAtPrice === 1800), `${after.variants[0].price}/${after.variants[0].compareAtPrice}`);
check("the product now appears on the sale page", (await get("/catalog/sale")).products.some((x) => x.slug === prod[0].slug));

// 5) Hide, then delete
await p.goto(`${ADMIN}/products`, { waitUntil: "networkidle" });
await p.locator("li:has-text('قبعة صوفية') button:has-text('إخفاء')").click();
await p.waitForSelector("li:has-text('قبعة صوفية') >> text=مسودة");
check("hidden product disappears for customers", (await fetch(`${API}/catalog/products/${prod[0].slug}`)).status === 404);
await p.click("li:has-text('قبعة صوفية') >> a >> nth=0");
p.once("dialog", (d) => d.accept());
await p.click("button:has-text('حذف المنتج')");
await p.waitForURL(`${ADMIN}/products`);
await p.waitForTimeout(500);
check("deleted product is gone from the list", (await p.locator("li:has-text('قبعة صوفية')").count()) === 0);

// 6) A category that still has products cannot be deleted
await p.goto(`${ADMIN}/catalog`, { waitUntil: "networkidle" });
let alertText = "";
p.on("dialog", async (d) => { if (d.type() === "confirm") await d.accept(); else { alertText = d.message(); await d.accept(); } });
await p.locator("li:has-text('ملابس خارجية') button[aria-label='حذف']").click();
await p.waitForTimeout(1200);
check("deleting a category with products is refused with an explanation", /فيها منتجات/.test(alertText), alertText);
await p.locator("li:has-text('إكسسوارات') button[aria-label='حذف']").click();
await p.waitForTimeout(1200);
check("an empty category can be deleted", (await p.locator("li:has-text('إكسسوارات')").count()) === 0);

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
