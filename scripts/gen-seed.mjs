// Generates supabase/seed.sql: sample catalog for development (placeholder images, no real data).
// Usage: node scripts/gen-seed.mjs
// Image paths starting with "/" are placeholder assets served by the storefront (store-web/public/placeholders).
import { writeFileSync } from "node:fs";

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const tr = (o) => q(JSON.stringify(o)) + "::jsonb";

const categories = [
  ["outerwear", { ar: "ملابس خارجية", fr: "Vestes & manteaux", en: "Outerwear" }],
  ["tops", { ar: "قمصان وتيشرتات", fr: "Hauts", en: "Tops" }],
  ["footwear", { ar: "أحذية", fr: "Chaussures", en: "Footwear" }],
  ["bottoms", { ar: "سراويل", fr: "Bas", en: "Bottoms" }],
];

const APPAREL = ["XS", "S", "M", "L", "XL"];
const SHOES = ["40", "41", "42", "43", "44"];

// slug, art, category, name, description, price, compareAt, isNew, shoes, soldOutSizes
const products = [
  ["nylon-zip-hoodie", "hoodie-stone", "outerwear", { ar: "هودي بسحاب نايلون", fr: "Hoodie zippé en nylon", en: "Nylon Full Zip Hoodie" }, { ar: "هودي بسحاب كامل بقصّة قصيرة قليلاً وأكمام واسعة وقبعة تبقى منتصبة. قطعة أساسية لكل يوم.", fr: "Hoodie zippé légèrement court, manches amples et capuche qui garde sa forme. Une pièce essentielle du quotidien.", en: "A full zip hoodie with a slightly cropped fit, voluminous sleeves and a hood that holds its shape. An everyday staple." }, 7900, null, true, false, []],
  ["denim-track-jacket", "jacket-denim", "outerwear", { ar: "جاكيت جينز", fr: "Veste en jean", en: "Denim Track Jacket" }, { ar: "جاكيت جينز مغسول بجيبين على الصدر وقصّة مريحة.", fr: "Veste en jean délavé, deux poches poitrine, coupe décontractée.", en: "Washed denim jacket with two chest pockets and a relaxed fit." }, 6900, 8500, false, false, []],
  ["hooded-deck-coat", "coat-sand", "outerwear", { ar: "معطف طويل بقبعة", fr: "Manteau long à capuche", en: "Hooded Deck Coat" }, { ar: "معطف طويل دافئ بأزرار أمامية ولون رملي هادئ.", fr: "Manteau long et chaud, boutonné, couleur sable.", en: "A long, warm coat with front buttons in a soft sand tone." }, 12900, null, false, false, []],
  ["utility-jacket", "jacket-olive", "outerwear", { ar: "جاكيت عملي زيتي", fr: "Veste utilitaire olive", en: "Olive Utility Jacket" }, { ar: "جاكيت متين بلون زيتي مع جيوب عملية.", fr: "Veste robuste olive avec poches utilitaires.", en: "A sturdy olive jacket with utility pockets." }, 8400, null, true, false, []],
  ["charcoal-overcoat", "coat-charcoal", "outerwear", { ar: "معطف رمادي داكن", fr: "Pardessus anthracite", en: "Charcoal Overcoat" }, { ar: "معطف كلاسيكي بلون رمادي داكن يناسب كل الإطلالات.", fr: "Pardessus classique anthracite, facile à porter.", en: "A classic charcoal overcoat that works with everything." }, 13900, null, false, false, []],
  ["essential-hoodie-black", "hoodie-black", "outerwear", { ar: "هودي أسود أساسي", fr: "Hoodie essentiel noir", en: "Essential Hoodie Black" }, { ar: "هودي قطني ناعم بلون أسود.", fr: "Hoodie en coton doux, noir.", en: "Soft cotton hoodie in black." }, 5900, null, false, false, ["XS"]],
  ["henley-pullover", "shirt-plaid", "tops", { ar: "قميص مربعات", fr: "Chemise à carreaux", en: "Plaid Flannel Shirt" }, { ar: "قميص فلانيل بمربعات حمراء، دافئ ومريح.", fr: "Chemise en flanelle à carreaux rouges, chaude et confortable.", en: "A warm, comfortable red plaid flannel shirt." }, 4200, null, false, false, []],
  ["oxford-shirt-white", "shirt-white", "tops", { ar: "قميص أكسفورد أبيض", fr: "Chemise Oxford blanche", en: "White Oxford Shirt" }, { ar: "قميص أبيض كلاسيكي من قماش أكسفورد.", fr: "Chemise blanche classique en tissu Oxford.", en: "A classic white Oxford cloth shirt." }, 3900, null, false, false, []],
  ["heavy-tee-cream", "tee-cream", "tops", { ar: "تيشرت سميك كريمي", fr: "T-shirt épais crème", en: "Heavy Tee Cream" }, { ar: "تيشرت قطني سميك بقصّة واسعة.", fr: "T-shirt en coton épais, coupe ample.", en: "Heavyweight cotton tee with a boxy fit." }, 2400, null, true, false, []],
  ["heavy-tee-black", "tee-black", "tops", { ar: "تيشرت سميك أسود", fr: "T-shirt épais noir", en: "Heavy Tee Black" }, { ar: "تيشرت قطني سميك بقصّة واسعة.", fr: "T-shirt en coton épais, coupe ample.", en: "Heavyweight cotton tee with a boxy fit." }, 2400, null, false, false, []],
  ["black-skate-mid", "sneaker-black", "footwear", { ar: "حذاء رياضي أسود", fr: "Baskets mi-hautes noires", en: "Black Skate Mid Sneaker" }, { ar: "حذاء رياضي متوسط الارتفاع بنعل أبيض.", fr: "Baskets mi-hautes, semelle blanche.", en: "Mid-top sneaker with a white sole." }, 9800, null, false, true, []],
  ["red-skate-mid", "sneaker-red", "footwear", { ar: "حذاء رياضي أحمر", fr: "Baskets mi-hautes rouges", en: "Red Skate Mid Sneaker" }, { ar: "حذاء رياضي متوسط الارتفاع باللون الأحمر.", fr: "Baskets mi-hautes rouges.", en: "Mid-top sneaker in red." }, 9800, null, true, true, []],
  ["tear-away-sneaker", "sneaker-navy", "footwear", { ar: "حذاء رياضي كحلي", fr: "Baskets bleu marine", en: "Navy Low Sneaker" }, { ar: "حذاء رياضي منخفض بلون كحلي.", fr: "Baskets basses bleu marine.", en: "Low-top sneaker in navy." }, 8900, 10900, false, true, []],
  ["chelsea-boot", "boot-cream", "footwear", { ar: "حذاء تشيلسي", fr: "Bottines Chelsea", en: "Chelsea Boot" }, { ar: "حذاء تشيلسي من الجلد المدبوغ بلون كريمي.", fr: "Bottines Chelsea en suède crème.", en: "Chelsea boot in cream suede." }, 11500, null, false, true, ["40"]],
  ["quilted-pant", "pants-black", "bottoms", { ar: "سروال مبطّن أسود", fr: "Pantalon matelassé noir", en: "Quilted Pant Black" }, { ar: "سروال مريح مبطّن بخصر مرن.", fr: "Pantalon matelassé confortable, taille élastique.", en: "A comfortable quilted pant with an elastic waist." }, 5900, null, false, false, []],
  ["slim-denim-jean", "jeans-light", "bottoms", { ar: "جينز ضيّق فاتح", fr: "Jean slim clair", en: "Slim Denim Jean" }, { ar: "جينز بقصّة ضيقة ولون أزرق فاتح.", fr: "Jean coupe slim, bleu clair.", en: "Slim-fit jean in light blue." }, 5400, null, true, false, []],
];

const looks = [
  ["look-1", ["utility-jacket", "quilted-pant"]],
  ["look-2", ["essential-hoodie-black", "quilted-pant"]],
  ["look-3", ["charcoal-overcoat", "slim-denim-jean"]],
  ["look-4", ["henley-pullover", "quilted-pant"]],
];

const out = [];
out.push("-- GENERATED by scripts/gen-seed.mjs — sample data for development. Do not use in production.");
out.push("-- Image paths starting with '/' are placeholder assets from store-web/public/placeholders.");
out.push("");
out.push("insert into public.categories (slug, name, sort_order) values");
out.push(categories.map(([s, n], i) => `  (${q(s)}, ${tr(n)}, ${i})`).join(",\n") + ";");
out.push("");
out.push("insert into public.products (slug, name, description, category_id, is_published, is_new) values");
out.push(
  products
    .map(([slug, , cat, name, desc, , , isNew]) => `  (${q(slug)}, ${tr(name)}, ${tr(desc)}, (select id from public.categories where slug = ${q(cat)}), true, ${isNew})`)
    .join(",\n") + ";",
);
out.push("");
out.push("insert into public.product_images (product_id, path, alt, sort_order)");
out.push("select p.id, v.path, v.alt::jsonb, v.sort_order from public.products p join (values");
const imgs = [];
for (const [slug, art, , name] of products)
  for (const n of [1, 2, 3]) imgs.push(`  (${q(slug)}, ${q(`/placeholders/${art}-${n}.svg`)}, ${q(JSON.stringify(name))}, ${n - 1})`);
out.push(imgs.join(",\n"));
out.push(") as v(slug, path, alt, sort_order) on v.slug = p.slug;");
out.push("");
out.push("insert into public.product_variants (product_id, sku, size, color, stock, price, compare_at_price)");
out.push("select p.id, v.sku, v.size, v.color, v.stock, v.price, v.compare_at from public.products p join (values");
const vars = [];
for (const [slug, art, , , , price, compare, , shoes, soldOut] of products) {
  (shoes ? SHOES : APPAREL).forEach((size, i) => {
    const stock = soldOut.includes(size) ? 0 : 2 + ((i * 7) % 9);
    vars.push(`  (${q(slug)}, ${q(`${slug}-${size}`.toUpperCase())}, ${q(size)}, ${q(art.split("-")[1] ?? "")}, ${stock}, ${price}, ${compare ?? "null::integer"})`);
  });
}
out.push(vars.join(",\n"));
out.push(") as v(slug, sku, size, color, stock, price, compare_at) on v.slug = p.slug;");
out.push("");
out.push("insert into public.brands (slug, name, sort_order) values ('store', 'Store', 0);");
out.push("update public.products set brand_id = (select id from public.brands where slug = 'store');");
out.push("");
out.push("insert into public.collections (slug, title, subtitle, hero_path, is_published) values");
out.push(`  ('winter', ${tr({ ar: "تشكيلة الشتاء", fr: "Collection hiver", en: "Winter Collection" })}, ${tr({ ar: "قطع دافئة بخطوط بسيطة", fr: "Des pièces chaudes aux lignes simples", en: "Warm pieces, simple lines" })}, '/placeholders/hero-1.svg', true);`);
out.push("insert into public.collection_products (collection_id, product_id, sort_order)");
out.push("select (select id from public.collections where slug = 'winter'), id, row_number() over (order by created_at, slug) from public.products;");
out.push("");
out.push("insert into public.looks (collection_id, image_path, alt, sort_order) values");
out.push(looks.map(([id], i) => `  ((select id from public.collections where slug = 'winter'), ${q(`/placeholders/${id}.svg`)}, ${tr({ ar: `إطلالة ${i + 1}`, fr: `Look ${i + 1}`, en: `Look ${i + 1}` })}, ${i})`).join(",\n") + ";");
out.push("insert into public.look_products (look_id, product_id, sort_order)");
out.push("select l.id, p.id, v.n from public.looks l join (values");
out.push(looks.flatMap(([id, slugs]) => slugs.map((s, n) => `  (${q(`/placeholders/${id}.svg`)}, ${q(s)}, ${n})`)).join(",\n"));
out.push(") as v(image_path, slug, n) on v.image_path = l.image_path join public.products p on p.slug = v.slug;");
out.push("");
out.push("insert into public.slides (kind, title, subtitle, image_path, collection_id, sort_order) values");
out.push(`  ('hero', ${tr({ ar: "تشكيلة الشتاء", fr: "Collection hiver", en: "Winter Collection" })}, ${tr({ ar: "قطع دافئة بخطوط بسيطة", fr: "Des pièces chaudes aux lignes simples", en: "Warm pieces, simple lines" })}, '/placeholders/hero-1.svg', (select id from public.collections where slug = 'winter'), 0);`);
out.push("");
out.push("insert into public.site_settings (key, value) values");
out.push(`  ('announcement', ${tr({ ar: "توصيل مجاني ابتداءً من 10,000 دج · الدفع عند الاستلام في 58 ولاية", fr: "Livraison gratuite dès 10 000 DA · Paiement à la livraison dans 58 wilayas", en: "Free delivery from 10,000 DA · Cash on delivery in 58 wilayas" })}),`);
out.push(`  ('store_info', '{"name": "Store"}'::jsonb);`);
out.push("");
out.push("insert into public.discount_codes (code, kind, value, min_subtotal) values ('WELCOME10', 'percent', 10, 3000);");

writeFileSync("supabase/seed.sql", out.join("\n") + "\n");
console.info(`seed.sql: ${products.length} products`);
