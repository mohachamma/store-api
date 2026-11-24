import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "../env.js";
import { ApiError } from "./errors.js";

let admin: SupabaseClient | undefined;

/**
 * Server-side Supabase client using the service role key.
 * Only this API may hold that key; it must never reach a browser.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (admin) return admin;
  const env = getEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ApiError(503, "service_unavailable", "Database is not configured");
  }
  admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
