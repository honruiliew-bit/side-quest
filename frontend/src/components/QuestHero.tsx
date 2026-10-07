"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { clock, dayShort, deadline, money, statusBoard } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { QuestDetail } from "@/lib/types";
import { LineBullet } from "./Avatar";
import { Board } from "./Board";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { HoldButton } from "./HoldButton";

const STAMP: Record<string, string | null> = { open: null, on: "It's on", locked: "Charged", completed: "Arrived", cancelled: "Cancelled" };

export function QuestHero({ q, onChange }: { q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const stamp = STAMP[q.status];
  return (
    <section className="platform" aria-labelledby="quest-title">
      <div className="tactile" aria-hidden="true" />
      <div className="mx-auto flex max-w-page flex-col gap-6 px-4 pb-12 pt-8 sm:px-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <LineBullet code={q.line_code} size={44} />
            <span className="text-[17px] font-semibold">
              {q.area} line, {dayShort(q.starts_at, q.tz)} departure
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ShareInvite id={q.id} />
            <Board text={statusBoard(q.status, q.headcount, q.min_people, q.max_people)} length={12} label={`Status: ${q.status}, ${q.headcount} going`} />
          </div>
        </div>

        <div className="ticket relative flex flex-wrap">
          <div className="perf-r flex flex-[1_1_200px] flex-col justify-between gap-5 p-6 sm:p-7">
            <div className="label">Quest no.</div>
            <div className="tab text-[44px] font-extrabold leading-none condensed">{q.code}</div>
            <div className="flex flex-col gap-1 text-[15px]">
              <span><strong>From</strong> {q.from_label || "Meet point"}</span>
              <span><strong>To</strong> {q.to_label || q.area}</span>
            </div>
          </div>

          <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-5 p-6 sm:px-8 sm:py-7">
            <h1 id="quest-title" className="display max-w-[16ch] text-[44px] sm:text-[60px]">{q.title}</h1>
            <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[16px]">
              <Fact k="Date" v={dayShort(q.starts_at, q.tz)} />
              <Fact k="Leaves" v={clock(q.starts_at, q.tz)} />
              {q.ends_at && <Fact k="Back by" v={clock(q.ends_at, q.tz)} />}
              <Fact k="Hosted by" v={q.host.name} />
              <Fact k="Join by" v={deadline(q.join_by, q.tz)} />
            </dl>
          </div>

          <div className="perf-l flex flex-[1_1_290px] flex-col gap-3 p-6 sm:p-7">
            <Fare q={q} onChange={onChange} />
          </div>

          {stamp && (
            <div className="absolute right-4 top-4 sm:right-[310px] sm:top-5" aria-hidden="true">
              <div key={q.status} className="stamp" style={q.status === "cancelled" ? { borderColor: "var(--muted)", color: "var(--muted)" } : undefined}>
                {stamp}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="label">{k}</dt>
      <dd className="tab font-semibold">{v}</dd>
    </div>
  );
}

function Fare({ q, onChange }: { q: QuestDetail; onChange: (q: QuestDetail) => void }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<(ConfirmRequest & { run: () => void }) | null>(null);
  const mine = q.viewer.membership;
  const isHost = q.viewer.role === "host";
  const lowest = q.price_table[q.price_table.length - 1]?.cents ?? q.lowest_cents;

  const act = (key: string, path: string, done: string, confirm?: ConfirmRequest) => {
    if (confirm) {
      setAsk({ ...confirm, run: () => run(key, path, done) });
      return;
    }
    run(key, path, done);
  };

  const run = async (key: string, path: string, done: string) => {
    setAsk(null);
    setBusy(key);
    try {
      const res = await api<QuestDetail | { quest: QuestDetail; result: { done: boolean } }>(path, { method: "POST" });
      const detail = "quest" in res ? res.quest : res;
      onChange(detail);
      if ("result" in res && !res.result.done) toast("The quest is locked, so your host has to approve a refund.");
      else if (done) toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.", "error");
    } finally {
      setBusy(null);
    }
  };

  let label = "Max hold";
  let amount = q.hold_cents;
  let note = `Drops to ${money(lowest)} if ${q.max_people} people join.`;
  if (q.status === "on") {
    label = "Your share now";
    amount = q.share_cents;
    note = q.headcount >= q.max_people ? "Every seat is taken. This is the lowest it gets." : `Drops to ${money(lowest)} if the quest fills.`;
  }
  if (q.status === "locked" || q.status === "completed") {
    label = mine?.status === "charged" ? "You paid" : "Everyone paid";
    amount = mine?.charged_cents || q.share_cents;
    note = amount < q.hold_cents
      ? `Final split for ${q.headcount} people. Held ${money(q.hold_cents)}, saved ${money(q.hold_cents - amount)}.`
      : `Final split for ${q.headcount} people.`;
  }
  if (q.status === "cancelled") {
    label = "Charged";
    amount = 0;
    note = "The quest didn't reach its minimum. Every hold was released.";
  }

  const joinable = (q.status === "open" || q.status === "on") && new Date(q.join_by).getTime() > Date.now();
  const activeMine = mine && ["held", "standby", "charged"].includes(mine.status) ? mine : null;

  return (
    <>
      <div>
        <div className="label">{label}</div>
        <div className="tab text-[60px] font-extrabold leading-none text-money condensed sm:text-[64px]">{money(amount)}</div>
        <p className="mt-2 text-[14px] text-muted">{note}</p>
      </div>

      {activeMine?.status === "held" && (
        <MineLine chip="chip-held" text={`Seat ${activeMine.seat}. ${money(activeMine.hold_cents)} held by PayPal.`} />
      )}
      {activeMine?.status === "standby" && (
        <MineLine chip="chip-held" text={`On standby. ${money(activeMine.hold_cents)} held. You move up if a seat opens.`} />
      )}
      {activeMine?.status === "charged" && (
        <MineLine chip="chip-paid" text={`Seat ${activeMine.seat ?? ""}. Charged ${money(activeMine.charged_cents)}.`} />
      )}

      {joinable && !activeMine && <HoldButton q={q} onDone={onChange} />}

      {isHost && q.status === "on" && (
        <button className="btn btn-ink-signal w-full" disabled={!!busy} onClick={() => act("lock", `/quests/${q.id}/lock`, "", {
          title: "Lock the quest and charge everyone?",
          body: `PayPal captures ${money(q.share_cents)} from each of the ${q.headcount} holds. Everyone authorized ${money(q.hold_cents)}, so nobody pays more than they agreed to. Standby holds stay in place until the trip.`,
          action: `Charge ${q.headcount} × ${money(q.share_cents)}`,
        })}>
          {busy === "lock" ? "Charging" : "Lock and charge everyone"}
        </button>
      )}
      {isHost && q.status === "locked" && (
        <button className="btn btn-ink-signal w-full" disabled={!!busy} onClick={() => act("complete", `/quests/${q.id}/complete`, "", {
          title: "Trip done?",
          body: `Sidequest sends ${money(q.money.charged_cents - q.money.refunded_cents)} to your PayPal account through PayPal Payouts and releases any standby holds.`,
          action: "Send my payout",
          tone: "money",
        })}>
          {busy === "complete" ? "Sending payout" : "Trip done: send my payout"}
        </button>
      )}

      {activeMine && (activeMine.status === "held" || activeMine.status === "standby") && (
        <button className="btn btn-ghost btn-sm w-full" disabled={!!busy} onClick={() => act("leave", `/quests/${q.id}/leave`, "You left. Your hold was released.", {
          title: "Leave this quest?",
          body: `PayPal voids your ${money(activeMine.hold_cents)} hold right away. You won't be charged anything.`,
          action: "Leave and release",
          tone: "danger",
        })}>
          {busy === "leave" ? "Releasing" : "Leave and release my hold"}
        </button>
      )}

      <p className="mt-auto text-[13px] text-muted">PayPal holds your fare. Nothing is charged unless the quest runs.</p>
      {ask && <ConfirmDialog req={ask} onConfirm={ask.run} onCancel={() => setAsk(null)} />}
    </>
  );
}

function MineLine({ chip, text }: { chip: string; text: string }) {
  return (
    <div className="flex items-start gap-2 rounded border-2 border-money bg-white p-3 text-[14px]">
      <span className={`chip ${chip}`}>You</span>
      <span>{text}</span>
    </div>
  );
}

function ShareInvite({ id }: { id: string }) {
  const { toast } = useSession();
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        const url = `${window.location.origin}/join/${id}`;
        try {
          await navigator.clipboard.writeText(url);
          toast("Invite link copied.");
        } catch {
          window.open(url, "_blank");
        }
      }}
    >
      Copy invite link
    </button>
  );
}
