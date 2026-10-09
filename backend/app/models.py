"""Tables. All money is stored as integer cents."""

import secrets
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(8).replace('-', 'x').replace('_', 'y')}"


class TZDateTime(TypeDecorator):
    """Stores UTC, always returns timezone-aware UTC. SQLite has no timezone support."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
        return value.replace(tzinfo=None) if dialect.name == "sqlite" else value

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("usr"))
    name: Mapped[str] = mapped_column(String(80))
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    color: Mapped[str] = mapped_column(String(9), default="#FFC93C")
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    persona: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    # Sidequest staff. Admins mediate reports, audit payments and set fees.
    is_admin: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)
    payout_email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    @property
    def initials(self) -> str:
        parts = [p for p in self.name.replace("-", " ").split() if p]
        if not parts:
            return "?"
        if len(parts) == 1:
            return parts[0][:2].upper()
        return (parts[0][0] + parts[-1][0]).upper()


class Quest(Base):
    __tablename__ = "quests"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("q"))
    number: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(160))
    summary: Mapped[str] = mapped_column(Text, default="")
    area: Mapped[str] = mapped_column(String(80), default="")
    line_code: Mapped[str] = mapped_column(String(4), default="SQ")
    from_label: Mapped[str] = mapped_column(String(80), default="")
    to_label: Mapped[str] = mapped_column(String(80), default="")
    meet_point: Mapped[str] = mapped_column(String(200), default="")
    starts_at: Mapped[datetime] = mapped_column(TZDateTime())
    ends_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    join_by: Mapped[datetime] = mapped_column(TZDateTime())
    tz: Mapped[str] = mapped_column(String(40), default="America/New_York")
    # Set on copies made by the guided demo, so the UI can show the walkthrough.
    tour: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)
    # Escrow: the payout releases on its own after the trip unless a member reports a problem.
    payout_paused_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    payout_paused_by: Mapped[str | None] = mapped_column(String(40), nullable=True)
    min_people: Mapped[int] = mapped_column(Integer)
    max_people: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    # Fees are copied from the fee schedule when the quest is created and never change after that.
    fee_bps: Mapped[int] = mapped_column(Integer, default=0)  # booking fee, percent of each share
    fee_fixed_cents: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)  # booking fee, per person
    host_fee_bps: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)  # taken from the host payout
    # [{"label": str, "cents": int, "split": "shared" | "each"}]
    cost_lines: Mapped[list] = mapped_column(JSON, default=list)
    # [{"time": "8:10 am", "title": str, "detail": str, "note": str | None}]
    itinerary: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    # open -> on -> locked -> completed, or open/on -> cancelled
    host_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    tipped_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    locked_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    host: Mapped[User] = relationship(lazy="joined")
    memberships: Mapped[list["Membership"]] = relationship(
        back_populates="quest", order_by="Membership.created_at", cascade="all, delete-orphan"
    )

    @property
    def code(self) -> str:
        return f"{self.line_code}-{self.number:04d}"


class Membership(Base):
    """One person's place in a quest, and the PayPal objects behind it."""

    __tablename__ = "memberships"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("m"))
    quest_id: Mapped[str] = mapped_column(ForeignKey("quests.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    # pending  : PayPal order created, waiting for the buyer to approve
    # held     : authorization placed, has a seat
    # standby  : authorization placed, on the waitlist
    # charged  : authorization captured
    # released : authorization voided (left, quest cancelled, or never got a seat)
    # refunded : capture fully refunded
    # failed   : PayPal declined
    # abandoned: order never approved
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    provider: Mapped[str] = mapped_column(String(12), default="paypal")  # paypal | card | sim
    funding: Mapped[str | None] = mapped_column(String(20), nullable=True)
    order_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    authorization_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    authorized_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    capture_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    hold_cents: Mapped[int] = mapped_column(Integer, default=0)
    charged_cents: Mapped[int] = mapped_column(Integer, default=0)
    refunded_cents: Mapped[int] = mapped_column(Integer, default=0)
    # The booking fee inside charged_cents. Sidequest keeps it unless the charge is fully refunded.
    fee_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    seat: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, onupdate=utcnow)

    quest: Mapped[Quest] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(lazy="joined")


class LedgerEntry(Base):
    """Every money event, with the PayPal id that proves it."""

    __tablename__ = "ledger"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("le"))
    quest_id: Mapped[str] = mapped_column(ForeignKey("quests.id"), index=True)
    membership_id: Mapped[str | None] = mapped_column(ForeignKey("memberships.id"), nullable=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    # hold | release | charge | refund | payout | invoice | reauthorize | decline
    kind: Mapped[str] = mapped_column(String(16))
    cents: Mapped[int] = mapped_column(Integer, default=0)
    paypal_ref: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    provider: Mapped[str] = mapped_column(String(12), default="paypal")
    note: Mapped[str] = mapped_column(Text, default="")
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)  # set when a webhook confirms it
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # What PayPal charged Sidequest for this event. Negative on refunds, when PayPal hands part of it back.
    fee_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fee_source: Mapped[str | None] = mapped_column(String(10), nullable=True)  # paypal | estimate
    # Set by the admin audit: matched | mismatch | missing | simulated | error
    recon_status: Mapped[str | None] = mapped_column(String(12), nullable=True)
    recon_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    recon_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    user: Mapped[User | None] = relationship(lazy="joined")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("msg"))
    quest_id: Mapped[str] = mapped_column(ForeignKey("quests.id"), index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    role: Mapped[str] = mapped_column(String(10))  # user | agent | system
    body: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    user: Mapped[User | None] = relationship(lazy="joined")


class Proposal(Base):
    """A money move the agent wants to make. Only the host can approve it."""

    __tablename__ = "proposals"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("pr"))
    quest_id: Mapped[str] = mapped_column(ForeignKey("quests.id"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    rationale: Mapped[str] = mapped_column(Text, default="")
    # [{"type": "void_hold" | "promote" | "refund" | "invoice", ...}]
    actions: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(12), default="pending")  # pending|running|executed|declined|failed|expired
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Supporting evidence shown to the host and members, e.g. receipts behind a settle up.
    evidence: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)


class Receipt(Base):
    """A photo of a real cost, read by Claude and checked before it can change what anyone pays."""

    __tablename__ = "receipts"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("rc"))
    quest_id: Mapped[str] = mapped_column(ForeignKey("quests.id"), index=True)
    uploaded_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(200), default="receipt")
    media_type: Mapped[str] = mapped_column(String(40))
    data: Mapped[bytes] = mapped_column(LargeBinary)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    merchant: Mapped[str | None] = mapped_column(String(160), nullable=True)
    purchased_on: Mapped[str | None] = mapped_column(String(10), nullable=True)
    total_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_line: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # verified | flagged | unverified | rejected | removed
    status: Mapped[str] = mapped_column(String(12), default="unverified")
    issues: Mapped[list] = mapped_column(JSON, default=list)
    reader: Mapped[str] = mapped_column(String(12), default="claude")  # claude | host
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)


class Invoice(Base):
    """A PayPal invoice for someone's share of an over-budget cost. Tracked until it is paid."""

    __tablename__ = "invoices"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("iv"))
    quest_id: Mapped[str] = mapped_column(ForeignKey("quests.id"), index=True)
    membership_id: Mapped[str | None] = mapped_column(ForeignKey("memberships.id"), nullable=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paypal_id: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    cents: Mapped[int] = mapped_column(Integer)
    item: Mapped[str] = mapped_column(String(200), default="")
    provider: Mapped[str] = mapped_column(String(12), default="paypal")  # paypal | sim (seeded demo data)
    # sent | paid | cancelled
    status: Mapped[str] = mapped_column(String(12), default="sent")
    reminders: Mapped[int] = mapped_column(Integer, default=0)
    last_reminded_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    user: Mapped[User] = relationship(lazy="joined")
    quest: Mapped["Quest"] = relationship()


class Case(Base):
    """A report that pauses a payout until a Sidequest admin decides. Opened by a member or by a PayPal dispute."""

    __tablename__ = "cases"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("cs"))
    quest_id: Mapped[str] = mapped_column(ForeignKey("quests.id"), index=True)
    membership_id: Mapped[str | None] = mapped_column(ForeignKey("memberships.id"), nullable=True)
    opened_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    source: Mapped[str] = mapped_column(String(10), default="member")  # member | paypal
    provider: Mapped[str] = mapped_column(String(12), default="paypal")  # paypal | sim (seeded demo data)
    paypal_dispute_id: Mapped[str | None] = mapped_column(String(80), nullable=True, unique=True)
    paypal_reason: Mapped[str | None] = mapped_column(String(80), nullable=True)
    paypal_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    disputed_cents: Mapped[int] = mapped_column(Integer, default=0)
    # open | resolved | withdrawn
    status: Mapped[str] = mapped_column(String(12), default="open", index=True)
    host_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    host_responded_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    ai_review: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # release | refund_reporter | refund_everyone | accept_claim
    decision: Mapped[str | None] = mapped_column(String(20), nullable=True)
    refund_cents_each: Mapped[int | None] = mapped_column(Integer, nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    quest: Mapped[Quest] = relationship()
    reporter: Mapped[User | None] = relationship(foreign_keys=[opened_by], lazy="joined")
    resolver: Mapped[User | None] = relationship(foreign_keys=[resolved_by], lazy="joined")


class FeeSchedule(Base):
    """What Sidequest charges. The newest row applies to quests created after it."""

    __tablename__ = "fee_schedules"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("fee"))
    booking_bps: Mapped[int] = mapped_column(Integer, default=0)
    booking_fixed_cents: Mapped[int] = mapped_column(Integer, default=0)
    host_bps: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    author: Mapped[User | None] = relationship(lazy="joined")


class AuditLog(Base):
    """Every staff action and every decision that changes who gets paid."""

    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("au"))
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(40), index=True)
    target: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)

    actor: Mapped[User | None] = relationship(lazy="joined")


class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(80))
    resource_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
