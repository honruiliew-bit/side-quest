"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LedgerRow } from "@/components/LedgerGrid";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";

const LedgerGrid = dynamic(() => import("@/components/LedgerGrid").then((m) => m.LedgerGrid), {
  ssr: false,
  loading: () => <div className="h-[420px] border-2 border-ink bg-stock" aria-busy="true" />,
});

export default function Books() {
  const { user, ready, config, toast } = useSession();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [showTour, setShowTour] = useState(false);

  useEffect(() => {
    if (!ready || !user) return;
    setRows(null);
    api<LedgerRow[]>("/me/ledger").then(setRows).catch((e) => toast(e.message, "error"));
  }, [ready, user, toast]);

  const visible = useMemo(() => (rows ?? []).filter((r) => showTour || !r.quest?.tour), [rows, showTour]);
  const hasTour = (rows ?? []).some((r) => r.quest?.tour);

  const sum = (k: string, pred: (r: LedgerRow) => boolean = () => true) =>
    visible.filter((r) => r.kind === k && pred(r)).reduce((a, r) => a + r.cents, 0);
  const charged = sum("charge");
  const refunded = sum("refund");
  const paidOut = sum("payout", (r) => r.quest?.role === "host");
  const hosting = visible.some((r) => r.quest?.role === "host");

  return (
    <>
      <section className="platform">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-wrap items-end justify-between gap-6 px-4 pb-12 pt-10 sm:px-10">
          <div className="max-w-[560px]">
            <h1 className="display text-[52px] sm:text-[68px]">Books</h1>
            <p className="mt-3 text-[17px]">
              Every PayPal hold, charge, refund, invoice and payout on your quests, with the PayPal ID that proves it.
              {hosting ? " As a host you see every traveler on your quests." : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-4">
            <Stat label="Charged" value={money(charged)} />
            <Stat label="Refunded" value={money(refunded)} />
            {hosting && <Stat label="Paid out to you" value={money(paidOut)} />}
          </div>
        </div>
      </section>
      <main className="mx-auto flex max-w-page flex-col gap-6 px-4 pt-12 sm:px-10">
        {!user && <p className="text-[17px]">Pick who you are in the top right to see your books.</p>}
        {user && rows === null && <div className="h-[420px] border-2 border-ink bg-stock" aria-busy="true" />}
        {user && rows && rows.length === 0 && (
          <div className="panel flex flex-wrap items-center justify-between gap-4 p-6">
            <span className="text-[16px]">No PayPal activity yet. Hold a spot and it shows up here.</span>
            <Link href="/" className="btn btn-ink">See departures</Link>
          </div>
        )}
        {user && rows && rows.length > 0 && (
          <>
            {hasTour && (
              <label className="flex items-center gap-2 text-[15px]">
                <input type="checkbox" checked={showTour} onChange={(e) => setShowTour(e.target.checked)} />
                Include my tour quest
              </label>
            )}
            <LedgerGrid
              rows={visible}
              paypalMode={config?.paypal_mode ?? "mock"}
              showQuest
              pageSize={25}
              fileName={`sidequest-books-${user.name.toLowerCase().replace(/\W+/g, "-")}`}
            />
          </>
        )}
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ticket min-w-[170px] px-5 py-4">
      <div className="label">{label}</div>
      <div className="tab text-[36px] font-extrabold leading-none text-money" style={{ fontStretch: "62%" }}>{value}</div>
    </div>
  );
}
