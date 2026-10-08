"use client";

import { useState } from "react";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { friendlyNote } from "./NudgeBoard";
import { ReminderDialog } from "./ReminderDialog";
import type { Books, ReminderDraft } from "./types";

/** Phone version of the host desk: who still owes you, with the same Nudge flow. */
export function OwedList({ books, onChanged }: { books: Books; onChanged: () => void }) {
  const { toast } = useSession();
  const [draft, setDraft] = useState<ReminderDraft | null>(null);
  const quests = new Map(books.quests.map((q) => [q.id, q]));
  const open = books.dues.filter((d) => d.status === "Open").sort((a, b) => b.amount - a.amount);
  const due = draft ? books.dues.find((d) => d.id === draft.invoiceId) : undefined;
  const total = open.reduce((a, d) => a + Math.round(d.amount * 100), 0);

  return (
    <section aria-labelledby="owed-h" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="owed-h" className="h2">Who still owes</h2>
        <span className="tab font-bold text-money">{money(total)}</span>
      </div>
      {open.length === 0 ? (
        <p className="panel p-4 text-[15px]">Everyone has paid.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {open.map((d) => {
            const q = quests.get(d.quest_id);
            return (
              <li key={d.id} className="flex items-center gap-3 border-2 border-ink bg-stock px-3 py-3">
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="font-bold">{d.person}</div>
                  <div className="truncate text-[13px] text-muted">
                    {q?.title} · <span className={d.days_open >= 7 ? "font-semibold text-stamp" : ""}>{d.days_open}d open</span>
                    {d.reminders ? ` · nudged ${d.reminders}x` : ""}
                  </div>
                </div>
                <span className="tab font-bold text-money">{money(Math.round(d.amount * 100))}</span>
                {d.can_remind && (
                  <button
                    className="border-2 border-ink bg-signal px-2 py-1 text-[13px] font-bold"
                    onClick={() => setDraft({
                      invoiceId: d.id, subject: `Reminder: ${q?.title ?? "your quest"}`,
                      note: friendlyNote(d.person, q?.title ?? "the trip", Math.round(d.amount * 100)), by: "host",
                    })}
                  >
                    Nudge
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[13px] text-muted">Open this page on a laptop for the full dashboard and Claude.</p>
      {draft && due && (
        <ReminderDialog
          draft={draft}
          due={due}
          quest={quests.get(due.quest_id)}
          onClose={() => setDraft(null)}
          onSent={(m) => {
            setDraft(null);
            toast(m, "money");
            onChanged();
          }}
        />
      )}
    </section>
  );
}
