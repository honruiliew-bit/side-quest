export type UserLite = { id: string; name: string; initials: string; color: string; persona: string | null; is_admin?: boolean };

export type MemberStatus =
  | "pending"
  | "held"
  | "standby"
  | "charged"
  | "released"
  | "refunded"
  | "failed"
  | "abandoned";

export type Membership = {
  id: string;
  user: UserLite;
  status: MemberStatus;
  seat: number | null;
  provider: "paypal" | "card" | "sim";
  funding: string | null;
  hold_cents: number;
  charged_cents: number;
  refunded_cents: number;
  order_id: string | null;
  authorization_id: string | null;
  capture_id: string | null;
  created_at: string;
};

export type QuestStatus = "open" | "on" | "locked" | "completed" | "cancelled";

export type QuestCard = {
  id: string;
  code: string;
  line_code: string;
  title: string;
  area: string;
  from_label: string;
  to_label: string;
  starts_at: string;
  ends_at: string | null;
  join_by: string;
  tz: string;
  status: QuestStatus;
  stage: number;
  min_people: number;
  max_people: number;
  headcount: number;
  standby_count: number;
  hold_cents: number;
  share_cents: number;
  lowest_cents: number;
  currency: string;
  host: UserLite;
  faces: UserLite[];
  tour: boolean;
};

export type CostLine = { label: string; cents: number; split: "shared" | "each" };
export type Stop = { time: string; title: string; detail: string; note?: string | null };

export type LedgerKind = "hold" | "release" | "charge" | "refund" | "payout" | "invoice" | "invoice_paid" | "reauthorize" | "decline";

export type LedgerEntry = {
  id: string;
  kind: LedgerKind;
  cents: number;
  ref: string | null;
  provider: string;
  note: string;
  confirmed: boolean;
  user: UserLite | null;
  created_at: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "agent" | "system";
  body: string;
  user: UserLite | null;
  meta: { tools?: string[]; event?: string; model?: boolean; proposal?: string };
  created_at: string;
};

export type ProposalAction = {
  type: "void_hold" | "promote" | "refund" | "invoice";
  membership_id: string;
  name: string;
  cents: number;
  ref?: string | null;
  note?: string;
  item?: string;
};

export type Receipt = {
  id: string;
  merchant: string | null;
  purchased_on: string | null;
  total_cents: number | null;
  cost_line: string | null;
  status: "verified" | "flagged" | "unverified" | "rejected" | "removed";
  issues: string[];
  reader: "claude" | "host";
  filename: string;
  created_at: string | null;
};

export type Proposal = {
  id: string;
  title: string;
  rationale: string;
  actions: ProposalAction[];
  status: "pending" | "running" | "executed" | "declined" | "failed" | "expired";
  result: { done?: { type: string; name: string }[]; error?: string } | null;
  evidence: Receipt[];
  created_at: string;
};

export type QuestDetail = QuestCard & {
  summary: string;
  meet_point: string;
  cost_lines: CostLine[];
  shared_cents: number;
  each_cents: number;
  fee_bps: number;
  fee_fixed_cents: number;
  itinerary: Stop[];
  price_table: { people: number; cents: number }[];
  seats: { seat: number; is_minimum: boolean; member: Membership | null }[];
  standby: Membership[];
  money: { held_cents: number; charged_cents: number; refunded_cents: number; paid_out_cents: number };
  viewer: { role: "host" | "member" | "guest"; membership: Membership | null; is_admin: boolean };
  ledger: LedgerEntry[];
  messages: ChatMessage[];
  proposals: Proposal[];
  timestamps: Record<string, string | null>;
  paypal_mode: "mock" | "sandbox";
  host_stats: { hosted: number; completed: number; travelers: number };
  receipts: Receipt[];
  payout: { due_at: string; paused_reason: string | null; blocker: string | null; hold_hours: number };
  cases: QuestCase[];
};

/** A report on a quest. A Sidequest admin decides it, not the host. */
export type QuestCase = {
  id: string;
  status: "open" | "resolved" | "withdrawn";
  source: "member" | "paypal";
  reason: string;
  reporter: UserLite | null;
  host_response: string | null;
  decision: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  mine: boolean;
};

export type AppConfig = {
  demo_buyer: { email: string; password: string } | null;
  paypal_mode: "mock" | "sandbox";
  paypal_client_id: string | null;
  currency: string;
  demo_mode: boolean;
  ai: "claude" | "offline";
  model: string | null;
  mcp_url: string;
};

export type Draft = {
  title: string;
  area: string;
  summary: string;
  line_code: string;
  from_label: string;
  to_label: string;
  meet_point: string;
  date: string;
  start_time: string;
  end_time: string;
  min_people: number;
  max_people: number;
  join_by_hours_before: number;
  itinerary: Stop[];
  cost_lines: CostLine[];
  source?: "claude" | "offline";
};
