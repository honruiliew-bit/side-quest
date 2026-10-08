import { money } from "@/lib/format";
import type { QuestDetail } from "@/lib/types";

/** The PayPal lifecycle drawn as a rail line: hold, it's on, charged, host paid. */
export function MoneyRoute({ q }: { q: QuestDetail }) {
  const cancelled = q.status === "cancelled";
  const stage = cancelled ? 1 : q.stage;
  const paidOut = q.money.paid_out_cents;
  const stations = [
    {
      title: "Holds placed",
      detail: cancelled
        ? "Every hold was released"
        : q.status === "open" || q.status === "on"
          ? `${q.headcount} holds, ${money(q.money.held_cents)} held by PayPal`
          : `${q.headcount} holds at ${money(q.hold_cents)}`,
      api: "Orders v2, intent AUTHORIZE",
    },
    {
      title: "It's on",
      detail: cancelled ? "Didn't reach the minimum" : stage >= 2 ? `Seat ${q.min_people} filled. It runs.` : `${q.min_people - q.headcount} more needed`,
      api: "Live split",
    },
    {
      title: "Everyone charged",
      detail: stage >= 3
        ? `${money(q.money.charged_cents - q.money.refunded_cents)} kept at ${money(q.share_cents)} each${q.money.refunded_cents ? `, ${money(q.money.refunded_cents)} refunded` : ""}`
        : "The final split, never more than you approved",
      api: "Capture authorization",
    },
    {
      title: "Host paid",
      detail: stage >= 4
        ? `${money(paidOut)} paid to ${q.host.name}`
        : q.payout?.paused_reason
          ? "Paused: a member reported a problem"
          : `${q.payout?.hold_hours ?? 24} hours after the trip, unless someone reports a problem`,
      api: "Payouts v1",
    },
  ];
  const fill = cancelled ? 0 : [0, 0, 33.3, 66.6, 100][stage] ?? 0;

  return (
    <section aria-labelledby="money-h" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="money-h" className="h2">Where the money is</h2>
        <span className="tab text-[16px] font-semibold text-money">
          {cancelled
            ? "Nothing charged"
            : stage >= 4
              ? `${money(paidOut)} paid to the host`
              : stage === 3
                ? `${money(q.money.charged_cents - q.money.refunded_cents)} charged`
                : `${money(q.money.held_cents)} held, $0.00 charged`}
        </span>
      </div>
      <div className="relative">
        <div aria-hidden="true" className="absolute hidden sm:block left-[12.5%] right-[12.5%] top-[14px] h-[6px] rounded bg-rule" />
        <div aria-hidden="true" className="route-fill absolute hidden sm:block left-[12.5%] top-[14px] h-[6px] rounded bg-money" style={{ width: `${fill * 0.75}%` }} />
        <ol className="relative grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-4">
          {stations.map((s, i) => {
            const done = !cancelled && i + 1 <= stage;
            const current = !cancelled && i + 1 === stage;
            return (
              <li key={s.title} className="flex flex-col items-center gap-2 text-center" aria-current={current ? "step" : undefined}>
                <span
                  className="block rounded-full transition-colors duration-200"
                  style={{
                    width: current ? 34 : 26,
                    height: current ? 34 : 26,
                    marginTop: current ? 0 : 4,
                    background: done ? "var(--money)" : "var(--stock)",
                    border: done ? "5px solid var(--ink)" : "4px solid var(--dash)",
                  }}
                />
                <span className="text-[16px] font-bold">{s.title}</span>
                <span className="tab max-w-[24ch] text-[14px] text-muted">{s.detail}</span>
                <span className="text-[12px] font-semibold text-money/80">{s.api}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="text-[13px] text-muted">
        PayPal holds last up to 29 days. If a quest locks more than 3 days after someone joined, Sidequest reauthorizes
        that hold before charging it.
      </p>
    </section>
  );
}
