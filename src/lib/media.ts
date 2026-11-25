import { getEnv } from "../env.js";

export const BUCKET = "product-images";

/**
 * Image columns hold either a Storage path or, for sample data, a path starting with "/"
 * (a placeholder served by the storefront). Absolute URLs are passed through.
 */
export function imageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("/") || /^https?:\/\//.test(path) || path.startsWith("data:")) return path;
  const base = getEnv().SUPABASE_URL;
  return base ? `${base.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${path}` : path;
}

/** Inverse of imageUrl() for values coming back from the dashboard: keep only the Storage path when it is one of ours. */
export function toStoredPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const base = getEnv().SUPABASE_URL;
  const prefix = base ? `${base.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/` : null;
  return prefix && url.startsWith(prefix) ? url.slice(prefix.length) : url;
}
