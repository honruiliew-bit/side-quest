"""Sidequest as an MCP server, so Claude, ChatGPT or any MCP client can find and join quests.

Joining from an assistant returns a PayPal approval link. The person approves the hold
on PayPal's own page, so an AI agent can commit to a quest for you but never moves
money without your approval.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from sqlalchemy import select

from . import engine
from .auth import get_or_create_user
from .config import settings
from .db import session_scope
from .models import Quest
from .pricing import fmt
from .views import quest_card

mcp = FastMCP(
    "Sidequest",
    instructions=("Sidequest lists small-group day trips and city adventures that only run if enough people "
                  "commit. Holding a spot places a PayPal authorization at the max price. Nobody is charged "
                  "unless the quest runs, and the final charge is the group split, which is usually lower."),
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


def _summary(card: dict) -> dict:
    return {
        "quest_id": card["id"],
        "code": card["code"],
        "title": card["title"],
        "area": card["area"],
        "starts_at": card["starts_at"],
        "join_by": card["join_by"],
        "status": card["status"],
        "going": f"{card['headcount']} of {card['max_people']} (runs at {card['min_people']})",
        "max_price": fmt(card["hold_cents"]),
        "price_if_full": fmt(card["lowest_cents"]),
        "price_now": fmt(card["share_cents"]),
        "url": f"{settings.frontend_url}/join/{card['id']}",
    }


@mcp.tool()
def list_quests(area: str | None = None, max_price_usd: float | None = None) -> list[dict]:
    """List quests that are still taking people. Optionally filter by area text or by the max price."""
    with session_scope() as db:
        rows = db.scalars(select(Quest).where(Quest.status.in_(["open", "on"]), Quest.tour.isnot(True))
                          .order_by(Quest.starts_at)).all()
        cards = [quest_card(q) for q in rows]
    if area:
        cards = [c for c in cards if area.lower() in (c["area"] + " " + c["title"]).lower()]
    if max_price_usd is not None:
        cards = [c for c in cards if c["hold_cents"] <= max_price_usd * 100]
    return [_summary(c) for c in cards]


@mcp.tool()
def get_quest(quest_id: str) -> dict:
    """Full plan, cost split and seats for one quest."""
    with session_scope() as db:
        q = db.get(Quest, quest_id)
        if not q:
            return {"error": "No quest with that id."}
        card = quest_card(q)
        return {
            **_summary(card),
            "summary": q.summary,
            "meet_point": q.meet_point,
            "plan": q.itinerary,
            "costs": [{"label": l["label"], "amount": fmt(l["cents"]), "split": l["split"]} for l in q.cost_lines],
            "going_names": [m.user.name for m in engine.seated(q)],
        }


@mcp.tool()
def hold_spot(quest_id: str, name: str, email: str) -> dict:
    """Start holding a spot for this person. Returns a PayPal link they must open to approve the hold.
    Nothing is charged now. Share the link with the person and tell them the max price."""
    with session_scope() as db:
        q = db.get(Quest, quest_id)
        if not q:
            return {"error": "No quest with that id."}
        user = get_or_create_user(db, name, email)
        try:
            m, order_id, approve_url = engine.start_hold(db, q, user)
        except engine.QuestError as exc:
            return {"error": str(exc)}
        return {
            "approve_url": approve_url,
            "max_price": fmt(m.hold_cents),
            "paypal_order_id": order_id,
            "next_step": "Open the link and approve the hold on PayPal. The spot is confirmed after approval.",
        }


@mcp.tool()
def check_my_spot(quest_id: str, email: str) -> dict:
    """Check whether a person's hold went through and what they will pay."""
    with session_scope() as db:
        q = db.get(Quest, quest_id)
        if not q:
            return {"error": "No quest with that id."}
        rows = [m for m in q.memberships if m.user.email == email.strip().lower()]
        if not rows:
            return {"status": "not joined"}
        m = rows[-1]
        return {
            "status": m.status,
            "seat": m.seat,
            "hold": fmt(m.hold_cents),
            "charged": fmt(m.charged_cents) if m.charged_cents else None,
            "quest_status": q.status,
            "price_now": fmt(engine.current_share(q)),
        }
