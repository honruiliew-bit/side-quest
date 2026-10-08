"""The Render Workflows tasks, run without Render: fan-out, per-person failures, and no double billing."""

import asyncio
import os
import sys
from pathlib import Path

os.environ.update({"PAYPAL_MODE": "mock", "ANTHROPIC_API_KEY": ""})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import workflows  # noqa: E402
from app.paypal import toolkit  # noqa: E402


class FakeCtx:
    """Stands in for Render's TaskContext: runs child tasks in-process."""

    def __init__(self, fail_keys=()):
        self.fail_keys = set(fail_keys)
        self.ran = []

    async def run(self, task, job):
        self.ran.append(job["key"])
        if job["key"] in self.fail_keys:
            raise RuntimeError("PayPal said no")
        return task.func(self, job)


def job(key):
    return {"key": key, "email": f"{key}@example.com", "name": key.title(), "cents": 1100, "item": "Gas overage",
            "note": "Receipts attached", "reference": "SQ-417", "number": toolkit.invoice_number(417, f"m_{key}", 1100)}


def test_settle_up_sends_everyone_and_reports_failures_per_person():
    ctx = FakeCtx(fail_keys={"sam"})
    out = asyncio.run(workflows.settle_up.func(ctx, [job("leo"), job("sam"), job("noor")]))
    assert sorted(ctx.ran) == ["leo", "noor", "sam"]
    by = {r["key"]: r for r in out}
    assert by["leo"]["invoice_id"].startswith("INV2-") and by["noor"]["status"] == "SENT"
    assert "PayPal said no" in by["sam"]["error"]


def test_retry_after_a_lost_response_finds_the_invoice_instead_of_billing_twice(monkeypatch):
    class Dupe(Exception):
        response = type("R", (), {"text": '{"name":"UNPROCESSABLE_ENTITY","details":[{"issue":"DUPLICATE_INVOICE_NUMBER"}]}'})()

    sent = []

    def fake_run(method, params):
        if method == "create_invoice":
            raise Dupe("422")
        if method == "search_invoicing":
            assert params["invoice_filters"]["invoice_number"] == "SQ-417-m_leo-1100"
            return {"items": [{"id": "INV2-ALREADY-SENT", "status": "SENT"}]}
        sent.append(method)
        return {}

    monkeypatch.setattr(toolkit, "run", fake_run)
    out = workflows.send_invoice.func(None, job("leo"))
    assert out["invoice_id"] == "INV2-ALREADY-SENT" and out.get("recovered") is True
    assert sent == []  # nothing was sent a second time


def test_invoice_numbers_are_stable_and_fit_paypal():
    a = toolkit.invoice_number(417, "ms_AbCdEfGhIj", 1100)
    assert a == toolkit.invoice_number(417, "ms_AbCdEfGhIj", 1100) and len(a) <= 25
    assert a != toolkit.invoice_number(417, "ms_AbCdEfGhIj", 1200)
