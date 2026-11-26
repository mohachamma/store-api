import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getEnv } from "./env.js";
import { lazyDb, type Db } from "./lib/db.js";
import { errorBody, handleError } from "./lib/errors.js";
import { requireAdmin } from "./lib/auth.js";
import { r2Storage } from "./lib/storage.js";
import type { AppEnv, ImageStorage } from "./lib/types.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { healthRoutes } from "./routes/health.js";
import { shippingRoutes } from "./routes/shipping.js";

export const OPENAPI_INFO = {
  openapi: "3.1.0",
  info: {
    title: "Store API",
    version: "0.2.0",
    description: "API for the store storefront (store-web) and admin dashboard (store-admin).",
  },
} as const;

/** `deps.db` lets tests inject an in-process database; production connects lazily from DATABASE_URL. */
export function createApp(deps: { db?: Db; storage?: ImageStorage } = {}) {
  const db = deps.db ?? lazyDb();
  const storage = deps.storage ?? r2Storage;
  const app = new OpenAPIHono<AppEnv>({
    // Uniform validation error format for every route.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody("validation_error", "Invalid request", result.error.issues), 422);
      }
    },
  });

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("storage", storage);
    await next();
  });
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) => {
        const env = getEnv();
        const allowed = [...env.WEB_ORIGIN, ...env.ADMIN_ORIGIN];
        return allowed.includes(origin) ? origin : null;
      },
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

  app.route("/", healthRoutes);
  app.route("/", authRoutes);
  app.route("/", catalogRoutes);
  app.route("/", shippingRoutes);
  // Everything under /admin needs a valid token with role "admin".
  app.use("/admin/*", requireAdmin);
  app.route("/", adminRoutes);
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });

  app.doc31("/openapi.json", OPENAPI_INFO);

  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));
  app.onError(handleError);

  return app;
}

export const app = createApp();
export default app;
