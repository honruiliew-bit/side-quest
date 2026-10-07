import { money } from "@/lib/format";
import type { QuestDetail } from "@/lib/types";

export function FareSplit({ q }: { q: QuestDetail }) {
  const live = Math.min(Math.max(q.headcount, q.min_people), q.max_people);
  const showTiers = q.price_table.length > 1;
  const tiers = q.price_table.length > 6
    ? [q.price_table[0], ...q.price_table.slice(1, -1).filter((t) => t.people === live), q.price_table[q.price_table.length - 1]]
    : q.price_table;
  return (
    <section aria-labelledby="split-h" className="flex flex-col gap-3">
      <h2 id="split-h" className="h2">How the fare is split</h2>
      <div className="overflow-x-auto">
        <table className="tab w-full border-collapse border-2 border-ink bg-stock text-[16px]">
          <caption className="sr-only">Costs collected up front</caption>
          <tbody>
            {q.cost_lines.map((l) => (
              <tr key={l.label} className="border-b border-rule last:border-0">
                <td className="px-4 py-3">{l.label}</td>
                <td className="px-4 py-3 text-muted">{l.split === "shared" ? "Split by the group" : "Each"}</td>
                <td className="px-4 py-3 text-right">{money(l.cents)}</td>
              </tr>
            ))}
            {q.fee_bps > 0 && (
              <tr className="border-t border-rule">
                <td className="px-4 py-3">Sidequest fee</td>
                <td className="px-4 py-3 text-muted">{(q.fee_bps / 100).toFixed(1)}% of each share</td>
                <td className="px-4 py-3 text-right" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {showTiers && (
        <div className="flex flex-wrap gap-3" role="list" aria-label="Share by group size">
          {tiers.map((t) => {
            const active = t.people === live;
            return (
              <div
                key={t.people}
                role="listitem"
                aria-current={active ? "true" : undefined}
                className={`tab min-w-[120px] rounded px-4 py-[10px] ${active ? "bg-ink text-signal" : "border-2 border-ink bg-stock"}`}
              >
                <div className="text-[13px]">{t.people} going</div>
                <div className="text-[24px] font-extrabold" style={{ fontStretch: "72%" }}>{money(t.cents)}</div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[14px] text-muted">
        Your hold is the {q.min_people}-person price, the most you can pay. When the quest locks you're charged the split for
        the real group, so the price only goes down.
      </p>
    </section>
  );
}
