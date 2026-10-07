"""Tables. All money is stored as integer cents."""

import secrets
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
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
    min_people: Mapped[int] = mapped_column(Integer)
    max_people: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    fee_bps: Mapped[int] = mapped_column(Integer, default=0)
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
    status: Mapped[str] = mapped_column(String(12), default="pending")  # pending|executed|declined|failed
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)


class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(80))
    resource_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
