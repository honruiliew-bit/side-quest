// Plain words and PayPal API names for each money event. Kept apart from the grid so pages can use them without loading AG Grid.
import type { LedgerKind } from "./types";

export const EVENT: Record<LedgerKind, string> = {
  hold: "Hold placed",
  release: "Hold released",
  charge: "Charged",
  refund: "Refunded",
  payout: "Paid out to host",
  invoice: "Invoice sent",
  invoice_paid: "Invoice paid",
  reauthorize: "Hold renewed",
  decline: "Declined",
};

export const API: Record<LedgerKind, string> = {
  hold: "Orders v2 authorize",
  release: "Void authorization",
  charge: "Capture authorization",
  refund: "Refund capture",
  payout: "Payouts v1",
  invoice: "Agent Toolkit invoice",
  invoice_paid: "Invoicing",
  reauthorize: "Reauthorize",
  decline: "PayPal error",
};
