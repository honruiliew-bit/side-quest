"use client";

import { useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { AuditRow } from "./types";

const ACTION: Record<string, string> = {
  case_opened: "Report opened",
  host_reply: "Host replied",
  case_withdrawn: "Report withdrawn",
  case_review: "Claude reviewed",
  case_resolved: "Case decided",
  payout_released: "Payout released early",
  dispute_opened: "PayPal dispute",
  dispute_sync: "Checked PayPal disputes",
  fee_change: "Fees changed",
  reconcile: "Checked with PayPal",
};

const FILTERS = [
  { id: "all", label: "All", actions: null },
  { id: "decisions", label: "Decisions", actions: ["case_resolved", "payout_released", "fee_change"] },
  { id: "cases", label: "Reports", actions: ["case_opened", "host_reply", "case_withdrawn", "case_review", "dispute_opened"] },
  { id: "paypal", label: "PayPal checks", actions: ["reconcile", "dispute_sync"] },
];

export function AuditTab() {
  const { toast } = useSession();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    api<AuditRow[]>("/admin/audit").then(setRows).catch((e) => toast(e.message, "error"));
  }, [toast]);

  const actions = FILTERS.find((f) => f.id === filter)?.actions ?? null;
  const shown = (rows ?? []).filter((r) => !actions || actions.includes(r.action));

  return (
    <section className="flex flex-col gap-4" aria-labelledby="audit-h">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-[620px]">
          <h2 id="audit-h" className="h2">Audit log</h2>
          <p className="text-[14px] text-muted">Every staff action and every decision that changes who gets paid. Entries can&apos;t be edited.</p>
        </div>
        <div role="group" aria-label="Filter the log" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
              className={`border-2 border-ink px-3 py-1 text-[14px] font-semibold ${filter === f.id ? "bg-ink text-stock" : "bg-stock hover:bg-white"}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {rows === null ? (
        <div className="skeleton h-[300px]" />
      ) : (
        <ol className="flex flex-col border-2 border-ink bg-stock">
          {shown.map((r) => (
            <li key={r.id} className="grid gap-x-4 gap-y-1 border-b border-rule px-4 py-3 last:border-b-0 sm:grid-cols-[150px_150px_minmax(0,1fr)]">
              <time className="text-[13px] text-muted" dateTime={r.created_at}>
                {new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </time>
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                {r.actor ? <Avatar user={r.actor} size={22} /> : <span aria-hidden="true" className="grid h-[22px] w-[22px] place-items-center rounded-full bg-money text-[10px] font-black text-white">PP</span>}
                {r.actor?.name ?? "PayPal"}
              </span>
              <span className="text-[14px]">
                <span className="font-bold">{ACTION[r.action] ?? r.action}.</span> {r.summary}
              </span>
            </li>
          ))}
          {shown.length === 0 && <li className="px-4 py-6 text-[15px] text-muted">Nothing here yet.</li>}
        </ol>
      )}
    </section>
  );
}
