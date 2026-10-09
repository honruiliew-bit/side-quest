"""Host desk: the data behind the AG Studio dashboard, invoice reminders, and the Claude
proxy that lets AG Studio's agents run on Claude without the key reaching the browser."""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from . import engine
from .auth import require_user
from .config import settings
from .db import get_db
from .models import Invoice, LedgerEntry, Membership, Quest, User, aware, utcnow
from .paypal.gateway import paypal_mode

router = APIRouter()

EVENT = {
    "hold": "Hold placed", "release": "Hold released", "charge": "Charged", "refund": "Refunded",
    "payout": "Paid out to host", "invoice": "Invoice sent", "invoice_paid": "Invoice paid",
    "reauthorize": "Hold renewed", "decline": "Declined",
}
SEATED = {"held", "charged", "refunded"}


def _source(provider: str) -> str:
    if provider == "sim":
        return "Simulated"
    return "Mock" if paypal_mode() == "mock" else "Sandbox"


def _visible_quests(db: Session, user: User) -> tuple[list[Quest], set[str]]:
    joined = select(Membership.quest_id).where(Membership.user_id == user.id,
                                               Membership.status.notin_(["abandoned", "pending"]))
    quests = db.scalars(select(Quest).where(
        Quest.tour.isnot(True), or_(Quest.host_id == user.id, Quest.id.in_(joined))
    ).order_by(Quest.starts_at)).all()
    return list(quests), {q.id for q in quests if q.host_id == user.id}


def _dollars(cents: int) -> float:
    return round(cents / 100, 2)


@router.get("/me/books")
def books(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Three related tables for AG Studio. Hosts see everyone on their quests; members see their own rows."""
    quests, hosting = _visible_quests(db, user)
    ids = [q.id for q in quests]
    if not ids:
        return {"hosting": False, "quests": [], "ledger": [], "dues": [], "paypal_mode": paypal_mode()}
    mine = lambda qid, uid: qid in hosting or uid == user.id  # noqa: E731

    ledger = db.scalars(select(LedgerEntry).where(LedgerEntry.quest_id.in_(ids))
                        .order_by(LedgerEntry.created_at.desc()).limit(3000)).all()
    invoices = db.scalars(select(Invoice).where(Invoice.quest_id.in_(ids)).order_by(Invoice.created_at.desc())).all()
    now = utcnow()

    return {
        "hosting": bool(hosting),
        "paypal_mode": paypal_mode(),
        "quests": [{
            "id": q.id, "title": q.title, "line": q.line_code, "status": q.status.capitalize(),
            "role": "Host" if q.id in hosting else "Member", "host": q.host.name,
            "starts_at": aware(q.starts_at).isoformat(),
            "travelers": sum(1 for m in q.memberships if m.status in SEATED),
            "min_people": q.min_people,
        } for q in quests],
        "ledger": [{
            "id": e.id, "quest_id": e.quest_id, "person": e.user.name if e.user else "Sidequest",
            "event": EVENT.get(e.kind, e.kind), "kind": e.kind,
            # Money in, positive. Refunds go back out, negative. Holds and invoices are shown at face value.
            "amount": -_dollars(e.cents) if e.kind == "refund" else _dollars(e.cents),
            "source": _source(e.provider),
            "confirmed": "Yes" if e.confirmed else "No", "at": aware(e.created_at).isoformat(),
        } for e in ledger if mine(e.quest_id, e.user_id)],
        "dues": [{
            "id": i.id, "quest_id": i.quest_id, "person": i.user.name, "amount": _dollars(i.cents),
            "status": {"sent": "Open", "paid": "Paid", "cancelled": "Cancelled"}[i.status],
            "item": i.item, "sent_at": aware(i.created_at).isoformat(),
            "days_open": max(0, ((aware(i.paid_at) if i.paid_at else now) - aware(i.created_at)).days),
            # The PayPal id is only sent to the person who owes it, so they can open the invoice and pay.
            "reminders": i.reminders, "paypal_id": i.paypal_id if i.user_id == user.id else "",
            "source": _source(i.provider),
            "can_remind": i.quest_id in hosting and i.status == "sent" and i.reminders < engine.MAX_REMINDERS,
        } for i in invoices if mine(i.quest_id, i.user_id)],
    }


@router.post("/me/books/refresh")
def refresh_books(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Ask PayPal whether open invoices on your quests have been paid."""
    _, hosting = _visible_quests(db, user)
    invoices = db.scalars(select(Invoice).where(
        Invoice.status == "sent", or_(Invoice.quest_id.in_(hosting), Invoice.user_id == user.id))).all()
    changed = 0
    for qid in {i.quest_id for i in invoices}:
        with engine.quest_lock(qid):
            changed += engine.refresh_invoices(db, [i for i in invoices if i.quest_id == qid])
            db.commit()
    return {"checked": len(invoices), "changed": changed}


class RemindIn(BaseModel):
    subject: str = Field(default="", max_length=200)
    note: str = Field(min_length=1, max_length=2000)


@router.post("/invoices/{invoice_id}/remind")
def remind(invoice_id: str, body: RemindIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    inv = db.get(Invoice, invoice_id)
    if not inv:
        raise HTTPException(404, "Invoice not found.")
    with engine.quest_lock(inv.quest_id):
        db.refresh(inv)
        engine.remind_invoice(db, inv, user, body.subject, body.note)
        db.commit()
    return {"ok": True, "reminders": inv.reminders, "person": inv.user.name}


# --- Claude for AG Studio's agents ------------------------------------------------------
# AG Studio runs its agent loop and tools in the browser (they act on the live dashboard).
# Each model turn comes here, so the Anthropic key never leaves the server.

_turns: defaultdict[str, deque] = defaultdict(deque)
TURNS_PER_MINUTE = 40
ALLOWED_MODELS = {"claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"}


def _rate_limit(user_id: str) -> None:
    now = time.monotonic()
    window = _turns[user_id]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= TURNS_PER_MINUTE:
        raise HTTPException(429, "The dashboard agent is busy. Give it a few seconds.")
    window.append(now)


class TurnIn(BaseModel):
    model: str | None = None
    system: str | None = Field(default=None, max_length=60000)
    messages: list[dict] = Field(min_length=1, max_length=120)
    tools: list[dict] = Field(default_factory=list, max_length=60)
    tool_choice: dict | None = None


@router.post("/studio/llm")
def studio_llm(body: TurnIn, user: User = Depends(require_user)):
    _rate_limit(user.id)
    if not settings.ai_enabled:
        return {"id": f"msg_off_{int(time.time())}", "model": "offline", "stop_reason": "end_turn", "content": [{
            "type": "text",
            "text": "Claude is off on this server. Add ANTHROPIC_API_KEY to let the dashboard agent build widgets.",
        }]}
    from anthropic import BadRequestError

    from .agent import llm

    model = body.model if body.model in ALLOWED_MODELS else settings.anthropic_model
    tools = [{"name": t["name"], "description": str(t.get("description", ""))[:1024],
              "input_schema": t.get("input_schema") or {"type": "object", "properties": {}}}
             for t in body.tools if t.get("name")]
    base = dict(model=model, max_tokens=4096, messages=body.messages)
    if body.system:
        base["system"] = body.system
    if tools:
        base["tools"] = tools
    choice = body.tool_choice or None
    try:
        if choice and choice.get("type") in {"tool", "any"} and llm._forced_ok:
            try:
                resp = llm.client().messages.create(**base, tool_choice=choice)
            except BadRequestError as exc:
                if "tool_choice" not in str(exc):
                    raise
                llm._forced_ok = False
                resp = llm.client().messages.create(**base)
        elif choice and choice.get("type") == "none":
            resp = llm.client().messages.create(**base, tool_choice=choice)
        else:
            resp = llm.client().messages.create(**base)
    except BadRequestError as exc:
        raise HTTPException(400, f"Claude rejected the request: {str(exc)[:400]}")
    return resp.model_dump(include={"id", "model", "stop_reason", "content", "usage"})
