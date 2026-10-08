"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import type { BooksDue, BooksQuest, ReminderDraft } from "./types";

/** The host reads, edits and sends. Claude's draft never leaves this dialog on its own. */
export function ReminderDialog({
  draft, due, quest, onClose, onSent,
}: {
  draft: ReminderDraft;
  due: BooksDue;
  quest?: BooksQuest;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [note, setNote] = useState(draft.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    noteRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/invoices/${due.id}/remind`, { method: "POST", json: { subject, note } });
      onSent(
        due.source === "Simulated"
          ? `Reminder logged for ${due.person}. This is demo data, so PayPal wasn't called.`
          : `PayPal sent ${due.person} your reminder.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "PayPal didn't send it.");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(26,33,48,0.55)] p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="rd-title"
        className="w-full max-w-[520px] rounded-md border-2 border-ink bg-stock p-6 shadow-[0_8px_0_var(--ink)]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="rd-title" className="h3">Nudge {due.person}</h2>
          {draft.by === "claude" && <span className="chip chip-held">Drafted by Claude</span>}
        </div>
        <p className="mt-1 text-[14px] text-muted">
          {money(Math.round(due.amount * 100))} for {quest?.title ?? "the trip"}. Open {due.days_open} days.
          {due.reminders > 0 ? ` Reminded ${due.reminders} time${due.reminders > 1 ? "s" : ""} already.` : ""}
        </p>
        <label className="label mt-5 block" htmlFor="rd-subject">Subject</label>
        <input id="rd-subject" className="field mt-1" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        <label className="label mt-4 block" htmlFor="rd-note">Note</label>
        <textarea
          id="rd-note"
          ref={noteRef}
          className="field mt-1 py-2 leading-relaxed"
          style={{ minHeight: 140 }}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="mt-2 text-[13px] text-muted">
          PayPal emails this with the invoice and its pay button. You can nudge each person up to 3 times, 12 hours apart.
        </p>
        {error && <p role="alert" className="mt-3 text-[14px] font-semibold text-stamp">{error}</p>}
        <div className="mt-5 flex flex-wrap gap-3">
          <button className="btn btn-money" onClick={send} disabled={busy || !note.trim()}>
            {busy ? "Sending..." : "Send through PayPal"}
          </button>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Not now</button>
        </div>
      </div>
    </div>
  );
}
