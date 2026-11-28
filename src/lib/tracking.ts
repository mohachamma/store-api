import type { Db } from "./db.js";
import type { DeliveryProvider } from "./delivery/types.js";
import { moveOrder } from "./order-status.js";

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * What a delivery company's status text means for our order. Written from Yalidine's public status list
 * ("Ramassé", "Expédié", "Sorti en livraison", "Livré", "Retourné au vendeur", ...): verify once with real parcels.
 */
export function classifyStatus(status: string): "shipped" | "delivered" | "returned" | null {
  const s = plain(status);
  if (!s || s === "created" || s === "unknown") return null;
  // Still at the shop: not on the road yet.
  if (/pas encore|pret a expedier|en preparation|a verifier|annule/.test(s)) return null;
  if (s === "livre") return "delivered";
  if (/retourne au vendeur|retour.*vendeur|rendu au vendeur/.test(s)) return "returned";
  if (/ramasse|expedie|transfert|centre|localisation|wilaya|livreur|en livraison|tentative|alerte|attente du client|bloque|debloque|retour/.test(s)) return "shipped";
  return null;
}

export interface TrackedOrder {
  id: string;
  status: string;
  delivery_company: string | null;
  tracking_number: string | null;
}

/**
 * Asks the delivery company about one parcel, saves its status text and, when the company says the parcel
 * is on the road / delivered / returned, moves our order the same way (stock and payment follow). Returns the new order status.
 */
export async function syncTracking(db: Db, providers: Record<string, DeliveryProvider>, o: TrackedOrder): Promise<{ deliveryStatus: string; status: string } | null> {
  const p = o.delivery_company ? providers[o.delivery_company] : undefined;
  if (!p || p.id === "manual" || !o.tracking_number || !p.configured()) return null;
  const t = await p.getTracking(o.tracking_number);
  await db.query(`update public.orders set delivery_status = $2, tracking_checked_at = now() where id = $1`, [o.id, t.status]);
  let status = o.status;
  const next = classifyStatus(t.status);
  const move = async (to: "shipped" | "delivered" | "returned", from: string[]) => ((await db.tx((q) => moveOrder(q, o.id, to, from))) ? to : status);
  if (next === "shipped" && status === "confirmed") status = await move("shipped", ["confirmed"]);
  if (next === "delivered" && (status === "confirmed" || status === "shipped")) status = await move("delivered", ["confirmed", "shipped"]);
  if (next === "returned" && (status === "confirmed" || status === "shipped")) status = await move("returned", ["confirmed", "shipped"]);
  return { deliveryStatus: t.status, status };
}
