"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LineBullet } from "@/components/Avatar";
import type { LedgerRow } from "@/components/LedgerGrid";
import { api } from "@/lib/api";
import { dayShort, money, statusLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { Membership, QuestCard } from "@/lib/types";
import { useWide } from "@/lib/useWide";
import { OwedList } from "@/studio/OwedList";
import type { Books } from "@/studio/types";

// AG Studio, AG Grid Enterprise and AG Charts load only for hosts on a wide screen.
const HostDesk = dynamic(() => import("@/studio/HostDesk"), { ssr: false, loading: () => <DeskLoading /> });
const LedgerGrid = dynamic(() => import("@/components/LedgerGrid").then((m) => m.LedgerGrid), {
  ssr: false,
  loading: () => <div className="h-[240px] border-2 border-ink bg-stock" aria-busy="true" />,
});

type Question = { case_id: string; quest_id: string; quest_title: string; from: string; body: string };
type Me = { memberships: (Membership & { quest: QuestCard })[]; hosting: QuestCard[]; questions: Question[] };

const STATE: Record<string, { chip: string; text: (m: Membership) => string }> = {
  held: { chip: "chip-held", text: (m) => `Held ${money(m.hold_cents)}, not charged` },
  standby: { chip: "chip-held", text: (m) => `Standby, held ${money(m.hold_cents)}` },
  charged: { chip: "chip-paid", text: (m) => `Paid ${money(m.charged_cents - m.refunded_cents)}` },
  refunded: { chip: "chip-refund", text: (m) => `Refunded ${money(m.refunded_cents)}` },
  released: { chip: "chip-released", text: () => "Released, paid nothing" },
  failed: { chip: "chip-released", text: () => "Declined" },
};

export default function MyMoney() {
  const { user, ready, toast, config, signInAs } = useSession();
  const wide = useWide();
  const [me, setMe] = useState<Me | null>(null);
  const [books, setBooks] = useState<Books | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [checking, setChecking] = useState(false);

  const load = useCallback(() => {
    api<Me>("/me").then(setMe).catch((e) => toast(e.message, "error"));
    api<Books>("/me/books").then(setBooks).catch((e) => toast(e.message, "error"));
  }, [toast]);

  useEffect(() => {
    if (!ready || !user) return;
    setMe(null);
    setBooks(null);
    setLedger(null);
    setMode("view");
    load();
  }, [ready, user, load]);

  useEffect(() => {
    if (books && !books.hosting && ledger === null) {
      api<LedgerRow[]>("/me/ledger").then(setLedger).catch(() => setLedger([]));
    }
  }, [books, ledger]);

  const checkPayPal = async () => {
    setChecking(true);
    try {
      const r = await api<{ checked: number; changed: number }>("/me/books/refresh", { method: "POST" });
      toast(r.changed ? `${r.changed} invoice${r.changed > 1 ? "s" : ""} paid since you last looked.` : `Checked ${r.checked} open invoice${r.checked === 1 ? "" : "s"} with PayPal. Nothing new.`, r.changed ? "money" : "info");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't reach PayPal.", "error");
    } finally {
      setChecking(false);
    }
  };

  const memberships = me?.memberships ?? [];
  const held = memberships.filter((m) => m.status === "held" || m.status === "standby").reduce((a, m) => a + m.hold_cents, 0);
  const paid = memberships.reduce((a, m) => a + m.charged_cents - m.refunded_cents, 0);
  const owedToYou = (books?.dues ?? []).filter((d) => d.status === "Open" && d.can_remind).reduce((a, d) => a + Math.round(d.amount * 100), 0);
  const hosting = !!books?.hosting;
  const youOwe = (books?.dues ?? []).filter((d) => d.status === "Open" && !d.can_remind && d.person === user?.name);

  return (
    <>
      <section className="platform">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-wrap items-end justify-between gap-6 px-4 pb-10 pt-10 sm:px-10">
          <div className="max-w-[560px]">
            <h1 className="display text-[52px] sm:text-[68px]">My money</h1>
            <p className="mt-3 text-[17px]">
              A hold isn't a charge. You only pay when a quest runs, and never more than you approved.
            </p>
          </div>
          {user && (
            <div className="flex flex-wrap gap-3">
              <Stat label="Held, not charged" value={money(held)} />
              <Stat label="Paid for quests" value={money(paid)} />
              {hosting && <Stat label="Owed to you" value={money(owedToYou)} />}
            </div>
          )}
        </div>
      </section>

      <main className="mx-auto flex max-w-page flex-col gap-12 px-4 pt-12 sm:px-10">
        {!user && <p className="text-[17px]">Pick who you are in the top right to see your money.</p>}
        {user && me && me.questions.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="questions-h">
            <h2 id="questions-h" className="h2">Sidequest has a question</h2>
            {me.questions.map((qq) => (
              <Link key={qq.case_id} href={`/q/${qq.quest_id}`} className="panel flex flex-wrap items-center justify-between gap-3 border-stamp p-4 no-underline hover:bg-white">
                <span className="min-w-0">
                  <span className="block text-[14px] text-muted">{qq.from} from Sidequest, about {qq.quest_title}</span>
                  <span className="block font-semibold">{qq.body}</span>
                </span>
                <span className="btn btn-ink btn-sm">Answer</span>
              </Link>
            ))}
          </section>
        )}
        {user && me && (
          <section className="flex flex-col gap-4" aria-labelledby="mine-h">
            <h2 id="mine-h" className="h2">Your quests</h2>
            {memberships.length === 0 ? (
              <div className="panel flex flex-wrap items-center justify-between gap-4 p-6">
                <span className="text-[16px]">You haven't held a spot yet.</span>
                <Link href="/" className="btn btn-ink">See departures</Link>
              </div>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {memberships.map((m) => {
                  const st = STATE[m.status] ?? STATE.released;
                  return (
                    <li key={m.id}>
                      <Link href={`/q/${m.quest.id}`} className="panel flex h-full items-center gap-4 p-4 no-underline hover:bg-white">
                        <LineBullet code={m.quest.line_code} size={44} />
                        <div className="min-w-0 flex-1">
                          <div className="font-bold">{m.quest.title}</div>
                          <div className="text-[14px] text-muted">
                            {dayShort(m.quest.starts_at, m.quest.tz)}. {statusLine(m.quest.status, m.quest.headcount, m.quest.min_people)}.
                          </div>
                          <span className={`chip tab mt-2 ${st.chip}`}>{st.text(m)}</span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {user && books && youOwe.length > 0 && (
          <section className="flex flex-col gap-3" aria-labelledby="owe-h">
            <h2 id="owe-h" className="h2">You owe</h2>
            <ul className="flex flex-col gap-2">
              {youOwe.map((d) => {
                const q = books.quests.find((x) => x.id === d.quest_id);
                return (
                  <li key={d.id} className="panel flex flex-wrap items-center gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-bold">{money(Math.round(d.amount * 100))} to {q?.host ?? "the host"}</div>
                      <div className="text-[14px] text-muted">
                        Your share of extra costs on {q?.title}. Sent {d.days_open === 0 ? "today" : `${d.days_open} days ago`} as a PayPal invoice with the receipts.
                      </div>
                    </div>
                    {d.source === "Sandbox" ? (
                      <a className="btn btn-money" href={`https://www.sandbox.paypal.com/invoice/p/#${d.paypal_id}`} target="_blank" rel="noreferrer">Pay on PayPal</a>
                    ) : (
                      <span className="chip chip-sim">Demo invoice</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {user && books && !hosting && (
          <section className="flex flex-col gap-4" aria-labelledby="activity-h">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="activity-h" className="h2">Your PayPal activity</h2>
              <span className="text-[14px] text-muted">Every hold, charge and refund on your quests</span>
            </div>
            {ledger === null ? (
              <div className="h-[240px] border-2 border-ink bg-stock" aria-busy="true" />
            ) : ledger.length === 0 ? (
              <p className="panel p-5 text-[15px]">No PayPal activity yet.</p>
            ) : (
              <LedgerGrid rows={ledger} paypalMode={config?.paypal_mode ?? "mock"} showQuest fileName={`sidequest-${user.name.toLowerCase()}`} staff={!!user.is_admin} />
            )}
            {config?.demo_mode && (
              <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
                <span className="text-[15px]">Hosts get a desk with every payment, who still owes them, and Claude to chase it.</span>
                <button className="btn btn-ink" onClick={() => signInAs("hon")}>See Hon's host desk</button>
              </div>
            )}
          </section>
        )}

        {user && books && hosting && !wide && <OwedList books={books} onChanged={load} />}
      </main>

      {user && books && hosting && wide && (
        <section id="desk" aria-labelledby="desk-h" className="mt-14 flex flex-col">
          <div className="mx-auto flex w-full max-w-page flex-wrap items-end justify-between gap-4 px-4 pb-5 sm:px-10">
            <div className="max-w-[640px]">
              <h2 id="desk-h" className="h2">Host desk</h2>
              <p className="mt-1 text-[15px] text-muted">
                Every PayPal payment on the quests you host, and who still owes you. Click a quest or a bar to filter. Ask Claude for any view.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button className="btn btn-ghost" onClick={checkPayPal} disabled={checking}>
                {checking ? "Checking PayPal..." : "Check PayPal for payments"}
              </button>
              <button className="btn btn-ink" onClick={() => setMode((m) => (m === "edit" ? "view" : "edit"))} aria-pressed={mode === "edit"}>
                {mode === "edit" ? "Done editing" : "Edit with Claude"}
              </button>
            </div>
          </div>
          <div className="h-[calc(100vh-80px)] min-h-[760px] w-full border-y-2 border-ink">
            <HostDesk books={books} mode={mode} onChanged={load} />
          </div>
        </section>
      )}
    </>
  );
}

function DeskLoading() {
  return (
    <div className="grid h-full place-items-center bg-paper" aria-busy="true">
      <span className="text-[15px] text-muted">Loading the host desk...</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ticket min-w-[170px] px-5 py-4">
      <div className="label">{label}</div>
      <div className="tab text-[36px] font-extrabold leading-none text-money" style={{ fontStretch: "62%" }}>{value}</div>
    </div>
  );
}
