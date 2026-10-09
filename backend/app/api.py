"""HTTP routes."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import base64
import binascii

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from . import cases, engine, fees, seed as seeding
from .agent import builder, keeper, shopper
from .auth import ADMINS, PERSONAS, ensure_personas, get_or_create_user, issue_token, optional_user, require_user
from .config import settings
from .db import get_db
from .models import Case, LedgerEntry, Membership, Proposal, Quest, Receipt, User, WebhookEvent, utcnow
from .paypal.gateway import PayPalError, gateway_for, paypal_mode
from .views import ledger_out, membership_out, quest_card, quest_detail, user_out

router = APIRouter()


def _quest(db: Session, quest_id: str) -> Quest:
    q = db.get(Quest, quest_id)
    if not q:
        raise HTTPException(404, "That quest doesn't exist.")
    return q


def _host_only(q: Quest, user: User) -> None:
    if q.host_id != user.id:
        raise HTTPException(403, f"Only the host, {q.host.name}, can do that.")


def _detail(db: Session, q: Quest, user: User | None) -> dict:
    db.commit()
    db.refresh(q)
    return quest_detail(db, q, user)


@contextmanager
def locked(db: Session, quest_id: str):
    """Run a money move under the quest's lock, on fresh data, and commit before releasing the lock."""
    with engine.quest_lock(quest_id):
        db.expire_all()
        q = _quest(db, quest_id)
        try:
            yield q
            db.commit()
        except Exception:
            db.rollback()
            raise


# Holds last 29 days at PayPal. Keep every quest's deadline inside that window.
MAX_DEADLINE = timedelta(days=28)

_chat_log: defaultdict[str, deque] = defaultdict(deque)


def _rate_limit_chat(user_id: str) -> None:
    now = time.monotonic()
    window = _chat_log[user_id]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= settings.chat_per_minute:
        raise HTTPException(429, "You're sending messages quickly. Wait a few seconds and try again.")
    window.append(now)


# --- Meta ----------------------------------------------------------------------

@router.get("/health")
def health():
    return {"ok": True}


@router.get("/config")
def config():
    show_buyer = settings.demo_mode and paypal_mode() == "sandbox" and settings.demo_buyer_email
    return {
        "demo_buyer": {"email": settings.demo_buyer_email, "password": settings.demo_buyer_password} if show_buyer else None,
        "paypal_mode": paypal_mode(),
        "paypal_client_id": settings.paypal_client_id if paypal_mode() == "sandbox" else None,
        "currency": settings.currency,
        "demo_mode": settings.demo_mode,
        "ai": "claude" if settings.ai_enabled else "offline",
        "model": settings.anthropic_model if settings.ai_enabled else None,
        "mcp_url": f"{settings.public_api_url}/mcp/",
        "demo_reset": _demo_reset_label(),
    }


def _demo_reset_label() -> str | None:
    from . import demo

    return demo.label()


# --- Auth ------------------------------------------------------------------------

class DemoIn(BaseModel):
    persona: str


class SignInIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=3, max_length=200)


@router.get("/personas")
def personas(db: Session = Depends(get_db)):
    users = ensure_personas(db)
    db.commit()
    return [user_out(users[p[0]]) for p in PERSONAS + ADMINS]


@router.post("/auth/demo")
def auth_demo(body: DemoIn, db: Session = Depends(get_db)):
    if not settings.demo_mode:
        raise HTTPException(403, "Demo sign-in is turned off.")
    users = ensure_personas(db)
    user = users.get(body.persona)
    if not user:
        raise HTTPException(404, "Unknown persona.")
    db.commit()
    return {"token": issue_token(user), "user": user_out(user)}


@router.post("/auth/signin")
def auth_signin(body: SignInIn, db: Session = Depends(get_db)):
    if "@" not in body.email:
        raise HTTPException(422, "Enter a valid email address.")
    user = get_or_create_user(db, body.name, body.email)
    db.commit()
    return {"token": issue_token(user), "user": user_out(user)}


@router.get("/me")
def me(user: User = Depends(require_user), db: Session = Depends(get_db)):
    # Tour copies are private demo quests. They'd crowd out real ones, so they stay off this page.
    rows = db.scalars(select(Membership).join(Quest, Quest.id == Membership.quest_id)
                      .where(Membership.user_id == user.id, Membership.status.notin_(["abandoned", "pending"]),
                             Quest.tour.isnot(True))
                      .order_by(Membership.created_at.desc())).all()
    hosting = db.scalars(select(Quest).where(Quest.host_id == user.id, Quest.tour.isnot(True))
                         .order_by(Quest.starts_at)).all()
    return {
        "user": user_out(user),
        "memberships": [{**membership_out(m), "quest": quest_card(m.quest)} for m in rows],
        "hosting": [quest_card(q) for q in hosting],
    }


@router.get("/me/ledger")
def my_ledger(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Every PayPal event on quests you host, plus your own events on quests you joined."""
    hosted = select(Quest.id).where(Quest.host_id == user.id)
    rows = db.execute(
        select(LedgerEntry, Quest)
        .join(Quest, Quest.id == LedgerEntry.quest_id)
        .where(or_(LedgerEntry.quest_id.in_(hosted), LedgerEntry.user_id == user.id))
        .order_by(LedgerEntry.created_at.desc())
        .limit(2000)
    ).all()
    return [{
        **ledger_out(e, bool(user.is_admin)),
        "quest": {"id": q.id, "title": q.title, "line_code": q.line_code, "tz": q.tz,
                  "role": "host" if q.host_id == user.id else "member", "tour": bool(q.tour)},
        "simulated": e.provider == "sim",
    } for e, q in rows]


# --- Quests ---------------------------------------------------------------------

@router.get("/quests")
def list_quests(status: str = "active", db: Session = Depends(get_db)):
    stmt = select(Quest).where(Quest.tour.isnot(True)).order_by(Quest.starts_at)
    if status == "active":
        stmt = stmt.where(Quest.status.in_(["open", "on", "locked"]))
    elif status != "all":
        stmt = stmt.where(Quest.status == status)
    return [quest_card(q) for q in db.scalars(stmt)]


@router.get("/quests/{quest_id}")
def get_quest(quest_id: str, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    return quest_detail(db, _quest(db, quest_id), user)


class DraftIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=600)


@router.post("/quests/draft")
def draft_quest(body: DraftIn, user: User = Depends(require_user)):
    return builder.draft(body.prompt)


class CostLineIn(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    cents: int = Field(gt=0, le=500_000)
    split: str = Field(pattern="^(shared|each)$")


class StopIn(BaseModel):
    time: str = Field(max_length=20)
    title: str = Field(min_length=1, max_length=120)
    detail: str = Field(default="", max_length=240)


class QuestIn(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    area: str = Field(default="", max_length=80)
    summary: str = Field(default="", max_length=600)
    line_code: str = Field(default="SQ", max_length=2)
    from_label: str = Field(default="", max_length=80)
    to_label: str = Field(default="", max_length=80)
    meet_point: str = Field(default="", max_length=200)
    date: str
    start_time: str
    end_time: str = "18:00"
    min_people: int = Field(ge=2, le=30)
    max_people: int = Field(ge=2, le=40)
    join_by_hours_before: int = Field(default=36, ge=1, le=336)
    itinerary: list[StopIn] = []
    cost_lines: list[CostLineIn] = Field(min_length=1)
    tz: str = "America/New_York"


@router.post("/quests")
def create_quest(body: QuestIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if body.max_people < body.min_people:
        raise HTTPException(422, "The most people can't be lower than the minimum.")
    try:
        tz = ZoneInfo(body.tz)
        starts = datetime.fromisoformat(f"{body.date}T{body.start_time}").replace(tzinfo=tz)
        ends = datetime.fromisoformat(f"{body.date}T{body.end_time}").replace(tzinfo=tz)
    except ValueError:
        raise HTTPException(422, "Use a date like 2026-10-17 and times like 08:10.")
    join_by = starts - timedelta(hours=body.join_by_hours_before)
    if join_by <= utcnow():
        raise HTTPException(422, "The join deadline would already be over. Pick a later date or a shorter deadline.")
    if join_by - utcnow() > MAX_DEADLINE:
        raise HTTPException(422, "PayPal holds last 29 days, so the join deadline has to be within 28 days. Pick an earlier date.")
    q = Quest(
        number=engine.next_number(db), host_id=user.id, title=body.title, area=body.area, summary=body.summary,
        line_code=(body.line_code or "SQ").upper()[:2], from_label=body.from_label, to_label=body.to_label,
        meet_point=body.meet_point, starts_at=starts, ends_at=ends, join_by=join_by, tz=body.tz,
        min_people=body.min_people, max_people=body.max_people, currency=settings.currency,
        cost_lines=[c.model_dump() for c in body.cost_lines],
        itinerary=[s.model_dump() for s in body.itinerary],
    )
    fees.apply_to(db, q)  # the quest keeps today's fees even if the schedule changes later
    db.add(q)
    db.flush()
    engine.say(db, q, f"{user.name} posted this quest. It runs if {q.min_people} people commit by the deadline.",
               meta={"event": "created"})
    db.commit()
    return {"id": q.id, "code": q.code}


# --- Holds ------------------------------------------------------------------------

@router.post("/quests/{quest_id}/holds")
def start_hold(quest_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, quest_id) as q:
        m, order_id, approve_url = engine.start_hold(db, q, user)
    return {"membership_id": m.id, "order_id": order_id, "approve_url": approve_url,
            "hold_cents": m.hold_cents, "paypal_mode": paypal_mode()}


class ConfirmIn(BaseModel):
    order_id: str | None = None


@router.post("/holds/{membership_id}/confirm")
def confirm_hold(membership_id: str, body: ConfirmIn, user: User | None = Depends(optional_user),
                 db: Session = Depends(get_db)):
    m = db.get(Membership, membership_id)
    if not m:
        raise HTTPException(404, "That hold doesn't exist.")
    with locked(db, m.quest_id) as q:
        m = db.get(Membership, membership_id)
        try:
            engine.confirm_hold(db, m, body.order_id)
        except engine.QuestError:
            db.commit()  # keep the abandoned or failed status
            raise
    return _detail(db, q, user or m.user)


@router.get("/paypal/orders/{order_id}")
def order_lookup(order_id: str, db: Session = Depends(get_db)):
    """Used by the return page and the mock approval page."""
    m = db.scalar(select(Membership).where(Membership.order_id == order_id))
    if not m:
        raise HTTPException(404, "No hold for that PayPal order.")
    return {"membership": membership_out(m), "quest": quest_card(m.quest), "paypal_mode": paypal_mode()}


@router.post("/quests/{quest_id}/leave")
def leave(quest_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, quest_id) as q:
        m = engine.membership_for(q, user.id)
        if not m:
            raise HTTPException(400, "You're not on this quest.")
        result = engine.leave(db, m)
    return {"result": result, "quest": _detail(db, q, user)}


# --- Host controls ------------------------------------------------------------------

@router.post("/quests/{quest_id}/lock")
def lock(quest_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, quest_id) as q:
        _host_only(q, user)
        engine.lock(db, q, reason=f"{user.name} locked the quest.")
    return _detail(db, q, user)


@router.post("/quests/{quest_id}/complete")
def complete(quest_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, quest_id) as q:
        _host_only(q, user)
        due = engine.payout_due_at(q)
        if utcnow() < due:
            raise HTTPException(409, f"Your payout releases on its own at {due.astimezone(ZoneInfo(q.tz)):%a %b %d, %I:%M %p}, "
                                     f"{settings.payout_hold_hours} hours after the trip, unless someone reports a problem.")
        engine.complete(db, q, reason=f"{user.name} released the payout after the trip.")
    return _detail(db, q, user)


@router.post("/quests/{quest_id}/cancel")
def cancel(quest_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, quest_id) as q:
        _host_only(q, user)
        engine.cancel(db, q, f"{user.name} cancelled the quest.")
    return _detail(db, q, user)


class SettleIn(BaseModel):
    actual_shared_cents: int | None = Field(default=None, ge=0, le=5_000_000)
    note: str = Field(default="", max_length=300)


@router.post("/quests/{quest_id}/settle")
def settle(quest_id: str, body: SettleIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, quest_id) as q:
        _host_only(q, user)
        engine.propose_settle_up(db, q, body.actual_shared_cents, body.note)
    return _detail(db, q, user)


class ReceiptIn(BaseModel):
    filename: str = Field(default="receipt", max_length=200)
    media_type: str = Field(max_length=40)
    data_base64: str = Field(max_length=7_500_000)
    total_cents: int | None = Field(default=None, ge=1, le=5_000_000)
    cost_line: str | None = Field(default=None, max_length=80)


@router.post("/quests/{quest_id}/receipts")
def add_receipt(quest_id: str, body: ReceiptIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    try:
        data = base64.b64decode(body.data_base64.split(",")[-1], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(422, "That file didn't upload correctly. Try again.")
    q = _quest(db, quest_id)
    _host_only(q, user)
    if body.media_type not in engine.RECEIPT_TYPES or len(data) > engine.RECEIPT_MAX_BYTES:
        raise HTTPException(422, "Upload a JPG, PNG, WebP or GIF under 5 MB.")
    # Reading the receipt takes a few seconds. Do it outside the quest lock, then store under it.
    reading = engine.read_receipt(q, data, body.media_type)
    with locked(db, quest_id) as q:
        r = engine.add_receipt(db, q, user, body.filename, body.media_type, data, body.total_cents,
                               pre_read=reading, host_cost_line=body.cost_line)
        out = engine.receipt_out(r)
    return {"receipt": out, "quest": _detail(db, q, user)}


@router.get("/receipts/{receipt_id}/image")
def receipt_image(receipt_id: str, db: Session = Depends(get_db)):
    r = db.get(Receipt, receipt_id)
    if not r or r.status == "removed":
        raise HTTPException(404, "No receipt here.")
    return Response(content=r.data, media_type=r.media_type, headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/receipts/{receipt_id}")
def remove_receipt(receipt_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    r = db.get(Receipt, receipt_id)
    if not r:
        raise HTTPException(404, "No receipt here.")
    with locked(db, r.quest_id) as q:
        _host_only(q, user)
        engine.remove_receipt(db, db.get(Receipt, receipt_id))
    return _detail(db, q, user)


class ProblemIn(BaseModel):
    reason: str = Field(min_length=3, max_length=280)


@router.post("/quests/{quest_id}/problem")
def report_problem(quest_id: str, body: ProblemIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, quest_id) as q:
        engine.report_problem(db, q, user, body.reason)
    return _detail(db, q, user)


class ReplyIn(BaseModel):
    text: str = Field(min_length=3, max_length=600)


def _case_quest(db: Session, case_id: str) -> str:
    c = db.get(Case, case_id)
    if not c:
        raise HTTPException(404, "That report doesn't exist.")
    return c.quest_id


@router.post("/cases/{case_id}/respond")
def respond_to_case(case_id: str, body: ReplyIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """The host's side of the story. Only a Sidequest admin can resolve the report."""
    with locked(db, _case_quest(db, case_id)) as q:
        cases.respond(db, db.get(Case, case_id), user, body.text)
    return _detail(db, q, user)


@router.post("/cases/{case_id}/withdraw")
def withdraw_case(case_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    with locked(db, _case_quest(db, case_id)) as q:
        cases.withdraw(db, db.get(Case, case_id), user)
    return _detail(db, q, user)


class DecideIn(BaseModel):
    approve: bool


@router.post("/proposals/{proposal_id}/decide")
def decide(proposal_id: str, body: DecideIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    p = db.get(Proposal, proposal_id)
    if not p:
        raise HTTPException(404, "That proposal doesn't exist.")
    with locked(db, p.quest_id) as q:
        _host_only(q, user)
        engine.decide_proposal(db, db.get(Proposal, proposal_id), body.approve)
    return _detail(db, q, user)


# --- Agent ---------------------------------------------------------------------------

class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=800)


@router.post("/quests/{quest_id}/chat")
def chat(quest_id: str, body: ChatIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    _rate_limit_chat(user.id)
    q = _quest(db, quest_id)
    reply = keeper.reply(db, q, user, body.text.strip())
    db.commit()
    return {"reply": reply, "quest": _detail(db, q, user)}


# --- Your own assistant, connected over MCP ----------------------------------------------

class AssistantMsg(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=2000)


class AssistantIn(BaseModel):
    messages: list[AssistantMsg] = Field(min_length=1, max_length=20)


@router.post("/assistant/chat")
def assistant_chat(body: AssistantIn, user: User = Depends(require_user)):
    """The For AI agents page: an assistant that only has Sidequest's MCP tools."""
    _rate_limit_chat(user.id)
    if body.messages[-1].role != "user":
        raise HTTPException(422, "The last message has to be from you.")
    return shopper.chat(user, [m.model_dump() for m in body.messages])


# --- PayPal webhooks -------------------------------------------------------------------

@router.post("/webhooks/paypal")
async def paypal_webhook(request: Request, db: Session = Depends(get_db)):
    event = await request.json()
    event_id = event.get("id") or ""
    if not event_id:
        raise HTTPException(400, "Missing event id.")
    if db.get(WebhookEvent, event_id):
        return {"status": "duplicate"}
    verified = True
    if paypal_mode() == "sandbox":
        try:
            verified = gateway_for("paypal").verify_webhook(dict(request.headers), event)
        except PayPalError:
            verified = False
        if not verified:
            raise HTTPException(400, "Webhook signature did not verify.")
    resource = event.get("resource") or {}
    db.add(WebhookEvent(id=event_id, event_type=event.get("event_type", ""), resource_id=resource.get("id"),
                        verified=verified, payload=event))
    db.commit()
    batch = (resource.get("batch_header") or {}).get("payout_batch_id") or resource.get("payout_batch_id")
    invoice_id = (resource.get("invoice") or {}).get("id")  # invoicing events nest the invoice
    disputed = next((t.get("seller_transaction_id") for t in resource.get("disputed_transactions") or []
                     if t.get("seller_transaction_id")), None)  # dispute events point at our capture
    quest_id = (_quest_for_resource(db, resource.get("id")) or _quest_for_resource(db, batch)
                or _quest_for_resource(db, invoice_id) or _quest_for_resource(db, disputed))
    if not quest_id:
        return {"status": "unknown"}
    with engine.quest_lock(quest_id):
        db.expire_all()
        try:
            outcome = engine.handle_webhook(db, event)
            db.commit()
        except engine.QuestError as exc:
            db.rollback()
            outcome = f"skipped: {exc}"
    return {"status": outcome}


def _quest_for_resource(db: Session, rid: str | None) -> str | None:
    """Find which quest a PayPal object belongs to: order, authorization, capture, or ledger reference."""
    if not rid:
        return None
    m = db.scalar(select(Membership).where(
        (Membership.order_id == rid) | (Membership.authorization_id == rid) | (Membership.capture_id == rid)))
    if m:
        return m.quest_id
    from .models import LedgerEntry

    entry = db.scalar(select(LedgerEntry).where(LedgerEntry.paypal_ref == rid))
    return entry.quest_id if entry else None


# --- Clock ------------------------------------------------------------------------------

@router.post("/cron/tick")
def cron_tick(x_cron_secret: str | None = Header(default=None), db: Session = Depends(get_db)):
    if not settings.cron_secret or x_cron_secret != settings.cron_secret:
        raise HTTPException(403, "Bad cron secret.")
    from . import demo

    if demo.maybe_reset():
        return {"demo_reset": True}
    counts = engine.tick(db)
    db.commit()
    return counts


# --- Demo controls -------------------------------------------------------------------------

def _demo_only():
    if not settings.demo_mode:
        raise HTTPException(403, "Demo controls are turned off.")


class CrowdIn(BaseModel):
    count: int = Field(default=1, ge=1, le=10)


@router.post("/demo/quests/{quest_id}/crowd")
def demo_crowd(quest_id: str, body: CrowdIn, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    _demo_only()
    with locked(db, quest_id) as q:
        people = ensure_personas(db)
        taken = {m.user_id for m in q.memberships if m.status in engine.ACTIVE}
        added = 0
        for persona, *_ in PERSONAS:
            if added >= body.count:
                break
            u = people[persona]
            if u.id in taken:
                continue
            engine.simulate_join(db, q, u)
            added += 1
        if not added:
            raise HTTPException(400, "Every demo persona is already on this quest.")
    return _detail(db, q, user)


@router.post("/demo/quests/{quest_id}/deadline")
def demo_deadline(quest_id: str, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    """Jump the clock to the join deadline and let the scheduler do its job."""
    _demo_only()
    with locked(db, quest_id) as q:
        q.join_by = utcnow() - timedelta(seconds=1)
    engine.tick(db)
    q = _quest(db, quest_id)
    return _detail(db, q, user)


@router.post("/demo/quests/{quest_id}/payout")
def demo_payout(quest_id: str, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    """The real payout waits 24 hours after the trip. The demo skips the wait, never the checks."""
    _demo_only()
    with locked(db, quest_id) as q:
        engine.complete(db, q, reason="Demo: skipped the wait after the trip. Nobody reported a problem.")
    return _detail(db, q, user)


@router.post("/demo/tour")
def demo_tour(db: Session = Depends(get_db)):
    """A private copy of the hero quest for one judge, so nobody's walkthrough collides with anyone else's."""
    _demo_only()
    q = seeding.make_tour(db)
    db.commit()
    return {"id": q.id}


@router.post("/demo/reset")
def demo_reset(db: Session = Depends(get_db)):
    from . import demo

    _demo_only()
    db.close()
    demo.reset("Demo data reset from the menu.")
    return {"ok": True}
