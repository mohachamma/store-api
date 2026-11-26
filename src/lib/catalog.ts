import type { Db } from "./db.js";
import { pick, pickOrNull, type Locale } from "./i18n.js";
import { imageUrl } from "./media.js";

/** Sizes sort in garment order, then numerically (shoes). */
export const SIZE_RANK = `coalesce(array_position(array['XXS','XS','S','M','L','XL','XXL','XXXL'], v.size), 100), v.size`;

const iso = (v: unknown) => (v ? new Date(v as string | number | Date).toISOString() : null);

export interface SummaryRow {
  id: string;
  slug: string;
  name: unknown;
  is_new: boolean;
  category_slug: string;
  category_name: unknown;
  price: number;
  compare_at_price: number | null;
  image_path: string | null;
  image_alt: unknown;
}

/** Published products with their cheapest variant and first image. Append WHERE / ORDER BY yourself. */
export const SUMMARY_SQL = `
  select p.id, p.slug, p.name, p.is_new, c.slug as category_slug, c.name as category_name,
         mv.price, mv.compare_at_price, img.path as image_path, img.alt as image_alt
    from public.products p
    join public.categories c on c.id = p.category_id and c.is_active
    join lateral (select v.price, v.compare_at_price from public.product_variants v
                   where v.product_id = p.id order by v.price, v.id limit 1) mv on true
    left join lateral (select i.path, i.alt from public.product_images i
                        where i.product_id = p.id order by i.sort_order, i.id limit 1) img on true
`;

export function toSummary(r: SummaryRow, locale: Locale) {
  const name = pick(r.name, locale);
  return {
    id: r.id,
    slug: r.slug,
    name,
    price: Number(r.price),
    compareAtPrice: r.compare_at_price && Number(r.compare_at_price) > Number(r.price) ? Number(r.compare_at_price) : null,
    image: { url: imageUrl(r.image_path) ?? "", alt: pickOrNull(r.image_alt, locale) ?? name },
    category: { slug: r.category_slug, name: pick(r.category_name, locale) },
    isNew: Boolean(r.is_new),
  };
}

export async function getSetting(db: Db, key: string): Promise<Record<string, unknown> | null> {
  const rows = await db.query<{ value: Record<string, unknown> }>(`select value from public.site_settings where key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export const DEFAULT_STRIP = {
  enabled: true,
  animated: true,
  speed: 30,
  pause_on_hover: true,
  title: { ar: "علاماتنا التجارية", fr: "Nos marques", en: "Our brands" },
};

export const DEFAULT_SALE = {
  enabled: true,
  title: { ar: "التخفيضات", fr: "Promotions", en: "Sale" },
  subtitle: { ar: "أفضل العروض لفترة محدودة", fr: "Les meilleures offres, pour une durée limitée", en: "Our best deals, for a limited time" },
};

export async function getBrandsStrip(db: Db, locale: Locale) {
  const s = { ...DEFAULT_STRIP, ...((await getSetting(db, "brands_strip")) ?? {}) } as typeof DEFAULT_STRIP;
  return {
    enabled: Boolean(s.enabled),
    animated: Boolean(s.animated),
    speed: Math.min(120, Math.max(5, Number(s.speed) || 30)),
    pauseOnHover: Boolean(s.pause_on_hover),
    title: pick(s.title, locale),
  };
}

export async function getSale(db: Db, locale: Locale) {
  const s = { ...DEFAULT_SALE, ...((await getSetting(db, "sale_page")) ?? {}) } as typeof DEFAULT_SALE;
  const rows = await db.query<SummaryRow>(
    `${SUMMARY_SQL}
      where p.is_published
        and exists (select 1 from public.product_variants v where v.product_id = p.id and v.compare_at_price > v.price)
      order by (1 - mv.price::numeric / nullif(mv.compare_at_price, 0)) desc nulls last, p.created_at desc`,
  );
  return {
    enabled: Boolean(s.enabled),
    title: pick(s.title, locale),
    subtitle: pickOrNull(s.subtitle, locale),
    products: rows.map((r) => toSummary(r, locale)),
  };
}

export async function getBrands(db: Db) {
  const rows = await db.query<{ id: string; slug: string; name: string; logo_path: string | null; link_url: string | null }>(
    `select id, slug, name, logo_path, link_url from public.brands where is_active order by sort_order, name`,
  );
  return rows.map((b) => ({
    id: b.id,
    slug: b.slug,
    name: b.name,
    logo: { url: imageUrl(b.logo_path) ?? "", alt: b.name },
    href: b.link_url,
  }));
}

export async function getOffers(db: Db, locale: Locale) {
  const rows = await db.query<{
    id: string; label: unknown; title: unknown; subtitle: unknown; cta_label: unknown; link_url: string | null;
    collection_slug: string | null; image_path: string | null; theme: "dark" | "light"; show_countdown: boolean; ends_at: unknown;
  }>(
    `select o.id, o.label, o.title, o.subtitle, o.cta_label, o.link_url, c.slug as collection_slug, o.image_path,
            o.theme, o.show_countdown, o.ends_at
       from public.offers o left join public.collections c on c.id = o.collection_id and c.is_published
      where o.is_active and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now())
      order by o.sort_order, o.created_at desc`,
  );
  return rows.map((o) => ({
    id: o.id,
    label: pickOrNull(o.label, locale),
    title: pick(o.title, locale),
    subtitle: pickOrNull(o.subtitle, locale),
    ctaLabel: pickOrNull(o.cta_label, locale),
    href: o.link_url ?? (o.collection_slug ? `/collections/${o.collection_slug}` : null),
    image: o.image_path ? { url: imageUrl(o.image_path) ?? "", alt: "" } : null,
    theme: o.theme,
    countdownEndsAt: o.show_countdown ? iso(o.ends_at) : null,
  }));
}

export async function getLooks(db: Db, locale: Locale, collectionId: string | null) {
  const rows = await db.query<{ id: string; image_path: string; alt: unknown; slugs: string[] | null }>(
    `select l.id, l.image_path, l.alt,
            array_agg(p.slug order by lp.sort_order) filter (where p.id is not null) as slugs
       from public.looks l
       left join public.look_products lp on lp.look_id = l.id
       left join public.products p on p.id = lp.product_id and p.is_published
      where l.is_published and ($1::uuid is null or l.collection_id = $1)
      group by l.id order by l.sort_order, l.id limit 24`,
    [collectionId],
  );
  return rows.map((l, i) => ({
    id: l.id,
    image: { url: imageUrl(l.image_path) ?? "", alt: pickOrNull(l.alt, locale) ?? `Look ${i + 1}` },
    productSlugs: l.slugs ?? [],
  }));
}

/** Group summaries into rows, in the order categories first appear. */
export function groupRows(rows: (SummaryRow & { category_sort?: number })[], locale: Locale, perRow = 12) {
  const map = new Map<string, { category: { slug: string; name: string }; products: ReturnType<typeof toSummary>[] }>();
  for (const r of rows) {
    const row = map.get(r.category_slug) ?? { category: { slug: r.category_slug, name: pick(r.category_name, locale) }, products: [] };
    if (row.products.length < perRow) row.products.push(toSummary(r, locale));
    map.set(r.category_slug, row);
  }
  return [...map.values()];
}

export const WHY_ICONS = ["truck", "shield", "refresh", "headset", "card", "gift", "star", "heart"] as const;

/** "Why us" block, or null when switched off / empty. */
export async function getWhyUs(db: Db, locale: Locale) {
  const v = (await getSetting(db, "why_us")) as { enabled?: boolean; title?: unknown; items?: { icon?: string; title?: unknown; text?: unknown }[] } | null;
  if (!v || v.enabled === false || !v.items?.length) return null;
  return {
    title: pick(v.title, locale),
    items: v.items.map((i) => ({ icon: i.icon ?? "star", title: pick(i.title, locale), text: pickOrNull(i.text, locale) })),
  };
}

export async function getNewsletter(db: Db, locale: Locale) {
  const v = (await getSetting(db, "newsletter")) as { enabled?: boolean; title?: unknown; subtitle?: unknown; button?: unknown } | null;
  if (!v || v.enabled === false) return null;
  return { title: pick(v.title, locale), subtitle: pickOrNull(v.subtitle, locale), button: pick(v.button, locale) };
}

export async function getCategoryCards(db: Db, locale: Locale) {
  const rows = await db.query<{ id: string; title: unknown; subtitle: unknown; image_path: string; link_url: string | null }>(
    `select id, title, subtitle, image_path, link_url from public.home_cards where is_active order by sort_order, created_at, id`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: pick(r.title, locale),
    subtitle: pickOrNull(r.subtitle, locale),
    image: { url: imageUrl(r.image_path) ?? "", alt: pick(r.title, locale) },
    href: r.link_url,
  }));
}
