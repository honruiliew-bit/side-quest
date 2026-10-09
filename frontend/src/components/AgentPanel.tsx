"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { money, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { ChatMessage, Proposal, ProposalAction, QuestDetail } from "@/lib/types";
import { Avatar } from "./Avatar";
import { ReceiptCard, SettleUp } from "./Receipts";

const TOOL_LABEL: Record<string, string> = {
  get_quest_state: "Read the quest",
  price_for: "Priced the split",
  leave_quest: "Handled leaving",
  propose_money_actions: "Sent to the host",
  add_stop_note: "Updated the plan",
  report_problem: "Sent to a Sidequest admin",
  paypal_get_order_details: "PayPal Agent Toolkit: get_order_details",
  paypal_get_invoice: "PayPal Agent Toolkit: get_invoice",
};

function opLine(a: ProposalAction, locked: boolean): string {
  // Plain words first, the PayPal call in brackets for anyone checking.
  switch (a.type) {
    case "void_hold":
      return `Release ${a.name}'s ${money(a.cents)} hold. They pay nothing. (PayPal void ${a.ref ?? ""})`;
    case "promote":
      return locked
        ? `Charge ${a.name} ${money(a.cents)} from their standby hold. (PayPal capture ${a.ref ?? ""})`
        : `Move ${a.name} from standby into a seat. Their hold stays.`;
    case "refund":
      return `Refund ${a.name} ${money(a.cents)}. (PayPal refund ${a.ref ?? ""})`;
    case "invoice":
      return `Send ${a.name} a PayPal invoice for ${money(a.cents)}, receipts linked. (Agent Toolkit)`;
  }
}

export function AgentPanel({ q, onChange }: { q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const { user, config, toast } = useSession();
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const isHost = q.viewer.role === "host";
  const pending = q.proposals.filter((p) => p.status === "pending");
  const decided = q.proposals.filter((p) => p.status !== "pending").slice(0, 3);
  const msgs = q.messages.slice(-40);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [msgs.length, thinking]);

  const send = async (value: string) => {
    const t = value.trim();
    if (!t || thinking) return;
    setText("");
    setOptimistic(t);
    setThinking(true);
    try {
      const res = await api<{ quest: QuestDetail }>(`/quests/${q.id}/chat`, { method: "POST", json: { text: t } });
      onChange(res.quest);
    } catch (e) {
      toast(e instanceof Error ? e.message : "The agent didn't answer. Try again.", "error");
      setText(t);
    } finally {
      setOptimistic(null);
      setThinking(false);
    }
  };

  const decide = async (p: Proposal, approve: boolean) => {
    if (deciding) return;
    setDeciding(p.id);
    try {
      const detail = await api<QuestDetail>(`/proposals/${p.id}/decide`, { method: "POST", json: { approve } });
      onChange(detail);
      const after = detail.proposals.find((x) => x.id === p.id);
      if (after?.status === "failed") toast(after.result?.error ?? "Stopped partway.", "error");
      else toast(approve ? "Approved. Done on PayPal." : "Declined.", approve ? "money" : "info");
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setDeciding(null);
    }
  };

  const suggestions = isHost
    ? q.status === "locked"
      ? ["Who still owes anything?", "What did everyone pay?"]
      : ["Who's going?", "What happens if someone drops?"]
    : q.viewer.membership
      ? ["What's my share now?", "What should I bring?", "I can't make it anymore"]
      : ["How much would I pay?", "Who's going?", "Where do we meet?"];

  return (
    <aside aria-labelledby="agent-h" className="panel flex min-w-0 flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="agent-h" className="h3">Quest agent</h2>
        <span className="rounded-full border border-rule px-2 py-[2px] text-[12px] font-semibold text-muted">
          {config?.ai === "claude" ? "Claude" : "Offline mode"}
        </span>
      </div>

      {pending.map((p) => (
        <div key={p.id} className="overflow-hidden rounded border-2 border-ink">
          <div className="bg-signal px-4 py-2 font-bold">{isHost ? "Needs your approval" : `Waiting on ${q.host.name}`}</div>
          <div className="flex flex-col gap-3 bg-white p-4">
            <div className="font-bold">{p.title}</div>
            <p className="text-[15px] leading-relaxed">{p.rationale}</p>
            {p.evidence.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="label">Receipts behind this</div>
                {p.evidence.map((r) => <ReceiptCard key={r.id} r={r} />)}
              </div>
            )}
            <div>
              <div className="label mb-1">Exactly what runs on PayPal</div>
              <ol className="tab list-decimal pl-5 text-[14px] leading-relaxed">
                {p.actions.map((a, i) => (
                  <li key={i}>
                    {opLine(a, q.status === "locked" || q.status === "completed")}
                  </li>
                ))}
              </ol>
            </div>
            {isHost && (
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-ink btn-sm" disabled={!!deciding} onClick={() => decide(p, true)}>
                  {deciding === p.id ? "Running on PayPal" : "Approve and run"}
                </button>
                <button className="btn btn-ghost btn-sm" disabled={!!deciding} onClick={() => decide(p, false)}>Decline</button>
              </div>
            )}
          </div>
        </div>
      ))}

      <div ref={box} className="flex max-h-[420px] min-h-[200px] flex-col gap-3 overflow-y-auto pr-1" aria-live="polite">
        {msgs.length === 0 && !optimistic && (
          <p className="text-[15px] text-muted">Ask about the plan, the split, or your hold. The agent can also take you off the quest.</p>
        )}
        {msgs.map((m) => (
          <Bubble key={m.id} m={m} tz={q.tz} me={user?.id} />
        ))}
        {optimistic && user && (
          <Bubble m={{ id: "opt", role: "user", body: optimistic, user, meta: {}, created_at: new Date().toISOString() }} tz={q.tz} me={user.id} />
        )}
        {thinking && (
          <div className="flex items-center gap-2 text-[14px] text-muted">
            <span className="pulse-dot" /> Checking the quest
          </div>
        )}
      </div>

      {user ? (
        <>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} type="button" disabled={thinking} onClick={() => send(s)}
                className="min-h-[36px] rounded-full border-2 border-ink px-3 text-[13px] font-semibold hover:bg-ink hover:text-stock disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <label htmlFor="ask" className="sr-only">Ask the quest agent</label>
            <input id="ask" className="field" placeholder={`Message as ${user.name}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={800} />
            <button className="btn btn-ink" type="submit" disabled={thinking || !text.trim()}>Send</button>
          </form>
        </>
      ) : (
        <p className="text-[14px] text-muted">Pick who you are in the top right to talk to the agent.</p>
      )}

      {isHost && (q.status === "locked" || q.status === "completed") && <SettleUp q={q} onChange={onChange} />}

      {decided.length > 0 && (
        <details className="text-[14px]">
          <summary className="cursor-pointer py-1 font-semibold">Earlier decisions</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {decided.map((p) => (
              <li key={p.id} className="flex justify-between gap-3">
                <span>{p.title}</span>
                <span className={p.status === "executed" ? "font-semibold text-money" : "text-muted"}>
                  {p.status === "executed" ? "Done on PayPal" : p.status === "failed" ? "Stopped" : p.status === "expired" ? "No longer needed" : "Declined"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

function Bubble({ m, tz, me }: { m: ChatMessage; tz: string; me?: string }) {
  if (m.role === "system") {
    return (
      <div className="flex gap-2 text-[13px] text-muted">
        <span aria-hidden="true" className="mt-[6px] h-[6px] w-[6px] flex-none rounded-full bg-muted" />
        <span>{m.body}</span>
      </div>
    );
  }
  if (m.role === "agent") {
    const tools = (m.meta.tools ?? []).filter((t) => TOOL_LABEL[t]);
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-muted">Quest agent, {timeAgo(m.created_at, tz)}</span>
        <p className="rounded bg-paper px-3 py-2 text-[15px] leading-relaxed">{m.body}</p>
        {tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tools.map((t, i) => (
              <span key={`${t}-${i}`} className={`chip ${t.startsWith("paypal_") ? "chip-held" : "chip-sim"}`}>{TOOL_LABEL[t]}</span>
            ))}
          </div>
        )}
      </div>
    );
  }
  const mine = m.user?.id === me;
  return (
    <div className="flex items-start gap-2">
      {m.user && <Avatar user={m.user} size={28} />}
      <div className="min-w-0">
        <span className="text-[12px] font-semibold text-muted">{mine ? "You" : m.user?.name}, {timeAgo(m.created_at, tz)}</span>
        <p className="text-[15px] leading-relaxed">{m.body}</p>
      </div>
    </div>
  );
}
