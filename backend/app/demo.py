"""Nightly demo reset. Anyone can play Kai on the live demo, so one judge's fee change or refunds
shouldn't greet the next judge. Once a night the demo data goes back to its starting state."""

from __future__ import annotations

import logging
import threading
from datetime import timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .config import settings
from .models import AuditLog, utcnow

log = logging.getLogger("sidequest.demo")
_running = threading.Lock()
ACTION = "demo_reset"


def enabled() -> bool:
    return settings.demo_mode and 0 <= settings.demo_reset_hour <= 23


def label() -> str | None:
    if not enabled():
        return None
    h = settings.demo_reset_hour
    return f"{(h % 12) or 12}:00 {'am' if h < 12 else 'pm'} ET"


def reset(summary: str) -> None:
    """Drop and reseed everything, then note it in the fresh audit log."""
    from . import seed as seeding
    from .db import SessionLocal, session_scope

    db = SessionLocal()
    try:
        seeding.reset(db)
    finally:
        db.close()
    with session_scope() as fresh:
        seeding.seed(fresh)
        fresh.add(AuditLog(action=ACTION, summary=summary, created_at=utcnow()))


def due(now=None) -> bool:
    from .db import session_scope

    if not enabled():
        return False
    now = now or utcnow()
    if now.astimezone(ZoneInfo("America/New_York")).hour != settings.demo_reset_hour:
        return False
    with session_scope() as db:
        last = db.scalar(select(AuditLog.created_at).where(AuditLog.action == ACTION)
                         .order_by(AuditLog.created_at.desc()).limit(1))
    return last is None or now - last > timedelta(hours=20)


def maybe_reset() -> bool:
    """Called by the clock. Resets at most once a night, and never twice at the same time."""
    if not due() or not _running.acquire(blocking=False):
        return False
    try:
        if not due():
            return False
        reset("Nightly reset: quests, cases, fees and the audit log are back to the demo's starting point.")
        log.info("nightly demo reset done")
        return True
    finally:
        _running.release()
