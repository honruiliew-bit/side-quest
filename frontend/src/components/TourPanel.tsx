"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { sampleReceipt } from "@/lib/sampleReceipt";
import type { QuestDetail } from "@/lib/types";
import { uploadReceipt } from "./Receipts";

type Step = {
  id: string;
  who: "leo" | "hon" | "dev" | "any";
  title: string;
  body: string;
  done: boolean;
  action: string;
  run?: () => Promise<void>;
  target: string;
};

const NAMES: Record<string, string> = { leo: "Leo", hon: "Hon", dev: "Dev" };

function scrollTo(id: string) {
  window.setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 90;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  }, 120);
}

/** The guided demo: a private quest and the whole PayPal lifecycle in five clicks.
 *  Docked at the bottom so it never covers the ticket or the PayPal button. */
export function TourPanel({ q, onChange }: { q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const { user, config, signInAs, toast } = useSession();
  const [open, setOpen] = useState(true);
  const [list, setList] = useState(false);
  const [busy, setBusy] = useState(false);

  // Lets Scout move up out of the bar's way on narrow screens.
  useEffect(() => {
    document.body.dataset.tour = open ? "on" : "";
    return () => {
      document.body.dataset.tour = "";
    };
  }, [open]);

  const held = [...q.seats.flatMap((s) => (s.member ? [s.member] : [])), ...q.standby].filter((m) => m.status === "held");
  const leoIn = q.ledger.some((e) => e.kind === "hold" && e.user?.persona === "leo");
  const devRefunded = q.ledger.some((e) => e.kind === "refund" && e.user?.persona === "dev");
  const swapPending = q.proposals.find(
    (p) => p.status === "pending" && p.actions.some((a) => a.type === "refund" && a.name === "Dev"),
  );
  const settlePending = q.proposals.find((p) => p.status === "pending" && p.actions.some((a) => a.type === "invoice"));
  const invoiced = q.ledger.some((e) => e.kind === "invoice");
  const hasReceipt = q.receipts.some((r) => r.status !== "removed" && r.status !== "rejected");
  const filled = q.standby.length > 0 || q.stage >= 3;
  const room = Math.max(q.max_people - held.length, 0);

  const post = async (path: string, json?: unknown) => {
    const res = await api<QuestDetail | { quest: QuestDetail }>(path, { method: "POST", json });
    const next = "quest" in res ? res.quest : res;
    onChange(next);
    return next;
  };

  const steps: Step[] = [
    {
      id: "hold", who: "leo", title: "Hold your spot",
      body: `Four of five are in. Approve a ${money(q.hold_cents)} hold on PayPal. You're not charged, and seat 5 makes the quest run.`,
      done: leoIn, action: "Show me the PayPal button", target: "hold-spot",
    },
    {
      id: "lock", who: "hon", title: "It's on: lock and charge",
      body: "More people join, so everyone's share drops. The host locks the quest and PayPal charges each person the final split, never more than they approved.",
      done: q.stage >= 3, action: "Fill the van and lock", target: "money-h",
      run: async () => {
        if (!filled) await post(`/demo/quests/${q.id}/crowd`, { count: room + 1 });
        await post(`/quests/${q.id}/lock`);
      },
    },
    swapPending
      ? {
          id: "swap", who: "hon", title: "Someone drops out",
          body: "Claude can't move money, so it asked the host. The card shows exactly what PayPal will do: charge the standby, refund Dev.",
          done: devRefunded, action: "Approve the swap", target: "agent-h",
          run: async () => {
            await post(`/proposals/${swapPending.id}/decide`, { approve: true });
          },
        }
      : {
          id: "swap", who: "dev", title: "Someone drops out",
          body: "Dev already paid and gets sick. He tells the group chat. Watch what Claude does with that.",
          done: devRefunded, action: "Tell the group I'm out", target: "agent-h",
          run: async () => {
            await post(`/quests/${q.id}/chat`, { text: "I'm sick, I can't make it Saturday anymore." });
          },
        },
    {
      id: "settle", who: "hon", title: "Settle up from a receipt",
      body: settlePending
        ? "Check the receipt on the card, then approve. Everyone gets a PayPal invoice for their share, with the receipt linked."
        : hasReceipt
          ? "Claude read the receipt. Draft the settle up: lines with receipts use the real cost."
          : "Gas came in over the estimate. Add the receipt and Claude reads it: merchant, date, total and which cost it covers.",
      done: invoiced,
      action: settlePending ? "Approve the invoices" : hasReceipt ? "Draft the settle up" : "Add the gas receipt",
      target: "agent-h",
      run: async () => {
        if (settlePending) await post(`/proposals/${settlePending.id}/decide`, { approve: true });
        else if (hasReceipt) await post(`/quests/${q.id}/settle`, {});
        else {
          const blob = await sampleReceipt(q.starts_at, q.tz);
          const res = await uploadReceipt(q.id, blob, "sample-gas-receipt.png", { total_cents: 9500, cost_line: "Gas and tolls" });
          onChange(res.quest);
        }
      },
    },
    {
      id: "payout", who: "any", title: "The host gets paid",
      body: `Normally this happens ${q.payout?.hold_hours ?? 24} hours after the trip, unless someone reports a problem. The demo skips the wait, not the checks.`,
      done: q.status === "completed", action: "Pay the host now", target: "money-h",
      run: async () => {
        await post(`/demo/quests/${q.id}/payout`);
      },
    },
  ];

  const current = steps.find((s) => !s.done);
  const index = current ? steps.indexOf(current) : steps.length;
  const doneCount = steps.filter((s) => s.done).length;

  const go = async (s: Step) => {
    setBusy(true);
    try {
      if (s.who !== "any" && user?.persona !== s.who) {
        await signInAs(s.who);
        toast(`You're now ${NAMES[s.who]}.`);
      }
      if (s.run) await s.run();
      scrollTo(s.target);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That step didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="fixed bottom-4 left-4 z-40">
        <button className="btn btn-ink btn-sm shadow-[0_4px_0_var(--signal)]" onClick={() => setOpen(true)}>
          Guided demo {doneCount}/{steps.length}
        </button>
      </div>
    );
  }

  const label = (s: Step) =>
    s.who !== "any" && user?.persona !== s.who ? `Be ${NAMES[s.who]}: ${s.action.toLowerCase()}` : s.action;

  return (
    <>
      {/* Room at the bottom of the page so the bar never hides the last section. */}
      <div aria-hidden="true" className="h-[220px] sm:h-[180px]" />
      <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3 sm:px-4 sm:pb-4">
        <section
          aria-label="Guided demo"
          className="toast mx-auto w-full max-w-[780px] overflow-hidden rounded-md border-2 border-ink bg-stock shadow-[0_6px_0_var(--ink)]"
        >
          <div className="flex items-center gap-3 bg-ink px-4 py-2 text-stock">
            <span className="text-[13px] font-bold">Guided demo</span>
            <div className="flex flex-1 gap-1" aria-label={`${doneCount} of ${steps.length} done`}>
              {steps.map((s, i) => (
                <span key={s.id} className={`h-[6px] flex-1 rounded-full ${s.done ? "bg-signal" : i === index ? "bg-stock" : "bg-stock/25"}`} />
              ))}
            </div>
            <button className="min-h-[32px] px-1 text-[13px] underline" onClick={() => setList((v) => !v)} aria-expanded={list}>
              {list ? "Close steps" : "All steps"}
            </button>
            <button className="min-h-[32px] px-1 text-[13px] underline" onClick={() => setOpen(false)}>Hide</button>
          </div>

          {list && (
            <ol className="grid gap-1 border-b-2 border-ink bg-paper px-4 py-3 sm:grid-cols-5">
              {steps.map((s, i) => (
                <li key={s.id} className={`flex items-center gap-2 text-[13px] ${s.done ? "text-muted line-through" : i === index ? "font-bold" : ""}`}>
                  <span className={`grid h-5 w-5 flex-none place-items-center rounded-full text-[11px] font-black ${s.done ? "bg-money text-white" : i === index ? "bg-ink text-signal" : "border-2 border-dash text-muted"}`}>
                    {s.done ? "✓" : i + 1}
                  </span>
                  {s.title}
                </li>
              ))}
            </ol>
          )}

          {current ? (
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold">
                  <span className="text-muted">Step {index + 1} of {steps.length}.</span> {current.title}
                  {current.who !== "any" && <span className="ml-2 text-[12px] font-semibold text-muted">as {NAMES[current.who]}</span>}
                </div>
                <p className="mt-1 text-[14px] leading-snug">{current.body}</p>
                {current.id === "hold" && config?.demo_buyer && (
                  <p className="mt-1 text-[12px] text-muted">
                    PayPal sandbox login: <span className="font-semibold text-ink">{config.demo_buyer.email}</span> / {config.demo_buyer.password}. Pay with balance or card, not Pay in 4.
                  </p>
                )}
              </div>
              <button className="btn btn-ink shrink-0" disabled={busy} onClick={() => go(current)}>
                {busy ? "Working..." : label(current)}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
              <p className="flex-1 text-[14px] leading-snug">
                <strong>That's the whole thing.</strong> A hold, a charge at the real split, a refund for a dropout, invoices from a receipt and a payout. Every step is in the money log with its PayPal ID.
              </p>
              <button className="btn btn-ghost shrink-0" onClick={() => scrollTo("ledger-h")}>See the money log</button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
