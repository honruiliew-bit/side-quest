"use client";

import { useRef, useState } from "react";
import { api, API_URL } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { QuestDetail, Receipt } from "@/lib/types";

const STATUS: Record<Receipt["status"], { label: string; cls: string }> = {
  verified: { label: "Read and checked", cls: "chip-held" },
  flagged: { label: "Needs a look", cls: "chip-refund" },
  unverified: { label: "Not checked", cls: "chip-sim" },
  rejected: { label: "Rejected", cls: "chip-released" },
  removed: { label: "Removed", cls: "chip-released" },
};

export function receiptImage(id: string) {
  return `${API_URL}/receipts/${id}/image`;
}

export function ReceiptCard({ r, onRemove }: { r: Receipt; onRemove?: () => void }) {
  const st = STATUS[r.status];
  return (
    <div className="flex gap-3 rounded border-2 border-ink bg-white p-2">
      <a href={receiptImage(r.id)} target="_blank" rel="noreferrer" className="block h-[72px] w-[56px] flex-none overflow-hidden rounded border border-rule bg-paper">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={receiptImage(r.id)} alt={`Receipt${r.merchant ? ` from ${r.merchant}` : ""}`} className="h-full w-full object-cover" />
      </a>
      <div className="min-w-0 flex-1 text-[13px] leading-snug">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="font-bold">{r.merchant ?? r.filename}</span>
          <span className="tab font-bold text-money">{r.total_cents != null ? money(r.total_cents) : "No total"}</span>
        </div>
        <div className="text-muted">
          {[r.cost_line, r.purchased_on].filter(Boolean).join(", ") || "No matching cost"}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={`chip ${st.cls}`}>{r.reader === "claude" ? `${st.label} by Claude` : st.label}</span>
          {onRemove && (
            <button type="button" className="text-[12px] underline" onClick={onRemove}>Remove</button>
          )}
        </div>
        {r.issues.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-[12px] text-stamp">
            {r.issues.slice(0, 3).map((i) => <li key={i}>{i}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function uploadReceipt(questId: string, file: Blob, filename: string, extra: Record<string, unknown> = {}) {
  const data_base64 = await toBase64(file);
  return api<{ quest: QuestDetail }>(`/quests/${questId}/receipts`, {
    method: "POST",
    json: { filename, media_type: file.type || "image/png", data_base64, ...extra },
  });
}

/** Host only. Upload receipts, let Claude read them, then draft the settle up from what they prove. */
export function SettleUp({ q, onChange }: { q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const { config, toast } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState((q.shared_cents / 100).toFixed(2));
  const [total, setTotal] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const live = q.receipts.filter((r) => r.status !== "removed");
  const usable = live.filter((r) => r.status !== "rejected" && r.total_cents != null);
  const aiOff = config?.ai !== "claude";
  const sharedLines = q.cost_lines.filter((l) => l.split === "shared");
  const [line, setLine] = useState(sharedLines[0]?.label ?? "");

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      setBusy(`Reading ${f.name}`);
      try {
        const extra = aiOff ? { total_cents: Math.round(parseFloat(total || "0") * 100) || undefined, cost_line: line } : {};
        const res = await uploadReceipt(q.id, f, f.name, extra);
        onChange(res.quest);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't add that receipt.", "error");
      }
    }
    setBusy(null);
    if (input.current) input.current.value = "";
  };

  const draft = async (json: unknown) => {
    setBusy("Drafting");
    try {
      onChange(await api<QuestDetail>(`/quests/${q.id}/settle`, { method: "POST", json }));
      toast("Settle up drafted. Review it above.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't settle up.", "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    try {
      onChange(await api<QuestDetail>(`/receipts/${id}`, { method: "DELETE" }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove it.", "error");
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t-2 border-dashed border-ink pt-4">
      <div>
        <div className="font-bold">Settle up after the trip</div>
        <p className="mt-1 text-[14px] text-muted">
          Add the receipts for shared costs. {aiOff ? "Enter each total." : "Claude reads each one and checks it."} The difference
          from the {money(q.shared_cents)} estimate becomes refunds, or PayPal invoices with the receipts attached.
        </p>
      </div>
      {aiOff && (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            Receipt total
            <input className="field tab" inputMode="decimal" placeholder="95.00" value={total} onChange={(e) => setTotal(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-semibold">
            Pays for
            <select className="field" value={line} onChange={(e) => setLine(e.target.value)}>
              {sharedLines.map((l) => <option key={l.label}>{l.label}</option>)}
            </select>
          </label>
        </div>
      )}
      <label className={`btn btn-ghost btn-sm cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}>
        {busy?.startsWith("Reading") ? busy : "Add receipt photos"}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only"
          onChange={(e) => onFiles(e.target.files)} />
      </label>
      {live.length > 0 && (
        <div className="flex flex-col gap-2">
          {live.map((r) => <ReceiptCard key={r.id} r={r} onRemove={() => remove(r.id)} />)}
        </div>
      )}
      <button className="btn btn-ink btn-sm" disabled={!!busy || usable.length === 0} onClick={() => draft({})}>
        {busy === "Drafting" ? "Drafting" : `Draft from ${usable.length} receipt${usable.length === 1 ? "" : "s"}`}
      </button>
      <details className="text-[14px]">
        <summary className="cursor-pointer py-1 font-semibold">No receipts? Enter the total</summary>
        <div className="mt-2 flex gap-2">
          <span className="grid place-items-center px-1 font-bold">$</span>
          <input className="field tab" inputMode="decimal" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Real shared total" />
          <button className="btn btn-ghost btn-sm whitespace-nowrap" disabled={!!busy}
            onClick={() => draft({ actual_shared_cents: Math.round(parseFloat(manual) * 100) })}>
            Draft it
          </button>
        </div>
        <p className="mt-1 text-[13px] text-muted">Members will see this was entered without receipts.</p>
      </details>
    </div>
  );
}
