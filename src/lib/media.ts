import { getEnv } from "../env.js";

/**
 * Image columns hold either an R2 object key (e.g. "uploads/2026/11/abc.png") or, for sample data,
 * a path starting with "/" that points to a placeholder served by the storefront.
 * Absolute URLs are passed through.
 */
export function imageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("/") || /^https?:\/\//.test(path) || path.startsWith("data:")) return path;
  const base = getEnv().R2_PUBLIC_URL;
  return base ? `${base.replace(/\/$/, "")}/${path}` : path;
}

/** Inverse of imageUrl() for values coming back from the dashboard: store only the R2 key when the URL is ours. */
export function toStoredPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const base = getEnv().R2_PUBLIC_URL;
  const prefix = base ? `${base.replace(/\/$/, "")}/` : null;
  return prefix && url.startsWith(prefix) ? url.slice(prefix.length) : url;
}
