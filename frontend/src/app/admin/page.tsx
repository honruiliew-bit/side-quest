"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { AuditTab } from "@/admin/AuditTab";
import { CasesTab } from "@/admin/CasesTab";
import { FeesTab } from "@/admin/FeesTab";
import { MoneyTab } from "@/admin/MoneyTab";
import { Tile, pct } from "@/admin/parts";
import type { Overview } from "@/admin/types";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";

// AG Grid only loads when the Payments tab opens.
const PaymentsTab = dynamic(() => import("@/admin/PaymentsTab").then((m) => m.PaymentsTab), {
  ssr: false,
  loading: () => <div className="skeleton h-[400px]" />,
});

const TABS = [
  { id: "cases", label: "Cases" },
  { id: "money", label: "Money" },
  { id: "payments", label: "Payments" },
  { id: "fees", label: "Fees" },
  { id: "audit", label: "Audit log" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export default function Admin() {
  const { user, ready, signInAs, toast, config } = useSession();
  const [tab, setTab] = useState<Tab>("cases");
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1) as Tab;
    if (TABS.some((t) => t.id === fromHash)) setTab(fromHash);
  }, []);

  const load = useCallback(() => {
    api<Overview>("/admin/overview").then(setData).catch((e) => toast(e.message, "error"));
  }, [toast]);

  useEffect(() => {
    if (ready && user?.is_admin) load();
  }, [ready, user, load]);

  const pick = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", `#${t}`);
  };

  if (ready && !user?.is_admin) {
    return (
      <main className="mx-auto flex max-w-page flex-col gap-4 px-4 py-16 sm:px-10">
        <h1 className="display text-[52px]">Admin</h1>
        <p className="max-w-[560px] text-[17px]">
          This is where Sidequest staff decide reports, audit payments against PayPal and set fees. Hosts and members can&apos;t open it.
        </p>
        {config?.demo_mode && (
          <div>
            <button className="btn btn-ink" onClick={async () => { await signInAs("kai"); toast("You're now Kai, a Sidequest admin."); }}>
              Switch to Kai, the demo admin
            </button>
          </div>
        )}
      </main>
    );
  }

  const t = data?.totals;
  return (
    <>
      <section className="platform">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-wrap items-end justify-between gap-6 px-4 pb-8 pt-10 sm:px-10">
          <div className="max-w-[560px]">
            <h1 className="display text-[52px] sm:text-[68px]">Admin</h1>
            <p className="mt-3 text-[17px]">Reports, payments and fees. Hosts never decide their own reports. Every decision here is logged.</p>
          </div>
          {t && (
            <div className="grid grid-cols-3 gap-3">
              <Tile label="Open cases" value={String(data.open_cases)} tone={data.open_cases ? "stamp" : "ink"} />
              <Tile label="Held for hosts" value={money(t.escrow_cents)} />
              <Tile label="Net revenue" value={money(t.net_revenue_cents)} tone="money" note={`${pct(t.take_rate_bps)} take`} />
            </div>
          )}
        </div>
      </section>

      <div className="sticky top-0 z-30 border-b-2 border-ink bg-paper">
        <nav aria-label="Admin sections" className="mx-auto flex max-w-page gap-1 overflow-x-auto px-4 sm:px-10">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => pick(x.id)}
              aria-current={tab === x.id ? "page" : undefined}
              className={`relative min-h-[48px] whitespace-nowrap px-4 text-[15px] font-semibold ${tab === x.id ? "text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-[4px] after:bg-ink" : "text-muted hover:text-ink"}`}
            >
              {x.label}
              {x.id === "cases" && data?.open_cases ? <span className="ml-2 rounded-full bg-stamp px-2 py-[1px] text-[12px] text-white">{data.open_cases}</span> : null}
              {x.id === "payments" && data?.recon_issues ? <span className="ml-2 rounded-full bg-stamp px-2 py-[1px] text-[12px] text-white">{data.recon_issues}</span> : null}
            </button>
          ))}
        </nav>
      </div>

      <main className="mx-auto max-w-page px-4 pt-8 sm:px-10">
        {!ready || (user?.is_admin && !data && tab === "money") ? (
          <div className="skeleton h-[400px]" />
        ) : tab === "cases" ? (
          <CasesTab onChanged={load} />
        ) : tab === "money" ? (
          data && <MoneyTab data={data} />
        ) : tab === "payments" ? (
          <PaymentsTab onChanged={load} />
        ) : tab === "fees" ? (
          <FeesTab onChanged={load} />
        ) : (
          <AuditTab />
        )}
      </main>
    </>
  );
}
