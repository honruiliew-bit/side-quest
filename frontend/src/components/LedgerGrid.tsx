"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
  type IRowNode,
  type ValueFormatterParams,
} from "ag-grid-community";
import { money, timeAgo } from "@/lib/format";
import type { LedgerEntry, LedgerKind } from "@/lib/types";

ModuleRegistry.registerModules([AllCommunityModule]);

export type LedgerRow = LedgerEntry & {
  quest?: { id: string; title: string; line_code: string; tz: string; role: "host" | "member"; tour: boolean };
};

type Row = LedgerRow & { pinned?: boolean };

export const EVENT: Record<LedgerKind, string> = {
  hold: "Hold placed",
  release: "Hold released",
  charge: "Charged",
  refund: "Refunded",
  payout: "Paid out to host",
  invoice: "Invoice sent",
  reauthorize: "Hold renewed",
  decline: "Declined",
};

export const API: Record<LedgerKind, string> = {
  hold: "Orders v2 authorize",
  release: "Void authorization",
  charge: "Capture authorization",
  refund: "Refund capture",
  payout: "Payouts v1",
  invoice: "Agent Toolkit invoice",
  reauthorize: "Reauthorize",
  decline: "PayPal error",
};

const FILTERS: { id: string; label: string; kinds: LedgerKind[] | null }[] = [
  { id: "all", label: "All", kinds: null },
  { id: "holds", label: "Holds", kinds: ["hold", "release", "reauthorize"] },
  { id: "charges", label: "Charges", kinds: ["charge"] },
  { id: "refunds", label: "Refunds", kinds: ["refund"] },
  { id: "payouts", label: "Payouts", kinds: ["payout"] },
  { id: "invoices", label: "Invoices", kinds: ["invoice"] },
];

// The ticket-stock look: ink frame, paper header, blue only for money.
const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 15,
  backgroundColor: "#f7f8f3",
  foregroundColor: "#1a2130",
  textColor: "#1a2130",
  subtleTextColor: "#556070",
  accentColor: "#1f5fd6",
  borderColor: "#c9cfc2",
  headerBackgroundColor: "#e9ede4",
  headerTextColor: "#1a2130",
  headerFontWeight: 700,
  headerRowBorder: { width: 2, color: "#1a2130" },
  wrapperBorder: { width: 2, color: "#1a2130" },
  wrapperBorderRadius: 0,
  borderRadius: 0,
  rowHoverColor: "#ffffff",
  pinnedRowBorder: { width: 2, color: "#1a2130" },
  spacing: 7,
  rowHeight: 56,
  headerHeight: 46,
});

function signed(r: LedgerEntry) {
  return r.kind === "refund" ? -r.cents : r.cents;
}

function source(r: LedgerEntry, paypalMode: string) {
  if (r.provider === "sim") return "Simulated";
  return paypalMode === "mock" ? "Mock" : "Sandbox";
}

function EventCell({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  if (data.pinned) return <span className="font-bold">{data.note}</span>;
  return (
    <span className="flex h-full flex-col justify-center leading-tight">
      <span>{EVENT[data.kind]}</span>
      {data.note && data.kind !== "hold" && (
        <span className="truncate text-[13px] text-muted" title={data.note}>{data.note}</span>
      )}
    </span>
  );
}

function AmountCell({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  const muted = data.kind === "release" || data.kind === "decline";
  return (
    <span className={`tab font-semibold ${muted ? "text-muted" : "text-money"} ${data.pinned ? "text-[17px] font-extrabold" : ""}`}>
      {signed(data) < 0 ? `-${money(-signed(data))}` : money(signed(data))}
    </span>
  );
}

function QuestCell({ data }: ICellRendererParams<Row>) {
  if (!data?.quest) return null;
  return (
    <Link href={`/q/${data.quest.id}`} className="flex h-full items-center gap-2 leading-tight no-underline hover:underline">
      <span
        aria-hidden="true"
        className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-black leading-none text-signal"
        style={{ fontStretch: "62%" }}
      >
        {data.quest.line_code}
      </span>
      <span className="truncate font-semibold">{data.quest.title}</span>
    </Link>
  );
}

export function LedgerGrid({
  rows,
  paypalMode,
  tz,
  showQuest = false,
  fileName,
  pageSize = 10,
}: {
  rows: LedgerRow[];
  paypalMode: string;
  tz?: string;
  showQuest?: boolean;
  fileName: string;
  pageSize?: number;
}) {
  const apiRef = useRef<GridApi<Row> | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [total, setTotal] = useState<Row[]>([]);
  const [shown, setShown] = useState(rows.length);
  const kinds = FILTERS.find((f) => f.id === filter)?.kinds ?? null;

  const SourceCell = useCallback(
    ({ data }: ICellRendererParams<Row>) => {
      if (!data || data.pinned) return null;
      const s = source(data, paypalMode);
      return (
        <span className="flex h-full flex-wrap content-center items-center gap-1 leading-tight">
          <span className={`chip ${s === "Sandbox" ? "chip-held" : "chip-sim"}`}>{s}</span>
          {data.confirmed && <span className="chip chip-held">Webhook</span>}
        </span>
      );
    },
    [paypalMode],
  );

  const columns = useMemo<ColDef<Row>[]>(() => {
    const cols: ColDef<Row>[] = [
      {
        colId: "when",
        headerName: "When",
        valueGetter: (p) => (p.data?.pinned ? null : p.data?.created_at),
        valueFormatter: (p: ValueFormatterParams<Row, string>) =>
          p.value ? timeAgo(p.value, p.data?.quest?.tz ?? tz ?? "America/New_York") : "",
        sort: "desc",
        width: 130,
        filter: false,
        getQuickFilterText: () => "",
      },
      {
        colId: "who",
        headerName: "Who",
        valueGetter: (p) => (p.data?.pinned ? "" : p.data?.user?.name ?? "Sidequest"),
        width: 130,
      },
      {
        colId: "event",
        headerName: "Event",
        valueGetter: (p) => (p.data?.pinned ? p.data.note : p.data ? EVENT[p.data.kind] : ""),
        cellRenderer: EventCell,
        flex: 1.4,
        minWidth: 200,
        getQuickFilterText: (p) => (p.data ? `${EVENT[p.data.kind]} ${p.data.note}` : ""),
      },
      {
        colId: "amount",
        headerName: "Amount",
        type: "rightAligned",
        valueGetter: (p) => (p.data ? signed(p.data) / 100 : 0),
        cellRenderer: AmountCell,
        filter: "agNumberColumnFilter",
        useValueFormatterForExport: false,
        width: 130,
      },
      {
        colId: "api",
        headerName: "PayPal API",
        valueGetter: (p) => (p.data && !p.data.pinned ? API[p.data.kind] : ""),
        width: 190,
      },
      {
        colId: "ref",
        headerName: "PayPal ID",
        valueGetter: (p) => p.data?.ref ?? "",
        cellClass: "font-mono text-[13px]",
        width: 200,
      },
      {
        colId: "source",
        headerName: "Source",
        valueGetter: (p) => (p.data && !p.data.pinned ? source(p.data, paypalMode) + (p.data.confirmed ? ", webhook confirmed" : "") : ""),
        cellRenderer: SourceCell,
        width: 170,
      },
    ];
    if (showQuest) {
      cols.splice(1, 0, {
        colId: "quest",
        headerName: "Quest",
        valueGetter: (p) => p.data?.quest?.title ?? "",
        cellRenderer: QuestCell,
        flex: 1.2,
        minWidth: 220,
      });
    }
    return cols;
  }, [paypalMode, showQuest, tz, SourceCell]);

  const refreshTotal = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    let net = 0;
    let count = 0;
    api.forEachNodeAfterFilter((n: IRowNode<Row>) => {
      if (!n.data) return;
      count += 1;
      if (n.data.kind === "charge") net += n.data.cents;
      if (n.data.kind === "refund") net -= n.data.cents;
    });
    setShown(count);
    setTotal([{
      id: "total", kind: "charge", cents: net, ref: null, provider: "paypal", confirmed: false, user: null,
      created_at: "", note: "Net charged in this view", pinned: true,
    }]);
  }, []);

  // The event filter lives in React state; tell the grid when it changes.
  useEffect(() => {
    apiRef.current?.onFilterChanged();
  }, [filter]);

  const exportCsv = () =>
    apiRef.current?.exportDataAsCsv({
      fileName,
      columnKeys: columns.map((c) => c.colId!),
      skipPinnedBottom: true,
      // Spreadsheet friendly: full timestamps and plain two-decimal amounts.
      processCellCallback: (p) => {
        const id = p.column.getColId();
        if (id === "amount") return Number(p.value ?? 0).toFixed(2);
        if (id === "when") return p.node?.data?.created_at ?? "";
        return p.formatValue ? p.formatValue(p.value) : String(p.value ?? "");
      },
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Filter by event" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={`border-2 border-ink px-3 py-1 text-[14px] font-semibold ${filter === f.id ? "bg-ink text-stock" : "bg-stock hover:bg-white"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <label className="sr-only" htmlFor={`${fileName}-search`}>Search the money log</label>
          <div className="min-w-0 flex-1 sm:w-[240px] sm:flex-none">
            <input
              id={`${fileName}-search`}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, ID, note"
              className="field text-[15px]"
              style={{ minHeight: 40, height: 40 }}
            />
          </div>
          <button type="button" onClick={exportCsv} className="btn btn-ghost shrink-0 text-[15px]" style={{ minHeight: 40, height: 40 }}>
            Export CSV
          </button>
        </div>
      </div>
      <div className="w-full">
        <AgGridReact<Row>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true, filter: "agTextColumnFilter", suppressHeaderMenuButton: false }}
          getRowId={(p) => p.data.id}
          quickFilterText={search}
          isExternalFilterPresent={() => kinds !== null}
          doesExternalFilterPass={(n) => !!n.data && !!kinds && kinds.includes(n.data.kind)}
          pinnedBottomRowData={total}
          domLayout="autoHeight"
          pagination
          paginationPageSize={pageSize}
          paginationPageSizeSelector={[10, 25, 50, 100]}
          overlayNoRowsTemplate="<span>No PayPal events match.</span>"
          onGridReady={(e) => {
            apiRef.current = e.api;
            refreshTotal();
          }}
          onModelUpdated={refreshTotal}
        />
      </div>
      <p className="text-[13px] text-muted">
        {shown} of {rows.length} events. Sort or filter any column. Grid by AG Grid.
      </p>
    </div>
  );
}
