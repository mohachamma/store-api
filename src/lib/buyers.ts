import type { Query } from "./db.js";
import { buyerCode } from "./fingerprint.js";

export type Risk = "loyal" | "watch" | "high" | null;

/**
 * What the history of a buyer says, before accepting a new order from him.
 *  - high:  two parcels or more came back
 *  - watch: one parcel came back
 *  - loyal: two parcels or more delivered and none came back
 */
export function riskOf(h: { delivered: number; returned: number }): Risk {
  if (h.returned >= 2) return "high";
  if (h.returned === 1) return "watch";
  if (h.delivered >= 2) return "loyal";
  return null;
}

export interface BuyerHistory {
  code: string;
  previousOrders: number;
  delivered: number;
  returned: number;
  cancelled: number;
  risk: Risk;
  /** Other buyers (different phone numbers) who ordered from the same connection in the last 24 hours. A weak hint: mobile networks share addresses. */
  sameConnectionOthers: number;
}

/** History of the buyer behind `orderId` (same phone fingerprint), not counting that order itself. Null when the order has no fingerprint. */
export async function buyerHistory(q: Query, orderId: string): Promise<BuyerHistory | null> {
  const o = (await q.query<{ phone_key: string | null; ip_key: string | null; created_at: unknown }>(`select phone_key, ip_key, created_at from public.orders where id = $1`, [orderId]))[0];
  if (!o?.phone_key) return null;
  const [h, ip] = await Promise.all([
    q.query<{ n: number; delivered: number; returned: number; cancelled: number }>(
      `select count(*)::int as n, count(*) filter (where status = 'delivered')::int as delivered, count(*) filter (where status = 'returned')::int as returned, count(*) filter (where status = 'cancelled')::int as cancelled
         from public.orders where phone_key = $1 and id <> $2`,
      [o.phone_key, orderId],
    ),
    o.ip_key
      ? q.query<{ n: number }>(`select count(distinct phone_key)::int as n from public.orders where ip_key = $1 and phone_key is not null and phone_key <> $2 and created_at > $3::timestamptz - interval '24 hours' and created_at <= $3::timestamptz`, [o.ip_key, o.phone_key, new Date(o.created_at as string).toISOString()])
      : Promise.resolve([{ n: 0 }]),
  ]);
  const r = h[0]!;
  return {
    code: buyerCode(o.phone_key),
    previousOrders: Number(r.n),
    delivered: Number(r.delivered),
    returned: Number(r.returned),
    cancelled: Number(r.cancelled),
    risk: riskOf({ delivered: Number(r.delivered), returned: Number(r.returned) }),
    sameConnectionOthers: Number(ip[0]?.n ?? 0),
  };
}

/** Risk of many orders' buyers at once (for the orders list), not counting each row's own order. */
export async function risksFor(q: Query, rows: { id: string; status: string; phone_key: string | null }[]): Promise<Map<string, Risk>> {
  const keys = [...new Set(rows.map((r) => r.phone_key).filter((k): k is string => !!k))];
  const out = new Map<string, Risk>();
  if (!keys.length) return out;
  const totals = await q.query<{ phone_key: string; delivered: number; returned: number }>(
    `select phone_key, count(*) filter (where status = 'delivered')::int as delivered, count(*) filter (where status = 'returned')::int as returned
       from public.orders where phone_key = any($1::text[]) group by phone_key`,
    [keys],
  );
  const byKey = new Map(totals.map((t) => [t.phone_key, t]));
  for (const r of rows) {
    const t = r.phone_key ? byKey.get(r.phone_key) : undefined;
    if (!t) continue;
    out.set(r.id, riskOf({ delivered: Number(t.delivered) - (r.status === "delivered" ? 1 : 0), returned: Number(t.returned) - (r.status === "returned" ? 1 : 0) }));
  }
  return out;
}
