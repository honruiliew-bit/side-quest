"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { CaseMessage, QuestCase, QuestDetail } from "@/lib/types";

/** The private thread on a report, as the host or the person who reported sees it. */
export function CaseThread({ c, q, onChange }: { c: QuestCase; q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const { toast } = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!c.my_role || c.my_role === "admin") return null;
  const asked = c.waiting_on.includes(c.my_role);
  const firstReply = c.my_role === "host" && !c.host_response;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onChange(await api<QuestDetail>(`/cases/${c.id}/messages`, { method: "POST", json: { body: text } }));
      setText("");
      toast("Sent to Sidequest.");
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't send.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {c.messages.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label="Messages with Sidequest">
          {c.messages.map((m) => <Bubble key={m.id} m={m} tz={q.tz} />)}
        </ol>
      )}
      {asked && <p className="text-[13px] font-semibold text-stamp">Sidequest is waiting for your answer.</p>}
      <form onSubmit={send} className="flex flex-col gap-2">
        <label htmlFor={`thread-${c.id}`} className="text-[13px] font-semibold">
          {firstReply ? "Your side" : "Message Sidequest"}
        </label>
        <textarea id={`thread-${c.id}`} className="field" rows={2} value={text} onChange={(e) => setText(e.target.value)} minLength={2} required
          placeholder={firstReply ? "What happened, and anything you've already done about it" : "Only Sidequest and the other side of this report see this"} />
        <button className="btn btn-ink btn-sm self-start" disabled={busy} type="submit">{busy ? "Sending..." : "Send to Sidequest"}</button>
      </form>
    </div>
  );
}

export function Bubble({ m, tz }: { m: CaseMessage; tz: string }) {
  const staff = m.role === "admin";
  const to = m.to === "both" ? "both sides" : m.to === "host" ? "the host" : m.to === "reporter" ? "the reporter" : "Sidequest";
  return (
    <li className={`max-w-[92%] rounded border-2 px-3 py-2 text-[14px] ${staff ? "self-start border-ink bg-paper" : "self-end border-rule bg-white"}`}>
      <div className="text-[12px] text-muted">
        <span className="font-semibold text-ink">{m.author.name}{staff ? " from Sidequest" : ""}</span> to {to}, {timeAgo(m.created_at, tz)}
      </div>
      <p className="mt-1 leading-snug">{m.body}</p>
    </li>
  );
}
