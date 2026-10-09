import type { AgDataSourcesDefinition } from "ag-studio";
import { createFormats } from "ag-studio";
import type { SidequestRegistry } from "./registry";
import type { Books } from "./types";

/** Three related tables from GET /me/books. Every number is in US dollars. */
export function buildStudioData(books: Books): AgDataSourcesDefinition<SidequestRegistry> {
  const ledger = books.ledger.map((e) => ({
    ...e,
    // Money that actually moved to the quest: captures in, refunds out. Holds are only promises.
    net: e.kind === "charge" || e.kind === "refund" ? e.amount : 0,
    paid_out: e.kind === "payout" ? e.amount : 0,
    collected: e.kind === "invoice_paid" ? e.amount : 0,
  }));
  return {
    description:
      "Sidequest group trips paid through PayPal. A quest only runs if enough people hold a spot. " +
      "Holds are PayPal authorizations, captured at the final split when the host locks. " +
      "After the trip, extra costs become PayPal invoices (dues). The host is paid out by PayPal Payouts.",
    sources: [
      {
        id: "quests",
        name: "Quests",
        description: "Trips you host or joined.",
        data: books.quests,
        fields: [
          { id: "id", name: "Quest ID", format: "textFormat", hide: true },
          { id: "title", name: "Quest", format: "textFormat" },
          { id: "line", name: "Line", format: "textFormat" },
          { id: "status", name: "Quest status", format: "textFormat" },
          { id: "role", name: "Your role", format: "textFormat" },
          { id: "host", name: "Host", format: "textFormat" },
          { id: "starts_at", name: "Trip date", format: "dateTimeFormat" },
          { id: "travelers", name: "Travelers", format: "integerFormat" },
          { id: "min_people", name: "Minimum group", format: "integerFormat" },
        ],
      },
      {
        id: "ledger",
        name: "PayPal events",
        description: "One row per money event: hold, charge, release, refund, invoice, invoice paid, payout.",
        data: ledger,
        fields: [
          { id: "id", name: "Event ID", format: "textFormat", hide: true },
          { id: "quest_id", name: "Quest ID", format: "textFormat", hide: true },
          { id: "at", name: "When", format: "dateTimeFormat" },
          { id: "person", name: "Person", format: "textFormat" },
          { id: "event", name: "Event", format: "textFormat" },
          { id: "kind", name: "Event code", format: "textFormat", hide: true },
          { id: "amount", name: "Amount", format: "currencyFormat" },
          { id: "net", name: "Net charged", format: "currencyFormat", description: "Captures minus refunds." },
          { id: "paid_out", name: "Paid out", format: "currencyFormat", description: "PayPal Payouts to the host." },
          { id: "collected", name: "Collected by invoice", format: "currencyFormat" },
          { id: "source", name: "Source", format: "textFormat" },
          { id: "confirmed", name: "Webhook confirmed", format: "textFormat" },
        ],
      },
      {
        id: "dues",
        name: "Invoices",
        description: "PayPal invoices for each person's share of costs that came in over the estimate.",
        data: books.dues,
        fields: [
          { id: "id", name: "Invoice", format: "textFormat" },
          { id: "quest_id", name: "Quest ID", format: "textFormat", hide: true },
          { id: "person", name: "Person", format: "textFormat" },
          { id: "amount", name: "Owed", format: "currencyFormat" },
          { id: "status", name: "Invoice status", format: "textFormat" },
          { id: "item", name: "For", format: "textFormat" },
          { id: "sent_at", name: "Sent", format: "dateTimeFormat" },
          { id: "days_open", name: "Days open", format: "integerFormat" },
          { id: "reminders", name: "Reminders", format: "integerFormat" },
          { id: "source", name: "Source", format: "textFormat", hide: true },
        ],
      },
    ],
    relationships: [
      { id: "ledger-quest", source: { tableId: "ledger", fieldId: "quest_id" }, target: { tableId: "quests", fieldId: "id" }, type: "many-to-one" },
      { id: "dues-quest", source: { tableId: "dues", fieldId: "quest_id" }, target: { tableId: "quests", fieldId: "id" }, type: "many-to-one" },
    ],
    formats: createFormats({ overrides: { currencyFormat: { formatOptions: { format: "$#,##0.00" } } } }),
  };
}
