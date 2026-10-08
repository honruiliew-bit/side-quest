"use client";

import dynamic from "next/dynamic";
import type { QuestDetail } from "@/lib/types";

// AG Grid measures the DOM, so it renders in the browser only.
const LedgerGrid = dynamic(() => import("./LedgerGrid").then((m) => m.LedgerGrid), {
  ssr: false,
  loading: () => <div className="h-[200px] border-2 border-ink bg-stock" aria-busy="true" />,
});

export function MoneyLog({ q }: { q: QuestDetail }) {
  if (q.ledger.length === 0) return null;
  return (
    <section aria-labelledby="ledger-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="ledger-h" className="h2">Money log</h2>
        <span className="text-[14px] text-muted">Every PayPal call behind this quest</span>
      </div>
      <LedgerGrid rows={q.ledger} paypalMode={q.paypal_mode} tz={q.tz} fileName={`sidequest-${q.line_code}-money-log`} />
    </section>
  );
}
