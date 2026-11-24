import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const HealthSchema = z
  .object({
    status: z.literal("ok"),
    version: z.string(),
    time: z.string().openapi({ format: "date-time" }),
    database: z.enum(["configured", "not_configured"]),
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

export const healthRoutes = new OpenAPIHono().openapi(route, (c) =>
  c.json(
    {
      status: "ok" as const,
      version: process.env.npm_package_version ?? "0.1.0",
      time: new Date().toISOString(),
      database:
        process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
          ? ("configured" as const)
          : ("not_configured" as const),
    },
    200,
  ),
);
