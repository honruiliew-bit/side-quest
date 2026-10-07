import { money, timeAgo } from "@/lib/format";
import type { LedgerEntry, QuestDetail } from "@/lib/types";

const EVENT: Record<LedgerEntry["kind"], string> = {
  hold: "Hold placed",
  release: "Hold released",
  charge: "Charged",
  refund: "Refunded",
  payout: "Paid out to host",
  invoice: "Invoice sent",
  reauthorize: "Hold renewed",
  decline: "Declined",
};

const API: Record<LedgerEntry["kind"], string> = {
  hold: "Orders v2 authorize",
  release: "Void authorization",
  charge: "Capture authorization",
  refund: "Refund capture",
  payout: "Payouts v1",
  invoice: "Agent Toolkit invoice",
  reauthorize: "Reauthorize",
  decline: "PayPal error",
};

export function MoneyLog({ q }: { q: QuestDetail }) {
  if (q.ledger.length === 0) return null;
  return (
    <section aria-labelledby="ledger-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="ledger-h" className="h2">Money log</h2>
        <span className="text-[14px] text-muted">Every PayPal call behind this quest</span>
      </div>
      <div className="overflow-x-auto border-2 border-ink bg-stock">
        <table className="tab w-full min-w-[720px] border-collapse text-[15px]">
          <thead>
            <tr className="border-b-2 border-ink text-left">
              <th className="px-4 py-[10px] font-bold">Time</th>
              <th className="px-4 py-[10px] font-bold">Who</th>
              <th className="px-4 py-[10px] font-bold">Event</th>
              <th className="px-4 py-[10px] text-right font-bold">Amount</th>
              <th className="px-4 py-[10px] font-bold">PayPal</th>
            </tr>
          </thead>
          <tbody>
            {q.ledger.map((e) => (
              <tr key={e.id} className="border-b border-rule last:border-0">
                <td className="whitespace-nowrap px-4 py-[10px]">{timeAgo(e.created_at, q.tz)}</td>
                <td className="px-4 py-[10px]">{e.user?.name ?? "Sidequest"}</td>
                <td className="px-4 py-[10px]">
                  {EVENT[e.kind]}
                  {e.note && e.kind !== "hold" && <span className="block text-[13px] text-muted">{e.note}</span>}
                </td>
                <td className={`px-4 py-[10px] text-right font-semibold ${e.kind === "release" || e.kind === "decline" ? "text-muted" : "text-money"}`}>
                  {e.kind === "refund" ? `-${money(e.cents)}` : money(e.cents)}
                </td>
                <td className="px-4 py-[10px]">
                  <span className="block text-[13px]">{API[e.kind]}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-muted">{e.ref ?? ""}</span>
                    {e.provider === "sim" ? (
                      <span className="chip chip-sim">Simulated</span>
                    ) : q.paypal_mode === "mock" ? (
                      <span className="chip chip-sim">Mock</span>
                    ) : (
                      <span className="chip chip-held">Sandbox</span>
                    )}
                    {e.confirmed && <span className="chip chip-held">Webhook confirmed</span>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
