"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import { API, EVENT } from "@/lib/ledger";
import { api } from "@/lib/api";
import { money, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { LineDot } from "./parts";
import type { Payment, StatementRow } from "./types";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 14,
  backgroundColor: "#f7f8f3",
  foregroundColor: "#1a2130",
  textColor: "#1a2130",
  subtleTextColor: "#556070",
  accentColor: "#1f5fd6",
  borderColor: "#c9cfc2",
  headerBackgroundColor: "#e9ede4",
  headerFontWeight: 700,
  headerRowBorder: { width: 2, color: "#1a2130" },
  wrapperBorder: { width: 2, color: "#1a2130" },
  wrapperBorderRadius: 0,
  borderRadius: 0,
  rowHoverColor: "#ffffff",
  spacing: 6,
  rowHeight: 52,
  headerHeight: 44,
});

const CHECK: Record<string, { text: string; chip: string }> = {
  matched: { text: "Matches PayPal", chip: "chip-paid" },
  mismatch: { text: "Doesn't match", chip: "chip-refund" },
  missing: { text: "Not on PayPal", chip: "chip-refund" },
  error: { text: "Couldn't check", chip: "chip-sim" },
  simulated: { text: "Simulated", chip: "chip-sim" },
};

const VIEWS: { id: string; label: string; test: (p: Payment) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "issues", label: "Needs a look", test: (p) => p.recon_status === "mismatch" || p.recon_status === "missing" || p.recon_status === "error" },
  { id: "charge", label: "Charges", test: (p) => p.kind === "charge" },
  { id: "refund", label: "Refunds", test: (p) => p.kind === "refund" },
  { id: "payout", label: "Payouts", test: (p) => p.kind === "payout" },
  { id: "invoice", label: "Invoices", test: (p) => p.kind === "invoice" || p.kind === "invoice_paid" },
];

function signed(p: Payment) {
  return p.kind === "refund" ? -p.cents : p.cents;
}

function QuestCell({ data }: ICellRendererParams<Payment>) {
  if (!data) return null;
  return (
    <span className="flex h-full items-center gap-2 leading-tight">
      <LineDot code={data.quest.line_code} />
      <span className="min-w-0">
        <span className="block truncate font-semibold">{data.quest.title}</span>
        <span className="text-[12px] text-muted">{data.quest.code}</span>
      </span>
    </span>
  );
}

function CheckCell({ data }: ICellRendererParams<Payment>) {
  if (!data) return null;
  const c = data.recon_status ? CHECK[data.recon_status] : null;
  return (
    <span className="flex h-full flex-wrap content-center items-center gap-1" title={data.recon_note ?? ""}>
      {c ? <span className={`chip ${c.chip}`}>{c.text}</span> : <span className="text-[13px] text-muted">Not checked</span>}
      {data.confirmed && <span className="chip chip-held">Webhook</span>}
    </span>
  );
}

export function PaymentsTab({ onChanged }: { onChanged: () => void }) {
  const { toast, config } = useSession();
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [view, setView] = useState("all");
  const [search, setSearch] = useState("");
  const [checking, setChecking] = useState(false);
  const gridRef = useRef<GridApi<Payment> | null>(null);
  const test = VIEWS.find((v) => v.id === view)?.test ?? (() => true);

  const load = useCallback(() => {
    api<Payment[]>("/admin/payments").then(setRows).catch((e) => toast(e.message, "error"));
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    gridRef.current?.onFilterChanged();
  }, [view]);

  const reconcile = async () => {
    setChecking(true);
    try {
      const r = await api<{ checked: number; matched: number; mismatch: number; missing: number; error: number; simulated: number; fees_updated: number }>(
        "/admin/reconcile", { method: "POST" });
      const bad = r.mismatch + r.missing;
      toast(
        r.checked
          ? `Checked ${r.checked} with PayPal: ${r.matched} match${bad ? `, ${bad} need a look` : ""}. ${r.fees_updated} fees updated from PayPal.`
          : `Nothing to check on PayPal. ${r.simulated} simulated payments skipped.`,
        bad ? "error" : "money",
      );
      load();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't reach PayPal.", "error");
    } finally {
      setChecking(false);
    }
  };

  const columns = useMemo<ColDef<Payment>[]>(() => [
    {
      colId: "when", headerName: "When", field: "created_at", sort: "desc", width: 105,
      valueFormatter: (p: ValueFormatterParams<Payment, string>) => (p.value ? timeAgo(p.value, p.data?.quest.tz ?? "America/New_York") : ""),
    },
    { colId: "quest", headerName: "Quest", valueGetter: (p) => p.data?.quest.title, cellRenderer: QuestCell, flex: 1.3, minWidth: 200 },
    { colId: "who", headerName: "Who", valueGetter: (p) => p.data?.user?.name ?? "Sidequest", width: 95 },
    {
      colId: "event", headerName: "Event", valueGetter: (p) => (p.data ? EVENT[p.data.kind] : ""), width: 180,
      cellRenderer: ({ data }: ICellRendererParams<Payment>) => data ? (
        <span className="flex h-full flex-col justify-center leading-tight">
          <span>{EVENT[data.kind]}</span>
          <span className="text-[12px] text-muted">{API[data.kind]}</span>
        </span>
      ) : null,
      getQuickFilterText: (p) => (p.data ? `${EVENT[p.data.kind]} ${API[p.data.kind]}` : ""),
    },
    {
      colId: "amount", headerName: "Amount", type: "rightAligned", width: 110,
      valueGetter: (p) => (p.data ? signed(p.data) / 100 : 0),
      valueFormatter: (p) => (p.value < 0 ? `-${money(-p.value * 100)}` : money(p.value * 100)),
      cellClass: "tab font-semibold",
    },
    {
      colId: "fee", headerName: "PayPal fee", type: "rightAligned", width: 110,
      valueGetter: (p) => (p.data?.fee_cents ?? 0) / 100,
      valueFormatter: (p) => (p.value ? (p.value < 0 ? `-${money(-p.value * 100)}` : money(p.value * 100)) : ""),
      tooltipValueGetter: (p) => (p.data?.fee_source === "estimate" ? "Estimated at PayPal's US rate" : p.data?.fee_source === "paypal" ? "Reported by PayPal" : ""),
      cellClass: (p) => `tab ${p.data?.fee_source === "estimate" ? "text-muted italic" : ""}`,
    },
    { colId: "ref", headerName: "PayPal ID", field: "ref", cellClass: "font-mono text-[12px]", width: 165 },
    { colId: "check", headerName: "Check", valueGetter: (p) => (p.data?.recon_status ? CHECK[p.data.recon_status].text : "Not checked"), cellRenderer: CheckCell, width: 165 },
  ], []);

  const issues = (rows ?? []).filter(VIEWS[1].test).length;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="pay-h">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-[640px]">
            <h2 id="pay-h" className="h2">Every payment</h2>
            <p className="text-[14px] text-muted">
              All PayPal events across Sidequest. &quot;Check with PayPal&quot; fetches each capture, refund, payout and invoice from
              PayPal, compares the amount and status, and records the fee PayPal actually charged.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-ghost" onClick={() => gridRef.current?.exportDataAsCsv({ fileName: "sidequest-payments" })}>Export CSV</button>
            <button className="btn btn-ink" onClick={reconcile} disabled={checking}>{checking ? "Checking with PayPal..." : "Check with PayPal"}</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter payments" className="flex flex-wrap gap-2">
            {VIEWS.map((v) => (
              <button key={v.id} type="button" onClick={() => setView(v.id)} aria-pressed={view === v.id}
                className={`border-2 border-ink px-3 py-1 text-[14px] font-semibold ${view === v.id ? "bg-ink text-stock" : "bg-stock hover:bg-white"}`}>
                {v.label}{v.id === "issues" && issues ? ` (${issues})` : ""}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor="pay-search">Search payments</label>
          <input id="pay-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, quest, PayPal ID"
            className="field ml-auto w-full text-[15px] sm:w-[260px]" style={{ minHeight: 40, height: 40 }} />
        </div>
        {rows === null ? (
          <div className="skeleton h-[400px]" />
        ) : (
          <AgGridReact<Payment>
            theme={theme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={{ sortable: true, resizable: true, filter: true }}
            getRowId={(p) => p.data.id}
            quickFilterText={search}
            isExternalFilterPresent={() => view !== "all"}
            doesExternalFilterPass={(n) => !!n.data && test(n.data)}
            domLayout="autoHeight"
            pagination
            paginationPageSize={15}
            paginationPageSizeSelector={[15, 50, 100]}
            tooltipShowDelay={300}
            onGridReady={(e) => { gridRef.current = e.api; }}
          />
        )}
        {config?.paypal_mode === "mock" && (
          <p className="text-[13px] text-muted">PayPal is in mock mode on this server, so every payment is simulated and there is nothing on PayPal to check against.</p>
        )}
      </section>
      <Statement />
    </div>
  );
}

function Statement() {
  const { toast } = useSession();
  const [data, setData] = useState<{ ok: boolean; error?: string; rows: StatementRow[]; days: number; unmatched?: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      setData(await api("/admin/statement?days=14"));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't reach PayPal.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel flex flex-col gap-3 p-5" aria-labelledby="stmt-h">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-[640px]">
          <h2 id="stmt-h" className="h3">PayPal&apos;s side</h2>
          <p className="text-[14px] text-muted">
            The platform account&apos;s statement from PayPal&apos;s Transaction Search, matched against Sidequest&apos;s books. Anything
            not in the books is money we didn&apos;t record. New sandbox transactions can take up to 3 hours to appear.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={load} disabled={busy}>{busy ? "Asking PayPal..." : data ? "Reload" : "Load the last 14 days"}</button>
      </div>
      {data && !data.ok && <p className="border-l-4 border-stamp bg-white px-3 py-2 text-[14px]">{data.error}</p>}
      {data?.ok && (
        data.rows.length === 0 ? (
          <p className="text-[14px]">PayPal lists no transactions in the last {data.days} days.</p>
        ) : (
          <div className="overflow-x-auto">
            <p className="mb-2 text-[14px] font-semibold">
              {data.rows.length} transactions. {data.unmatched ? `${data.unmatched} not in Sidequest's books.` : "All in Sidequest's books."}
            </p>
            <table className="w-full min-w-[720px] text-left text-[14px]">
              <thead className="border-b-2 border-ink">
                <tr><th className="py-2 pr-3">When</th><th className="pr-3">Type</th><th className="pr-3">PayPal ID</th><th className="pr-3 text-right">Amount</th><th className="pr-3 text-right">Fee</th><th>In our books</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-b border-rule">
                    <td className="py-2 pr-3">{r.at ? new Date(r.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</td>
                    <td className="pr-3">{r.event} <span className="text-[12px] text-muted">{r.event_code}</span></td>
                    <td className="pr-3 font-mono text-[12px]">{r.id}</td>
                    <td className="tab pr-3 text-right">{r.cents != null ? money(r.cents) : ""}</td>
                    <td className="tab pr-3 text-right text-muted">{r.fee_cents ? money(r.fee_cents) : ""}</td>
                    <td>{r.in_books ? <span className="chip chip-paid">Yes</span> : <span className="chip chip-refund">No</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}
