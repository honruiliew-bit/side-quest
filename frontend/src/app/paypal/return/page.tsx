"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Board } from "@/components/Board";
import { api } from "@/lib/api";
import type { QuestDetail } from "@/lib/types";

/** PayPal sends the buyer here after approving a hold opened from a link (assistant, email, or redirect flow). */
export default function PayPalReturn() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const membership = sp.get("m");
    const token = sp.get("token");
    if (!membership || !token) {
      setError("This link is missing the PayPal order details.");
      return;
    }
    api<QuestDetail>(`/holds/${membership}/confirm`, { method: "POST", json: { order_id: token } })
      .then((q) => router.replace(`/q/${q.id}`))
      .catch((e) => setError(e instanceof Error ? e.message : "PayPal couldn't place the hold."));
  }, [router]);

  return (
    <main className="mx-auto flex max-w-page flex-col items-start gap-6 px-4 py-20 sm:px-10">
      <Board text={error ? "NOT HELD" : "PLACING HOLD"} length={12} />
      {error ? (
        <>
          <h1 className="display text-[44px]">{error}</h1>
          <Link href="/" className="btn btn-ink">Back to departures</Link>
        </>
      ) : (
        <h1 className="display text-[44px]">Placing your hold with PayPal.</h1>
      )}
    </main>
  );
}
