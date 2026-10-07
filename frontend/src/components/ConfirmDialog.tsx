"use client";

import { useEffect, useRef } from "react";

export type ConfirmRequest = { title: string; body: string; action: string; tone?: "money" | "ink" | "danger" };

export function ConfirmDialog({ req, onConfirm, onCancel }: { req: ConfirmRequest; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const cls = req.tone === "money" ? "btn-money" : req.tone === "danger" ? "btn-ink" : "btn-ink-signal";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(26,33,48,0.55)] p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="cd-title" aria-describedby="cd-body"
        className="toast w-full max-w-[440px] rounded-md border-2 border-ink bg-stock p-6 shadow-[0_8px_0_var(--ink)]">
        <h2 id="cd-title" className="h3">{req.title}</h2>
        <p id="cd-body" className="mt-2 text-[15px] leading-relaxed">{req.body}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button ref={ref} className={`btn ${cls}`} onClick={onConfirm}>{req.action}</button>
          <button className="btn btn-ghost" onClick={onCancel}>Not now</button>
        </div>
      </div>
    </div>
  );
}
