"""Staff routes: mediate reports, audit payments, set fees. Admins only."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit as audits
from . import cases, engine, fees
from .auth import require_user
from .db import get_db
from .models import AuditLog, Case, FeeSchedule, LedgerEntry, Message, Quest, Receipt, User
from .paypal.gateway import PayPalError, paypal_mode
from .views import iso, ledger_out, membership_out, user_out

router = APIRouter(prefix="/admin")


def require_admin(user: User = Depends(require_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Admins only. In the demo, switch to Kai from the menu in the top right.")
    return user


# --- Money -------------------------------------------------------------------------------

@router.get("/overview")
def overview(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return audits.overview(db)


@router.get("/payments")
def payments(include_tours: bool = False, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    stmt = select(LedgerEntry, Quest).join(Quest, Quest.id == LedgerEntry.quest_id)
    if not include_tours:
        stmt = stmt.where(Quest.tour.isnot(True))
    rows = db.execute(stmt.order_by(LedgerEntry.created_at.desc()).limit(3000)).all()
    return [{
        **ledger_out(e),
        "quest": {"id": q.id, "code": q.code, "title": q.title, "line_code": q.line_code, "tz": q.tz,
                  "host": q.host.name, "tour": bool(q.tour)},
        "fee_cents": e.fee_cents or 0, "fee_source": e.fee_source,
        "recon_status": e.recon_status, "recon_note": e.recon_note, "recon_at": iso(e.recon_at),
        "simulated": e.provider == "sim",
    } for e, q in rows]


@router.post("/reconcile")
def reconcile(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    out = audits.reconcile(db, admin)
    db.commit()
    return out


@router.get("/statement")
def statement(days: int = 14, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return audits.statement(db, days)


# --- Cases ------------------------------------------------------------------------------

@router.get("/cases")
def list_cases(status: str = "all", admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    stmt = select(Case).order_by(Case.created_at.desc()).limit(200)
    if status != "all":
        stmt = stmt.where(Case.status == status)
    return [cases.case_out(c) for c in db.scalars(stmt)]


def _case(db: Session, case_id: str) -> Case:
    c = db.get(Case, case_id)
    if not c:
        raise HTTPException(404, "That case doesn't exist.")
    return c


def _case_detail(db: Session, c: Case) -> dict:
    q = c.quest
    entries = list(db.scalars(select(LedgerEntry).where(LedgerEntry.quest_id == q.id).order_by(LedgerEntry.created_at)))
    chat = db.scalars(select(Message).where(Message.quest_id == q.id).order_by(Message.created_at.desc()).limit(40)).all()
    receipts = db.scalars(select(Receipt).where(Receipt.quest_id == q.id, Receipt.status != "removed")).all()
    return {
        **cases.case_out(c),
        "money": fees.quest_money(q, entries).out(),
        "payout_due_at": iso(engine.payout_due_at(q)),
        "members": [membership_out(m) for m in q.memberships if m.charged_cents or m.status in {"held", "standby"}],
        "ledger": [ledger_out(e) for e in reversed(entries)],
        "receipts": [engine.receipt_out(r) for r in receipts],
        "chat": [{"id": m.id, "role": m.role, "body": m.body, "user": user_out(m.user), "created_at": iso(m.created_at)}
                 for m in reversed(chat)],
    }


@router.get("/cases/{case_id}")
def get_case(case_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return _case_detail(db, _case(db, case_id))


@router.post("/cases/{case_id}/review")
def review_case(case_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Ask Claude for a read of the case. It's a suggestion; nothing moves until the admin decides."""
    from .agent import mediator

    c = _case(db, case_id)
    try:
        c.ai_review = mediator.review(db, c)
    except Exception as exc:  # the AI being down shouldn't block the admin
        raise HTTPException(502, f"Claude couldn't review this case right now ({type(exc).__name__}). Decide from the records.")
    cases.audit(db, admin, "case_review", c.id, f"{admin.name} asked Claude to review a case on {c.quest.code}. "
                                                f"Claude suggested: {c.ai_review.get('decision')}.")
    db.commit()
    return _case_detail(db, c)


class ResolveIn(BaseModel):
    decision: str = Field(pattern="^(release|refund_reporter|refund_everyone|accept_claim)$")
    refund_cents_each: int = Field(default=0, ge=0, le=500_000)
    note: str = Field(min_length=3, max_length=600)
    pay_now: bool = False


@router.post("/cases/{case_id}/resolve")
def resolve_case(case_id: str, body: ResolveIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    c = _case(db, case_id)
    with engine.quest_lock(c.quest_id):
        db.expire_all()
        c = _case(db, case_id)
        try:
            cases.resolve(db, c, admin, body.decision, body.refund_cents_each, body.note, body.pay_now)
            db.commit()
        except Exception:
            db.rollback()
            raise
    return _case_detail(db, _case(db, case_id))


@router.post("/disputes/sync")
def sync_disputes(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if paypal_mode() == "mock":
        raise HTTPException(409, "PayPal is in mock mode, so there's no PayPal account to check. "
                                 "Set sandbox keys to pull real disputes.")
    try:
        out = cases.sync_paypal_disputes(db, admin)
    except PayPalError as exc:
        raise HTTPException(502, f"PayPal didn't return disputes: {exc}")
    db.commit()
    return out


# --- Fees -----------------------------------------------------------------------------

def _fees_out(db: Session) -> dict:
    current = fees.current_schedule(db)
    history = db.scalars(select(FeeSchedule).order_by(FeeSchedule.created_at.desc()).limit(30)).all()
    active = len(db.scalars(select(Quest.id).where(Quest.status.in_(["open", "on", "locked"]),
                                                   Quest.tour.isnot(True))).all())
    return {"current": fees.schedule_out(current), "history": [fees.schedule_out(s) for s in history],
            "active_quests": active,
            "limits": {"booking_bps": fees.MAX_BOOKING_BPS, "booking_fixed_cents": fees.MAX_FIXED_CENTS,
                       "host_bps": fees.MAX_HOST_BPS}}


@router.get("/fees")
def get_fees(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    out = _fees_out(db)
    db.commit()
    return out


class FeesIn(BaseModel):
    booking_bps: int = Field(ge=0, le=fees.MAX_BOOKING_BPS)
    booking_fixed_cents: int = Field(ge=0, le=fees.MAX_FIXED_CENTS)
    host_bps: int = Field(ge=0, le=fees.MAX_HOST_BPS)
    reason: str = Field(min_length=3, max_length=300)


@router.post("/fees")
def set_fees(body: FeesIn, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    try:
        fees.set_schedule(db, admin, body.booking_bps, body.booking_fixed_cents, body.host_bps, body.reason)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    db.commit()
    return _fees_out(db)


class PreviewIn(BaseModel):
    booking_bps: int = Field(ge=0, le=fees.MAX_BOOKING_BPS)
    booking_fixed_cents: int = Field(ge=0, le=fees.MAX_FIXED_CENTS)
    host_bps: int = Field(ge=0, le=fees.MAX_HOST_BPS)
    base_cents: int = Field(gt=0, le=500_000)
    people: int = Field(default=6, ge=1, le=40)


@router.post("/fees/preview")
def preview_fees(body: PreviewIn, admin: User = Depends(require_admin)):
    return fees.unit_economics(body.base_cents, body.people, body.booking_bps, body.booking_fixed_cents, body.host_bps)


# --- Audit log ------------------------------------------------------------------------

@router.get("/audit")
def audit_log(limit: int = 200, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(max(1, min(limit, 500))))
    return [{"id": a.id, "action": a.action, "target": a.target, "summary": a.summary, "detail": a.detail,
             "actor": user_out(a.actor), "created_at": iso(a.created_at)} for a in rows]
