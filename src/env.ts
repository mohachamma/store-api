import { z } from "zod";

const origins = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  WEB_ORIGIN: origins,
  ADMIN_ORIGIN: origins,
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /** Supabase "JWT secret" (HS256). Without it the API verifies tokens with the project's JWKS. */
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),
  /** Postgres connection string (Supabase → Project Settings → Database → Connection pooling). Secret. */
  DATABASE_URL: z.string().min(1).optional(),
  /** Only for `npm run db:migrate` (deploy time): the Session pooler string. Falls back to DATABASE_URL. Secret. */
  MIGRATIONS_DATABASE_URL: z.string().min(1).optional(),
  /** Cloudflare R2 (images). Account id, S3-compatible API token, bucket and the public base URL of the bucket. */
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  /** e.g. https://images.yourstore.dz (custom domain) or https://pub-xxxx.r2.dev — no trailing slash needed. */
  R2_PUBLIC_URL: z.string().url().optional(),
  /** Chargily Pay v2 secret key (test or live) and which one it is. Secret. */
  CHARGILY_SECRET_KEY: z.string().min(1).optional(),
  CHARGILY_MODE: z.enum(["test", "live"]).default("test"),
  /** Public https address of this API (used for the payment webhook), no trailing slash. */
  PUBLIC_API_URL: z.string().url().transform((v) => v.replace(/\/$/, "")).optional(),
  /** Yalidine keys (Yalidine dashboard → Developers) and the wilaya name parcels are sent from, e.g. "Alger". Secret. */
  YALIDINE_API_ID: z.string().min(1).optional(),
  YALIDINE_API_TOKEN: z.string().min(1).optional(),
  DELIVERY_FROM_WILAYA: z.string().min(1).optional(),
  /** Vercel Cron sends this as "Authorization: Bearer <value>" to /cron/*. Secret. */
  CRON_SECRET: z.string().min(16).optional(),
  /**
   * Secret key for the one-way fingerprints of phone numbers and connections (to recognise repeat buyers and refused parcels
   * without keeping the number). Use a long random value, keep it in Vercel env only, and NEVER change it later (old fingerprints would stop matching). Secret.
   */
  FINGERPRINT_SECRET: z.string().min(32).optional(),
  /** Shared with the storefront, which forwards the visitor's IP address with it (otherwise the API only sees the storefront's server). Secret. */
  STOREFRONT_SECRET: z.string().min(16).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parses and validates process.env once. Throws with a readable list of problems. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the cached env so the next getEnv() re-reads process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
