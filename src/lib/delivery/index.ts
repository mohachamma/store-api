import type { Query } from "../db.js";
import { yalidine } from "./yalidine.js";
import type { DeliveryProvider } from "./types.js";

export * from "./types.js";

/** "manual": no company integration; the admin types the tracking number himself. */
export const manualProvider: DeliveryProvider = {
  id: "manual",
  name: "Manual",
  configured: () => true,
  async createParcel() { throw new Error("manual provider has no API"); },
  async getTracking() { return { status: "unknown" }; },
  async cancelParcel() { /* nothing to cancel */ },
};

/** Every delivery company the store can use. Add new adapters here; the admin picks one from the dashboard. */
export function buildProviders(): Record<string, DeliveryProvider> {
  const y = yalidine();
  return { manual: manualProvider, [y.id]: y };
}

export async function getActiveProviderId(q: Query): Promise<string> {
  const r = await q.query<{ value: { provider?: string } }>(`select value from public.site_settings where key = 'delivery'`);
  return r[0]?.value?.provider ?? "manual";
}
