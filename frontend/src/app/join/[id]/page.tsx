"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Avatar, LineBullet } from "@/components/Avatar";
import { Board } from "@/components/Board";
import { HoldButton } from "@/components/HoldButton";
import { api, ApiError } from "@/lib/api";
import { clock, dayLong, deadline, money, relative } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { QuestDetail } from "@/lib/types";

/** The invite. What someone sees before they join: enough to decide, nothing they have to work out. */
export default function JoinPage({ params }: { params: { id: string } }) {
  const { ready, user } = useSession();
  const router = useRouter();
  const [q, setQ] = useState<QuestDetail | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setQ(await api<QuestDetail>(`/quests/${params.id}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    }
  }, [params.id]);

  useEffect(() => {
    if (ready) load();
  }, [ready, user?.id, load]);

  useEffect(() => {
    if (!ready) return;
    const t = window.setInterval(() => document.visibilityState === "visible" && load(), 5000);
    return () => window.clearInterval(t);
  }, [ready, load]);

  useEffect(() => {
    if (q) document.title = `Join: ${q.title} | Sidequest`;
  }, [q]);

  if (missing) {
    return (
      <main className="mx-auto max-w-page px-4 py-20 sm:px-10">
        <h1 className="display text-[48px]">This invite has expired.</h1>
        <p className="mt-4 text-[17px]">The quest may have been removed.</p>
        <Link href="/" className="btn btn-ink mt-6">See all departures</Link>
      </main>
    );
  }
  if (!q) return <div className="platform h-[520px]" aria-busy="true"><div className="tactile" /></div>;

  const mine = q.viewer.membership && ["held", "standby", "charged"].includes(q.viewer.membership.status);
  const joinable = (q.status === "open" || q.status === "on") && new Date(q.join_by).getTime() > Date.now();
  const need = Math.max(0, q.min_people - q.headcount);
  const lowest = q.price_table[q.price_table.length - 1]?.cents ?? q.lowest_cents;
  const hours = q.ends_at ? Math.round((new Date(q.ends_at).getTime() - new Date(q.starts_at).getTime()) / 3600000) : null;
  const covered = q.cost_lines;
  const payOwn = q.itinerary.filter((s) => /pay your own/i.test(s.detail));
  const people = q.seats.flatMap((s) => (s.member ? [s.member] : []));
  const empty = Math.max(0, q.min_people - people.length);
  const done = () => router.push(`/q/${q.id}`);

  const board =
    q.status === "open" ? (need === 1 ? "1 SEAT TO GO" : `${need} SEATS TO GO`)
      : q.status === "on" ? (q.headcount >= q.max_people ? "FULL" : "IT'S ON")
        : q.status === "locked" ? "BOARDING CLOSED" : q.status === "completed" ? "ARRIVED" : "CANCELLED";

  return (
    <>
      <section className="platform" aria-labelledby="join-title">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-col gap-6 px-4 pb-28 pt-10 sm:px-10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <LineBullet code={q.line_code} size={44} />
              <span className="text-[17px] font-semibold">{q.host.name} is putting together a trip to {q.to_label || q.area}</span>
            </div>
            <Board text={board} length={15} label={`Status: ${board.toLowerCase()}`} />
          </div>
          <h1 id="join-title" className="display max-w-[18ch] text-[52px] sm:text-[84px]">{q.title}</h1>
          <p className="max-w-[58ch] text-[19px] leading-relaxed">{q.summary}</p>
          <p className="tab text-[18px] font-semibold">
            {dayLong(q.starts_at, q.tz)}, {clock(q.starts_at, q.tz)}
            {q.ends_at ? ` to ${clock(q.ends_at, q.tz)}` : ""}
            {hours ? `. About ${hours} hours.` : "."}
          </p>
        </div>
      </section>

      <main className="mx-auto -mt-20 flex max-w-page flex-col gap-14 px-4 pb-32 sm:px-10">
        <section className="ticket flex flex-wrap" aria-label="Who's going and what it costs">
          <div className="perf-r flex min-w-0 flex-[1_1_300px] flex-col gap-4 p-6 sm:p-7">
            <h2 className="h3">Who's going</h2>
            <div className="flex flex-wrap items-center">
              {people.map((m, i) => (
                <span key={m.id} style={{ marginLeft: i === 0 ? 0 : -8 }}><Avatar user={m.user} size={44} /></span>
              ))}
              {Array.from({ length: empty }).map((_, i) => (
                <span key={`e${i}`} aria-hidden="true" className="inline-block h-[44px] w-[44px] rounded-full border-2 border-dashed border-dash bg-stock" style={{ marginLeft: -8 }} />
              ))}
            </div>
            <p className="text-[16px]">
              {q.status === "open"
                ? <><strong>{q.headcount} in, {need} more needed</strong> by {deadline(q.join_by, q.tz)} ({relative(q.join_by)}).</>
                : q.status === "on"
                  ? <><strong>It's happening.</strong> {q.headcount} going, room for {q.max_people - q.headcount} more until {deadline(q.join_by, q.tz)}.</>
                  : <>{q.headcount} people went.</>}
            </p>
            <div className="flex items-center gap-3 border-t border-rule pt-4">
              <Avatar user={q.host} size={40} />
              <div className="text-[14px] leading-snug">
                <div className="font-bold">Hosted by {q.host.name}</div>
                <div className="text-muted">
                  {q.host_stats.completed > 0
                    ? `${q.host_stats.completed} completed ${q.host_stats.completed === 1 ? "quest" : "quests"}, ${q.host_stats.travelers} people taken`
                    : "First quest as a host"}
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-3 p-6 sm:p-7">
            <h2 className="h3">What it costs</h2>
            <div>
              <div className="label">{q.status === "locked" || q.status === "completed" ? "Everyone paid" : "Up to"}</div>
              <div className="tab text-[64px] font-extrabold leading-none text-money condensed">
                {money(q.status === "locked" || q.status === "completed" ? q.share_cents : q.hold_cents)}
              </div>
            </div>
            {joinable && (
              <p className="text-[15px] leading-relaxed">
                {q.status === "on" && q.share_cents < q.hold_cents
                  ? <>Right now it's <strong>{money(q.share_cents)}</strong> each. </>
                  : null}
                Drops to <strong>{money(lowest)}</strong> if all {q.max_people} seats fill. You're only charged if the quest runs.
              </p>
            )}
          </div>

          <div id="hold" className="perf-l flex min-w-0 flex-[1_1_300px] scroll-mt-24 flex-col gap-3 p-6 sm:p-7">
            {mine ? (
              <>
                <h2 className="h3">You're on this quest</h2>
                <p className="text-[15px]">Your hold is in place. See the plan, the split and the group chat.</p>
                <Link href={`/q/${q.id}`} className="btn btn-ink">Open the quest</Link>
              </>
            ) : joinable ? (
              <>
                <h2 className="h3">Hold your spot</h2>
                <HoldButton q={q} onDone={done} />
                <p className="text-[13px] text-muted">PayPal holds {money(q.hold_cents)}. Nothing is charged unless the quest runs.</p>
              </>
            ) : (
              <>
                <h2 className="h3">{q.status === "locked" ? "Boarding is closed" : q.status === "completed" ? "This trip already happened" : "This quest didn't run"}</h2>
                <p className="text-[15px]">Find another quest on the departures board.</p>
                <Link href="/" className="btn btn-ink">See departures</Link>
              </>
            )}
            <Link href={`/q/${q.id}`} className="mt-auto text-[14px] font-semibold underline">See the full breakdown</Link>
          </div>
        </section>

        <section aria-labelledby="day-h" className="flex flex-col gap-6">
          <h2 id="day-h" className="h2">The day</h2>
          <div className="relative hidden md:block">
            <div aria-hidden="true" className="absolute left-0 right-0 top-[38px] h-[4px] rounded bg-ink" />
            <ol className="relative grid gap-3" style={{ gridTemplateColumns: `repeat(${q.itinerary.length}, minmax(0, 1fr))` }}>
              {q.itinerary.map((s, i) => (
                <li key={i} className="flex flex-col gap-2 pr-2">
                  <span className="tab text-[15px] font-bold">{s.time}</span>
                  <span aria-hidden="true" className="block h-5 w-5 rounded-full border-[3px] border-ink bg-signal" />
                  <span className="text-[17px] font-bold leading-tight">{s.title}</span>
                  <span className="text-[14px] text-muted">{s.detail}</span>
                  {s.note && <span className="text-[13px]">{s.note}</span>}
                </li>
              ))}
            </ol>
          </div>
          <ol className="relative flex flex-col gap-6 md:hidden">
            <span aria-hidden="true" className="absolute bottom-2 left-[10px] top-2 w-[3px] bg-ink" />
            {q.itinerary.map((s, i) => (
              <li key={i} className="relative flex gap-4 pl-8">
                <span aria-hidden="true" className="absolute left-[2px] top-[3px] h-5 w-5 rounded-full border-[3px] border-ink bg-signal" />
                <div>
                  <div className="tab text-[14px] font-bold">{s.time}</div>
                  <div className="text-[17px] font-bold">{s.title}</div>
                  <div className="text-[14px] text-muted">{s.detail}</div>
                  {s.note && <div className="text-[13px]">{s.note}</div>}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <div className="grid gap-6 md:grid-cols-2">
          <section aria-labelledby="cov-h" className="panel flex flex-col gap-3 p-6">
            <h2 id="cov-h" className="h3">Covered by your share</h2>
            <ul className="tab flex flex-col text-[16px]">
              {covered.map((c) => (
                <li key={c.label} className="flex items-start justify-between gap-4 border-b border-rule py-3 first:pt-0">
                  <span>{c.label}</span>
                  <span className="text-right">
                    <span className="block font-semibold">
                      {c.split === "shared" ? `${money(Math.ceil(c.cents / q.min_people))} each` : `${money(c.cents)} each`}
                    </span>
                    <span className="block text-[13px] text-muted">
                      {c.split === "shared"
                        ? `${money(c.cents)} split by the group, ${money(Math.ceil(c.cents / q.max_people))} if full`
                        : "same for everyone"}
                    </span>
                  </span>
                </li>
              ))}
              <li className="flex items-start justify-between gap-4 pt-3">
                <span className="font-bold">Your share</span>
                <span className="text-right">
                  <span className="block font-bold text-money">Up to {money(q.hold_cents)}</span>
                  <span className="block text-[13px] text-muted">{money(lowest)} if all {q.max_people} seats fill</span>
                </span>
              </li>
            </ul>
          </section>
          <section aria-labelledby="own-h" className="panel flex flex-col gap-3 p-6">
            <h2 id="own-h" className="h3">You pay for yourself</h2>
            {payOwn.length ? (
              <ul className="flex flex-col gap-2 text-[16px]">
                {payOwn.map((s) => <li key={s.title}>{s.title}</li>)}
              </ul>
            ) : (
              <p className="text-[16px]">Nothing else. Everything on the plan is in your share.</p>
            )}
          </section>
        </div>

        <section aria-labelledby="money-safe-h" className="flex flex-col gap-4">
          <h2 id="money-safe-h" className="h2">Your money</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="panel p-5">
              <h3 className="h3">A hold, not a charge</h3>
              <p className="mt-2 text-[15px] leading-relaxed">PayPal sets aside {money(q.hold_cents)} when you join. Nothing leaves your account until the quest locks.</p>
            </div>
            <div className="panel p-5">
              <h3 className="h3">Never more than {money(q.hold_cents)}</h3>
              <p className="mt-2 text-[15px] leading-relaxed">You're charged the final split for the real group. More people means you pay less, never more.</p>
            </div>
            <div className="panel p-5">
              <h3 className="h3">No trip, no charge</h3>
              <p className="mt-2 text-[15px] leading-relaxed">If {q.min_people} people don't commit by the deadline, every hold is released automatically.</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="know-h" className="flex flex-col gap-4">
          <h2 id="know-h" className="h2">Good to know</h2>
          <dl className="grid gap-x-10 gap-y-5 text-[16px] md:grid-cols-2">
            <div><dt className="font-bold">Meet at</dt><dd className="text-muted">{q.meet_point}</dd></div>
            <div><dt className="font-bold">Join by</dt><dd className="text-muted">{deadline(q.join_by, q.tz)}. The quest locks then, or earlier if the host locks it.</dd></div>
            <div><dt className="font-bold">Group size</dt><dd className="text-muted">Runs with {q.min_people}, room for {q.max_people}. Extra people join standby.</dd></div>
            <div><dt className="font-bold">If you can't make it</dt><dd className="text-muted">Leave any time before it locks and your hold is released. After that, someone on standby can take your spot and you're refunded.</dd></div>
          </dl>
        </section>
      </main>

      {joinable && !mine && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-ink bg-stock px-4 py-3 md:hidden">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="label">Up to</div>
              <div className="tab text-[24px] font-extrabold leading-none text-money" style={{ fontStretch: "62%" }}>{money(q.hold_cents)}</div>
            </div>
            <a href="#hold" className="btn btn-money">Hold my spot</a>
          </div>
        </div>
      )}
    </>
  );
}
