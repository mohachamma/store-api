/** What a delivery company needs to create a parcel. Personal data lives only in memory for the duration of the call. */
export interface ParcelInput {
  orderNumber: number;
  customerName: string;
  phone: string;
  address: string;
  wilayaName: string;
  communeName: string;
  deliveryType: "home" | "desk";
  /** Amount the courier collects from the customer, in DZD (0 when already paid online). */
  amountToCollect: number;
  /** Short plain description of the goods, e.g. "T-shirt (M, black) x2". */
  productList: string;
}

export interface ParcelResult {
  trackingNumber: string;
  /** Status text as the company reports it (kept in orders.delivery_status). */
  status: string;
}

/** One adapter per delivery company. Add a file in this folder and register it in `index.ts`. */
export interface DeliveryProvider {
  id: string;
  name: string;
  /** False when the secret keys are missing in the environment. */
  configured(): boolean;
  createParcel(input: ParcelInput): Promise<ParcelResult>;
  getTracking(trackingNumber: string): Promise<{ status: string }>;
  cancelParcel(trackingNumber: string): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}
