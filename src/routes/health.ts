import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../lib/types.js";

const HealthSchema = z
  .object({
    status: z.literal("ok"),
    version: z.string(),
    time: z.string().openapi({ format: "date-time" }),
    database: z.enum(["configured", "not_configured"]),
    /** A real round trip to the database (only when DATABASE_URL is set): ok / unreachable / not_configured. */
    databaseConnection: z.enum(["ok", "unreachable", "not_configured"]),
  })
  .openapi("Health");

const route = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Liveness check",
  responses: {
    200: { description: "Service is up", content: { "application/json": { schema: HealthSchema } } },
  },
});

export const healthRoutes = new OpenAPIHono<AppEnv>().openapi(route, async (c) => {
  let databaseConnection: "ok" | "unreachable" | "not_configured" = "not_configured";
  if (process.env.DATABASE_URL) {
    try {
      await Promise.race([c.get("db").query("select 1"), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))]);
      databaseConnection = "ok";
    } catch {
      databaseConnection = "unreachable";
    }
  }
  return c.json(
    {
      status: "ok" as const,
      version: process.env.npm_package_version ?? "0.1.0",
      time: new Date().toISOString(),
      database: process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? ("configured" as const) : ("not_configured" as const),
      databaseConnection,
    },
    200,
  );
});
