"""How Sidequest earns money, and where every dollar of a quest ends up.

Revenue
  Booking fee  a percent plus a fixed amount on each person's share. It is inside the hold, so the
               "most you'll pay" promise still holds. Kept unless that person is fully refunded.
  Host fee     a percent of what the host is paid. Zero at launch.

Costs
  PayPal's processing fee on each capture and invoice payment (read from PayPal when it reports it,
  estimated at the US rate otherwise), minus the part PayPal hands back on refunds, plus the
  Payouts fee.

A quest copies the fee schedule when it is posted and keeps those terms, so changing fees never
changes what anyone already agreed to.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import floor

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import FeeSchedule, LedgerEntry, Membership, Quest, User
from .pricing import base_cents, booking_fee

MAX_BOOKING_BPS = 2000
MAX_FIXED_CENTS = 500
MAX_HOST_BPS = 2000


def current_schedule(db: Session) -> FeeSchedule:
    row = db.scalar(select(FeeSchedule).order_by(FeeSchedule.created_at.desc()).limit(1))
    if row:
        return row
    row = FeeSchedule(booking_bps=settings.booking_fee_bps, booking_fixed_cents=settings.booking_fee_fixed_cents,
                      host_bps=settings.host_fee_bps, reason="Starting fee schedule")
    db.add(row)
    db.flush()
    return row


def apply_to(db: Session, quest: Quest) -> None:
    s = current_schedule(db)
    quest.fee_bps, quest.fee_fixed_cents, quest.host_fee_bps = s.booking_bps, s.booking_fixed_cents, s.host_bps


def set_schedule(db: Session, admin: User, booking_bps: int, booking_fixed_cents: int, host_bps: int,
                 reason: str) -> FeeSchedule:
    from .cases import audit

    if not (0 <= booking_bps <= MAX_BOOKING_BPS and 0 <= booking_fixed_cents <= MAX_FIXED_CENTS
            and 0 <= host_bps <= MAX_HOST_BPS):
        raise ValueError("Booking fee up to 20% plus $5.00, host fee up to 20%.")
    reason = reason.strip()
    if len(reason) < 3:
        raise ValueError("Say why the fees are changing. It goes in the audit log.")
    before = current_schedule(db)
    row = FeeSchedule(booking_bps=booking_bps, booking_fixed_cents=booking_fixed_cents, host_bps=host_bps,
                      reason=reason[:300], created_by=admin.id)
    db.add(row)
    db.flush()
    audit(db, admin, "fee_change", row.id,
          f"Fees changed to {describe(row)}. Was {describe(before)}. {reason}",
          {"from": schedule_out(before), "to": schedule_out(row)})
    return row


def describe(s) -> str:
    booking_bps = getattr(s, "booking_bps", None)
    if booking_bps is None:
        booking_bps = s.fee_bps
    fixed = getattr(s, "booking_fixed_cents", None)
    if fixed is None:
        fixed = s.fee_fixed_cents or 0
    host = getattr(s, "host_bps", None)
    if host is None:
        host = s.host_fee_bps or 0
    parts = [f"{booking_bps / 100:g}%" + (f" + ${fixed / 100:.2f}" if fixed else "") + " booking fee"]
    parts.append(f"{host / 100:g}% host fee" if host else "no host fee")
    return ", ".join(parts)


def schedule_out(s: FeeSchedule) -> dict:
    return {"id": s.id, "booking_bps": s.booking_bps, "booking_fixed_cents": s.booking_fixed_cents,
            "host_bps": s.host_bps, "reason": s.reason, "created_at": s.created_at.isoformat() if s.created_at else None,
            "by": s.author.name if s.author else "Setup", "label": describe(s)}


# --- Where the money goes ----------------------------------------------------------------

def fee_kept(m: Membership, quest: Quest) -> int:
    """The booking fee Sidequest keeps from one person. A full refund gives it back."""
    if not m.charged_cents or m.refunded_cents >= m.charged_cents:
        return 0
    if m.fee_cents is not None:
        return m.fee_cents
    if quest.fee_bps:  # charged before fees were tracked per person
        return m.charged_cents - floor(m.charged_cents * 10_000 / (10_000 + quest.fee_bps))
    return 0


def paypal_fee_for(entry_kind: str, cents: int, reported: int | None) -> tuple[int, str]:
    """The fee to record on a ledger entry, and whether PayPal reported it or it's an estimate."""
    from .paypal.gateway import estimate_capture_fee, estimate_refund_fee_back

    if entry_kind in {"charge", "invoice_paid"}:
        return (reported, "paypal") if reported is not None else (estimate_capture_fee(cents), "estimate")
    if entry_kind == "refund":
        return (-reported, "paypal") if reported is not None else (-estimate_refund_fee_back(cents), "estimate")
    if entry_kind == "payout":
        return (reported, "paypal") if reported is not None else (settings.payout_fee_cents, "estimate")
    return 0, "paypal"


@dataclass
class QuestMoney:
    gross_cents: int = 0  # captured from members
    refunded_cents: int = 0
    invoices_collected_cents: int = 0  # extra costs members paid by PayPal invoice, owed to the host
    booking_fees_cents: int = 0
    host_fee_cents: int = 0
    host_due_cents: int = 0
    paid_out_cents: int = 0
    paypal_fees_cents: int = 0
    fees_estimated: bool = False
    revenue_cents: int = 0
    net_revenue_cents: int = 0
    escrow_cents: int = 0  # held by Sidequest, still owed to the host
    owed_back_cents: int = 0  # paid to the host, then refunded to a member: the host owes it back

    def out(self) -> dict:
        return asdict(self)


def quest_money(quest: Quest, entries: list[LedgerEntry]) -> QuestMoney:
    q = QuestMoney()
    for m in quest.memberships:
        q.gross_cents += m.charged_cents
        q.refunded_cents += m.refunded_cents
        q.booking_fees_cents += fee_kept(m, quest)
    for e in entries:
        if e.kind == "payout":
            q.paid_out_cents += e.cents
        elif e.kind == "invoice_paid":
            q.invoices_collected_cents += e.cents
        if e.fee_cents:
            q.paypal_fees_cents += e.fee_cents
            q.fees_estimated = q.fees_estimated or e.fee_source == "estimate"
    host_gross = q.gross_cents - q.refunded_cents - q.booking_fees_cents
    q.host_fee_cents = floor(max(host_gross, 0) * (quest.host_fee_bps or 0) / 10_000)
    q.host_due_cents = max(host_gross - q.host_fee_cents, 0) + q.invoices_collected_cents
    q.revenue_cents = q.booking_fees_cents + q.host_fee_cents
    q.net_revenue_cents = q.revenue_cents - q.paypal_fees_cents
    if quest.status in {"locked", "completed"}:
        q.escrow_cents = max(q.host_due_cents - q.paid_out_cents, 0)
        q.owed_back_cents = max(q.paid_out_cents - q.host_due_cents, 0)
    return q


def quest_money_db(db: Session, quest: Quest) -> QuestMoney:
    entries = list(db.scalars(select(LedgerEntry).where(LedgerEntry.quest_id == quest.id)))
    return quest_money(quest, entries)


def unit_economics(base: int, people: int, booking_bps: int, booking_fixed: int, host_bps: int) -> dict:
    """One person's share, split into who gets what. Used by the fee editor's live preview."""
    fee = booking_fee(base, booking_bps, booking_fixed)
    price = base + fee
    from .paypal.gateway import estimate_capture_fee

    paypal = estimate_capture_fee(price)
    payout = -(-settings.payout_fee_cents // max(people, 1))
    host_fee = floor(base * host_bps / 10_000)
    return {
        "price_cents": price, "base_cents": base, "booking_fee_cents": fee, "host_fee_cents": host_fee,
        "host_gets_cents": base - host_fee, "paypal_cents": paypal + payout,
        "sidequest_net_cents": fee + host_fee - paypal - payout,
        "take_rate_bps": round((fee + host_fee - paypal - payout) * 10_000 / price) if price else 0,
    }


def example_base(quest: Quest) -> int:
    return base_cents(quest.cost_lines, quest.max_people)
