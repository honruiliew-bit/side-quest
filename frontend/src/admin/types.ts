import type { LedgerKind, Membership, Receipt, UserLite } from "@/lib/types";

export type QuestMoney = {
  gross_cents: number;
  refunded_cents: number;
  invoices_collected_cents: number;
  booking_fees_cents: number;
  host_fee_cents: number;
  host_due_cents: number;
  paid_out_cents: number;
  paypal_fees_cents: number;
  fees_estimated: boolean;
  revenue_cents: number;
  net_revenue_cents: number;
  escrow_cents: number;
  owed_back_cents: number;
};

export type OverviewQuest = QuestMoney & {
  id: string;
  code: string;
  title: string;
  status: string;
  host: string;
  line_code: string;
  starts_at: string | null;
  fee_bps: number;
  fee_fixed_cents: number;
  host_fee_bps: number;
};

export type Overview = {
  totals: Omit<QuestMoney, "fees_estimated"> & { authorized_cents: number; take_rate_bps: number };
  fees_estimated: boolean;
  quests: OverviewQuest[];
  open_cases: number;
  recon_issues: number;
  paypal_mode: "mock" | "sandbox";
};

export type Decision = "release" | "refund_reporter" | "split_refund" | "refund_everyone" | "accept_claim";

export type AiReview = {
  summary: string;
  facts: string[];
  missing: string[];
  decision: Decision | "need_more_info";
  refund_cents: number; // refund_reporter: to the reporter. split_refund: the total to split
  reasoning: string;
  source: "claude" | "offline";
};

export type AdminCase = {
  id: string;
  source: "member" | "paypal";
  provider: "paypal" | "sim";
  status: "open" | "resolved" | "withdrawn";
  reason: string;
  disputed_cents: number;
  reporter: UserLite | null;
  paypal_dispute_id: string | null;
  paypal_reason: string | null;
  paypal_status: string | null;
  host_response: string | null;
  host_responded_at: string | null;
  decision: Decision | null;
  refund_cents_each: number | null;
  resolution_note: string | null;
  resolved_by: UserLite | null;
  resolved_at: string | null;
  created_at: string;
  quest: { id: string; code: string; title: string; status: string; line_code: string; host: UserLite; tz: string };
  ai_review: AiReview | null;
};

export type CaseDetail = AdminCase & {
  money: QuestMoney;
  host_paid: boolean;
  payout_due_at: string;
  members: Membership[];
  ledger: { id: string; kind: LedgerKind; cents: number; ref: string | null; note: string; user: UserLite | null; created_at: string }[];
  receipts: Receipt[];
  chat: { id: string; role: string; body: string; user: UserLite | null; created_at: string }[];
};

export type Payment = {
  id: string;
  kind: LedgerKind;
  cents: number;
  ref: string | null;
  provider: string;
  note: string;
  confirmed: boolean;
  user: UserLite | null;
  created_at: string;
  quest: { id: string; code: string; title: string; line_code: string; tz: string; host: string; tour: boolean };
  fee_cents: number;
  fee_source: "paypal" | "estimate" | null;
  recon_status: "matched" | "mismatch" | "missing" | "simulated" | "error" | null;
  recon_note: string | null;
  recon_at: string | null;
  simulated: boolean;
};

export type Schedule = {
  id: string;
  booking_bps: number;
  booking_fixed_cents: number;
  host_bps: number;
  reason: string;
  created_at: string;
  by: string;
  label: string;
};

export type Fees = {
  current: Schedule;
  history: Schedule[];
  active_quests: number;
  limits: { booking_bps: number; booking_fixed_cents: number; host_bps: number };
};

export type Preview = {
  price_cents: number;
  base_cents: number;
  booking_fee_cents: number;
  host_fee_cents: number;
  host_gets_cents: number;
  paypal_cents: number;
  sidequest_net_cents: number;
  take_rate_bps: number;
};

export type AuditRow = {
  id: string;
  action: string;
  target: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  actor: UserLite | null;
  created_at: string;
};

export type StatementRow = {
  id: string;
  event_code: string;
  event: string;
  status: string;
  cents: number | null;
  fee_cents: number | null;
  at: string | null;
  invoice_id: string | null;
  payer: string | null;
  in_books: boolean;
};
