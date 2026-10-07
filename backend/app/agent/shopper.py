"""A stand-in for someone's own AI assistant (Claude, ChatGPT) connected to Sidequest over MCP.

It gets exactly the four tools the MCP server exposes and nothing else, so what judges see on
the page is what a real assistant would do with the connector.
"""

from __future__ import annotations

import json
import re

from .. import mcp_server
from ..models import User
from . import llm

TOOLS = [
    {"name": "list_quests", "description": mcp_server.list_quests.__doc__.strip(),
     "input_schema": {"type": "object", "properties": {
         "area": {"type": "string"}, "max_price_usd": {"type": "number"}}}},
    {"name": "get_quest", "description": mcp_server.get_quest.__doc__.strip(),
     "input_schema": {"type": "object", "properties": {"quest_id": {"type": "string"}}, "required": ["quest_id"]}},
    {"name": "hold_spot", "description": " ".join(mcp_server.hold_spot.__doc__.split()),
     "input_schema": {"type": "object", "properties": {
         "quest_id": {"type": "string"}, "name": {"type": "string"}, "email": {"type": "string"}},
         "required": ["quest_id", "name", "email"]}},
    {"name": "check_my_spot", "description": mcp_server.check_my_spot.__doc__.strip(),
     "input_schema": {"type": "object", "properties": {
         "quest_id": {"type": "string"}, "email": {"type": "string"}}, "required": ["quest_id", "email"]}},
]

FUNCS = {
    "list_quests": mcp_server.list_quests,
    "get_quest": mcp_server.get_quest,
    "hold_spot": mcp_server.hold_spot,
    "check_my_spot": mcp_server.check_my_spot,
}

SYSTEM = """You are the user's personal AI assistant. The user connected the Sidequest app to you over MCP.
Sidequest lists small-group day trips and city adventures that only run if enough people commit.

The user is {name}, email {email}. Use that name and email when holding a spot.

How to help
- To find things to do, call list_quests. Mention two or three good options with the max price, the price if
  it fills, and how many more people are needed. Keep it short.
- Only call hold_spot when the user clearly asks to join or hold a specific quest.
- After hold_spot, tell them to open the PayPal link to approve the hold. Say it's a hold, not a charge, and
  they only pay the final split if the quest runs. Never say the spot is confirmed before they approve.
- Plain sentences. No em dashes, no exclamation marks, no markdown tables."""


def chat(user: User, messages: list[dict]) -> dict:
    """Returns {"reply", "trace": [{tool, input, output}], "approve_url"}."""
    trace: list[dict] = []

    def handle(name: str, args: dict):
        if name not in FUNCS:
            raise ValueError(f"Unknown tool {name}")
        if name == "hold_spot":
            args = {**args, "name": user.name, "email": user.email}
        if name == "check_my_spot":
            args = {**args, "email": user.email}
        out = FUNCS[name](**args)
        trace.append({"tool": name, "input": args, "output": out})
        return out

    if llm.enabled():
        try:
            reply, _ = llm.run_with_tools(SYSTEM.format(name=user.name, email=user.email),
                                          messages[-12:], TOOLS, handle, max_turns=5, max_tokens=700)
            return _result(reply, trace, "claude")
        except Exception as exc:
            llm.log.warning("shopper fell back: %s", exc)
            trace.clear()
    return _offline(user, messages, handle, trace)


def _result(reply: str, trace: list[dict], engine: str) -> dict:
    approve = next((t["output"].get("approve_url") for t in reversed(trace)
                    if t["tool"] == "hold_spot" and isinstance(t["output"], dict)), None)
    return {"reply": reply, "trace": trace, "approve_url": approve, "engine": engine}


def _offline(user: User, messages: list[dict], handle, trace: list[dict]) -> dict:
    """Rule-based stand-in so the page still works without an Anthropic key."""
    text = str(messages[-1]["content"]).lower()
    price = re.search(r"\$?(\d{2,4})", text)
    wants_hold = re.search(r"\b(hold|join|book|sign me up|i'?m in|reserve)\b", text)
    quests = handle("list_quests", {"max_price_usd": float(price.group(1))} if price and not wants_hold else {})
    if not quests:
        return _result("I couldn't find any quests that match. Try a higher budget.", trace, "offline")
    if wants_hold:
        pick = None
        number = re.search(r"\b(first|second|third|1|2|3)\b", text)
        if number:
            idx = {"first": 0, "1": 0, "second": 1, "2": 1, "third": 2, "3": 2}[number.group(1)]
            pick = quests[idx] if idx < len(quests) else None
        for q in quests:
            words = [w for w in re.findall(r"[a-z]{4,}", q["title"].lower())]
            if any(w in text for w in words):
                pick = q
                break
        pick = pick or quests[0]
        out = handle("hold_spot", {"quest_id": pick["quest_id"]})
        if isinstance(out, dict) and out.get("error"):
            return _result(f"I couldn't hold that one: {out['error']}", trace, "offline")
        return _result(f"I started a hold on {pick['title']}. Open the PayPal link to approve up to {out['max_price']}. "
                       f"It's a hold, not a charge. You only pay the final split if the quest runs.", trace, "offline")
    top = quests[:3]
    lines = [f"{i + 1}. {q['title']}: up to {q['max_price']}, {q['price_if_full']} if it fills. {q['going']}."
             for i, q in enumerate(top)]
    return _result("Here are some quests still taking people:\n" + "\n".join(lines) +
                   "\nWant me to hold a spot on one of them?", trace, "offline")
