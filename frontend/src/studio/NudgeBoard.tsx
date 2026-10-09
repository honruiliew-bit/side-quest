"use client";

import { useEffect, useState } from "react";
import type { AgWidgetParams } from "ag-studio";
import { money } from "@/lib/format";
import type { NudgeBoardDefinition, NudgeBoardWidget } from "./registry";
import type { DeskContext } from "./types";

type Row = { invoice: string; person: string; quest: string; cents: number; days: number };

export function friendlyNote(person: string, quest: string, cents: number) {
  const first = person.split(" ")[0];
  return `Hey ${first}! Quick heads-up: your ${money(cents)} share of the extra costs on ${quest} is still open on PayPal. The receipts are linked on the invoice. Thanks for coming!`;
}

/** A friendly scoreboard of open invoices. It queries Studio's data engine, so filters and cross-filters apply. */
export function NudgeBoard(params: AgWidgetParams<NudgeBoardWidget, unknown, DeskContext>) {
  const { widgetApi, dataMapping, format, context } = params;
  const [rows, setRows] = useState<Row[]>([]);
  const maxRows = format?.style?.maxRows ?? 8;

  useEffect(() => {
    const f = {
      invoice: dataMapping.invoice?.[0],
      person: dataMapping.person?.[0],
      quest: dataMapping.quest?.[0],
      amount: dataMapping.amount?.[0],
      days: dataMapping.days?.[0],
    };
    if (!f.invoice || !f.person || !f.amount) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    let cancelled = false;
    const fields = [f.invoice, f.person, f.amount, ...(f.quest ? [f.quest] : []), ...(f.days ? [f.days] : [])];
    widgetApi.setDisplayState("loading", { prominent: false });
    widgetApi
      .getData({ fields, sort: [{ field: f.amount, direction: "desc" }], limit: { count: maxRows } })
      .then((res) => {
        if (cancelled) return;
        const next = res.results.rows.map((r) => ({
          invoice: String(r[f.invoice!.key] ?? ""),
          person: String(r[f.person!.key] ?? ""),
          quest: f.quest ? String(r[f.quest.key] ?? "") : "",
          cents: Math.round(Number(r[f.amount!.key] ?? 0) * 100),
          days: f.days ? Number(r[f.days.key] ?? 0) : 0,
        }));
        setRows(next);
        widgetApi.setDisplayState(next.length ? "displayed" : "noData");
      })
      .catch(() => !cancelled && widgetApi.setDisplayState("noData"));
    return () => {
      cancelled = true;
    };
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = rows.reduce((a, r) => a + r.cents, 0);
  const desk = context?.current;

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      <div className="flex items-baseline justify-between px-1 text-[13px] text-muted">
        <span>{rows.length} open</span>
        <span className="tab font-bold text-money">{money(total)} to collect</span>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
        {rows.map((r, i) => {
          const due = desk?.dues.get(r.invoice);
          const late = r.days >= 7;
          return (
            <li key={r.invoice} className="flex items-center gap-3 border-2 border-ink bg-stock px-3 py-2">
              <span className="tab w-5 text-center text-[15px] font-extrabold text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate font-bold">{r.person}</div>
                <div className="truncate text-[12px] text-muted">
                  {r.quest}
                  {" · "}
                  <span className={late ? "font-semibold text-stamp" : ""}>{r.days === 0 ? "sent today" : `${r.days}d open`}</span>
                  {due && due.reminders > 0 ? ` · nudged ${due.reminders}x` : ""}
                </div>
              </div>
              <span className="tab text-[15px] font-bold text-money">{money(r.cents)}</span>
              {due?.can_remind ? (
                <button
                  type="button"
                  className="border-2 border-ink bg-signal px-2 py-1 text-[12px] font-bold hover:bg-white"
                  onClick={() =>
                    desk?.openDraft({
                      invoiceId: r.invoice,
                      subject: `Reminder: ${r.quest}`,
                      note: friendlyNote(r.person, r.quest, r.cents),
                      by: "host",
                    })
                  }
                >
                  Nudge
                </button>
              ) : due && due.source === "Sandbox" && due.paypal_id ? (
                <a
                  className="border-2 border-ink px-2 py-1 text-[12px] font-bold no-underline hover:bg-white"
                  href={`https://www.sandbox.paypal.com/invoice/p/#${due.paypal_id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on PayPal
                </a>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export const nudgeBoardDefinition: NudgeBoardDefinition = {
  id: "nudge-board",
  label: "Who still owes",
  dataMapping: {
    invoice: { type: "field", supportedRoles: ["category"], requires: { cardinality: "many" }, required: true,
      aiDescription: "The invoice id. One row per invoice." },
    person: { type: "field", supportedRoles: ["category"], required: true, aiDescription: "Who owes the money." },
    quest: { type: "field", supportedRoles: ["category"], aiDescription: "The quest the invoice is for." },
    amount: { type: "field", supportedRoles: ["numeric"], requires: { per: "dataMapping.invoice", cardinality: "one" },
      required: true, aiDescription: "Amount owed in USD, summed per invoice." },
    days: { type: "field", supportedRoles: ["numeric"], aiDescription: "Days the invoice has been open." },
  },
  form: (formParams) =>
    formParams.createDefaults({
      dataMappingItems: [
        { key: "invoice", label: "Invoice" },
        { key: "person", label: "Person" },
        { key: "quest", label: "Quest" },
        { key: "amount", label: "Amount" },
        { key: "days", label: "Days open" },
      ],
    }),
  comp: NudgeBoard,
  defaultSize: { width: 8, height: 18 },
  minSize: { width: 6, height: 10 },
  ai: {
    description: "Scoreboard of unpaid PayPal invoices, largest first, with a Nudge button that opens a reminder for the host to review.",
    usage: "Use for who still owes money. Map invoice to dues.id, person to dues.person, quest to quests.title, amount to dues.amount (sum), days to dues.days_open (max), with a widget filter dues.status equals Open.",
  },
};
