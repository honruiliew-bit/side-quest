import type { AgReportState, AgWidgetLayoutState } from "ag-studio";
import type { SidequestRegistry } from "./registry";

// 24-column canvas, 16px rows.
const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string) => ({ title: { enabled: true, text } });
// KPI tiles: big condensed numbers in money blue.
const kpi = (text: string) => ({ ...title(text), style: { typography: { fontSize: 36, fontWeight: "bold" as const }, color: "#1f5fd6" } });
const openOnly = [{ field: { id: "dues.status" }, model: { operator: "equals" as const, value: "Open" } }];

export const initialState: AgReportState<SidequestRegistry> = {
  version: "3.0.0",
  selectedPageId: "desk",
  panels: { filters: { collapsed: true } },
  pages: [
    {
      id: "desk",
      widgets: {
        net: {
          type: "value",
          format: kpi("Net charged"),
          dataMapping: { value: [{ id: "ledger.net", aggregation: "sum" }], sparklineX: [{ id: "ledger.at::week" }] },
        },
        paidOut: { type: "value", format: kpi("Paid out to you"), dataMapping: { value: [{ id: "ledger.paid_out", aggregation: "sum" }] } },
        owed: { type: "value", format: kpi("Still owed"), dataMapping: { value: [{ id: "dues.amount", aggregation: "sum" }] } },
        collected: { type: "value", format: kpi("Collected by invoice"), dataMapping: { value: [{ id: "ledger.collected", aggregation: "sum" }] } },
        questFilter: {
          type: "button-filter",
          format: {
            ...title("Quest"),
            style: {
              dimensions: { height: 40, minWidth: 180 },
              defaultItem: { backgroundColor: "#f7f8f3", color: "#1a2130", borderEnabled: true, borderWidth: 2, borderColor: "#1a2130", borderRadius: 0 },
              activeItem: { backgroundColor: "#ffc93c", color: "#1a2130", borderColor: "#1a2130" },
            },
          },
          dataMapping: { value: [{ id: "quests.title" }] },
        },
        byQuest: {
          type: "bar-chart-grouped",
          format: title("Charged by quest"),
          dataMapping: { categoryKey: [{ id: "quests.title" }], valueKey: [{ id: "ledger.net", aggregation: "sum" }] },
          sort: [{ field: { id: "ledger.net", aggregation: "sum" }, direction: "desc" }],
        },
        nudge: {
          type: "nudge-board",
          format: title("Who still owes"),
          dataMapping: {
            invoice: [{ id: "dues.id" }],
            person: [{ id: "dues.person" }],
            quest: [{ id: "quests.title" }],
            amount: [{ id: "dues.amount", aggregation: "sum" }],
            days: [{ id: "dues.days_open", aggregation: "max" }],
          },
        },
        invoiceStatus: {
          type: "donut-chart",
          format: title("Invoices"),
          dataMapping: { categoryKey: [{ id: "dues.status" }], valueKey: [{ id: "dues.amount", aggregation: "sum" }] },
        },
        trend: {
          type: "line-chart",
          format: title("Net charged by week"),
          dataMapping: { categoryKey: [{ id: "ledger.at::week" }], valueKey: [{ id: "ledger.net", aggregation: "sum" }] },
          sort: [{ field: { id: "ledger.at::week" }, direction: "asc" }],
        },
        events: {
          type: "grid",
          format: title("Every PayPal call"),
          dataMapping: {
            cols: [
              { id: "ledger.at" }, { id: "quests.title" }, { id: "ledger.person" }, { id: "ledger.event" },
              { id: "ledger.amount" }, { id: "ledger.api" }, { id: "ledger.paypal_id" }, { id: "ledger.source" },
            ],
          },
          sort: [{ field: { id: "ledger.at" }, direction: "desc" }],
        },
      },
      widgetLayout: {
        net: at(0, 0, 6, 7),
        paidOut: at(6, 0, 6, 7),
        owed: at(12, 0, 6, 7),
        collected: at(18, 0, 6, 7),
        questFilter: at(0, 7, 24, 9),
        byQuest: at(0, 16, 16, 18),
        nudge: at(16, 16, 8, 34),
        invoiceStatus: at(0, 34, 7, 16),
        trend: at(7, 34, 9, 16),
        events: at(0, 50, 24, 26),
      },
      filter: { widget: { owed: openOnly, nudge: openOnly } },
    },
  ],
};
