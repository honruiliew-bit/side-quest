"use client";

import { useMemo, useRef, useState } from "react";
import { AgStudioAiModule, type AgAiToolLabelParams, type AgStudioMode, type AgWidgetsConfig } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { useSession } from "@/lib/session";
import { makeDeskAi } from "./ai";
import { buildStudioData } from "./data";
import { initialState } from "./initialState";
import { nudgeBoardDefinition } from "./NudgeBoard";
import type { SidequestRegistry } from "./registry";
import { ReminderDialog } from "./ReminderDialog";
import { sidequestTheme } from "./theme";
import type { Books, DeskContext, ReminderDraft } from "./types";

// Studio compares props by reference, so everything static lives at module level.
const MODULES = [AgStudioAiModule];
const STYLE = { height: "100%", width: "100%" };
const LAYOUT = { widgetBorderEnabled: true };
const LICENSE = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE || undefined;
const AI_TOOL_DISPLAY = {
  draft_payment_reminder: {
    label: ({ result }: AgAiToolLabelParams) => ({
      text: result ? (result.success ? "Opened a reminder for you to review" : "Couldn't draft that reminder") : "Drafting a reminder",
      pill: result && !result.success ? "failed" : undefined,
    }),
  },
};
const widgets = (defaults: AgWidgetsConfig) =>
  createWidgets<SidequestRegistry>({
    additionalTypes: [nudgeBoardDefinition],
    menu: [...defaults.menu, { label: "Sidequest", widgetIds: ["nudge-board"] }],
  });

export default function HostDesk({ books, mode, onChanged }: { books: Books; mode: AgStudioMode; onChanged: () => void }) {
  const { toast } = useSession();
  const [draft, setDraft] = useState<ReminderDraft | null>(null);

  // Studio reads `context` and `ai` once, so they hold a ref that always points at fresh app state.
  const desk = useRef<DeskContext["current"]>({ dues: new Map(), quests: new Map(), openDraft: setDraft });
  desk.current = {
    dues: new Map(books.dues.map((d) => [d.id, d])),
    quests: new Map(books.quests.map((q) => [q.id, q])),
    openDraft: setDraft,
  };
  const context = useMemo<DeskContext>(() => desk, []);
  const ai = useMemo(() => makeDeskAi(desk), []);
  const data = useMemo(() => buildStudioData(books), [books]);

  const due = draft ? desk.current.dues.get(draft.invoiceId) : undefined;

  return (
    <AgStudioProvider licenseKey={LICENSE} modules={MODULES}>
      <AgStudio<SidequestRegistry>
        style={STYLE}
        data={data}
        initialState={initialState}
        mode={mode}
        theme={sidequestTheme}
        layout={LAYOUT}
        widgets={widgets}
        context={context}
        ai={ai}
        aiToolDisplay={AI_TOOL_DISPLAY}
      />
      {draft && due && (
        <ReminderDialog
          draft={draft}
          due={due}
          quest={desk.current.quests.get(due.quest_id)}
          onClose={() => setDraft(null)}
          onSent={(message) => {
            setDraft(null);
            toast(message, "money");
            onChanged();
          }}
        />
      )}
    </AgStudioProvider>
  );
}
