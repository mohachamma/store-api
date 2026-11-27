import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getEnv } from "./env.js";
import { lazyDb, type Db } from "./lib/db.js";
import { errorBody, handleError } from "./lib/errors.js";
import { requireAdmin, requireUser } from "./lib/auth.js";
import { buildProviders } from "./lib/delivery/index.js";
import { chargily } from "./lib/payments/chargily.js";
import type { PaymentProvider } from "./lib/payments/types.js";
import type { DeliveryProvider } from "./lib/delivery/types.js";
import { r2Storage } from "./lib/storage.js";
import type { AppEnv, ImageStorage } from "./lib/types.js";
import { adminCatalogRoutes } from "./routes/admin-catalog.js";
import { adminDeliveryRoutes } from "./routes/admin-delivery.js";
import { adminHomeRoutes } from "./routes/admin-home.js";
import { adminPagesRoutes } from "./routes/admin-pages.js";
import { adminOrderRoutes } from "./routes/admin-orders.js";
import { adminStoreRoutes } from "./routes/admin-store.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { cronRoutes } from "./routes/cron.js";
import { pagesRoutes } from "./routes/pages.js";
import { paymentRoutes } from "./routes/payments.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { newsletterRoutes } from "./routes/newsletter.js";
import { orderRoutes } from "./routes/orders.js";
import { shippingRoutes } from "./routes/shipping.js";

export const OPENAPI_INFO = {
  openapi: "3.1.0",
  info: {
    title: "Store API",
    version: "0.11.0",
    description: "API for the store storefront (store-web) and admin dashboard (store-admin).",
  },
} as const;

/** `deps.db` lets tests inject an in-process database; production connects lazily from DATABASE_URL. */
export function createApp(deps: { db?: Db; storage?: ImageStorage; delivery?: Record<string, DeliveryProvider>; payment?: PaymentProvider } = {}) {
  const db = deps.db ?? lazyDb();
  const storage = deps.storage ?? r2Storage;
  const delivery = deps.delivery ?? buildProviders();
  const payment = deps.payment ?? chargily();
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
    c.set("delivery", delivery);
    c.set("payment", payment);
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
  app.route("/", orderRoutes);
  app.route("/", paymentRoutes);
  app.route("/", newsletterRoutes);
  app.route("/", pagesRoutes);
  app.route("/", cronRoutes);
  // Signed-in customers only.
  app.use("/me", requireUser);
  app.use("/me/*", requireUser);
  app.route("/", meRoutes);
  // Everything under /admin needs a valid token with role "admin".
  app.use("/admin/*", requireAdmin);
  app.route("/", adminRoutes);
  app.route("/", adminOrderRoutes);
  app.route("/", adminCatalogRoutes);
  app.route("/", adminStoreRoutes);
  app.route("/", adminDeliveryRoutes);
  app.route("/", adminHomeRoutes);
  app.route("/", adminPagesRoutes);
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });

  app.doc31("/openapi.json", OPENAPI_INFO);

  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));
  app.onError(handleError);

  return app;
}

export const app = createApp();
export default app;
