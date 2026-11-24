import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { getEnv } from "./env.js";
import { errorBody, handleError } from "./lib/errors.js";
import { healthRoutes } from "./routes/health.js";

export const OPENAPI_INFO = {
  openapi: "3.1.0",
  info: {
    title: "Store API",
    version: "0.1.0",
    description: "API for the store storefront (store-web) and admin dashboard (store-admin).",
  },
} as const;

export function createApp() {
  const app = new OpenAPIHono({
    // Uniform validation error format for every route.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody("validation_error", "Invalid request", result.error.issues), 422);
      }
    },
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

  app.doc31("/openapi.json", OPENAPI_INFO);

  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));
  app.onError(handleError);

  return app;
}

export const app = createApp();
export default app;
