"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { QuestDetail } from "@/lib/types";
import { MockPayPalSheet } from "./MockPayPalSheet";

type HoldStart = { membership_id: string; order_id: string; approve_url: string | null; hold_cents: number };

/**
 * Sandbox: PayPal's own Smart Buttons (PayPal, Venmo when eligible, cards) with intent=authorize.
 * Pay Later is turned off because installment plans can't be authorized now and captured later.
 * Mock: the same choices, approved in a clearly labelled mock sheet.
 */
export function HoldButton({ q, onDone }: { q: QuestDetail; onDone: (q: QuestDetail) => void }) {
  const { config, user, toast } = useSession();
  const membership = useRef<string | null>(null);
  const [pending, setPending] = useState<HoldStart | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (): Promise<HoldStart> => {
    const res = await api<HoldStart>(`/quests/${q.id}/holds`, { method: "POST" });
    membership.current = res.membership_id;
    return res;
  };

  const confirm = async (orderId: string, membershipId: string) => {
    const detail = await api<QuestDetail>(`/holds/${membershipId}/confirm`, { method: "POST", json: { order_id: orderId } });
    onDone(detail);
    const mine = detail.viewer.membership;
    toast(
      mine?.status === "standby"
        ? `Hold placed. You're on standby for ${money(q.hold_cents)}.`
        : `Hold placed. ${money(q.hold_cents)} is held by PayPal, not charged.`,
      "money",
    );
  };

  if (!user) return <p className="text-[15px] text-muted">Pick who you are in the top right to hold a spot.</p>;

  if (config?.paypal_mode === "sandbox" && config.paypal_client_id) {
    return (
      <div className="flex flex-col gap-2">
        <PayPalScriptProvider
          options={{
            clientId: config.paypal_client_id,
            intent: "authorize",
            currency: q.currency,
            components: "buttons",
            enableFunding: "venmo",
            // Pay Later is an installment loan and can't be held then captured later.
            disableFunding: "paylater,credit",
          }}
        >
          <PayPalButtons
            style={{ layout: "vertical", color: "blue", shape: "rect", label: "paypal", height: 48, tagline: false }}
            createOrder={async () => (await start()).order_id}
            onApprove={async (data, actions) => {
              try {
                await confirm(data.orderID, membership.current!);
              } catch (e) {
                const msg = e instanceof Error ? e.message : "PayPal couldn't place the hold.";
                if (msg.includes("declined")) {
                  toast(msg, "error");
                  return actions.restart();
                }
                toast(msg, "error");
              }
            }}
            onCancel={() => toast("Hold cancelled. Nothing was held.")}
            onError={(err) => toast(err instanceof Error ? err.message : "PayPal hit an error. Try again.", "error")}
          />
        </PayPalScriptProvider>
      </div>
    );
  }

  const begin = async (funding: string) => {
    setBusy(true);
    try {
      const res = await start();
      setPending({ ...res, approve_url: funding });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't start the hold.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button className="btn btn-money w-full" disabled={busy} onClick={() => begin("PayPal")}>
        {busy ? "Opening PayPal" : `Hold ${money(q.hold_cents)} with PayPal`}
      </button>
      <div className="flex gap-2">
        <button className="btn btn-ghost-money btn-sm flex-1" disabled={busy} onClick={() => begin("Venmo")}>Venmo</button>
        <button className="btn btn-ghost-money btn-sm flex-1" disabled={busy} onClick={() => begin("a card")}>Debit or credit card</button>
      </div>
      {pending && (
        <MockPayPalSheet
          amountCents={pending.hold_cents}
          funding={pending.approve_url ?? "PayPal"}
          description={`${q.code} ${q.title}`}
          orderId={pending.order_id}
          onCancel={() => {
            setPending(null);
            toast("Hold cancelled. Nothing was held.");
          }}
          onApprove={async () => {
            try {
              await confirm(pending.order_id, pending.membership_id);
            } catch (e) {
              toast(e instanceof Error ? e.message : "Couldn't place the hold.", "error");
            } finally {
              setPending(null);
            }
          }}
        />
      )}
    </div>
  );
}
