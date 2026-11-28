import type { Query } from "./db.js";

/**
 * Moves an order to shipped / delivered / returned (only from one of the allowed current statuses) and does what comes with it:
 * cash on delivery becomes paid on delivery, a returned paid order is refunded, delivered/returned dates are recorded,
 * and returned goods go back to stock (unless the owner says returned goods are lost). Returns false when the order was not in an allowed status.
 */
export async function moveOrder(q: Query, id: string, status: "shipped" | "delivered" | "returned", from: string[]): Promise<boolean> {
  const cur = (await q.query<{ status: string }>(`select status from public.orders where id = $1 for update`, [id]))[0];
  if (!cur || !from.includes(cur.status)) return false;
  await q.query(
    `update public.orders set status = $2::public.order_status,
            payment_status = case when $2 = 'delivered' and payment_method = 'cod' then 'paid'::public.payment_status
                                  when $2 = 'returned' and payment_status = 'paid' then 'refunded'::public.payment_status
                                  else payment_status end,
            delivered_at = case when $2 = 'delivered' then now() else delivered_at end,
            returned_at = case when $2 = 'returned' then now() else returned_at end
      where id = $1`,
    [id, status],
  );
  if (status === "returned") {
    const lost = (await q.query<{ lost: boolean }>(`select coalesce((value->>'returned_items_lost')::boolean, false) as lost from public.site_settings where key = 'profit'`))[0]?.lost === true;
    if (!lost) await q.query(`update public.product_variants v set stock = v.stock + i.quantity from public.order_items i where i.order_id = $1 and i.variant_id = v.id`, [id]);
  }
  return true;
}
