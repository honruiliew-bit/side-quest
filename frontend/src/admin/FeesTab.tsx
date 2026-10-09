"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import { COLORS, SplitBar, pct } from "./parts";
import type { Fees, Preview } from "./types";

const STREAMS = [
  { title: "Booking fee", text: "A percent plus a small fixed amount on each person's share. It's inside the hold, so nobody pays more than they approved. Kept unless that person is fully refunded." },
  { title: "Host fee", text: "A percent of the host's payout. Zero at launch so hosts have no reason to collect cash on the side." },
  { title: "Fees are locked per quest", text: "A quest keeps the fees it was posted with. A change here only applies to quests posted after it." },
];

export function FeesTab({ onChanged }: { onChanged: () => void }) {
  const { toast, config } = useSession();
  const [fees, setFees] = useState<Fees | null>(null);
  const [bookingPct, setBookingPct] = useState("");
  const [fixed, setFixed] = useState("");
  const [hostPct, setHostPct] = useState("");
  const [reason, setReason] = useState("");
  const [share, setShare] = useState("75.00");
  const [people, setPeople] = useState(6);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);

  const fill = useCallback((f: Fees) => {
    setFees(f);
    setBookingPct((f.current.booking_bps / 100).toString());
    setFixed((f.current.booking_fixed_cents / 100).toFixed(2));
    setHostPct((f.current.host_bps / 100).toString());
  }, []);

  useEffect(() => {
    api<Fees>("/admin/fees").then(fill).catch((e) => toast(e.message, "error"));
  }, [fill, toast]);

  const bps = Math.round(parseFloat(bookingPct || "0") * 100);
  const fixedCents = Math.round(parseFloat(fixed || "0") * 100);
  const hostBps = Math.round(parseFloat(hostPct || "0") * 100);
  const baseCents = Math.round(parseFloat(share || "0") * 100);
  const valid = fees && bps >= 0 && bps <= fees.limits.booking_bps && fixedCents >= 0 && fixedCents <= fees.limits.booking_fixed_cents
    && hostBps >= 0 && hostBps <= fees.limits.host_bps;
  const changed = fees && (bps !== fees.current.booking_bps || fixedCents !== fees.current.booking_fixed_cents || hostBps !== fees.current.host_bps);

  useEffect(() => {
    if (!valid || baseCents <= 0) return;
    const t = window.setTimeout(() => {
      api<Preview>("/admin/fees/preview", {
        method: "POST",
        json: { booking_bps: bps, booking_fixed_cents: fixedCents, host_bps: hostBps, base_cents: baseCents, people },
      }).then(setPreview).catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(t);
  }, [bps, fixedCents, hostBps, baseCents, people, valid]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      fill(await api<Fees>("/admin/fees", { method: "POST", json: { booking_bps: bps, booking_fixed_cents: fixedCents, host_bps: hostBps, reason } }));
      setReason("");
      toast("New fees saved. They apply to quests posted from now on.", "money");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save the fees.", "error");
    } finally {
      setSaving(false);
    }
  };

  if (!fees) return <div className="skeleton h-[480px]" />;

  return (
    <div className="flex flex-col gap-8">
      <section className="grid gap-3 md:grid-cols-3" aria-label="How Sidequest earns">
        {STREAMS.map((s) => (
          <div key={s.title} className="panel p-4">
            <h3 className="font-bold">{s.title}</h3>
            <p className="mt-1 text-[14px] leading-snug text-muted">{s.text}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <form onSubmit={save} className="panel flex flex-col gap-4 p-5" aria-labelledby="edit-h">
          <div>
            <h2 id="edit-h" className="h3">Fee schedule</h2>
            <p className="text-[14px] text-muted">Now: <strong className="text-ink">{fees.current.label}</strong>, since {new Date(fees.current.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Num label="Booking fee" suffix="%" value={bookingPct} onChange={setBookingPct} hint={`Up to ${pct(fees.limits.booking_bps)}`} />
            <Num label="Plus per person" prefix="$" value={fixed} onChange={setFixed} hint={`Up to ${money(fees.limits.booking_fixed_cents)}`} />
            <Num label="Host fee" suffix="%" value={hostPct} onChange={setHostPct} hint="Of the host's payout" />
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[14px] font-semibold">Why the change</span>
            <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required
              placeholder="Goes in the audit log next to your name" />
          </label>
          {!valid && <p className="text-[14px] text-stamp">Booking fee up to 20% plus $5.00, host fee up to 20%.</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-ink" disabled={!valid || !changed || saving || reason.trim().length < 3}>
              {saving ? "Saving..." : "Apply to new quests"}
            </button>
            <span className="text-[13px] text-muted">
              {fees.active_quests} active quests keep the fees they were posted with.
              {config?.demo_reset ? ` In the demo, changes last until the nightly reset at ${config.demo_reset}.` : ""}
            </span>
          </div>
        </form>

        <section className="panel flex flex-col gap-4 p-5" aria-labelledby="prev-h">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="prev-h" className="h3">One person&apos;s share</h2>
              <p className="text-[14px] text-muted">With the fees on the left, before you save.</p>
            </div>
            <div className="flex gap-2">
              <Num label="Share" prefix="$" value={share} onChange={setShare} small />
              <label className="flex w-[90px] flex-col gap-1">
                <span className="text-[13px] font-semibold">People</span>
                <input className="field tab" type="number" min={1} max={40} value={people} onChange={(e) => setPeople(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} />
              </label>
            </div>
          </div>
          {preview && (
            <>
              <p className="text-[15px]">
                Each person approves <strong>{money(preview.price_cents)}</strong>. Sidequest keeps{" "}
                <strong className={preview.sidequest_net_cents < 0 ? "text-stamp" : "text-money"}>{money(preview.sidequest_net_cents)}</strong>{" "}
                after PayPal, {pct(preview.take_rate_bps)} of the charge.
              </p>
              <SplitBar
                compact
                label="Where one share goes"
                total={preview.price_cents}
                slices={[
                  { label: "Host", cents: preview.host_gets_cents, color: COLORS.host },
                  { label: "PayPal", cents: preview.paypal_cents, color: COLORS.paypal, text: "3.49% + $0.49, plus a share of the payout fee" },
                  { label: "Sidequest", cents: Math.max(preview.sidequest_net_cents, 0), color: COLORS.sidequest },
                ]}
              />
              {preview.sidequest_net_cents < 0 && (
                <p className="border-l-4 border-stamp bg-white px-3 py-2 text-[14px]">These fees don&apos;t cover PayPal. Sidequest would lose {money(-preview.sidequest_net_cents)} on every person.</p>
              )}
            </>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="hist-h">
        <h2 id="hist-h" className="h3">History</h2>
        <ol className="flex flex-col border-2 border-ink bg-stock">
          {fees.history.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-4 py-3 last:border-b-0">
              <span>
                <span className="font-bold">{s.label}</span>
                {i === 0 && <span className="chip chip-paid ml-2">Current</span>}
                <span className="block text-[14px] text-muted">{s.reason}</span>
              </span>
              <span className="text-[13px] text-muted">{s.by}, {new Date(s.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Num({ label, value, onChange, prefix, suffix, hint, small }: {
  label: string; value: string; onChange: (v: string) => void; prefix?: string; suffix?: string; hint?: string; small?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${small ? "w-[120px]" : ""}`}>
      <span className={`${small ? "text-[13px]" : "text-[14px]"} font-semibold`}>{label}</span>
      <span className="flex items-center gap-1">
        {prefix && <span aria-hidden="true" className="font-bold">{prefix}</span>}
        <input className="field tab" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} />
        {suffix && <span aria-hidden="true" className="font-bold">{suffix}</span>}
      </span>
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </label>
  );
}
