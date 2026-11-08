/** What the frame hands to every screen. A screen takes the parts it needs. */
export interface PageProps {
  /** Goes up after any change, so a screen reads its data again. */
  version: number;
  refresh: () => void;
  hash: string;
  /** The record in the address, e.g. the invoice id in #/invoices/12. */
  param: string;
  health: Health | null;
}

export interface Health {
  pending_approvals: number;
  paypal_mode: "sandbox" | "simulated";
  sync?: { last_ok_at: string | null; last_error: string | null; interval_seconds: number };
  ai: { available: boolean; model: string };
}
