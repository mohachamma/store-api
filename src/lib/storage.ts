import { getSupabaseAdmin } from "./supabase.js";
import { BUCKET } from "./media.js";
import { ApiError } from "./errors.js";
import type { ImageStorage } from "./types.js";

/** Production storage: Supabase Storage bucket "product-images" (public read). */
export const supabaseStorage: ImageStorage = {
  async upload(path, bytes, contentType) {
    const { error } = await getSupabaseAdmin().storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
    if (error) throw new ApiError(502, "storage_error", "Could not store the image");
  },
};
