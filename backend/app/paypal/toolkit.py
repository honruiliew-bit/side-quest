"""PayPal Agent Toolkit, adapted for Claude.

The official toolkit ships adapters for OpenAI Agents, LangChain and CrewAI. Its
shared layer (tool names, descriptions, pydantic parameter models and handlers) is
framework-free, so this module turns those tools into Anthropic tool definitions and
runs them through the toolkit's own handlers.

In mock mode the toolkit's parameter models still validate every call, so a bad
payload fails here exactly as it would against the sandbox.
"""

from __future__ import annotations

import json
import secrets
import string
from datetime import date
from typing import Any

from paypal_agent_toolkit.shared.configuration import Context
from paypal_agent_toolkit.shared.tools import tools as TOOLKIT_TOOLS

from ..config import settings
from .gateway import paypal_mode

_BY_METHOD = {t["method"]: t for t in TOOLKIT_TOOLS}

# Read-only toolkit tools the quest agent may call directly.
AGENT_READ_TOOLS = ["get_order_details", "get_invoice"]


def _schema(tool: dict) -> dict:
    schema = tool["args_schema"].model_json_schema()
    schema.pop("title", None)
    return schema


def claude_tools(methods: list[str]) -> list[dict]:
    """Toolkit tools as Anthropic tool definitions, prefixed so they are easy to spot."""
    out = []
    for method in methods:
        tool = _BY_METHOD[method]
        out.append({
            "name": f"paypal_{method}",
            "description": f"[PayPal Agent Toolkit] {tool['description'].strip()}"[:1024],
            "input_schema": _schema(tool),
        })
    return out


def is_toolkit_tool(name: str) -> bool:
    return name.startswith("paypal_") and name[len("paypal_"):] in _BY_METHOD


_client = None


def _real_client():
    """The toolkit's own PayPal client, with its access token cached.

    Out of the box it fetches a new OAuth token before every request, which made sending
    seven invoices take about twenty requests. Reusing the gateway's cached token cuts that
    to one request per call."""
    global _client
    if _client is None:
        from paypal_agent_toolkit.shared.paypal_client import PayPalClient

        from .gateway import gateway_for

        class CachedTokenClient(PayPalClient):
            def get_access_token(self):  # noqa: D401
                return gateway_for("paypal")._access_token()

        _client = CachedTokenClient(settings.paypal_client_id, settings.paypal_client_secret,
                                    Context(sandbox=True, source="SIDEQUEST"))
    return _client


def _mock_id(prefix: str) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return prefix + "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))


def _mock(method: str, params: dict) -> dict:
    if method == "create_invoice":
        inv = _mock_id("INV2-")
        return {"id": inv, "status": "DRAFT", "href": f"https://api-m.sandbox.paypal.com/v2/invoicing/invoices/{inv}"}
    if method == "send_invoice":
        inv = params["invoice_id"]
        return {"href": f"https://www.sandbox.paypal.com/invoice/p/#{inv}", "status": "SENT"}
    if method == "get_invoice":
        return {"id": params.get("invoice_id"), "status": "SENT", "mock": True}
    if method == "get_order_details":
        return {"status": "COMPLETED", "order_id": params.get("order_id"), "mock": True}
    return {"ok": True, "mock": True}


def run(method: str, params: dict) -> dict:
    """Run a toolkit tool and return parsed JSON."""
    tool = _BY_METHOD[method]
    tool["args_schema"](**params)  # validate with the toolkit's own model
    if paypal_mode() == "mock":
        return _mock(method, params)
    raw = tool["execute"](_real_client(), params)
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return {"text": raw}


def run_for_claude(name: str, params: dict) -> str:
    method = name[len("paypal_"):]
    try:
        result = run(method, params)
    except Exception as exc:  # surfaced to the model as a tool error
        return json.dumps({"error": str(exc)[:500]})
    return json.dumps(result)[:6000]


def invoice_params(*, email: str, name: str, cents: int, item: str, note: str, reference: str,
                   description: str | None = None) -> dict:
    return {
        "currency_code": settings.currency,
        "invoice_date": date.today().isoformat(),
        "reference": reference[:120],
        "note": note[:4000],
        "primary_recipients": [{"billing_info": {"email_address": email, "name": {"given_name": name}}}],
        "items": [{
            "name": item[:200],
            **({"description": description[:1000]} if description else {}),
            "quantity": "1",
            "unit_amount": {"currency_code": settings.currency, "value": f"{cents // 100}.{cents % 100:02d}"},
        }],
    }


def create_and_send_invoice(*, email: str, name: str, cents: int, item: str, note: str, reference: str,
                            description: str | None = None) -> dict[str, Any]:
    created = run("create_invoice", invoice_params(email=email, name=name, cents=cents, item=item,
                                                   note=note, reference=reference, description=description))
    invoice_id = created.get("id")
    if not invoice_id and isinstance(created.get("href"), str):
        invoice_id = created["href"].rstrip("/").split("/")[-1]
    if not invoice_id:
        raise RuntimeError(f"PayPal did not return an invoice id: {created}")
    sent = run("send_invoice", {"invoice_id": invoice_id, "send_to_recipient": True})
    return {"invoice_id": invoice_id, "status": sent.get("status", "SENT"), "link": sent.get("href")}
