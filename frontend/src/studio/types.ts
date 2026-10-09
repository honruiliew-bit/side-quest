export type BooksQuest = {
  id: string; title: string; line: string; status: string; role: "Host" | "Member"; host: string;
  starts_at: string; travelers: number; min_people: number;
};
export type BooksLedger = {
  id: string; quest_id: string; person: string; event: string; kind: string; amount: number;
  source: string; confirmed: "Yes" | "No"; at: string;
};
export type BooksDue = {
  id: string; quest_id: string; person: string; amount: number; status: "Open" | "Paid" | "Cancelled"; item: string;
  sent_at: string; days_open: number; reminders: number; paypal_id: string; source: string; can_remind: boolean;
};
export type Books = {
  hosting: boolean; paypal_mode: string; quests: BooksQuest[]; ledger: BooksLedger[]; dues: BooksDue[];
};

/** What Claude (or the host) drafts. Nothing is sent until the host presses Send. */
export type ReminderDraft = { invoiceId: string; subject: string; note: string; by: "claude" | "host" };

/** Passed to Studio once through `context`. Read through a ref so handlers always see fresh app state. */
export type DeskContext = {
  current: {
    dues: Map<string, BooksDue>;
    quests: Map<string, BooksQuest>;
    openDraft: (draft: ReminderDraft) => void;
  };
};
