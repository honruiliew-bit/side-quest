"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPanel } from "@/components/AgentPanel";
import { DemoDock } from "@/components/DemoDock";
import { FareSplit } from "@/components/FareSplit";
import { Itinerary } from "@/components/Itinerary";
import { MoneyLog } from "@/components/MoneyLog";
import { MoneyRoute } from "@/components/MoneyRoute";
import { QuestHero } from "@/components/QuestHero";
import { SeatMap } from "@/components/SeatMap";
import { api, ApiError } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { QuestDetail } from "@/lib/types";

const POLL_MS = 3000;

export default function QuestPage({ params }: { params: { id: string } }) {
  const { user, ready, toast } = useSession();
  const [q, setQ] = useState<QuestDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const prev = useRef<QuestDetail | null>(null);

  const accept = useCallback(
    (next: QuestDetail) => {
      const before = prev.current;
      if (before && before.id === next.id && before.status !== next.status) {
        if (next.status === "on") toast(`It's on. Seat ${next.min_people} filled.`, "money");
        if (next.status === "locked") toast(`Locked. Everyone paid ${money(next.share_cents)}.`, "money");
        if (next.status === "completed") toast("Host paid out through PayPal Payouts.", "money");
        if (next.status === "cancelled") toast("The quest didn't run. Every hold was released.");
        if (next.status === "open" && before.status === "on") toast("Back below the minimum.");
      }
      prev.current = next;
      setQ(next);
    },
    [toast],
  );

  const load = useCallback(async () => {
    try {
      accept(await api<QuestDetail>(`/quests/${params.id}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    }
  }, [params.id, accept]);

  useEffect(() => {
    if (!ready) return;
    load();
  }, [ready, user?.id, load]);

  useEffect(() => {
    if (!ready) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [ready, load]);

  useEffect(() => {
    if (q) document.title = `${q.title} | Sidequest`;
  }, [q]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("hold") === "cancelled") toast("Hold cancelled on PayPal. Nothing was held.");
  }, [toast]);

  if (missing) {
    return (
      <main className="mx-auto max-w-page px-4 py-20 sm:px-10">
        <h1 className="display text-[48px]">This quest doesn't exist.</h1>
        <p className="mt-4 text-[17px]">It may have been removed after a demo reset.</p>
        <Link href="/" className="btn btn-ink mt-6">See all departures</Link>
      </main>
    );
  }

  if (!q) return <Skeleton />;

  return (
    <>
      <QuestHero q={q} onChange={accept} />
      <main className="mx-auto flex max-w-page flex-col gap-12 px-4 pb-24 pt-12 sm:px-10">
        <MoneyRoute q={q} />
        <SeatMap q={q} />
        <div className="flex flex-wrap items-start gap-10">
          <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-12">
            <Itinerary q={q} />
            <FareSplit q={q} />
          </div>
          <div className="min-w-0 flex-[1_1_360px]">
            <AgentPanel q={q} onChange={accept} />
          </div>
        </div>
        <MoneyLog q={q} />
      </main>
      <DemoDock q={q} onChange={accept} />
    </>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading quest">
      <div className="platform">
        <div className="tactile" />
        <div className="mx-auto max-w-page px-4 pb-12 pt-8 sm:px-10">
          <div className="skeleton h-[52px] w-[320px]" />
          <div className="skeleton mt-6 h-[300px] w-full" />
        </div>
      </div>
      <div className="mx-auto max-w-page px-4 pt-12 sm:px-10">
        <div className="skeleton h-[120px] w-full" />
      </div>
    </div>
  );
}
