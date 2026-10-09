import { money } from "@/lib/format";

export function pct(bps: number) {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2)}%`;
}

export function feeTerms(bps: number, fixedCents: number, hostBps = 0) {
  const booking = bps || fixedCents ? `${pct(bps)}${fixedCents ? ` + ${money(fixedCents)}` : ""}` : "No booking fee";
  return hostBps ? `${booking}, host ${pct(hostBps)}` : booking;
}

export function Tile({ label, value, note, tone = "ink" }: { label: string; value: string; note?: string; tone?: "ink" | "money" | "stamp" }) {
  const color = tone === "money" ? "text-money" : tone === "stamp" ? "text-stamp" : "text-ink";
  return (
    <div className="ticket flex min-w-0 flex-col gap-1 px-4 py-3">
      <div className="label">{label}</div>
      <div className={`tab text-[30px] font-extrabold leading-none ${color}`} style={{ fontStretch: "62%" }}>{value}</div>
      {note && <div className="text-[13px] leading-snug text-muted">{note}</div>}
    </div>
  );
}

export type Slice = { label: string; cents: number; color: string; text?: string };

/** One bar, split into who got what. Every slice is labelled in the legend, never by color alone. */
export function SplitBar({ slices, total, label, compact }: { slices: Slice[]; total?: number; label: string; compact?: boolean }) {
  const sum = total ?? slices.reduce((a, s) => a + Math.max(s.cents, 0), 0);
  return (
    <figure className="flex flex-col gap-3" aria-label={label}>
      <div className="flex h-9 w-full overflow-hidden border-2 border-ink bg-white">
        {slices.filter((s) => s.cents > 0).map((s) => (
          <div
            key={s.label}
            title={`${s.label}: ${money(s.cents)}`}
            className="h-full border-r-2 border-white last:border-r-0"
            style={{ width: `${(s.cents / Math.max(sum, 1)) * 100}%`, background: s.color, minWidth: 3 }}
          />
        ))}
      </div>
      <figcaption>
        <ul className={`grid gap-x-6 gap-y-2 text-[14px] ${compact ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4"}`}>
          {slices.map((s) => (
            <li key={s.label} className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-[3px] h-3 w-3 flex-none border border-ink" style={{ background: s.color }} />
              <span className="leading-tight">
                <span className="font-semibold">{s.label}</span>{" "}
                <span className="tab">{money(s.cents)}</span>
                {sum > 0 && <span className="text-muted"> ({((s.cents / sum) * 100).toFixed(1)}%)</span>}
                {s.text && <span className="block text-[13px] text-muted">{s.text}</span>}
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

export const COLORS = {
  host: "#1f5fd6",
  refund: "#8a93a0",
  paypal: "#2b3446",
  sidequest: "#ffc93c",
  held: "#9fbdf0",
};

export const DECISION_TEXT: Record<string, string> = {
  release: "Released the payout",
  refund_reporter: "Refunded the reporter",
  refund_everyone: "Refunded everyone",
  accept_claim: "Accepted the PayPal claim",
  need_more_info: "Ask for more information",
};

export function LineDot({ code }: { code: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid h-8 w-8 flex-none place-items-center rounded-full bg-ink text-[12px] font-black leading-none text-signal"
      style={{ fontStretch: "62%" }}
    >
      {code}
    </span>
  );
}
