import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { LocaleQuery, type Locale } from "../lib/i18n.js";
import type { AppEnv } from "../lib/types.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";

const WilayaSchema = z
  .object({
    code: z.number().int().min(1).max(58),
    name: z.string(),
    /** Delivery to the customer's door, integer DZD. */
    homeFee: z.number().int(),
    /** Delivery to a pickup desk, integer DZD. */
    deskFee: z.number().int(),
  })
  .openapi("Wilaya");

const CommuneSchema = z.object({ id: z.number().int(), name: z.string(), daira: z.string().nullable() }).openapi("Commune");

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const name = (ar: string, fr: string, locale: Locale) => (locale === "ar" ? ar : fr);

export const shippingRoutes = new OpenAPIHono<AppEnv>();

shippingRoutes.use("*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && c.res.status === 200) c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
});

shippingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/shipping/wilayas",
    tags: ["Shipping"],
    summary: "The 58 wilayas with their delivery fees",
    request: { query: z.object({ locale: LocaleQuery }) },
    responses: { 200: json(z.array(WilayaSchema), "OK") },
  }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const rows = await c.get("db").query<{ code: number; name_ar: string; name_fr: string; home_fee: number; desk_fee: number }>(
      `select code, name_ar, name_fr, home_fee, desk_fee from public.wilayas where active order by code`,
    );
    return c.json(rows.map((w) => ({ code: Number(w.code), name: name(w.name_ar, w.name_fr, locale), homeFee: Number(w.home_fee), deskFee: Number(w.desk_fee) })), 200);
  },
);

shippingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/shipping/wilayas/{code}/communes",
    tags: ["Shipping"],
    summary: "Communes of a wilaya",
    request: { params: z.object({ code: z.coerce.number().int().min(1).max(58) }), query: z.object({ locale: LocaleQuery }) },
    responses: { 200: json(z.array(CommuneSchema), "OK"), 404: json(ErrorSchema, "Unknown wilaya") },
  }),
  async (c) => {
    const { code } = c.req.valid("param");
    const { locale } = c.req.valid("query");
    const db = c.get("db");
    const exists = await db.query(`select 1 from public.wilayas where code = $1 and active`, [code]);
    if (!exists.length) throw new ApiError(404, "not_found", "Wilaya not found");
    const rows = await db.query<{ id: number; name_ar: string; name_fr: string; daira_ar: string | null; daira_fr: string | null }>(
      `select id, name_ar, name_fr, daira_ar, daira_fr from public.communes where wilaya_code = $1 order by name_fr, id`,
      [code],
    );
    return c.json(rows.map((r) => ({ id: Number(r.id), name: name(r.name_ar, r.name_fr, locale), daira: r.daira_ar ? name(r.daira_ar, r.daira_fr ?? r.daira_ar, locale) : null })), 200);
  },
);
