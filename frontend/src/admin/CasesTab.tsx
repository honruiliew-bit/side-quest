"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Bubble } from "@/components/CaseThread";
import { EVENT } from "@/lib/ledger";
import { api } from "@/lib/api";
import { money, relative, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { DECIDED_TEXT, DECISION_TEXT, LineDot } from "./parts";
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
                {c.status === "open" && c.waiting_on.length > 0 && <span className="chip chip-sim">Asked, no reply yet</span>}
                {c.status === "open" && c.waiting_on.length === 0 && c.messages.length > 0 && c.messages[c.messages.length - 1].role !== "admin" && (
                  <span className="chip chip-refund">New reply</span>
                )}
              </span>
              <span className="mt-1 line-clamp-2 block text-[14px]">{c.reason}</span>
              <span className="mt-1 block text-[12px] text-muted">
                {c.status === "open" ? `Opened ${relative(c.created_at)}` : `${c.decision ? DECIDED_TEXT[c.decision] : "Withdrawn"} ${c.resolved_at ? relative(c.resolved_at) : ""}`}
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
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState<"host" | "reporter" | "both">("both");

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
          text={c.host_response ?? "No reply yet. Ask below."}
          muted={!c.host_response} />
      </section>

      <Thread c={c} draft={draft} setDraft={setDraft} to={to} setTo={setTo} onSent={(next) => { setC(next); onDecided(); }} />

      <AiBox c={c} reviewing={reviewing} onReview={review} onAsk={(text) => {
        setDraft(text);
        setTo("both");
        document.getElementById("thread-h")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }} />

      {c.status === "open" ? (
        <DecisionForm c={c} onDone={(next) => { setC(next); onDecided(); }} />
      ) : (
        <section className="panel flex flex-col gap-2 p-5">
          <h3 className="h3">{c.decision ? DECIDED_TEXT[c.decision] : "Withdrawn by the reporter"}</h3>
          {c.refund_cents_each ? <p className="text-[15px]">{money(c.refund_cents_each)}{c.decision === "split_refund" || c.decision === "refund_everyone" ? " each" : ""}</p> : null}
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

function Thread({ c, draft, setDraft, to, setTo, onSent }: {
  c: CaseDetail; draft: string; setDraft: (v: string) => void; to: "host" | "reporter" | "both";
  setTo: (v: "host" | "reporter" | "both") => void; onSent: (c: CaseDetail) => void;
}) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const reporter = c.reporter?.name ?? "The reporter";
  const host = c.quest.host.name;
  const names = { host, reporter, both: "Both" };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onSent(await api<CaseDetail>(`/admin/cases/${c.id}/messages`, { method: "POST", json: { body: draft, to } }));
      setDraft("");
      toast(`Sent to ${to === "both" ? `${host} and ${reporter}` : names[to]}. They see it on the quest page.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't send.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel flex flex-col gap-3 p-5" aria-labelledby="thread-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="thread-h" className="h3 scroll-mt-24">Ask for details</h3>
        {c.waiting_on.length > 0 && (
          <span className="chip chip-refund">Waiting on {c.waiting_on.map((r) => (r === "host" ? host : reporter)).join(" and ")}</span>
        )}
      </div>
      <p className="text-[13px] text-muted">Private to Sidequest, {host} and {reporter}. Not posted in the group chat. They reply from the quest page.</p>
      {c.messages.length > 0 && (
        <ol className="flex flex-col gap-2">{c.messages.map((m) => <Bubble key={m.id} m={m} tz={c.quest.tz} />)}</ol>
      )}
      {c.status === "open" && (
        <form onSubmit={send} className="flex flex-col gap-2">
          <div role="radiogroup" aria-label="Send to" className="flex flex-wrap gap-2">
            {(["host", "reporter", "both"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={to === k} onClick={() => setTo(k)}
                className={`border-2 border-ink px-3 py-1 text-[14px] font-semibold ${to === k ? "bg-ink text-stock" : "bg-stock hover:bg-white"}`}>
                {k === "both" ? "Both" : names[k]}{k === "host" ? " (host)" : ""}
              </button>
            ))}
          </div>
          <label htmlFor="ask-input" className="sr-only">Message</label>
          <textarea id="ask-input" className="field" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} minLength={2} required
            placeholder={`What do you need to know? For example: "Was the lobster stop in the plan you shared?"`} />
          <button className="btn btn-ink btn-sm self-start" disabled={busy || draft.trim().length < 2} type="submit">
            {busy ? "Sending..." : `Send to ${to === "both" ? "both" : names[to]}`}
          </button>
        </form>
      )}
    </section>
  );
}

function AiBox({ c, reviewing, onReview, onAsk }: { c: CaseDetail; reviewing: boolean; onReview: () => void; onAsk: (text: string) => void }) {
  const raw = c.ai_review;
  const r = raw ? { ...raw, facts: list(raw.facts), missing: list(raw.missing), refund_cents: Number(raw.refund_cents) || 0 } : null;
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
            {r.refund_cents > 0 && <> ({r.decision === "split_refund" ? `${money(r.refund_cents)} split across everyone` : money(r.refund_cents)})</>}.
            {r.reasoning && <> {r.reasoning}</>}
          </p>
          {c.status === "open" && r.missing.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => onAsk(
              `To help us decide, can you tell us:\n${r.missing.map((m) => `- ${m}`).join("\n")}`)}>
              Ask both sides about this
            </button>
          )}
          {r.source === "offline" && <p className="text-[13px] text-muted">Claude is off on this server, so this is a simple rule of thumb.</p>}
        </div>
      )}
    </section>
  );
}

function DecisionForm({ c, onDone }: { c: CaseDetail; onDone: (c: CaseDetail) => void }) {
  const { toast } = useSession();
  const host = c.quest.host;
  const reporter = c.reporter?.name ?? "The reporter";
  const review = c.ai_review;
  const suggested = review && review.decision !== "need_more_info" ? review.decision : null;
  const [decision, setDecision] = useState<Decision>(suggested ?? (c.source === "paypal" ? "accept_claim" : "release"));
  const [reporterAmt, setReporterAmt] = useState("");
  const [splitTotal, setSplitTotal] = useState("");
  const [note, setNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);
  const [payNow, setPayNow] = useState(false);
  const [busy, setBusy] = useState(false);

  // When Claude has a suggestion, start from it: same option, same amount.
  useEffect(() => {
    if (!suggested) return;
    setDecision(suggested);
    const amt = review?.refund_cents ? (review.refund_cents / 100).toFixed(2) : "";
    if (suggested === "split_refund") setSplitTotal(amt);
    if (suggested === "refund_reporter") setReporterAmt(amt);
  }, [review, suggested]);

  const cents = (v: string) => Math.max(0, Math.round(parseFloat(v || "0") * 100) || 0);
  const payers = c.members.filter((m) => m.charged_cents - m.refunded_cents > 0);
  const reporterRow = c.members.find((m) => m.user.id === c.reporter?.id);
  const reporterLeft = reporterRow ? reporterRow.charged_cents - reporterRow.refunded_cents : c.disputed_cents;
  const hostPaid = payers.some((m) => m.user.id === host.id);
  const total = cents(splitTotal);
  const each = payers.length ? Math.floor(total / payers.length) : 0;
  const splitRefunds = payers.filter((m) => m.user.id !== host.id).map((m) => ({ name: m.user.name, cents: Math.min(each, m.charged_cents - m.refunded_cents) }));
  const reporterCents = Math.min(cents(reporterAmt), reporterLeft);

  const fromHost =
    decision === "refund_reporter" ? reporterCents
      : decision === "split_refund" ? splitRefunds.reduce((a, r) => a + r.cents, 0)
        : decision === "accept_claim" ? Math.min(c.disputed_cents, reporterLeft) : 0;
  const completed = c.quest.status === "completed";
  const payoutBefore = c.money.escrow_cents;
  const payoutAfter = Math.max(payoutBefore - fromHost, 0);
  const ready = decision === "release" || decision === "accept_claim" || (decision === "refund_reporter" ? reporterCents > 0 : each > 0);

  const options: { id: Decision; label: string; when: string; show: boolean }[] = [
    { id: "release", label: "Release the payout", when: "The trip ran as promised, or nobody lost money.", show: true },
    { id: "split_refund", label: "Split a refund across everyone", when: `It affected everyone who went, or ${host.name} got money back for a shared cost.`, show: true },
    { id: "refund_reporter", label: `Refund ${reporter} only`, when: `Only ${reporter} lost out.`, show: c.source === "member" },
    { id: "accept_claim", label: "Accept the claim on PayPal", when: "The buyer is right. PayPal refunds them and closes the dispute.", show: c.source === "paypal" },
  ];

  const defaultNote =
    suggested === decision && review?.reasoning ? review.reasoning
      : decision === "release" ? "The trip ran as planned, so the payout goes ahead."
        : decision === "split_refund" ? `Splitting ${money(total)} equally across the ${payers.length} people who went.`
          : decision === "refund_reporter" ? `Refunding ${reporter} ${money(reporterCents)}.`
            : "Accepting the buyer's claim on PayPal.";
  useEffect(() => {
    if (!noteTouched) setNote(defaultNote);
  }, [defaultNote, noteTouched]);

  const confirm =
    decision === "release" ? `Release ${host.name}'s payout`
      : decision === "split_refund" ? `Split ${money(total)}: ${money(each)} each`
        : decision === "refund_reporter" ? `Refund ${reporter} ${money(reporterCents)}`
          : "Accept the claim on PayPal";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) {
      toast("Enter an amount first.", "error");
      return;
    }
    setBusy(true);
    try {
      const next = await api<CaseDetail>(`/admin/cases/${c.id}/resolve`, {
        method: "POST",
        json: {
          decision, note, pay_now: payNow,
          refund_cents_each: decision === "refund_reporter" ? reporterCents : 0,
          refund_total_cents: decision === "split_refund" ? total : 0,
        },
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
    <form onSubmit={submit} className="panel flex flex-col gap-5 p-5" aria-labelledby="decide-h">
      <h3 id="decide-h" className="h3">Your decision</h3>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Decision</legend>
        {options.filter((o) => o.show).map((o) => (
          <label key={o.id} className={`flex cursor-pointer gap-3 border-2 p-3 ${decision === o.id ? "border-ink bg-white" : "border-rule hover:border-ink"}`}>
            <input type="radio" name="decision" value={o.id} checked={decision === o.id} onChange={() => setDecision(o.id)} className="mt-1 h-4 w-4 accent-[#1a2130]" />
            <span className="leading-tight">
              <span className="block font-bold">
                {o.label}
                {suggested === o.id && <span className="chip chip-held ml-2 align-middle">Claude&apos;s pick</span>}
              </span>
              <span className="text-[14px] text-muted">Use when: {o.when}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {decision === "split_refund" && (
        <Money label="Total to split" hint={`Divided equally between the ${payers.length} people who went, ${host.name} included.`}
          value={splitTotal} onChange={setSplitTotal} />
      )}
      {decision === "refund_reporter" && (
        <Money label={`Amount back to ${reporter}`} hint={`Up to ${money(reporterLeft)}, what they paid.`} value={reporterAmt} onChange={setReporterAmt} />
      )}

      <div className="border-2 border-ink bg-paper p-4" aria-live="polite">
        <div className="label mb-2">What happens</div>
        <ul className="flex flex-col gap-1 text-[15px]">
          {decision === "release" && <li>Nobody gets money back.</li>}
          {decision === "split_refund" && (
            each > 0 ? (
              <>
                <li className="font-semibold">{money(total)} ÷ {payers.length} people = {money(each)} each</li>
                {splitRefunds.map((r) => <li key={r.name}>{r.name} gets {money(r.cents)} back on PayPal</li>)}
                {hostPaid && <li className="text-muted">{host.name} went too. That {money(each)} share stays in {host.name}&apos;s payout instead of being refunded.</li>}
              </>
            ) : <li className="text-muted">Enter the total to split.</li>
          )}
          {decision === "refund_reporter" && (reporterCents > 0 ? <li>{reporter} gets {money(reporterCents)} back on PayPal</li> : <li className="text-muted">Enter an amount.</li>)}
          {decision === "accept_claim" && <li>PayPal refunds {reporter} {money(Math.min(c.disputed_cents, reporterLeft))} and closes the dispute.</li>}
          <li className="mt-1 border-t border-rule pt-2">
            {completed ? (
              fromHost > 0 ? <>{host.name} was already paid. Sidequest covers {money(fromHost)} and {host.name} owes it back.</> : <>{host.name} was already paid. Nothing changes for {host.name}.</>
            ) : (
              <><strong>{host.name} is paid {money(payoutAfter)}</strong>{fromHost > 0 && <span className="text-muted"> instead of {money(payoutBefore)}</span>}.</>
            )}
          </li>
        </ul>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[14px] font-semibold">Note to the group</span>
        <textarea className="field" rows={2} required minLength={3} maxLength={600} value={note}
          onChange={(e) => { setNote(e.target.value); setNoteTouched(true); }} />
        <span className="text-[12px] text-muted">Everyone on the quest sees this, and it goes in the audit log.</span>
      </label>
      {c.quest.status === "locked" && (
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={payNow} onChange={(e) => setPayNow(e.target.checked)} className="h-4 w-4 accent-[#1a2130]" />
          Pay {host.name} now instead of at the scheduled time
        </label>
      )}
      <div>
        <button className={`btn ${decision === "release" ? "btn-ink" : "btn-money"}`} type="submit" disabled={busy || !ready}>
          {busy ? "Working on PayPal..." : confirm}
        </button>
      </div>
    </form>
  );
}

function Money({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[14px] font-semibold">{label}</span>
      <span className="flex max-w-[260px] items-center gap-2">
        <span aria-hidden="true" className="text-[18px] font-bold">$</span>
        <input className="field tab" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
      </span>
      <span className="text-[13px] text-muted">{hint}</span>
    </label>
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
