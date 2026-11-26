export interface CheckoutInput {
  orderNumber: number;
  /** Amount in DZD (integer). */
  amount: number;
  token: string;
  locale: "ar" | "fr" | "en";
}

export interface PaymentEvent {
  /** Provider's checkout id (stored in orders.payment_ref). */
  ref: string;
  status: "paid" | "failed";
}

/** One implementation per payment company (Chargily now; others can be added later). */
export interface PaymentProvider {
  id: string;
  configured(): boolean;
  createCheckout(i: CheckoutInput): Promise<{ ref: string; checkoutUrl: string }>;
  /** Verifies the signature and returns the event, or null for events we do not care about. Throws when the signature is wrong. */
  parseWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null;
}
