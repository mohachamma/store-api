import type { Query } from "./db.js";
import { LOCALES } from "./i18n.js";

/** "Nylon Full-Zip Hoodie" → "nylon-full-zip-hoodie" (Latin letters and digits only; Arabic falls back to the given default). */
export const slugify = (s: string, fallback = "item") =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || fallback;

/** The first Latin-script translation (French, then English) is the best source for a URL slug. */
export function slugSource(name: Partial<Record<(typeof LOCALES)[number], string>>): string {
  return name.fr?.trim() || name.en?.trim() || "";
}

const TABLES = { products: true, categories: true, collections: true } as const;

/** A slug that is not used yet: the plain one when free, otherwise with a short random suffix. */
export async function uniqueSlug(q: Query, table: keyof typeof TABLES, base: string): Promise<string> {
  if (!TABLES[table]) throw new Error("unknown table");
  const free = async (s: string) => (await q.query(`select 1 from public.${table} where slug = $1`, [s])).length === 0;
  if (await free(base)) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (await free(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
