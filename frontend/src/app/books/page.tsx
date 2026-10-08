"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Books } from "@/studio/types";

// AG Studio, AG Grid Enterprise and AG Charts load only on this page, in the browser.
const HostDesk = dynamic(() => import("@/studio/HostDesk"), {
  ssr: false,
  loading: () => <Loading />,
});

export default function BooksPage() {
  const { user, ready, toast } = useSession();
  const [books, setBooks] = useState<Books | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [checking, setChecking] = useState(false);

  const load = useCallback(() => {
    api<Books>("/me/books").then(setBooks).catch((e) => toast(e.message, "error"));
  }, [toast]);

  useEffect(() => {
    if (!ready || !user) return;
    setBooks(null);
    load();
  }, [ready, user, load]);

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

  const empty = books && books.quests.length === 0;

  return (
    <>
      <section className="platform">
        <div className="tactile" aria-hidden="true" />
        <div className="mx-auto flex max-w-page flex-wrap items-end justify-between gap-6 px-4 pb-8 pt-8 sm:px-10">
          <div className="max-w-[620px]">
            <h1 className="display text-[48px] sm:text-[60px]">{books?.hosting ? "Host desk" : "Books"}</h1>
            <p className="mt-2 text-[17px]">
              Every PayPal hold, charge, refund, invoice and payout on your quests, and who still owes you.
              {books?.hosting ? " Click a quest or a bar to filter everything. Ask Claude to build any view you need." : ""}
            </p>
          </div>
          {books && !empty && (
            <div className="flex flex-wrap gap-3">
              <button className="btn btn-ghost bg-stock" onClick={checkPayPal} disabled={checking}>
                {checking ? "Checking PayPal..." : "Check PayPal for payments"}
              </button>
              <button className="btn btn-ink" onClick={() => setMode((m) => (m === "edit" ? "view" : "edit"))} aria-pressed={mode === "edit"}>
                {mode === "edit" ? "Done editing" : "Edit with Claude"}
              </button>
            </div>
          )}
        </div>
      </section>
      <main>
        {!user && <p className="mx-auto max-w-page px-4 pt-10 text-[17px] sm:px-10">Pick who you are in the top right to see your books.</p>}
        {user && !books && <Loading />}
        {empty && (
          <div className="mx-auto max-w-page px-4 pt-10 sm:px-10">
            <div className="panel flex flex-wrap items-center justify-between gap-4 p-6">
              <span className="text-[16px]">No PayPal activity yet. Hold a spot and it shows up here.</span>
              <Link href="/" className="btn btn-ink">See departures</Link>
            </div>
          </div>
        )}
        {books && !empty && (
          <div className="h-[calc(100vh-120px)] min-h-[760px] w-full border-y-2 border-ink">
            <HostDesk books={books} mode={mode} onChanged={load} />
          </div>
        )}
      </main>
    </>
  );
}

function Loading() {
  return (
    <div className="grid h-[calc(100vh-120px)] min-h-[760px] place-items-center border-y-2 border-ink bg-paper" aria-busy="true">
      <span className="text-[15px] text-muted">Loading your books...</span>
    </div>
  );
}
