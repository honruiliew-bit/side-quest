"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LineBullet } from "@/components/Avatar";
import { Board } from "@/components/Board";
import { api } from "@/lib/api";
import { dayShort, money, statusLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { Membership, QuestCard } from "@/lib/types";

type Me = { memberships: (Membership & { quest: QuestCard })[]; hosting: QuestCard[] };

const STATE: Record<string, { chip: string; text: (m: Membership) => string }> = {
  held: { chip: "chip-held", text: (m) => `Held ${money(m.hold_cents)}` },
  standby: { chip: "chip-held", text: (m) => `Standby, held ${money(m.hold_cents)}` },
  charged: { chip: "chip-paid", text: (m) => `Paid ${money(m.charged_cents - m.refunded_cents)}` },
  refunded: { chip: "chip-refund", text: (m) => `Refunded ${money(m.refunded_cents)}` },
  released: { chip: "chip-released", text: () => "Released, $0.00" },
  failed: { chip: "chip-released", text: () => "Declined" },
};

export default function MyHolds() {
  const { user, ready, toast } = useSession();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!ready || !user) return;
    api<Me>("/me").then(setMe).catch((e) => toast(e.message, "error"));
  }, [ready, user, toast]);

  const held = (me?.memberships ?? []).filter((m) => m.status === "held" || m.status === "standby").reduce((a, m) => a + m.hold_cents, 0);
  const paid = (me?.memberships ?? []).reduce((a, m) => a + m.charged_cents - m.refunded_cents, 0);

  return (
    <>
      <section className="platform">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-wrap items-end justify-between gap-6 px-4 pb-12 pt-10 sm:px-10">
          <div>
            <h1 className="display text-[52px] sm:text-[68px]">{user ? `${user.name}'s holds` : "My holds"}</h1>
            <p className="mt-3 text-[17px]">Holds are PayPal authorizations. They turn into charges only when a quest runs.</p>
          </div>
          <div className="flex flex-wrap gap-4">
            <Stat label="Held right now" value={money(held)} />
            <Stat label="Paid for quests" value={money(paid)} />
          </div>
        </div>
      </section>
      <main className="mx-auto flex max-w-page flex-col gap-12 px-4 pt-12 sm:px-10">
        {!user && <p className="text-[17px]">Pick who you are in the top right to see your holds.</p>}
        {user && me && (
          <>
            <section className="flex flex-col gap-4" aria-labelledby="mine-h">
              <h2 id="mine-h" className="h2">Your quests</h2>
              {me.memberships.length === 0 ? (
                <div className="panel flex flex-wrap items-center justify-between gap-4 p-6">
                  <span className="text-[16px]">You haven't held a spot yet.</span>
                  <Link href="/" className="btn btn-ink">See departures</Link>
                </div>
              ) : (
                <ul className="flex flex-col gap-3">
                  {me.memberships.map((m) => {
                    const st = STATE[m.status] ?? STATE.released;
                    return (
                      <li key={m.id}>
                        <Link href={`/q/${m.quest.id}`} className="panel flex flex-wrap items-center gap-4 p-4 no-underline hover:bg-white">
                          <LineBullet code={m.quest.line_code} size={44} />
                          <div className="min-w-0 flex-1">
                            <div className="font-bold">{m.quest.title}</div>
                            <div className="text-[14px] text-muted">
                              {dayShort(m.quest.starts_at, m.quest.tz)}. {statusLine(m.quest.status, m.quest.headcount, m.quest.min_people)}.
                            </div>
                          </div>
                          <span className={`chip tab ${st.chip}`}>{st.text(m)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            {me.hosting.length > 0 && (
              <section className="flex flex-col gap-4" aria-labelledby="host-h">
                <h2 id="host-h" className="h2">Quests you host</h2>
                <ul className="grid gap-3 md:grid-cols-2">
                  {me.hosting.map((q) => (
                    <li key={q.id}>
                      <Link href={`/q/${q.id}`} className="panel flex items-center justify-between gap-4 p-4 no-underline hover:bg-white">
                        <span className="font-bold">{q.title}</span>
                        <Board text={q.status === "open" ? `${q.headcount}/${q.min_people}` : q.status.toUpperCase()} size="sm" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ticket min-w-[180px] px-5 py-4">
      <div className="label">{label}</div>
      <div className="tab text-[36px] font-extrabold leading-none text-money" style={{ fontStretch: "62%" }}>{value}</div>
    </div>
  );
}
