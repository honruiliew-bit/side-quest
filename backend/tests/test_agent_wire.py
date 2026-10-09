"""Runs the real Anthropic SDK against a fake HTTP transport, so the tool loop and the
request bodies are exercised exactly as they would be against the API."""

import json
import os
import sys
from pathlib import Path

import httpx2 as httpx

DB = Path(__file__).parent / "test_agent.db"
if DB.exists():
    DB.unlink()
os.environ.update({"DATABASE_URL": f"sqlite:///{DB}", "PAYPAL_MODE": "mock", "ANTHROPIC_API_KEY": "sk-test",
                   "BOOKING_FEE_BPS": "0", "BOOKING_FEE_FIXED_CENTS": "0"})
os.environ.pop("ANTHROPIC_BASE_URL", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from anthropic import Anthropic  # noqa: E402

from app.agent import builder, keeper, llm  # noqa: E402
from app.db import init_db, session_scope  # noqa: E402
from app.models import Quest, User  # noqa: E402
from app.seed import seed  # noqa: E402
from sqlalchemy import select  # noqa: E402

REQUESTS = []


def _msg(content, stop):
    return {"id": "msg_1", "type": "message", "role": "assistant", "model": "test", "content": content,
            "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}


RECEIPT_READS = []


REJECT_FORCED = [False]


def _handler(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    REQUESTS.append(body)
    if REJECT_FORCED[0] and (body.get("tool_choice") or {}).get("type") in {"tool", "any"}:
        return httpx.Response(400, json={"type": "error", "error": {
            "type": "invalid_request_error",
            "message": 'tool_choice: type "tool" and "any" are not supported for this model.'}})
    tools = {t["name"] for t in body.get("tools", [])}
    if "read_receipt" in tools:
        RECEIPT_READS.append(body)
        answer = RECEIPT_READS_ANSWERS[len(RECEIPT_READS) - 1]
        return httpx.Response(200, json=_msg([{"type": "tool_use", "id": "tu_r", "name": "read_receipt", "input": answer}], "tool_use"))
    if "draft_quest" in tools:
        return httpx.Response(200, json=_msg([{"type": "tool_use", "id": "tu_d", "name": "draft_quest", "input": {
            "title": "Sunrise kayak", "area": "Hudson River", "summary": "Paddle at dawn.", "line_code": "hr",
            "from_label": "Pier 96", "to_label": "Pier 96", "meet_point": "Pier 96 boathouse", "date": "2026-10-10",
            "start_time": "06:30", "end_time": "09:00", "min_people": 3, "max_people": 6, "join_by_hours_before": 24,
            "itinerary": [{"time": "6:30 am", "title": "Launch", "detail": "Life vests on"},
                          {"time": "8:30 am", "title": "Coffee", "detail": "Pay your own"}],
            "cost_lines": [{"label": "Guide", "amount_usd": 150, "split": "shared"},
                           {"label": "Kayak", "amount_usd": 25.5, "split": "each"}]}}], "tool_use"))
    turn = sum(1 for m in body["messages"] if m["role"] == "assistant")
    if turn == 0:
        return httpx.Response(200, json=_msg([
            {"type": "text", "text": "Checking."},
            {"type": "tool_use", "id": "tu_1", "name": "get_quest_state", "input": {}},
            {"type": "tool_use", "id": "tu_2", "name": "paypal_get_order_details", "input": {"order_id": "NOT-MINE"}},
        ], "tool_use"))
    if turn == 1:
        return httpx.Response(200, json=_msg([
            {"type": "tool_use", "id": "tu_3", "name": "leave_quest", "input": {"reason": "sick"}}], "tool_use"))
    return httpx.Response(200, json=_msg([{"type": "text", "text": "Done, Dev. Your $81.00 hold was released."}], "end_turn"))


def test_agent_loop_over_the_real_sdk():
    llm._client = Anthropic(api_key="sk-test", http_client=httpx.Client(transport=httpx.MockTransport(_handler)))
    init_db()
    with session_scope() as db:
        seed(db)
    with session_scope() as db:
        q = db.scalar(select(Quest).where(Quest.line_code == "HV"))
        dev = db.scalar(select(User).where(User.persona == "dev"))
        out = keeper.reply(db, q, dev, "I'm sick, can't make it Saturday")
        assert out["tools"] == ["get_quest_state", "paypal_get_order_details", "leave_quest"]
        assert out["body"].startswith("Done, Dev")
        assert all(m.user_id != dev.id or m.status == "released" for m in q.memberships)

    # Second request carries the assistant turn and both tool results, the second one an error.
    second = REQUESTS[1]["messages"]
    assert second[1]["role"] == "assistant" and second[1]["content"][1]["type"] == "tool_use"
    results = second[2]["content"]
    assert results[0]["type"] == "tool_result" and not results[0]["is_error"]
    assert results[1]["is_error"] is True and "own order" in results[1]["content"]
    assert any(t["name"] == "paypal_get_invoice" for t in REQUESTS[0]["tools"])


def test_builder_uses_forced_tool():
    d = builder.draft("sunrise kayak on the hudson for 5")
    assert d["source"] == "claude" and d["line_code"] == "HR"
    assert d["cost_lines"] == [{"label": "Guide", "cents": 15000, "split": "shared"},
                               {"label": "Kayak", "cents": 2550, "split": "each"}]
    assert REQUESTS[-1]["tool_choice"] == {"type": "tool", "name": "draft_quest"}


RECEIPT_READS_ANSWERS = [
    {"is_receipt": True, "legible": True, "merchant": "Route 9 Fuel", "date": None, "total_usd": 95.0,
     "category": "fuel", "cost_line": "Gas and tolls", "concerns": []},
    {"is_receipt": True, "legible": True, "merchant": "Big Spender", "date": "2025-01-01", "total_usd": 900.0,
     "category": "fuel", "cost_line": "Gas and tolls", "concerns": ["Total looks hand edited"]},
    {"is_receipt": False, "legible": True, "merchant": None, "date": None, "total_usd": None,
     "category": "other", "cost_line": "none", "concerns": []},
]


def test_receipts_are_read_by_claude_and_checked():
    from app import engine
    from app.models import Quest, User

    with session_scope() as db:
        q = db.scalar(select(Quest).where(Quest.line_code == "RI"))  # finished trip with a "Gas and tolls" line
        ana = db.get(User, q.host_id)
        good = engine.add_receipt(db, q, ana, "gas.png", "image/png", b"\x89PNGgood")
        bad = engine.add_receipt(db, q, ana, "big.png", "image/png", b"\x89PNGbad")
        cat = engine.add_receipt(db, q, ana, "cat.png", "image/png", b"\x89PNGcat")
        assert good.status == "verified" and good.total_cents == 9500 and good.cost_line == "Gas and tolls"
        assert bad.status == "flagged"
        assert any("edited" in i for i in bad.issues)
        assert any("outside the trip" in i for i in bad.issues)
        assert any("three times" in i for i in bad.issues)
        assert cat.status == "rejected"
    image_block = RECEIPT_READS[0]["messages"][0]["content"][0]
    assert image_block["type"] == "image" and image_block["source"]["media_type"] == "image/png"
    assert RECEIPT_READS[0]["tool_choice"] == {"type": "tool", "name": "read_receipt"}


def test_models_without_forced_tool_choice_still_work():
    """Reproduces claude-sonnet-5-5 rejecting tool_choice type tool: the call retries with auto and remembers."""
    from app import engine
    from app.models import Quest, User

    REJECT_FORCED[0] = True
    llm._forced_ok = True
    RECEIPT_READS.clear()
    RECEIPT_READS_ANSWERS[:] = [{"is_receipt": True, "legible": True, "merchant": "Route 9 Fuel", "date": None,
                                 "total_usd": 95.0, "category": "fuel", "cost_line": "Gas and tolls", "concerns": []}]
    before = len(REQUESTS)
    d = builder.draft("sunrise kayak on the hudson for 5")
    assert d["source"] == "claude"
    kinds = [(r.get("tool_choice") or {}).get("type") for r in REQUESTS[before:]]
    assert kinds == ["tool", "auto"]  # one rejected attempt, then auto
    assert llm._forced_ok is False
    with session_scope() as db:
        q = db.scalar(select(Quest).where(Quest.line_code == "RI"))
        r = engine.add_receipt(db, q, db.get(User, q.host_id), "gas2.png", "image/png", b"\x89PNGagain")
        assert r.reader == "claude" and r.total_cents == 9500
    assert (REQUESTS[-1].get("tool_choice") or {}).get("type") == "auto"  # no second rejected attempt
    REJECT_FORCED[0] = False
