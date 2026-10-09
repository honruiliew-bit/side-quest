"""PayPal REST calls used by the quest engine.

Two implementations share one interface:
  SandboxGateway  real calls to api-m.sandbox.paypal.com (Orders v2, Payments v2, Payouts v1)
  MockGateway     same shapes, no network, for local development and simulated demo members
"""

from __future__ import annotations

import secrets
import string
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import settings
from ..pricing import from_value, to_value

SANDBOX_BASE = "https://api-m.sandbox.paypal.com"


class PayPalError(Exception):
    def __init__(self, message: str, status: int | None = None, details: Any = None, debug_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.details = details
        self.debug_id = debug_id

    @property
    def issue(self) -> str | None:
        if isinstance(self.details, list) and self.details:
            return self.details[0].get("issue")
        return None


@dataclass
class OrderResult:
    order_id: str
    approve_url: str | None
    status: str
    raw: dict = field(default_factory=dict)


@dataclass
class AuthResult:
    order_id: str | None
    authorization_id: str
    status: str
    expires_at: datetime | None = None
    funding: str | None = None
    raw: dict = field(default_factory=dict)


@dataclass
class CaptureResult:
    capture_id: str
    status: str
    raw: dict = field(default_factory=dict)
    paypal_fee_cents: int | None = None  # what PayPal kept, from seller_receivable_breakdown


@dataclass
class RefundResult:
    refund_id: str
    status: str
    raw: dict = field(default_factory=dict)
    fee_returned_cents: int | None = None  # the part of PayPal's fee handed back, from seller_payable_breakdown


@dataclass
class PayoutResult:
    batch_id: str
    status: str
    raw: dict = field(default_factory=dict)


def money_cents(obj: dict | None) -> int | None:
    """PayPal money objects look like {"currency_code": "USD", "value": "81.00"}."""
    if not obj or obj.get("value") in (None, ""):
        return None
    return from_value(obj["value"])


def estimate_capture_fee(cents: int) -> int:
    """PayPal's US commercial rate, used when PayPal didn't report the fee (simulated payments)."""
    return -(-cents * settings.paypal_fee_bps // 10_000) + settings.paypal_fee_fixed_cents if cents else 0


def estimate_refund_fee_back(cents: int) -> int:
    """On a refund PayPal returns the percentage part of its fee and keeps the fixed part."""
    return cents * settings.paypal_fee_bps // 10_000


Lines = list[tuple[str, int]]


def purchase_unit(cents: int, currency: str, ref: str, description: str, lines: Lines | None = None) -> dict:
    """One purchase unit. With lines, PayPal shows each one on its approval page (for example the trip share
    and Sidequest's booking fee). Lines are only sent when they add up to the total, which PayPal requires."""
    unit: dict[str, Any] = {
        "reference_id": ref, "custom_id": ref, "description": description[:127],
        "amount": {"currency_code": currency, "value": to_value(cents)},
    }
    lines = [(name, c) for name, c in (lines or []) if c > 0]
    if lines and sum(c for _, c in lines) == cents:
        unit["items"] = [{"name": name[:127], "quantity": "1",
                          "unit_amount": {"currency_code": currency, "value": to_value(c)}} for name, c in lines]
        unit["amount"]["breakdown"] = {"item_total": {"currency_code": currency, "value": to_value(cents)}}
    return unit


def _paypal_id(n: int = 17) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class MockGateway:
    """Behaves like the sandbox for the happy path. Nothing leaves the server."""

    name = "mock"

    def create_order(self, cents: int, currency: str, ref: str, description: str,
                     return_url: str, cancel_url: str, lines: Lines | None = None) -> OrderResult:
        order_id = _paypal_id()
        approve = f"{settings.frontend_url}/paypal/mock-approve?token={order_id}"
        unit = purchase_unit(cents, currency, ref, description, lines)
        return OrderResult(order_id, approve, "PAYER_ACTION_REQUIRED",
                           {"id": order_id, "intent": "AUTHORIZE", "amount": to_value(cents), "mock": True,
                            "purchase_units": [unit]})

    def authorize_order(self, order_id: str) -> AuthResult:
        auth_id = _paypal_id()
        expires = datetime.now(timezone.utc) + timedelta(days=29)
        return AuthResult(order_id, auth_id, "CREATED", expires, "paypal",
                          {"id": order_id, "status": "COMPLETED", "authorization": auth_id, "mock": True})

    def card_authorization(self, cents: int, currency: str, ref: str, description: str,
                           lines: Lines | None = None) -> AuthResult:
        order_id = _paypal_id()
        return self.authorize_order(order_id)

    def capture_authorization(self, authorization_id: str, cents: int, currency: str,
                              note: str = "", invoice_id: str | None = None) -> CaptureResult:
        return CaptureResult(_paypal_id(), "COMPLETED", {"amount": to_value(cents), "mock": True})

    def reauthorize(self, authorization_id: str, cents: int, currency: str) -> AuthResult:
        return AuthResult(None, _paypal_id(), "CREATED", None, None, {"mock": True})

    def void_authorization(self, authorization_id: str) -> str:
        return "VOIDED"

    def refund_capture(self, capture_id: str, cents: int, currency: str, note: str = "") -> RefundResult:
        return RefundResult(_paypal_id(), "COMPLETED", {"amount": to_value(cents), "mock": True})

    def payout(self, receiver_email: str, cents: int, currency: str, note: str, batch_ref: str) -> PayoutResult:
        return PayoutResult(_paypal_id(13), "SUCCESS", {"receiver": receiver_email, "amount": to_value(cents), "mock": True})

    def get_order(self, order_id: str) -> dict:
        return {"id": order_id, "status": "APPROVED", "mock": True}

    def verify_webhook(self, headers: dict, event: dict) -> bool:
        return True

    # Audit and disputes. Simulated payments never reach PayPal, so there is nothing to look up.
    def lookup(self, kind: str, ref: str) -> dict:
        raise PayPalError("Simulated payment. It never reached PayPal.", 404)

    def search_transactions(self, start: datetime, end: datetime) -> list[dict]:
        raise PayPalError("PayPal is in mock mode, so there is no PayPal statement to compare against.")

    def list_disputes(self) -> list[dict]:
        return []

    def accept_claim(self, dispute_id: str, note: str) -> dict:
        return {"dispute_id": dispute_id, "status": "RESOLVED", "mock": True}


class SandboxGateway:
    name = "sandbox"

    def __init__(self, client_id: str, client_secret: str, base_url: str = SANDBOX_BASE):
        self.client_id = client_id
        self.client_secret = client_secret
        self.base_url = base_url
        self._http = httpx.Client(base_url=base_url, timeout=25.0)
        self._token: str | None = None
        self._token_expiry = 0.0
        self._lock = threading.Lock()

    # Auth ---------------------------------------------------------------
    def _access_token(self) -> str:
        with self._lock:
            if self._token and time.time() < self._token_expiry - 60:
                return self._token
            resp = self._http.post(
                "/v1/oauth2/token",
                data={"grant_type": "client_credentials"},
                auth=(self.client_id, self.client_secret),
                headers={"Accept": "application/json"},
            )
            if resp.status_code != 200:
                raise PayPalError("Could not get a PayPal access token. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
                                  resp.status_code, resp.text)
            body = resp.json()
            self._token = body["access_token"]
            self._token_expiry = time.time() + int(body.get("expires_in", 3000))
            return self._token

    def _request(self, method: str, path: str, json: dict | None = None,
                 request_id: str | None = None, prefer_full: bool = True) -> dict:
        headers = {
            "Authorization": f"Bearer {self._access_token()}",
            "Content-Type": "application/json",
            "PayPal-Request-Id": request_id or str(uuid.uuid4()),
        }
        if prefer_full:
            headers["Prefer"] = "return=representation"
        resp = self._http.request(method, path, json=json, headers=headers)
        if resp.status_code == 204:
            return {}
        try:
            body = resp.json()
        except ValueError:
            body = {"text": resp.text}
        if resp.status_code >= 400:
            message = body.get("message") or body.get("error_description") or f"PayPal returned {resp.status_code}"
            details = body.get("details")
            if isinstance(details, list) and details:
                d = details[0]
                message = f"{d.get('issue', '')}: {d.get('description', message)}".strip(": ")
            raise PayPalError(message, resp.status_code, details, body.get("debug_id"))
        return body

    @staticmethod
    def _link(body: dict, *rels: str) -> str | None:
        for link in body.get("links", []):
            if link.get("rel") in rels:
                return link.get("href")
        return None

    # Orders v2 ----------------------------------------------------------
    def create_order(self, cents: int, currency: str, ref: str, description: str,
                     return_url: str, cancel_url: str, lines: Lines | None = None) -> OrderResult:
        body = self._request("POST", "/v2/checkout/orders", {
            "intent": "AUTHORIZE",
            "purchase_units": [{**purchase_unit(cents, currency, ref, description, lines), "soft_descriptor": "SIDEQUEST"}],
            "payment_source": {"paypal": {"experience_context": {
                "brand_name": settings.paypal_brand_name,
                "shipping_preference": "NO_SHIPPING",
                "user_action": "CONTINUE",
                "return_url": return_url,
                "cancel_url": cancel_url,
            }}},
        }, request_id=f"order-{ref}-{uuid.uuid4().hex[:8]}")
        return OrderResult(body["id"], self._link(body, "payer-action", "approve"), body.get("status", ""), body)

    @staticmethod
    def _auth_from_order(body: dict) -> AuthResult:
        units = body.get("purchase_units") or [{}]
        auths = (units[0].get("payments") or {}).get("authorizations") or []
        if not auths:
            raise PayPalError("PayPal did not return an authorization for this order.", None, body)
        auth = auths[0]
        funding = None
        source = body.get("payment_source") or {}
        if source:
            funding = next(iter(source.keys()))
        return AuthResult(body.get("id"), auth["id"], auth.get("status", ""),
                          _parse_time(auth.get("expiration_time")), funding, body)

    def authorize_order(self, order_id: str) -> AuthResult:
        body = self._request("POST", f"/v2/checkout/orders/{order_id}/authorize", {},
                             request_id=f"authorize-{order_id}")
        return self._auth_from_order(body)

    def card_authorization(self, cents: int, currency: str, ref: str, description: str,
                           lines: Lines | None = None) -> AuthResult:
        if not settings.demo_card_number:
            raise PayPalError("DEMO_CARD_NUMBER is not set.")
        body = self._request("POST", "/v2/checkout/orders", {
            "intent": "AUTHORIZE",
            "purchase_units": [purchase_unit(cents, currency, ref, description, lines)],
            "payment_source": {"card": {
                "name": "Demo Member",
                "number": settings.demo_card_number,
                "expiry": settings.demo_card_expiry,
                "security_code": settings.demo_card_cvv,
            }},
        }, request_id=f"card-{ref}-{uuid.uuid4().hex[:8]}")
        return self._auth_from_order(body)

    def get_order(self, order_id: str) -> dict:
        return self._request("GET", f"/v2/checkout/orders/{order_id}", prefer_full=False)

    # Payments v2 --------------------------------------------------------
    def capture_authorization(self, authorization_id: str, cents: int, currency: str,
                              note: str = "", invoice_id: str | None = None) -> CaptureResult:
        payload: dict[str, Any] = {
            "amount": {"currency_code": currency, "value": to_value(cents)},
            "final_capture": True,
        }
        if note:
            payload["note_to_payer"] = note[:255]
        if invoice_id:
            payload["invoice_id"] = invoice_id[:127]
        body = self._request("POST", f"/v2/payments/authorizations/{authorization_id}/capture", payload,
                             request_id=f"capture-{authorization_id}")
        fee = money_cents((body.get("seller_receivable_breakdown") or {}).get("paypal_fee"))
        return CaptureResult(body["id"], body.get("status", ""), body, fee)

    def reauthorize(self, authorization_id: str, cents: int, currency: str) -> AuthResult:
        body = self._request("POST", f"/v2/payments/authorizations/{authorization_id}/reauthorize",
                             {"amount": {"currency_code": currency, "value": to_value(cents)}},
                             request_id=f"reauth-{authorization_id}")
        return AuthResult(None, body["id"], body.get("status", ""), _parse_time(body.get("expiration_time")), None, body)

    def void_authorization(self, authorization_id: str) -> str:
        body = self._request("POST", f"/v2/payments/authorizations/{authorization_id}/void", None,
                             request_id=f"void-{authorization_id}")
        return body.get("status", "VOIDED") if body else "VOIDED"

    def refund_capture(self, capture_id: str, cents: int, currency: str, note: str = "") -> RefundResult:
        payload: dict[str, Any] = {"amount": {"currency_code": currency, "value": to_value(cents)}}
        if note:
            payload["note_to_payer"] = note[:255]
        body = self._request("POST", f"/v2/payments/captures/{capture_id}/refund", payload)
        back = money_cents((body.get("seller_payable_breakdown") or {}).get("paypal_fee"))
        return RefundResult(body["id"], body.get("status", ""), body, back)

    # Payouts v1 ---------------------------------------------------------
    def payout(self, receiver_email: str, cents: int, currency: str, note: str, batch_ref: str) -> PayoutResult:
        body = self._request("POST", "/v1/payments/payouts", {
            "sender_batch_header": {
                "sender_batch_id": batch_ref,
                "email_subject": "Your Sidequest payout",
                "email_message": note[:255],
            },
            "items": [{
                "recipient_type": "EMAIL",
                "amount": {"value": to_value(cents), "currency": currency},
                "receiver": receiver_email,
                "note": note[:4000],
                "sender_item_id": batch_ref,
            }],
        }, request_id=batch_ref, prefer_full=False)
        header = body.get("batch_header", {})
        return PayoutResult(header.get("payout_batch_id", ""), header.get("batch_status", ""), body)

    # Audit: read back what PayPal has on record ------------------------
    LOOKUP_PATHS = {
        "hold": "/v2/payments/authorizations/{}",
        "reauthorize": "/v2/payments/authorizations/{}",
        "release": "/v2/payments/authorizations/{}",
        "charge": "/v2/payments/captures/{}",
        "refund": "/v2/payments/refunds/{}",
        "payout": "/v1/payments/payouts/{}",
        "invoice": "/v2/invoicing/invoices/{}",
        "invoice_paid": "/v2/invoicing/invoices/{}",
    }

    def lookup(self, kind: str, ref: str) -> dict:
        path = self.LOOKUP_PATHS.get(kind)
        if not path:
            raise PayPalError(f"Nothing to look up for a {kind} entry.")
        return self._request("GET", path.format(ref), prefer_full=False)

    def search_transactions(self, start: datetime, end: datetime) -> list[dict]:
        """Transaction Search: PayPal's own statement. New sandbox transactions can take up to 3 hours to show."""
        out: list[dict] = []
        page, pages = 1, 1
        while page <= pages and page <= 5:
            q = urlencode({
                "start_date": start.strftime("%Y-%m-%dT%H:%M:%S-0000"),
                "end_date": end.strftime("%Y-%m-%dT%H:%M:%S-0000"),
                "fields": "transaction_info,payer_info", "page_size": 100, "page": page,
            })
            body = self._request("GET", f"/v1/reporting/transactions?{q}", prefer_full=False)
            out += body.get("transaction_details") or []
            pages = int(body.get("total_pages") or 1)
            page += 1
        return out

    # Disputes v1 -------------------------------------------------------
    def list_disputes(self) -> list[dict]:
        body = self._request("GET", "/v1/customer/disputes?page_size=50", prefer_full=False)
        return body.get("items") or []

    def get_dispute(self, dispute_id: str) -> dict:
        return self._request("GET", f"/v1/customer/disputes/{dispute_id}", prefer_full=False)

    def accept_claim(self, dispute_id: str, note: str) -> dict:
        """Accept the buyer's claim. PayPal refunds the buyer from Sidequest's balance."""
        return self._request("POST", f"/v1/customer/disputes/{dispute_id}/accept-claim",
                             {"note": note[:2000]}, request_id=f"accept-{dispute_id}", prefer_full=False)

    # Webhooks -----------------------------------------------------------
    def verify_webhook(self, headers: dict, event: dict) -> bool:
        if not settings.paypal_webhook_id:
            return False
        h = {k.lower(): v for k, v in headers.items()}
        body = self._request("POST", "/v1/notifications/verify-webhook-signature", {
            "auth_algo": h.get("paypal-auth-algo"),
            "cert_url": h.get("paypal-cert-url"),
            "transmission_id": h.get("paypal-transmission-id"),
            "transmission_sig": h.get("paypal-transmission-sig"),
            "transmission_time": h.get("paypal-transmission-time"),
            "webhook_id": settings.paypal_webhook_id,
            "webhook_event": event,
        }, prefer_full=False)
        return body.get("verification_status") == "SUCCESS"


_mock = MockGateway()
_sandbox: SandboxGateway | None = None


def paypal_mode() -> str:
    return settings.effective_paypal_mode


def gateway_for(provider: str = "paypal"):
    """Simulated members always use the mock. Everyone else follows PAYPAL_MODE."""
    global _sandbox
    if provider == "sim" or paypal_mode() == "mock":
        return _mock
    if _sandbox is None:
        _sandbox = SandboxGateway(settings.paypal_client_id, settings.paypal_client_secret)
    return _sandbox
