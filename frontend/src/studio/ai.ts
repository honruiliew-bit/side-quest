import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiTool, type AgStudioApi } from "ag-studio";
import { API_URL } from "@/lib/api";
import { money } from "@/lib/format";
import { claudeProxyAdapter } from "./claudeAdapter";
import type { DeskContext } from "./types";

const RULES = `
You work on Sidequest's host desk: group trips paid through PayPal.
- Holds are PayPal authorizations. Charges are captures at the final split. Refunds go back to members.
- Dues are PayPal invoices for each person's share of costs that came in over the estimate.
- You can build and change dashboard widgets freely.
- You never send messages or move money. draft_payment_reminder only opens a draft that the host reads, edits and sends.
- Keep reminders short, warm and specific: name, amount, trip, and that the receipts are on the invoice. No guilt.
- Answer in plain sentences. No em dashes.`;

/** Claude writes the nudge. The app opens it for the host, who decides whether PayPal sends it. */
function draftReminderTool(api: AgStudioApi, desk: DeskContext): AgAiTool {
  return api.defineAiTool({
    name: "draft_payment_reminder",
    description:
      "Draft a friendly PayPal reminder for one open invoice. Opens the draft for the host to review and send. " +
      "Get the invoice id from the dues table (dues.id) first. Never claims the reminder was sent.",
    params: (s) =>
      s.object({
        invoice_id: s.string({ description: "dues.id of an open invoice, e.g. iv_AbC123." }),
        subject: s.string({ description: "Short email subject, under 80 characters." }),
        note: s.string({ description: "The reminder text, two or three friendly sentences." }),
      }),
    execute: async (args, ctx) => {
      const due = desk.current.dues.get(args.invoice_id);
      if (!due) return ctx.error(`No invoice ${args.invoice_id}. Query dues.id for open invoices first.`);
      if (due.status !== "Open") return ctx.error(`${due.person}'s invoice is already ${due.status.toLowerCase()}.`);
      if (!due.can_remind) return ctx.error(`Only the host can nudge ${due.person}, and at most 3 times.`);
      desk.current.openDraft({ invoiceId: due.id, subject: args.subject, note: args.note, by: "claude" });
      return ctx.success(
        `Opened a draft to ${due.person} for ${money(Math.round(due.amount * 100))}. The host will review it. Nothing has been sent.`,
      );
    },
  });
}

export const PROMPT_STARTERS = [
  { label: "Who owes the most?", prompt: "Who still owes money, and how long has each invoice been open?" },
  { label: "Nudge the oldest invoice", prompt: "Find the open invoice that has been open longest and draft a friendly reminder for it." },
  { label: "Refunds by quest", prompt: "Add a bar chart of refunds by quest next to the charges chart." },
  {
    label: "Spot anything odd",
    prompt: "Look at the PayPal events for anything unusual, like refunds above 20% of charges on a quest, declines, or invoices open more than two weeks. Add a widget that shows what you find.",
  },
];

export function makeDeskAi(desk: DeskContext): AgAiHarnessSetup {
  return ({ api }) => {
    const adapter = claudeProxyAdapter({ endpoint: `${API_URL}/studio/llm` });
    const draftReminder = draftReminderTool(api, desk);
    return createAiHarness(api, ({ builtIn }) => ({
      agents: [
        directLlmRunner({
          ...builtIn.lead,
          adapter,
          instructions: (ctx, p) => `${builtIn.lead.instructions?.(ctx, p) ?? ""}\n${RULES}`,
          tools: (ctx, p) => [...(builtIn.lead.tools?.(ctx, p) ?? []), draftReminder],
        }),
        directLlmRunner({ ...builtIn.planning, adapter }),
        directLlmRunner({ ...builtIn.data, adapter }),
        directLlmRunner({ ...builtIn.page, adapter }),
        directLlmRunner({ ...builtIn.widget, adapter }),
      ],
      primary: "lead",
      promptStarters: PROMPT_STARTERS,
    }));
  };
}
