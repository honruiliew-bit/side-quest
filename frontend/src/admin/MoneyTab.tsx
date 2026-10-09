"use client";

import Link from "next/link";
import { money } from "@/lib/format";
import { COLORS, LineDot, SplitBar, Tile, feeTerms, pct } from "./parts";
import type { Overview } from "./types";

const STATUS: Record<string, string> = {
  open: "Collecting holds",
  on: "It's on",
  locked: "Charged",
  completed: "Done",
  cancelled: "Didn't run",
};

export function MoneyTab({ data }: { data: Overview }) {
  const t = data.totals;
  const inflow = t.gross_cents + t.invoices_collected_cents;
  const toHosts = t.host_due_cents;
  const slices = [
    { label: "Hosts", cents: toHosts - t.escrow_cents, color: COLORS.host, text: "Paid out through PayPal Payouts" },
    { label: "Held for hosts", cents: t.escrow_cents, color: COLORS.held, text: "Charged, waiting for the payout date or a decision" },
    { label: "Refunded", cents: t.refunded_cents, color: COLORS.refund, text: "Back to members" },
    { label: "PayPal fees", cents: t.paypal_fees_cents, color: COLORS.paypal, text: data.fees_estimated ? "Some are estimates" : "As reported by PayPal" },
    { label: "Sidequest", cents: Math.max(t.net_revenue_cents, 0), color: COLORS.sidequest, text: "Fees kept, after PayPal" },
  ];
  const shown = data.quests.filter((q) => q.gross_cents > 0);

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="kpi-h" className="flex flex-col gap-4">
        <h2 id="kpi-h" className="sr-only">Totals</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Charged" value={money(t.gross_cents)} note={`${money(t.authorized_cents)} more on hold, not charged`} />
          <Tile label="Booking fees" value={money(t.booking_fees_cents)} note={t.host_fee_cents ? `Plus ${money(t.host_fee_cents)} in host fees` : "No host fees"} />
          <Tile label="PayPal fees" value={money(t.paypal_fees_cents)} note={data.fees_estimated ? "Estimated where PayPal didn't report" : "Reported by PayPal"} />
          <Tile label="Net revenue" value={money(t.net_revenue_cents)} tone={t.net_revenue_cents >= 0 ? "money" : "stamp"} note={`${pct(t.take_rate_bps)} of what was charged`} />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Held for hosts" value={money(t.escrow_cents)} note="Sidequest holds this until the payout" />
          <Tile label="Paid to hosts" value={money(t.paid_out_cents)} note="PayPal Payouts" />
          <Tile label="Refunded" value={money(t.refunded_cents)} />
          <Tile label="Owed back by hosts" value={money(t.owed_back_cents)} tone={t.owed_back_cents ? "stamp" : "ink"}
            note={t.owed_back_cents ? "Refunds after the host was paid" : "Nothing owed"} />
        </div>
      </section>

      <section aria-labelledby="split-h" className="panel flex flex-col gap-4 p-5">
        <div>
          <h2 id="split-h" className="h3">Where {money(inflow)} went</h2>
          <p className="text-[14px] text-muted">Everything members paid, by card or PayPal, including invoices for extra costs.</p>
        </div>
        <SplitBar slices={slices} total={inflow} label="Where the money went" />
      </section>

      <section aria-labelledby="byq-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="byq-h" className="h2">By quest</h2>
          <span className="text-[14px] text-muted">Each quest keeps the fees it was posted with.</span>
        </div>
        <div className="overflow-x-auto border-2 border-ink bg-stock">
          <table className="w-full min-w-[880px] text-left text-[14px]">
            <thead className="border-b-2 border-ink bg-paper">
              <tr>
                <th className="px-3 py-2">Quest</th>
                <th className="px-3 py-2">Fees</th>
                <th className="px-3 py-2 text-right">Charged</th>
                <th className="px-3 py-2 text-right">Refunded</th>
                <th className="px-3 py-2 text-right">Fees kept</th>
                <th className="px-3 py-2 text-right">PayPal</th>
                <th className="px-3 py-2 text-right">Net</th>
                <th className="px-3 py-2 text-right">Host</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((q) => (
                <tr key={q.id} className="border-b border-rule last:border-b-0">
                  <td className="px-3 py-2">
                    <Link href={`/q/${q.id}`} className="flex items-center gap-2 no-underline hover:underline">
                      <LineDot code={q.line_code} />
                      <span className="leading-tight">
                        <span className="block font-semibold">{q.title}</span>
                        <span className="text-[13px] text-muted">{q.code}, {STATUS[q.status] ?? q.status}, hosted by {q.host}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-[13px]">{feeTerms(q.fee_bps, q.fee_fixed_cents, q.host_fee_bps)}</td>
                  <td className="tab px-3 py-2 text-right">{money(q.gross_cents)}</td>
                  <td className="tab px-3 py-2 text-right text-muted">{q.refunded_cents ? money(q.refunded_cents) : "-"}</td>
                  <td className="tab px-3 py-2 text-right">{money(q.revenue_cents)}</td>
                  <td className="tab px-3 py-2 text-right text-muted">{money(q.paypal_fees_cents)}</td>
                  <td className={`tab px-3 py-2 text-right font-semibold ${q.net_revenue_cents < 0 ? "text-stamp" : "text-money"}`}>
                    {money(q.net_revenue_cents)}
                  </td>
                  <td className="px-3 py-2 text-right text-[13px] leading-tight">
                    <span className="tab block font-semibold">{money(q.host_due_cents)}</span>
                    <span className="text-muted">
                      {q.owed_back_cents ? `owes back ${money(q.owed_back_cents)}` : q.escrow_cents ? `${money(q.escrow_cents)} held` : "paid"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.fees_estimated && (
          <p className="text-[13px] text-muted">
            PayPal fees on simulated payments are estimated at PayPal&apos;s US rate (3.49% + $0.49, $0.25 per payout). Run
            &quot;Check with PayPal&quot; on the Payments tab to replace estimates with the fees PayPal reports.
          </p>
        )}
      </section>
    </div>
  );
}
