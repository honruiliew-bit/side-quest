"use client";

import { useEffect, useRef, useState } from "react";
import { money } from "@/lib/format";

/** Stands in for PayPal's approval window when PAYPAL_MODE=mock. Clearly labelled, never styled as PayPal. */
export function MockPayPalSheet({
  amountCents,
  funding,
  description,
  orderId,
  onApprove,
  onCancel,
  inline = false,
  feeCents = 0,
}: {
  feeCents?: number;
  amountCents: number;
  funding: string;
  description: string;
  orderId: string;
  onApprove: () => Promise<void> | void;
  onCancel: () => void;
  inline?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const approveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    approveRef.current?.focus();
    if (inline) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inline, onCancel]);

  const sheet = (
    <div
      role="dialog"
      aria-modal={!inline}
      aria-labelledby="mock-pp-title"
      className="toast w-full max-w-[420px] rounded-md border-2 border-ink bg-white p-6 text-ink shadow-[0_8px_0_var(--ink)]"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full border border-rule px-3 py-1 text-[12px] font-semibold text-muted">Mock PayPal sandbox</span>
        <span className="text-[12px] text-muted">Order {orderId}</span>
      </div>
      <h2 id="mock-pp-title" className="mt-5 text-[22px] font-extrabold" style={{ fontStretch: "76%" }}>
        Approve a hold with {funding}
      </h2>
      <p className="mt-1 text-[15px] text-muted">{description}</p>
      <div className="mt-5 rounded border-2 border-money p-4">
        <div className="text-[13px] text-muted">Amount held</div>
        <div className="tab text-[40px] font-extrabold leading-none text-money" style={{ fontStretch: "62%" }}>
          {money(amountCents)}
        </div>
        {feeCents > 0 && (
          <dl className="mt-3 flex flex-col gap-1 border-t border-rule pt-2 text-[14px]">
            <div className="flex justify-between"><dt>Trip share</dt><dd className="tab">{money(amountCents - feeCents)}</dd></div>
            <div className="flex justify-between"><dt>Sidequest booking fee</dt><dd className="tab">{money(feeCents)}</dd></div>
          </dl>
        )}
        <p className="mt-2 text-[14px]">This is a hold, not a charge. You only pay the final split if the quest runs.</p>
      </div>
      <p className="mt-4 text-[13px] text-muted">
        In sandbox mode this step happens on PayPal's own page. Mock mode simulates it so the app runs without keys.
      </p>
      <div className="mt-5 flex gap-3">
        <button
          ref={approveRef}
          className="btn btn-money flex-1"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onApprove();
          }}
        >
          {busy ? "Placing hold" : "Approve hold"}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );

  if (inline) return sheet;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(26,33,48,0.55)] p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      {sheet}
    </div>
  );
}
