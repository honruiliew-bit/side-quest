"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MockPayPalSheet } from "@/components/MockPayPalSheet";
import { api } from "@/lib/api";
import type { Membership, QuestCard } from "@/lib/types";

/** Approval page for links handed out by AI assistants when PAYPAL_MODE=mock. */
export default function MockApprove() {
  const router = useRouter();
  const [data, setData] = useState<{ membership: Membership; quest: QuestCard } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setTokenValue] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    setTokenValue(t);
    if (!t) return setError("This approval link is missing its order.");
    api<{ membership: Membership; quest: QuestCard }>(`/paypal/orders/${t}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main className="mx-auto grid min-h-[70vh] max-w-page place-items-center px-4 py-12">
      {error && <p className="text-[18px]">{error}</p>}
      {data && token && (
        <MockPayPalSheet
          inline
          amountCents={data.membership.hold_cents}
          feeCents={data.membership.hold_cents === data.quest.hold_cents ? data.quest.hold_fee_cents : 0}
          funding="PayPal"
          description={`${data.quest.code} ${data.quest.title}, for ${data.membership.user.name}`}
          orderId={token}
          onCancel={() => router.push(`/q/${data.quest.id}?hold=cancelled`)}
          onApprove={() => router.push(`/paypal/return?m=${data.membership.id}&token=${token}`)}
        />
      )}
    </main>
  );
}
