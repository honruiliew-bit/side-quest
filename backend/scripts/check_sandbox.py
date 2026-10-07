"""Proves the PayPal sandbox integration end to end with your keys.

    cd backend && python scripts/check_sandbox.py

What it does, all against api-m.sandbox.paypal.com:
  1. Gets an OAuth token.
  2. Creates an Orders v2 order with intent AUTHORIZE and prints the approval link.
  3. Waits while you open the link and approve with a sandbox personal account.
  4. Authorizes the order, captures less than the hold (the final split), then refunds part of it.
  5. Creates a second hold and voids it (the "quest didn't run" path).
  6. Sends a $1.00 Payout to a sandbox email (the host payout).
  7. Creates and sends a PayPal invoice through the PayPal Agent Toolkit.

Every step prints the PayPal id so you can find it in the sandbox dashboard.
"""

import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("PAYPAL_MODE", "sandbox")

from app.config import settings  # noqa: E402
from app.paypal import toolkit  # noqa: E402
from app.paypal.gateway import PayPalError, SandboxGateway  # noqa: E402
from app.pricing import fmt  # noqa: E402


def step(n, text):
    print(f"\n[{n}] {text}")

def wait_for_approval(gw, order_id, url):
    """Keep asking until PayPal reports the order as APPROVED."""
    while True:
        input("    Approve it in the browser, then press Enter. ")
        status = gw.get_order(order_id).get("status")
        if status == "APPROVED":
            print("    approved")
            return
        print(f"    PayPal still shows {status}. Open the link again and finish approving:")
        print(f"    {url}")



def main():
    if not settings.paypal_live_keys:
        sys.exit("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in backend/.env first.")
    gw = SandboxGateway(settings.paypal_client_id, settings.paypal_client_secret)

    step(1, "OAuth token")
    gw._access_token()
    print("    ok")

    step(2, "Create an order to hold $81.00 (intent AUTHORIZE)")
    ref = f"check-{uuid.uuid4().hex[:8]}"
    order = gw.create_order(8100, "USD", ref, "Sidequest sandbox check",
                            return_url="https://example.com/return", cancel_url="https://example.com/cancel")
    print(f"    order {order.order_id}")
    print(f"    approve here: {order.approve_url}")

    step(3, "Approve it")
    print("    Log in with a sandbox PERSONAL account and approve.")
    wait_for_approval(gw, order.order_id, order.approve_url)

    step(4, "Authorize, capture the final split, refund part")
    auth = gw.authorize_order(order.order_id)
    print(f"    authorization {auth.authorization_id} {auth.status} expires {auth.expires_at}")
    cap = gw.capture_authorization(auth.authorization_id, 6729, "USD", note="Final split for 7 people")
    print(f"    captured {fmt(6729)} of {fmt(8100)}: capture {cap.capture_id} {cap.status}")
    ref_ = gw.refund_capture(cap.capture_id, 500, "USD", note="Costs came in under")
    print(f"    refunded {fmt(500)}: refund {ref_.refund_id} {ref_.status}")

    step(5, "A second hold that gets voided (quest didn't run)")
    order2 = gw.create_order(4500, "USD", ref + "-2", "Sidequest void check",
                             return_url="https://example.com/return", cancel_url="https://example.com/cancel")
    print(f"    approve here: {order2.approve_url}")
    wait_for_approval(gw, order2.order_id, order2.approve_url)
    auth2 = gw.authorize_order(order2.order_id)
    print(f"    authorization {auth2.authorization_id}, voiding")
    print(f"    {gw.void_authorization(auth2.authorization_id)}")

    step(6, "Payout $1.00 to the host")
    receiver = input("    Sandbox email to pay (Enter to skip): ").strip()
    if receiver:
        try:
            p = gw.payout(receiver, 100, "USD", "Sidequest sandbox check", f"check-{uuid.uuid4().hex[:10]}")
            print(f"    batch {p.batch_id} {p.status}")
        except PayPalError as exc:
            print(f"    Payouts failed: {exc}. Enable Payouts on your sandbox business account if needed.")

    step(7, "Invoice through the PayPal Agent Toolkit")
    if receiver:
        inv = toolkit.create_and_send_invoice(email=receiver, name="Sandbox Tester", cents=1250,
                                              item="Gas overage", note="Sandbox check", reference=ref)
        print(f"    invoice {inv['invoice_id']} {inv['status']}")

    print("\nAll good. Open developer.paypal.com > Sandbox > Accounts > your business account to see each step.")


if __name__ == "__main__":
    main()
