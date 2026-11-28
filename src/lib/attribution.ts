import { z } from "@hono/zod-openapi";

/** Which ad brought the customer (UTM tags). Not personal data; each part is a short plain label. */
export const AttributionSchema = z
  .object({
    source: z.string().max(120).nullish(),
    medium: z.string().max(120).nullish(),
    campaign: z.string().max(120).nullish(),
    content: z.string().max(120).nullish(),
  })
  .openapi("Attribution");

/** Lowercase, letters/digits/space/_-. only, trimmed to `max`: so "Eid_Sale", "eid sale " and "EID_SALE" become one campaign. Null when empty. */
export function cleanTag(v: string | null | undefined, max = 60): string | null {
  const s = (v ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_\-. ]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}

export function cleanAttribution(a: z.infer<typeof AttributionSchema> | null | undefined) {
  return { source: cleanTag(a?.source), medium: cleanTag(a?.medium), campaign: cleanTag(a?.campaign, 80), content: cleanTag(a?.content, 80) };
}
