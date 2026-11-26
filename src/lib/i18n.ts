import { z } from "@hono/zod-openapi";

export const LOCALES = ["ar", "fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const LocaleQuery = z
  .enum(LOCALES)
  .default("ar")
  .openapi({ description: "Language of names and descriptions. Falls back to Arabic when a translation is missing." });

/** Translatable text stored as {"ar": "...", "fr": "...", "en": "..."}. */
export type I18n = Partial<Record<Locale, string>> & { ar: string };

/** Pick a translation, falling back to Arabic. */
export function pick(v: unknown, locale: Locale): string {
  const o = (v ?? {}) as Partial<Record<Locale, string>>;
  return o[locale]?.trim() || o.ar?.trim() || "";
}

/** Same as pick() but null for missing/empty values. */
export function pickOrNull(v: unknown, locale: Locale): string | null {
  return v ? pick(v, locale) || null : null;
}

/** All three translations (empty string when missing) — used by the admin API. */
export function full(v: unknown): { ar: string; fr: string; en: string } {
  const o = (v ?? {}) as Partial<Record<Locale, string>>;
  return { ar: o.ar ?? "", fr: o.fr ?? "", en: o.en ?? "" };
}

export const I18nSchema = z
  .object({ ar: z.string().min(1).max(300), fr: z.string().max(300).default(""), en: z.string().max(300).default("") })
  .openapi("I18n");

/** Like I18nSchema but every language may be empty (optional texts). */
export const OptionalI18nSchema = z
  .object({ ar: z.string().max(300).default(""), fr: z.string().max(300).default(""), en: z.string().max(300).default("") })
  .openapi("OptionalI18n");

/** Convert an admin I18n input to jsonb, dropping empty languages; null when nothing is filled. */
export function toJson(v: { ar: string; fr: string; en: string }): string | null {
  const o: Record<string, string> = {};
  for (const k of LOCALES) if (v[k].trim()) o[k] = v[k].trim();
  return Object.keys(o).length ? JSON.stringify(o) : null;
}
