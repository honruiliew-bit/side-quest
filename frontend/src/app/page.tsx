"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LineBullet } from "@/components/Avatar";
import { Board } from "@/components/Board";
import { api } from "@/lib/api";
import { clock, dayShort, money, statusBoard } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { QuestCard } from "@/lib/types";

export default function Home() {
  const { ready, toast } = useSession();
  const [quests, setQuests] = useState<QuestCard[] | null>(null);

  useEffect(() => {
    if (!ready) return;
    const load = () =>
      api<QuestCard[]>("/quests?status=all")
        .then(setQuests)
        .catch((e) => toast(e.message, "error"));
    load();
    const t = window.setInterval(() => document.visibilityState === "visible" && load(), 5000);
    return () => window.clearInterval(t);
  }, [ready, toast]);

  const upcoming = (quests ?? []).filter((q) => ["open", "on", "locked"].includes(q.status));
  const arrived = (quests ?? []).filter((q) => q.status === "completed");

  return (
    <>
      <section className="platform" aria-labelledby="hero-h">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-col gap-10 px-4 pb-14 pt-10 sm:px-10">
          <div className="flex flex-wrap items-end justify-between gap-8">
            <div className="flex max-w-[640px] flex-col gap-5">
              <h1 id="hero-h" className="display text-[52px] sm:text-[76px]">Weekend plans that only run if the group commits.</h1>
              <p className="max-w-[52ch] text-[18px] leading-relaxed">
                Hold your spot with PayPal. Nobody pays unless the quest runs, and every extra person lowers everyone's share.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/new" className="btn btn-ink">Start a quest</Link>
                <a href="#departures" className="btn btn-ghost">See departures</a>
              </div>
            </div>
            <Board text="NOW BOARDING" size="lg" label="Now boarding" />
          </div>

          <div id="departures" className="scroll-mt-6 overflow-hidden rounded-md border-2 border-ink bg-ink text-stock shadow-[0_10px_0_var(--ink)]">
            <div className="flex items-center justify-between px-5 py-3 text-[14px] font-semibold text-signal">
              <span>Departures</span>
              <span className="text-stock/70">Live</span>
            </div>
            <div className="overflow-x-auto">
              <table className="tab w-full min-w-[760px] border-collapse">
                <thead>
                  <tr className="border-y border-white/15 text-left text-[13px] text-stock/70">
                    <th className="px-5 py-2 font-medium">Leaves</th>
                    <th className="px-2 py-2 font-medium">Line</th>
                    <th className="px-3 py-2 font-medium">Quest</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-5 py-2 text-right font-medium">Fare</th>
                  </tr>
                </thead>
                <tbody>
                  {quests === null &&
                    [0, 1, 2].map((i) => (
                      <tr key={i} className="border-b border-white/10">
                        <td colSpan={5} className="px-5 py-5"><div className="h-6 w-2/3 rounded bg-white/10" /></td>
                      </tr>
                    ))}
                  {upcoming.map((q) => (
                    <tr key={q.id} className="group border-b border-white/10 last:border-0">
                      <td className="whitespace-nowrap px-5 py-4 align-middle">
                        <div className="text-[13px] text-stock/70">{dayShort(q.starts_at, q.tz)}</div>
                        <div className="text-[22px] font-extrabold text-signal" style={{ fontStretch: "72%" }}>{clock(q.starts_at, q.tz)}</div>
                      </td>
                      <td className="px-2 py-4 align-middle">
                        <span className="inline-grid h-10 w-10 place-items-center rounded-full bg-signal text-[17px] font-black text-ink" style={{ fontStretch: "62%" }}>
                          {q.line_code}
                        </span>
                      </td>
                      <td className="px-3 py-4 align-middle">
                        <Link href={`/q/${q.id}`} className="text-[19px] font-bold leading-tight text-stock no-underline group-hover:text-signal" style={{ fontStretch: "80%" }}>
                          {q.title}
                        </Link>
                        <div className="text-[13px] text-stock/70">{q.area}, hosted by {q.host.name}</div>
                      </td>
                      <td className="px-3 py-4 align-middle">
                        <Board text={statusBoard(q.status, q.headcount, q.min_people, q.max_people)} length={12} size="sm" />
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-right align-middle">
                        <div className="text-[20px] font-extrabold" style={{ fontStretch: "72%" }}>
                          {q.status === "locked" ? money(q.share_cents) : money(q.hold_cents)}
                        </div>
                        <div className="text-[12px] text-stock/70">
                          {q.status === "locked" ? "final split" : `down to ${money(q.lowest_cents)}`}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {quests !== null && upcoming.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-[16px]">
                        No departures yet. <Link href="/new" className="text-signal underline">Start the first quest</Link>.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto flex max-w-page flex-col gap-16 px-4 pt-14 sm:px-10">
        <section aria-labelledby="how-h" className="flex flex-col gap-6">
          <h2 id="how-h" className="h2">How a quest works</h2>
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { t: "Hold your spot", d: "PayPal authorizes the max price, the share if only the minimum shows up. Nothing is charged.", a: "Orders v2, intent AUTHORIZE" },
              { t: "The quest tips", d: "Once the minimum commits, it's on. More people can still join and the share keeps dropping.", a: "Live split" },
              { t: "Everyone is charged", d: "At the deadline each hold is captured at the final split. Never more than you approved.", a: "Capture authorization" },
              { t: "The host is paid", d: "After the trip the host gets paid out. Dropouts and cost changes go through the agent and the host.", a: "Payouts, Refunds, Invoicing" },
            ].map((s, i) => (
              <li key={s.t} className="panel flex flex-col gap-3 p-5">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-ink font-black text-signal" style={{ fontStretch: "62%" }}>{i + 1}</span>
                <h3 className="h3">{s.t}</h3>
                <p className="text-[15px] leading-relaxed">{s.d}</p>
                <span className="mt-auto text-[12px] font-semibold text-money">{s.a}</span>
              </li>
            ))}
          </ol>
        </section>

        {arrived.length > 0 && (
          <section aria-labelledby="arrived-h" className="flex flex-col gap-4">
            <h2 id="arrived-h" className="h2">Recently arrived</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {arrived.map((q) => (
                <Link key={q.id} href={`/q/${q.id}`} className="panel flex items-center gap-4 p-5 no-underline hover:bg-white">
                  <LineBullet code={q.line_code} size={44} />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold">{q.title}</div>
                    <div className="tab text-[14px] text-muted">
                      {q.headcount} went, {money(q.share_cents)} each instead of {money(q.hold_cents)}
                    </div>
                  </div>
                  <span className="chip chip-paid tab">Host paid</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="panel flex flex-wrap items-center justify-between gap-6 p-6 sm:p-8">
          <div className="max-w-[60ch]">
            <h2 className="h2">Let your AI assistant find a quest for you</h2>
            <p className="mt-2 text-[16px] leading-relaxed">
              Sidequest is also an MCP server. Ask Claude or ChatGPT for "something cheap to do Saturday", and it can find a
              quest and hold your spot. You still approve every hold on PayPal.
            </p>
          </div>
          <Link href="/agents" className="btn btn-ink">Connect an assistant</Link>
        </section>
      </main>
    </>
  );
}
