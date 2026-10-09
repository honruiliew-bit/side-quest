"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { EVENT } from "@/lib/ledger";
import { api } from "@/lib/api";
import { money, relative, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { DECISION_TEXT, LineDot } from "./parts";
import type { AdminCase, CaseDetail, Decision } from "./types";

const PAYPAL_STATUS: Record<string, string> = {
  OPEN: "Open on PayPal",
  WAITING_FOR_SELLER_RESPONSE: "PayPal is waiting for Sidequest",
  WAITING_FOR_BUYER_RESPONSE: "PayPal is waiting for the buyer",
  UNDER_REVIEW: "PayPal is reviewing",
  RESOLVED: "Resolved on PayPal",
};

export function CasesTab({ onChanged }: { onChanged: () => void }) {
  const { toast, config } = useSession();
  const [list, setList] = useState<AdminCase[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await api<AdminCase[]>("/admin/cases");
      setList(rows);
      setOpenId((id) => id ?? rows.find((r) => r.status === "open")?.id ?? rows[0]?.id ?? null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't load cases.", "error");
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api<{ found: number; opened: number; updated: number; unmatched: number }>("/admin/disputes/sync", { method: "POST" });
      toast(r.opened ? `${r.opened} new PayPal dispute${r.opened > 1 ? "s" : ""} opened as cases.` : `PayPal has ${r.found} dispute${r.found === 1 ? "" : "s"}. Nothing new.`);
      await load();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't reach PayPal.", "error");
    } finally {
      setSyncing(false);
    }
  };

  const open = (list ?? []).filter((c) => c.status === "open");
  const closed = (list ?? []).filter((c) => c.status !== "open");

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4" aria-label="Cases">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h3">{open.length} open</h2>
          <button className="btn btn-ghost btn-sm" onClick={sync} disabled={syncing}
            title={config?.paypal_mode === "mock" ? "Needs PayPal sandbox keys" : "Pull disputes from the PayPal Disputes API"}>
            {syncing ? "Checking..." : "Check PayPal for disputes"}
          </button>
        </div>
        {list === null && <div className="skeleton h-[200px]" />}
        <CaseList rows={open} openId={openId} onOpen={setOpenId} />
        {closed.length > 0 && (
          <>
            <h3 className="label mt-2">Closed</h3>
            <CaseList rows={closed} openId={openId} onOpen={setOpenId} />
          </>
        )}
        {list?.length === 0 && <p className="panel p-4 text-[15px]">No reports yet.</p>}
      </aside>
      <div className="min-w-0">
        {openId ? (
          <CaseView key={openId} id={openId} onDecided={() => { load(); onChanged(); }} />
        ) : (
          list && <p className="panel p-6 text-[15px]">Pick a case to review.</p>
        )}
      </div>
    </div>
  );
}

function CaseList({ rows, openId, onOpen }: { rows: AdminCase[]; openId: string | null; onOpen: (id: string) => void }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onOpen(c.id)}
            aria-current={openId === c.id ? "true" : undefined}
            className={`flex w-full items-start gap-3 border-2 p-3 text-left ${openId === c.id ? "border-ink bg-white shadow-[0_4px_0_var(--ink)]" : "border-rule bg-stock hover:border-ink"}`}
          >
            <LineDot code={c.quest.line_code} />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="flex flex-wrap items-center gap-1">
                <span className="font-bold">{c.reporter?.name ?? "Unknown"}</span>
                <span className="text-[13px] text-muted">on {c.quest.code}</span>
                {c.source === "paypal" && <span className="chip chip-held">PayPal dispute</span>}
              </span>
              <span className="mt-1 line-clamp-2 block text-[14px]">{c.reason}</span>
              <span className="mt-1 block text-[12px] text-muted">
                {c.status === "open" ? `Opened ${relative(c.created_at)}` : `${c.decision ? DECISION_TEXT[c.decision] : "Withdrawn"} ${c.resolved_at ? relative(c.resolved_at) : ""}`}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function CaseView({ id, onDecided }: { id: string; onDecided: () => void }) {
  const { toast } = useSession();
  const [c, setC] = useState<CaseDetail | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(() => {
    api<CaseDetail>(`/admin/cases/${id}`).then(setC).catch((e) => toast(e.message, "error"));
  }, [id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const review = async () => {
    setReviewing(true);
    try {
      setC(await api<CaseDetail>(`/admin/cases/${id}/review`, { method: "POST" }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Claude couldn't review this.", "error");
    } finally {
      setReviewing(false);
    }
  };

  if (!c) return <div className="skeleton h-[480px]" />;
  const q = c.quest;
  const tz = q.tz;
  const reporterPaid = c.members.find((m) => m.user.id === c.reporter?.id);
  const paidBy = c.members.filter((m) => m.charged_cents > 0);
  const payoutLine =
    q.status === "completed"
      ? `${q.host.name} was already paid ${money(c.money.paid_out_cents)}. A refund now comes out of Sidequest's money and ${q.host.name} would owe it back.`
      : `Sidequest holds ${money(c.money.escrow_cents)} for ${q.host.name}. The payout ${new Date(c.payout_due_at) > new Date() ? "is due" : "was due"} ${relative(c.payout_due_at)} and waits for your decision.`;

  return (
    <article className="flex flex-col gap-5" aria-labelledby="case-h">
      <header className="panel flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {c.source === "paypal" ? <span className="chip chip-held">PayPal dispute</span> : <span className="chip chip-sim">Member report</span>}
          <span className={`chip ${c.status === "open" ? "chip-refund" : "chip-paid"}`}>{c.status === "open" ? "Waiting on you" : c.status === "withdrawn" ? "Withdrawn" : "Decided"}</span>
          {c.provider === "sim" && <span className="chip chip-sim">Demo data</span>}
        </div>
        <h2 id="case-h" className="h2">
          <Link href={`/q/${q.id}`} className="underline-offset-4 hover:underline">{q.title}</Link>
        </h2>
        <p className="text-[14px] text-muted">{q.code}, hosted by {q.host.name}. {payoutLine}</p>
        {c.paypal_dispute_id && (
          <p className="text-[14px]">
            PayPal dispute <span className="font-mono">{c.paypal_dispute_id}</span>
            {c.paypal_status && <>: {PAYPAL_STATUS[c.paypal_status] ?? c.paypal_status}</>}
          </p>
        )}
      </header>

      <section className="grid gap-4 md:grid-cols-2" aria-label="Both sides">
        <Side who={c.reporter?.name ?? "The member"} user={c.reporter} label={c.source === "paypal" ? "Told PayPal" : "Reported"} when={c.created_at} tz={tz}
          text={c.reason} foot={reporterPaid ? `Paid ${money(reporterPaid.charged_cents - reporterPaid.refunded_cents)}` : `Disputing ${money(c.disputed_cents)}`} />
        <Side who={q.host.name} user={q.host} label="Host's side" when={c.host_responded_at} tz={tz}
          text={c.host_response ?? (c.source === "paypal" ? "No reply. PayPal disputes come straight to Sidequest." : "No reply yet.")}
          muted={!c.host_response} />
      </section>

      <AiBox c={c} reviewing={reviewing} onReview={review} />

      {c.status === "open" ? (
        <DecisionForm c={c} paidBy={paidBy.length} onDone={(next) => { setC(next); onDecided(); }} />
      ) : (
        <section className="panel flex flex-col gap-2 p-5">
          <h3 className="h3">{c.decision ? DECISION_TEXT[c.decision] : "Withdrawn by the reporter"}</h3>
          {c.refund_cents_each ? <p className="text-[15px]">{money(c.refund_cents_each)}{c.decision === "refund_everyone" ? " each" : ""}</p> : null}
          <p className="text-[15px]">{c.resolution_note}</p>
          <p className="text-[13px] text-muted">
            {c.resolved_by ? `${c.resolved_by.name}, ` : ""}{c.resolved_at ? timeAgo(c.resolved_at, tz) : ""}
          </p>
        </section>
      )}

      <Evidence c={c} />
    </article>
  );
}

function Side({ who, user, label, when, tz, text, foot, muted }: {
  who: string; user: CaseDetail["reporter"]; label: string; when: string | null; tz: string; text: string; foot?: string; muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 border-2 border-ink bg-white p-4">
      <div className="flex items-center gap-2">
        {user && <Avatar user={user} size={30} />}
        <span className="leading-tight">
          <span className="block font-bold">{who}</span>
          <span className="text-[12px] text-muted">{label}{when ? `, ${timeAgo(when, tz)}` : ""}</span>
        </span>
      </div>
      <p className={`text-[15px] leading-relaxed ${muted ? "text-muted" : ""}`}>{text}</p>
      {foot && <p className="mt-auto text-[13px] font-semibold">{foot}</p>}
    </div>
  );
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? [v] : [];
}

function AiBox({ c, reviewing, onReview }: { c: CaseDetail; reviewing: boolean; onReview: () => void }) {
  const raw = c.ai_review;
  const r = raw ? { ...raw, facts: list(raw.facts), missing: list(raw.missing), refund_cents_each: Number(raw.refund_cents_each) || 0 } : null;
  return (
    <section className="flex flex-col gap-3 border-2 border-ink bg-paper p-5" aria-labelledby="ai-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="ai-h" className="h3">Claude&apos;s read</h3>
          <p className="text-[13px] text-muted">Claude reads the chat, receipts and payments and suggests a decision. It can&apos;t move money. You decide.</p>
        </div>
        {c.status === "open" && (
          <button className="btn btn-ink btn-sm" onClick={onReview} disabled={reviewing}>
            {reviewing ? "Reading the case..." : r ? "Ask again" : "Ask Claude"}
          </button>
        )}
      </div>
      {r && (
        <div className="flex flex-col gap-3 text-[15px]">
          <p>{r.summary}</p>
          {r.facts.length > 0 && (
            <div>
              <div className="label">What the records show</div>
              <ul className="ml-5 list-disc text-[14px]">{r.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          {r.missing.length > 0 && (
            <div>
              <div className="label">Not clear from the records</div>
              <ul className="ml-5 list-disc text-[14px]">{r.missing.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          <p className="border-l-4 border-ink bg-white px-3 py-2">
            <strong>Suggests: {DECISION_TEXT[r.decision] ?? r.decision}</strong>
            {r.refund_cents_each > 0 && <> ({money(r.refund_cents_each)}{r.decision === "refund_everyone" ? " each" : ""})</>}. {r.reasoning}
          </p>
          {r.source === "offline" && <p className="text-[13px] text-muted">Claude is off on this server, so this is a simple rule of thumb.</p>}
        </div>
      )}
    </section>
  );
}

function DecisionForm({ c, paidBy, onDone }: { c: CaseDetail; paidBy: number; onDone: (c: CaseDetail) => void }) {
  const { toast } = useSession();
  const suggested = c.ai_review && c.ai_review.decision !== "need_more_info" ? c.ai_review.decision : null;
  const [decision, setDecision] = useState<Decision>(suggested ?? (c.source === "paypal" ? "accept_claim" : "release"));
  const [amount, setAmount] = useState(c.ai_review?.refund_cents_each ? (c.ai_review.refund_cents_each / 100).toFixed(2) : "");
  const [note, setNote] = useState("");
  const [payNow, setPayNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const reporter = c.reporter?.name ?? "the reporter";
  const reporterLeft = (() => {
    const m = c.members.find((x) => x.user.id === c.reporter?.id);
    return m ? m.charged_cents - m.refunded_cents : c.disputed_cents;
  })();

  useEffect(() => {
    if (suggested) setDecision(suggested);
    if (c.ai_review?.refund_cents_each) setAmount((c.ai_review.refund_cents_each / 100).toFixed(2));
  }, [c.ai_review, suggested]);

  const cents = Math.round(parseFloat(amount || "0") * 100);
  const needsAmount = decision === "refund_reporter" || decision === "refund_everyone";
  const options: { id: Decision; label: string; text: string; show: boolean }[] = [
    { id: "release", label: "Release the payout", text: `${c.quest.host.name} is paid in full. Nobody is refunded.`, show: true },
    { id: "refund_reporter", label: `Refund ${reporter}`, text: `Up to ${money(reporterLeft)}, through PayPal. It comes out of the host's payout.`, show: true },
    { id: "refund_everyone", label: "Refund everyone", text: `The same amount to each of the ${paidBy} people who paid.`, show: true },
    { id: "accept_claim", label: "Accept the claim on PayPal", text: "PayPal refunds the buyer and closes the dispute.", show: c.source === "paypal" },
  ];
  const confirm =
    decision === "release" ? `Release ${c.quest.host.name}'s payout`
      : decision === "refund_reporter" ? `Refund ${reporter} ${money(cents || 0)}`
        : decision === "refund_everyone" ? `Refund ${paidBy} people ${money(cents || 0)} each`
          : "Accept the claim on PayPal";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (needsAmount && !(cents > 0)) {
      toast("Enter an amount to refund.", "error");
      return;
    }
    setBusy(true);
    try {
      const next = await api<CaseDetail>(`/admin/cases/${c.id}/resolve`, {
        method: "POST",
        json: { decision, refund_cents_each: needsAmount ? cents : 0, note, pay_now: payNow },
      });
      toast("Decided. Everyone on the quest can see the outcome.", "money");
      onDone(next);
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't go through.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel flex flex-col gap-4 p-5" aria-labelledby="decide-h">
      <h3 id="decide-h" className="h3">Your decision</h3>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Decision</legend>
        {options.filter((o) => o.show).map((o) => (
          <label key={o.id} className={`flex cursor-pointer gap-3 border-2 p-3 ${decision === o.id ? "border-ink bg-white" : "border-rule hover:border-ink"}`}>
            <input type="radio" name="decision" value={o.id} checked={decision === o.id} onChange={() => setDecision(o.id)} className="mt-1 h-4 w-4 accent-[#1a2130]" />
            <span className="leading-tight">
              <span className="block font-bold">{o.label}{suggested === o.id && <span className="ml-2 text-[12px] font-semibold text-muted">Claude&apos;s pick</span>}</span>
              <span className="text-[13px] text-muted">{o.text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {needsAmount && (
        <label className="flex max-w-[260px] flex-col gap-1">
          <span className="text-[14px] font-semibold">{decision === "refund_everyone" ? "Amount each" : "Amount"}</span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="text-[18px] font-bold">$</span>
            <input className="field tab" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
          </span>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-[14px] font-semibold">Note to the group</span>
        <textarea className="field" rows={3} required minLength={3} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="What you decided and why. Everyone on the quest sees this, and it goes in the audit log." />
      </label>
      {c.quest.status === "locked" && (
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={payNow} onChange={(e) => setPayNow(e.target.checked)} className="h-4 w-4 accent-[#1a2130]" />
          Pay the host now instead of waiting for the scheduled payout
        </label>
      )}
      <div>
        <button className={`btn ${decision === "release" ? "btn-ink" : "btn-money"}`} type="submit" disabled={busy}>
          {busy ? "Working on PayPal..." : confirm}
        </button>
      </div>
    </form>
  );
}

function Evidence({ c }: { c: CaseDetail }) {
  const tz = c.quest.tz;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="ev-h">
      <h3 id="ev-h" className="h3">Records</h3>
      <div className="grid gap-4 xl:grid-cols-2">
        <details className="panel p-4" open>
          <summary className="cursor-pointer font-bold">Group chat, newest first ({c.chat.length})</summary>
          <ul className="mt-3 flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1 text-[14px]">
            {[...c.chat].reverse().map((m) => (
              <li key={m.id} className={m.role === "system" ? "text-muted" : ""}>
                <span className="font-semibold">{m.user?.name ?? (m.role === "agent" ? "Agent" : "Sidequest")}</span>{" "}
                <span className="text-[12px] text-muted">{timeAgo(m.created_at, tz)}</span>
                <span className="block">{m.body}</span>
              </li>
            ))}
          </ul>
        </details>
        <div className="flex flex-col gap-4">
          <details className="panel p-4" open>
            <summary className="cursor-pointer font-bold">Payments on this quest ({c.ledger.length})</summary>
            <ul className="mt-3 flex max-h-[220px] flex-col gap-1 overflow-y-auto pr-1 text-[14px]">
              {c.ledger.map((e) => (
                <li key={e.id} className="flex justify-between gap-3 border-b border-rule py-1 last:border-b-0">
                  <span className="min-w-0 truncate">{EVENT[e.kind]}{e.user ? `, ${e.user.name}` : ""}</span>
                  <span className={`tab flex-none font-semibold ${e.kind === "refund" ? "text-stamp" : "text-money"}`}>
                    {e.kind === "refund" ? "-" : ""}{money(e.cents)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <details className="panel p-4" open={c.receipts.length > 0}>
            <summary className="cursor-pointer font-bold">Receipts ({c.receipts.length})</summary>
            {c.receipts.length === 0 ? (
              <p className="mt-2 text-[14px] text-muted">None uploaded.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2 text-[14px]">
                {c.receipts.map((r) => (
                  <li key={r.id}>
                    <span className="font-semibold">{r.merchant ?? "Receipt"}</span> {r.total_cents ? money(r.total_cents) : ""}, {r.status}
                    {r.issues.length > 0 && <span className="block text-[13px] text-muted">{r.issues.join(" ")}</span>}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </div>
    </section>
  );
}
