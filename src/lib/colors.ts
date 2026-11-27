/**
 * Common color names (English, French, Arabic) → hex, used when a variant has no explicit swatch color.
 * The owner can always pick the exact color in the dashboard; this just makes existing data show sensible dots.
 */
const NAMED: Record<string, string> = {
  black: "#111111", noir: "#111111", "أسود": "#111111",
  white: "#ffffff", blanc: "#ffffff", "أبيض": "#ffffff",
  cream: "#f1e9d8", "crème": "#f1e9d8", creme: "#f1e9d8", ivory: "#f4efe1", "كريمي": "#f1e9d8",
  beige: "#d9c7a6", "بيج": "#d9c7a6",
  sand: "#c9ad82", sable: "#c9ad82", "رملي": "#c9ad82", camel: "#b98a50",
  stone: "#bdb3a2", pierre: "#bdb3a2", "حجري": "#bdb3a2",
  grey: "#8a8a8a", gray: "#8a8a8a", gris: "#8a8a8a", "رمادي": "#8a8a8a",
  charcoal: "#3a3a3a", anthracite: "#3a3a3a", "فحمي": "#3a3a3a",
  navy: "#1f2a44", marine: "#1f2a44", "كحلي": "#1f2a44",
  blue: "#2f5fa7", bleu: "#2f5fa7", "أزرق": "#2f5fa7",
  denim: "#4a6fa5", jean: "#4a6fa5", "جينز": "#4a6fa5",
  red: "#c0392b", rouge: "#c0392b", "أحمر": "#c0392b",
  burgundy: "#6d1f2e", bordeaux: "#6d1f2e", "عنابي": "#6d1f2e",
  green: "#3d7a4a", vert: "#3d7a4a", "أخضر": "#3d7a4a",
  olive: "#6b6b3a", kaki: "#7a7248", khaki: "#7a7248", "زيتي": "#6b6b3a",
  brown: "#6b4a2f", marron: "#6b4a2f", "بني": "#6b4a2f",
  pink: "#e8a7b6", rose: "#e8a7b6", "وردي": "#e8a7b6",
  yellow: "#e6c437", jaune: "#e6c437", "أصفر": "#e6c437",
  orange: "#e07b2f", "برتقالي": "#e07b2f",
  purple: "#6f4a8e", violet: "#6f4a8e", "بنفسجي": "#6f4a8e",
  gold: "#c9a227", "ذهبي": "#c9a227", silver: "#b8b8b8", argent: "#b8b8b8", "فضي": "#b8b8b8",
};

/** The dot color of a variant: the explicit one, else a known color name, else null (the storefront then shows a neutral dot). */
export function swatchHex(name: string, explicit: string | null | undefined): string | null {
  if (explicit) return explicit.toLowerCase();
  const key = name.trim().toLowerCase();
  return NAMED[key] ?? null;
}
