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
os.environ.update({"DATABASE_URL": f"sqlite:///{DB}", "PAYPAL_MODE": "mock", "ANTHROPIC_API_KEY": "sk-test"})
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


def _handler(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    REQUESTS.append(body)
    tools = {t["name"] for t in body.get("tools", [])}
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
