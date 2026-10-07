"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { sampleReceipt } from "@/lib/sampleReceipt";
import type { Membership, QuestDetail } from "@/lib/types";
import { uploadReceipt } from "./Receipts";

type Step = {
  id: string;
  who: string;
  title: string;
  body: string;
  done: boolean;
  action?: string;
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

/** The guided demo. Each judge gets a private quest and walks the whole PayPal lifecycle in seven clicks. */
export function TourPanel({ q, onChange }: { q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const { user, config, signInAs, toast } = useSession();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const everyone: Membership[] = [
    ...q.seats.flatMap((s) => (s.member ? [s.member] : [])),
    ...q.standby,
  ];
  const leoIn = q.ledger.some((e) => e.kind === "hold" && e.user?.persona === "leo");
  const dev = q.ledger.some((e) => e.kind === "refund" && e.user?.persona === "dev");
  const swapPending = q.proposals.find(
    (p) => p.status === "pending" && p.actions.some((a) => a.type === "refund" && a.name === "Dev"),
  );
  const settlePending = q.proposals.find((p) => p.status === "pending" && p.actions.some((a) => a.type === "invoice"));
  const invoiced = q.ledger.some((e) => e.kind === "invoice");
  const hasReceipt = q.receipts.some((r) => r.status !== "removed" && r.status !== "rejected");
  const filled = q.standby.length > 0 || q.stage >= 3;
  const room = q.max_people - everyone.filter((m) => m.status === "held").length;

  const post = async (path: string, json?: unknown) => {
    const res = await api<QuestDetail | { quest: QuestDetail }>(path, { method: "POST", json });
    onChange("quest" in res ? res.quest : res);
  };

  const steps: Step[] = [
    {
      id: "hold", who: "leo", title: "Hold your spot",
      body: `You're Leo. Four of five people are in. Click the blue PayPal button on the ticket and approve the ${money(q.hold_cents)} hold. Seat 5 fills and the quest tips.`,
      done: leoIn, target: "quest-title",
    },
    {
      id: "fill", who: "any", title: "Fill the van",
      body: `Add ${Math.max(room, 0)} more people plus one on standby. Everyone's share drops as seats fill.`,
      done: filled, action: "Fill the van", target: "seats-h",
      run: () => post(`/demo/quests/${q.id}/crowd`, { count: Math.max(room, 0) + 1 }),
    },
    {
      id: "lock", who: "hon", title: "Lock and charge",
      body: "As Hon, the host, lock the quest. PayPal captures every hold at the final split, never above what anyone approved.",
      done: q.stage >= 3, action: "Lock and charge everyone", target: "money-h",
      run: () => post(`/quests/${q.id}/lock`),
    },
    {
      id: "drop", who: "dev", title: "Drop out after paying",
      body: "As Dev, tell the agent you can't make it. It can't move money itself, so it asks the host to approve a swap.",
      done: dev || !!swapPending, action: "Tell the agent", target: "agent-h",
      run: () => post(`/quests/${q.id}/chat`, { text: "I'm sick, I can't make it Saturday anymore." }),
    },
    {
      id: "swap", who: "hon", title: "Approve the swap",
      body: "As Hon, read exactly what will run on PayPal: capture the standby hold, refund Dev. Then approve it.",
      done: dev, action: "Approve the swap", target: "seats-h",
      run: async () => {
        if (swapPending) await post(`/proposals/${swapPending.id}/decide`, { approve: true });
      },
    },
    {
      id: "settle", who: "hon", title: "Settle up with receipts",
      body: settlePending
        ? "Check the receipt on the card, then approve. Each person gets a PayPal invoice with the receipt linked, sent through the Agent Toolkit."
        : hasReceipt
          ? "Draft the settle up from the receipt. Lines with receipts use the real cost, the rest keep their estimate."
          : "Gas came in over the estimate. Add the sample gas receipt and Claude reads it: merchant, date, total, and which cost it covers.",
      done: invoiced,
      action: settlePending ? "Approve the invoices" : hasReceipt ? "Draft the settle up" : "Add the sample receipt",
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
      id: "payout", who: "any", title: "Pay the host",
      body: `For real, the payout releases on its own ${q.payout?.hold_hours ?? 24} hours after the trip. Any member who paid can report a problem to pause it. The demo skips the wait, not the checks.`,
      done: q.status === "completed", action: "Skip the wait and pay out", target: "money-h",
      run: () => post(`/demo/quests/${q.id}/payout`),
    },
  ];

  const current = steps.find((s) => !s.done);
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

  return (
    <div className="fixed bottom-4 left-4 z-40 w-[340px] max-w-[calc(100vw-32px)]">
      <section className="toast flex max-h-[calc(100dvh-120px)] flex-col overflow-hidden rounded-md border-2 border-ink bg-stock shadow-[0_6px_0_var(--ink)]" aria-label="Guided demo">
        <div className="flex items-center justify-between gap-3 bg-ink px-4 py-3 text-stock">
          <div>
            <div className="font-bold">Guided demo</div>
            <div className="text-[12px] text-stock/70">{doneCount} of {steps.length} done. This quest is your private copy.</div>
          </div>
          <button className="min-h-[36px] px-2 text-[14px] underline" onClick={() => setOpen(false)}>Hide</button>
        </div>
        <div className="h-[6px] bg-rule">
          <div className="route-fill h-full bg-money" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
        <ol className="flex flex-col gap-1 overflow-y-auto p-3">
          {steps.map((s, i) => {
            const isCurrent = current?.id === s.id;
            return (
              <li key={s.id} className={`rounded p-2 ${isCurrent ? "bg-white ring-2 ring-ink" : ""}`} aria-current={isCurrent ? "step" : undefined}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-[1px] grid h-6 w-6 flex-none place-items-center rounded-full text-[12px] font-black ${
                      s.done ? "bg-money text-white" : isCurrent ? "bg-ink text-signal" : "border-2 border-dash text-muted"
                    }`}
                    style={{ fontStretch: "70%" }}
                  >
                    {s.done ? "✓" : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[15px] font-bold ${s.done ? "text-muted line-through decoration-1" : ""}`}>
                      {s.title}
                      {s.who !== "any" && <span className="ml-2 text-[12px] font-semibold text-muted no-underline">as {NAMES[s.who]}</span>}
                    </div>
                    {isCurrent && (
                      <div className="mt-1 flex flex-col gap-2">
                        <p className="text-[14px] leading-relaxed">{s.body}</p>
                        {s.id === "hold" && config?.demo_buyer && (
                          <div className="rounded border border-rule bg-paper p-2 text-[13px]">
                            <div className="font-semibold">PayPal sandbox buyer</div>
                            <div className="break-all">{config.demo_buyer.email}</div>
                            <div>Password: {config.demo_buyer.password}</div>
                            <div className="mt-1 text-muted">Pay with the card or balance. Skip Pay in 4.</div>
                          </div>
                        )}
                        {s.id === "hold" && config?.paypal_mode === "mock" && (
                          <p className="text-[13px] text-muted">Approve in the mock PayPal window.</p>
                        )}
                        <button className="btn btn-ink btn-sm" disabled={busy} onClick={() => go(s)}>
                          {busy
                            ? "Working"
                            : s.who !== "any" && user?.persona !== s.who
                              ? `Switch to ${NAMES[s.who]}${s.action ? ` and ${s.action.toLowerCase()}` : ""}`
                              : s.action ?? "Show me"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {!current && (
            <li className="rounded bg-white p-3 text-[14px] leading-relaxed ring-2 ring-money">
              <strong>That's the whole lifecycle.</strong> Hold, tip, capture, swap with a refund, invoices and a payout.
              Every step is in the money log with its PayPal ID.
              <button className="btn btn-ghost btn-sm mt-3 w-full" onClick={() => scrollTo("ledger-h")}>See the money log</button>
            </li>
          )}
        </ol>
      </section>
    </div>
  );
}
