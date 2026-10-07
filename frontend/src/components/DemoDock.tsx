"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { QuestDetail } from "@/lib/types";

/** Judges can't recruit five friends. This adds simulated people and moves the clock. */
export function DemoDock({ q, onChange }: { q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const { config, toast } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!config?.demo_mode) return null;

  const open_ = q.status === "open" || q.status === "on";
  const toMin = Math.max(1, q.min_people - q.headcount);

  const run = async (key: string, path: string, json: unknown, done: string) => {
    setBusy(key);
    try {
      const d = await api<QuestDetail>(path, { method: "POST", json });
      onChange(d);
      toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed bottom-4 left-4 z-40">
      {open ? (
        <div className="toast w-[280px] rounded-md border-2 border-ink bg-stock p-4 shadow-[0_6px_0_var(--ink)]" role="region" aria-label="Demo controls">
          <div className="flex items-center justify-between">
            <span className="font-bold">Demo controls</span>
            <button className="min-h-[36px] px-2 text-[14px] underline" onClick={() => setOpen(false)}>Hide</button>
          </div>
          <p className="mt-1 text-[13px] text-muted">Simulated people place test holds so you can see the whole lifecycle alone.</p>
          <div className="mt-3 flex flex-col gap-2">
            <button className="btn btn-ghost btn-sm" disabled={!open_ || !!busy}
              onClick={() => run("one", `/demo/quests/${q.id}/crowd`, { count: 1 }, "Someone new placed a hold.")}>
              {busy === "one" ? "Adding" : "Add a person"}
            </button>
            {q.status === "open" && (
              <button className="btn btn-ghost btn-sm" disabled={!!busy}
                onClick={() => run("min", `/demo/quests/${q.id}/crowd`, { count: toMin }, `${toMin} people joined.`)}>
                {busy === "min" ? "Adding" : `Fill to the minimum (+${toMin})`}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={!open_ || !!busy}
              onClick={() => run("deadline", `/demo/quests/${q.id}/deadline`, {}, "Jumped to the join deadline.")}>
              {busy === "deadline" ? "Moving the clock" : "Jump to the join deadline"}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-ink btn-sm shadow-[0_4px_0_var(--signal)]" onClick={() => setOpen(true)} aria-expanded={false}>
          Demo controls
        </button>
      )}
    </div>
  );
}
