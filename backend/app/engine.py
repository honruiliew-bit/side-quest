"""The quest engine. Every money move in Sidequest goes through this file.

Lifecycle
  open       collecting holds. Each join is a PayPal authorization at the max price.
  on         the minimum is reached. Still open to more people, the share keeps dropping.
  locked     at the deadline (or when the host locks early) every seat is captured at the
             final split. Standby holds stay in place until the trip starts, for swaps.
  completed  after the trip the host is paid through PayPal Payouts.
  cancelled  the minimum was never reached. Every hold is voided, nobody pays.

Rules the agent cannot bend
  A capture is never above the authorization.
  A refund is never above what was captured.
  Money only moves after the host approves a proposal, except for a person
  releasing their own uncaptured hold.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from math import floor

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .config import settings
from .models import LedgerEntry, Membership, Message, Proposal, Quest, Receipt, User, aware, utcnow
from .paypal.gateway import PayPalError, gateway_for, paypal_mode
from .paypal import toolkit
from .pricing import fmt, hold_cents, price_cents

ACTIVE = {"pending", "held", "standby", "charged"}
HONOR_PERIOD = timedelta(days=3)


_locks: defaultdict[str, threading.RLock] = defaultdict(threading.RLock)
_locks_guard = threading.Lock()


@contextmanager
def quest_lock(quest_id: str):
    """Serialize every money move on one quest. The API runs as a single process, so this is enough
    to stop two joins taking the same seat or a webhook and a click authorizing the same order."""
    with _locks_guard:
        lock = _locks[quest_id]
    with lock:
        yield


class QuestError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------

def seated(quest: Quest) -> list[Membership]:
    rows = [m for m in quest.memberships if m.status in {"held", "charged"}]
    return sorted(rows, key=lambda m: (m.seat or 999, m.created_at))


def standby(quest: Quest) -> list[Membership]:
    return sorted([m for m in quest.memberships if m.status == "standby"], key=lambda m: m.created_at)


def headcount(quest: Quest) -> int:
    return len(seated(quest))


def quest_hold(quest: Quest) -> int:
    return hold_cents(quest.cost_lines, quest.min_people, quest.fee_bps)


def current_share(quest: Quest) -> int:
    """What each person pays if the quest locked right now."""
    n = max(headcount(quest), quest.min_people)
    return price_cents(quest.cost_lines, min(n, quest.max_people), quest.fee_bps)


def membership_for(quest: Quest, user_id: str) -> Membership | None:
    rows = [m for m in quest.memberships if m.user_id == user_id and m.status in ACTIVE]
    return rows[-1] if rows else None


def _free_seat(quest: Quest) -> int | None:
    taken = {m.seat for m in seated(quest) if m.seat}
    for seat in range(1, quest.max_people + 1):
        if seat not in taken:
            return seat
    return None


def log(db: Session, quest: Quest, kind: str, cents: int, *, membership: Membership | None = None,
        user: User | None = None, ref: str | None = None, note: str = "", provider: str | None = None,
        raw: dict | None = None) -> LedgerEntry:
    entry = LedgerEntry(
        quest_id=quest.id,
        membership_id=membership.id if membership else None,
        user_id=(user.id if user else membership.user_id if membership else None),
        kind=kind,
        cents=cents,
        paypal_ref=ref,
        provider=provider or (membership.provider if membership else paypal_mode()),
        note=note,
        raw=_trim(raw),
    )
    db.add(entry)
    return entry


def _trim(raw: dict | None) -> dict | None:
    if not raw:
        return None
    keep = {k: raw[k] for k in ("id", "status", "intent", "mock", "amount", "batch_header") if k in raw}
    return keep or None


def say(db: Session, quest: Quest, body: str, *, role: str = "system", user: User | None = None,
        meta: dict | None = None) -> Message:
    msg = Message(quest_id=quest.id, user_id=user.id if user else None, role=role, body=body, meta=meta)
    db.add(msg)
    return msg


def _gateway(m: Membership):
    return gateway_for(m.provider)


def _desc(quest: Quest) -> str:
    return f"{quest.code} {quest.title}. Hold only, charged if the quest runs."


# ----------------------------------------------------------------------------
# Joining
# ----------------------------------------------------------------------------

def _check_joinable(quest: Quest, user: User) -> None:
    if quest.status not in {"open", "on"}:
        raise QuestError("This quest is no longer taking people.")
    if aware(quest.join_by) < utcnow():
        raise QuestError("The join deadline for this quest has passed.")
    existing = membership_for(quest, user.id)
    if existing and existing.status in {"held", "standby", "charged"}:
        raise QuestError("You already have a spot on this quest.")


def start_hold(db: Session, quest: Quest, user: User) -> tuple[Membership, str, str | None]:
    """Create a PayPal order (intent AUTHORIZE) at the max price. Returns (membership, order_id, approve_url)."""
    _check_joinable(quest, user)
    for m in quest.memberships:
        if m.user_id == user.id and m.status == "pending":
            m.status = "abandoned"
    hold = quest_hold(quest)
    m = Membership(quest=quest, user=user, status="pending", provider="paypal", hold_cents=hold)
    db.add(m)
    db.flush()
    gw = _gateway(m)
    try:
        order = gw.create_order(
            hold, quest.currency, ref=m.id, description=_desc(quest),
            return_url=f"{settings.frontend_url}/paypal/return?m={m.id}",
            cancel_url=f"{settings.frontend_url}/q/{quest.id}?hold=cancelled",
        )
    except PayPalError as exc:
        m.status = "failed"
        raise QuestError(f"PayPal could not start the hold: {exc}", 502) from exc
    m.order_id = order.order_id
    db.flush()
    return m, order.order_id, order.approve_url


def confirm_hold(db: Session, m: Membership, order_id: str | None = None) -> Membership:
    """Authorize an approved order. Idempotent, so the redirect, the JS SDK and the webhook can all call it."""
    if m.status in {"held", "standby", "charged"}:
        return m
    if m.status != "pending":
        if m.quest.status not in {"open", "on"}:
            raise QuestError("This quest closed before your hold went through. Nothing was held.", 409)
        raise QuestError("This hold is no longer pending. Start again from the quest page.")
    if order_id and m.order_id and order_id != m.order_id:
        raise QuestError("That PayPal order does not belong to this hold.")
    quest = m.quest
    if quest.status not in {"open", "on"} or aware(quest.join_by) < utcnow():
        # Never authorize money for a quest that closed while the buyer was on PayPal.
        m.status = "abandoned"
        db.flush()
        raise QuestError("This quest closed before your hold went through. Nothing was held.", 409)
    try:
        auth = _gateway(m).authorize_order(m.order_id)
    except PayPalError as exc:
        if exc.issue == "INSTRUMENT_DECLINED":
            raise QuestError("PayPal declined that payment method. Try another one.", 402) from exc
        if exc.issue == "ORDER_ALREADY_AUTHORIZED":
            return m
        m.status = "failed"
        log(db, quest, "decline", m.hold_cents, membership=m, ref=m.order_id, note=str(exc))
        raise QuestError(f"PayPal could not place the hold: {exc}", 502) from exc
    _place(db, quest, m, auth.authorization_id, auth.funding, auth.raw)
    return m


def _place(db: Session, quest: Quest, m: Membership, authorization_id: str, funding: str | None, raw: dict | None) -> None:
    m.authorization_id = authorization_id
    m.authorized_at = utcnow()
    m.funding = funding
    seat = _free_seat(quest) if quest.status in {"open", "on"} else None
    if seat is not None:
        m.status, m.seat = "held", seat
    else:
        m.status, m.seat = "standby", None
    db.flush()
    who = m.user.name if m.user else "Someone"
    if m.status == "held":
        log(db, quest, "hold", m.hold_cents, membership=m, ref=authorization_id,
            note=f"{who} took seat {seat}", raw=raw)
        say(db, quest, f"{who} placed a {fmt(m.hold_cents)} hold and took seat {seat}.",
            meta={"event": "hold", "membership": m.id})
    else:
        log(db, quest, "hold", m.hold_cents, membership=m, ref=authorization_id,
            note=f"{who} joined standby", raw=raw)
        say(db, quest, f"{who} placed a {fmt(m.hold_cents)} hold and joined the standby list.",
            meta={"event": "standby", "membership": m.id})
    _after_change(db, quest)


def simulate_join(db: Session, quest: Quest, user: User) -> Membership:
    """Demo crowd. Uses a sandbox test card when one is configured, otherwise a simulated hold."""
    _check_joinable(quest, user)
    hold = quest_hold(quest)
    use_card = paypal_mode() == "sandbox" and bool(settings.demo_card_number)
    m = Membership(quest=quest, user=user, status="pending",
                   provider="card" if use_card else "sim", hold_cents=hold)
    db.add(m)
    db.flush()
    try:
        auth = _gateway(m).card_authorization(hold, quest.currency, ref=m.id, description=_desc(quest))
    except PayPalError:
        m.provider = "sim"
        auth = gateway_for("sim").card_authorization(hold, quest.currency, ref=m.id, description=_desc(quest))
    m.order_id = auth.order_id
    _place(db, quest, m, auth.authorization_id, auth.funding or ("card" if m.provider == "card" else None), auth.raw)
    return m


def _after_change(db: Session, quest: Quest) -> None:
    n = headcount(quest)
    if quest.status == "open" and n >= quest.min_people:
        quest.status = "on"
        quest.tipped_at = utcnow()
        say(db, quest, f"Seat {quest.min_people} is filled. The quest is on. "
                       f"Right now everyone pays {fmt(current_share(quest))}, and it drops as more people join.",
            meta={"event": "tipped"})
    elif quest.status == "on" and n < quest.min_people:
        quest.status = "open"
        quest.tipped_at = None
        say(db, quest, f"Back to {n} of {quest.min_people}. "
                       f"The quest needs {quest.min_people - n} more before the deadline.",
            meta={"event": "untipped"})


# ----------------------------------------------------------------------------
# Leaving
# ----------------------------------------------------------------------------

def release(db: Session, m: Membership, note: str) -> None:
    """Void an uncaptured authorization."""
    if m.status not in {"held", "standby"}:
        raise QuestError("Only an uncaptured hold can be released.")
    quest = m.quest
    try:
        _gateway(m).void_authorization(m.authorization_id)
    except PayPalError as exc:
        if exc.issue not in {"AUTHORIZATION_ALREADY_VOIDED", "AUTHORIZATION_VOIDED"}:
            raise QuestError(f"PayPal could not release the hold: {exc}", 502) from exc
    m.status, m.seat = "released", None
    log(db, quest, "release", m.hold_cents, membership=m, ref=m.authorization_id, note=note)
    db.flush()


def leave(db: Session, m: Membership) -> dict:
    """A member leaves. Before lock this is free and instant. After lock it needs the host."""
    quest = m.quest
    who = m.user.name
    if m.status == "pending":
        m.status = "abandoned"
        return {"done": True}
    if m.status in {"held", "standby"}:
        was_seated = m.status == "held"
        release(db, m, note=f"{who} left")
        say(db, quest, f"{who} left. Their {fmt(m.hold_cents)} hold was released.", meta={"event": "left"})
        if was_seated and quest.status in {"open", "on"}:
            _promote_first_standby(db, quest)
        _after_change(db, quest)
        return {"done": True}
    if m.status == "charged":
        proposal = propose_dropout(db, quest, m)
        return {"done": False, "proposal_id": proposal.id}
    raise QuestError("You are not on this quest.")


def _promote_first_standby(db: Session, quest: Quest) -> Membership | None:
    queue = standby(quest)
    if not queue:
        return None
    nxt = queue[0]
    nxt.status, nxt.seat = "held", _free_seat(quest)
    db.flush()
    say(db, quest, f"{nxt.user.name} moved up from standby into seat {nxt.seat}. Their hold carries over.",
        meta={"event": "promoted"})
    return nxt


def propose_dropout(db: Session, quest: Quest, m: Membership, rationale: str | None = None) -> Proposal:
    """After lock: swap in standby if there is one, otherwise let the host decide on a refund."""
    queue = standby(quest)
    paid = m.charged_cents - m.refunded_cents
    if queue:
        nxt = queue[0]
        actions = [
            {"type": "promote", "membership_id": nxt.id},
            {"type": "refund", "membership_id": m.id, "cents": paid, "note": "Your spot was taken by someone on standby."},
        ]
        title = f"Swap {m.user.name} for {nxt.user.name}"
        why = rationale or (f"{m.user.name} can't make it. {nxt.user.name} is first on standby with a "
                            f"{fmt(nxt.hold_cents)} hold. Charging {nxt.user.name} {fmt(current_share(quest))} "
                            f"and refunding {m.user.name} keeps everyone else's share the same.")
    else:
        actions = [{"type": "refund", "membership_id": m.id, "cents": paid, "note": "Refunded by the host."}]
        title = f"Refund {m.user.name}"
        why = rationale or (f"{m.user.name} can't make it and nobody is on standby. Refunding means "
                            f"the host absorbs {fmt(paid)}. Declining keeps the payment.")
    return create_proposal(db, quest, title, why, actions)


# ----------------------------------------------------------------------------
# Locking, completing, cancelling
# ----------------------------------------------------------------------------

def lock(db: Session, quest: Quest, reason: str = "The host locked the quest.") -> dict:
    if quest.status != "on":
        raise QuestError("A quest can only be locked once it is on.")
    people = seated(quest)
    n = len(people)
    share = price_cents(quest.cost_lines, n, quest.fee_bps)
    charged, failed = [], []
    for m in people:
        if share > m.hold_cents:
            raise QuestError("Refusing to capture more than a member authorized.", 500)
        gw = _gateway(m)
        try:
            if m.authorized_at and utcnow() - aware(m.authorized_at) > HONOR_PERIOD:
                re = gw.reauthorize(m.authorization_id, share, quest.currency)
                log(db, quest, "reauthorize", share, membership=m, ref=re.authorization_id,
                    note="Honor period passed, reauthorized before capture")
                m.authorization_id = re.authorization_id
                m.authorized_at = utcnow()
            cap = gw.capture_authorization(m.authorization_id, share, quest.currency,
                                           note=f"{quest.code}: final split for {n} people",
                                           invoice_id=f"{quest.code}-{m.id}")
        except PayPalError as exc:
            m.status = "failed"
            log(db, quest, "decline", share, membership=m, ref=m.authorization_id, note=str(exc))
            failed.append(m)
            continue
        m.status, m.capture_id, m.charged_cents = "charged", cap.capture_id, share
        log(db, quest, "charge", share, membership=m, ref=cap.capture_id,
            note=f"{m.user.name} charged the final split", raw=cap.raw)
        charged.append(m)
    quest.status = "locked"
    quest.locked_at = utcnow()
    total = share * len(charged)
    say(db, quest, f"{reason} {len(charged)} people charged {fmt(share)} each, {fmt(total)} in total. "
                   f"Every hold was {fmt(quest_hold(quest))}, so each person saved "
                   f"{fmt(quest_hold(quest) - share)}.", meta={"event": "locked"})
    if failed:
        names = ", ".join(m.user.name for m in failed)
        say(db, quest, f"PayPal declined the charge for {names}. The host has been asked what to do.",
            meta={"event": "declined"})
    db.flush()
    return {"share_cents": share, "charged": len(charged), "failed": len(failed)}


def trip_ends_at(quest: Quest) -> datetime:
    return aware(quest.ends_at) or aware(quest.starts_at) + timedelta(hours=12)


def payout_due_at(quest: Quest) -> datetime:
    """Money sits with Sidequest until this time, so members can report a problem first."""
    return trip_ends_at(quest) + timedelta(hours=settings.payout_hold_hours)


def payout_blocker(db: Session, quest: Quest) -> str | None:
    if quest.status != "locked":
        return "Only a locked quest can pay out."
    if quest.payout_paused_reason:
        return f"The payout is paused: {quest.payout_paused_reason}"
    if db.scalar(select(func.count(Proposal.id)).where(Proposal.quest_id == quest.id, Proposal.status == "pending")):
        return "There's a money change waiting for the host's approval."
    return None


def report_problem(db: Session, quest: Quest, user: User, reason: str) -> None:
    """Any member who paid can pause the payout. The host has to resolve it before money moves."""
    if quest.status != "locked":
        raise QuestError("You can report a problem after the quest is charged and before the host is paid.")
    m = membership_for(quest, user.id)
    if user.id != quest.host_id and not (m and m.status == "charged"):
        raise QuestError("Only people who paid for this quest can pause the payout.", 403)
    reason = reason.strip()[:280] or "No reason given"
    quest.payout_paused_reason = f"{user.name}: {reason}"
    quest.payout_paused_by = user.id
    say(db, quest, f"{user.name} reported a problem: {reason}. The host's payout is paused until it's resolved.",
        meta={"event": "problem"})
    db.flush()


def resolve_problem(db: Session, quest: Quest, note: str = "") -> None:
    if not quest.payout_paused_reason:
        raise QuestError("There's no open problem on this quest.")
    quest.payout_paused_reason = None
    quest.payout_paused_by = None
    tail = f" {note.strip()}" if note.strip() else ""
    say(db, quest, f"{quest.host.name} resolved the problem.{tail} The payout is back on schedule.",
        meta={"event": "resolved"})
    db.flush()


def complete(db: Session, quest: Quest, reason: str = "The trip is over and nobody reported a problem.") -> dict:
    """After the dispute window: release standby holds and pay the host through PayPal Payouts."""
    blocker = payout_blocker(db, quest)
    if blocker:
        raise QuestError(blocker, 409)
    for m in standby(quest):
        release(db, m, note="Trip happened, standby hold released")
    net = sum(m.charged_cents - m.refunded_cents for m in quest.memberships)
    payout_cents = floor(net * 10_000 / (10_000 + quest.fee_bps)) if quest.fee_bps else net
    providers = {m.provider for m in quest.memberships if m.charged_cents}
    gw = gateway_for("sim" if providers <= {"sim"} else "paypal")
    receiver = quest.host.payout_email or quest.host.email
    try:
        result = gw.payout(receiver, payout_cents, quest.currency,
                           note=f"Payout for {quest.code} {quest.title}", batch_ref=f"{quest.code}-{quest.id}")
    except PayPalError as exc:
        raise QuestError(f"PayPal Payouts failed: {exc}", 502) from exc
    log(db, quest, "payout", payout_cents, user=quest.host, ref=result.batch_id,
        provider=gw.name, note=f"Paid to {receiver}", raw=result.raw)
    quest.status = "completed"
    quest.completed_at = utcnow()
    say(db, quest, f"{reason} {fmt(payout_cents)} paid out to {quest.host.name} through PayPal Payouts.",
        meta={"event": "completed"})
    db.flush()
    return {"payout_cents": payout_cents, "batch_id": result.batch_id}


def cancel(db: Session, quest: Quest, reason: str) -> None:
    if quest.status not in {"open", "on"}:
        raise QuestError("Only an open quest can be cancelled.")
    for m in quest.memberships:
        if m.status in {"held", "standby"}:
            release(db, m, note="Quest cancelled")
        elif m.status == "pending":
            m.status = "abandoned"
    quest.status = "cancelled"
    quest.cancelled_at = utcnow()
    say(db, quest, f"{reason} Every hold was released. Nobody was charged.", meta={"event": "cancelled"})
    db.flush()


# ----------------------------------------------------------------------------
# Refunds, invoices, proposals
# ----------------------------------------------------------------------------

def refund(db: Session, m: Membership, cents: int, note: str) -> None:
    available = m.charged_cents - m.refunded_cents
    if cents <= 0 or cents > available:
        raise QuestError(f"A refund must be between $0.01 and {fmt(available)}.")
    result = _gateway(m).refund_capture(m.capture_id, cents, m.quest.currency, note=note)
    m.refunded_cents += cents
    if m.refunded_cents >= m.charged_cents:
        m.status, m.seat = "refunded", None
    log(db, m.quest, "refund", cents, membership=m, ref=result.refund_id, note=note, raw=result.raw)
    db.flush()


def promote(db: Session, m: Membership) -> None:
    quest = m.quest
    if m.status != "standby":
        raise QuestError(f"{m.user.name} is not on standby.")
    if quest.status in {"open", "on"}:
        seat = _free_seat(quest)
        if seat is None:
            raise QuestError("There is no free seat.")
        m.status, m.seat = "held", seat
        _after_change(db, quest)
        return
    if quest.status != "locked":
        raise QuestError("This quest is finished.")
    share = max((x.charged_cents for x in seated(quest)), default=current_share(quest))
    share = min(share, m.hold_cents)
    cap = _gateway(m).capture_authorization(m.authorization_id, share, quest.currency,
                                            note=f"{quest.code}: you moved up from standby")
    m.status, m.capture_id, m.charged_cents, m.seat = "charged", cap.capture_id, share, None
    log(db, quest, "charge", share, membership=m, ref=cap.capture_id, note=f"{m.user.name} moved up from standby")
    db.flush()


def _send_invoices(quest: Quest, jobs: list[tuple[Membership, dict]]) -> list[tuple[Membership, dict, dict | Exception]]:
    """Network only, no database. PayPal calls run in parallel so seven invoices take one round trip, not seven."""
    from concurrent.futures import ThreadPoolExecutor

    def one(job):
        m, a = job
        try:
            return m, a, toolkit.create_and_send_invoice(
                email=m.user.email, name=m.user.name, cents=a["cents"], item=a["item"], note=a["note"],
                reference=quest.code, description=a.get("description"))
        except Exception as exc:  # recorded per person
            return m, a, exc

    with ThreadPoolExecutor(max_workers=min(6, max(1, len(jobs)))) as pool:
        return list(pool.map(one, jobs))


ACTION_TYPES = {"void_hold", "promote", "refund", "invoice"}


def _validate_actions(db: Session, quest: Quest, actions: list[dict]) -> list[dict]:
    clean = []
    by_id = {m.id: m for m in quest.memberships}
    for a in actions:
        kind = a.get("type")
        if kind not in ACTION_TYPES:
            raise QuestError(f"Unknown action {kind!r}.")
        m = by_id.get(a.get("membership_id", ""))
        if not m:
            raise QuestError("An action points at someone who is not on this quest.")
        item = {"type": kind, "membership_id": m.id, "name": m.user.name}
        if kind == "void_hold":
            if m.status not in {"held", "standby"}:
                raise QuestError(f"{m.user.name} has no hold to release.")
            item.update(cents=m.hold_cents, ref=m.authorization_id)
        elif kind == "promote":
            if m.status != "standby":
                raise QuestError(f"{m.user.name} is not on standby.")
            item.update(cents=current_share(quest) if quest.status == "locked" else 0, ref=m.authorization_id)
        elif kind == "refund":
            cents = int(a.get("cents") or 0)
            available = m.charged_cents - m.refunded_cents
            if cents <= 0 or cents > available:
                raise QuestError(f"Refund for {m.user.name} must be between $0.01 and {fmt(available)}.")
            item.update(cents=cents, ref=m.capture_id, note=str(a.get("note") or "Refund from your quest host"))
        elif kind == "invoice":
            cents = int(a.get("cents") or 0)
            if cents <= 0 or cents > 50_000:
                raise QuestError("Invoices must be between $0.01 and $500.00.")
            item.update(cents=cents, item=str(a.get("item") or f"{quest.code} extra costs"),
                        note=str(a.get("note") or "Your share of costs that went over the estimate."))
        clean.append(item)
    if not clean:
        raise QuestError("A proposal needs at least one action.")
    return clean


def create_proposal(db: Session, quest: Quest, title: str, rationale: str, actions: list[dict]) -> Proposal:
    clean = _validate_actions(db, quest, actions)
    sig = _signature(clean)
    for p in db.scalars(select(Proposal).where(Proposal.quest_id == quest.id, Proposal.status == "pending")):
        if _signature(p.actions) == sig:
            return p
    p = Proposal(quest_id=quest.id, title=title[:200], rationale=rationale, actions=clean)
    db.add(p)
    db.flush()
    say(db, quest, f"Waiting on {quest.host.name}: {title}.", role="system", meta={"event": "proposal", "proposal": p.id})
    return p


def _signature(actions: list[dict]) -> list[tuple]:
    return sorted((a.get("type"), a.get("membership_id")) for a in actions)


def decide_proposal(db: Session, p: Proposal, approve: bool) -> Proposal:
    claimed = db.execute(
        update(Proposal)
        .where(Proposal.id == p.id, Proposal.status == "pending")
        .values(status="running")
        .execution_options(synchronize_session=False)
    ).rowcount
    if claimed != 1:
        raise QuestError("This proposal was already decided.", 409)
    p.status = "running"
    quest = db.get(Quest, p.quest_id)
    p.decided_at = utcnow()
    if not approve:
        p.status = "declined"
        say(db, quest, f"{quest.host.name} declined: {p.title}.", meta={"event": "declined_proposal"})
        db.flush()
        return p
    # Re-validate against the current state before touching money.
    actions = _validate_actions(db, quest, p.actions)
    by_id = {m.id: m for m in quest.memberships}
    results = []
    invoice_jobs = [(by_id[a["membership_id"]], {**a, "description": (p.evidence and _evidence_text(p.evidence)) or None})
                    for a in actions if a["type"] == "invoice"]
    sent = {m.id: out for m, _, out in _send_invoices(quest, invoice_jobs)} if invoice_jobs else {}
    try:
        for a in actions:
            m = by_id[a["membership_id"]]
            if a["type"] == "void_hold":
                release(db, m, note="Released by the host")
                if quest.status in {"open", "on"}:
                    _after_change(db, quest)
            elif a["type"] == "promote":
                promote(db, m)
            elif a["type"] == "refund":
                refund(db, m, a["cents"], a["note"])
            elif a["type"] == "invoice":
                out = sent[m.id]
                if isinstance(out, Exception):
                    raise QuestError(f"PayPal didn't send {m.user.name}'s invoice: {out}")
                log(db, quest, "invoice", a["cents"], membership=m, ref=out["invoice_id"],
                    provider="toolkit", note=f"Invoice sent to {m.user.name}: {a['item']}")
            results.append({"type": a["type"], "name": a["name"], "ok": True})
    except (QuestError, PayPalError, RuntimeError) as exc:
        p.status = "failed"
        p.result = {"done": results, "error": str(exc)}
        say(db, quest, f"Stopped partway through \"{p.title}\": {exc}", meta={"event": "proposal_failed"})
        db.flush()
        return p
    _reseat(quest)
    p.status = "executed"
    p.result = {"done": results}
    say(db, quest, f"{quest.host.name} approved: {p.title}. Done on PayPal.", meta={"event": "executed"})
    db.flush()
    _expire_stale(db, quest, keep=p.id)
    return p


def _expire_stale(db: Session, quest: Quest, keep: str) -> None:
    for other in db.scalars(select(Proposal).where(Proposal.quest_id == quest.id, Proposal.status == "pending",
                                                    Proposal.id != keep)):
        try:
            _validate_actions(db, quest, other.actions)
        except QuestError:
            other.status = "expired"
            other.decided_at = utcnow()
    db.flush()


def _evidence_text(evidence: list[dict]) -> str:
    parts = []
    for r in evidence:
        parts.append(f"{r.get('cost_line') or 'Cost'}: {r.get('merchant') or 'receipt'}"
                     f"{', ' + r['purchased_on'] if r.get('purchased_on') else ''}, {fmt(r.get('total_cents') or 0)}. "
                     f"Receipt: {settings.public_api_url}/receipts/{r['id']}/image")
    return "Receipts behind this charge. " + " ".join(parts)


def _reseat(quest: Quest) -> None:
    for m in seated(quest):
        if m.seat is None:
            m.seat = _free_seat(quest)


RECEIPT_MAX_BYTES = 5 * 1024 * 1024
RECEIPT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def read_receipt(quest: Quest, data: bytes, media_type: str) -> tuple[dict | None, str | None]:
    """Ask Claude to read a receipt. Slow, so callers run it before taking the quest lock."""
    from .agent import receipts as reader

    try:
        return reader.read(quest, data, media_type), None
    except Exception as exc:  # the AI being down shouldn't block the host
        import logging

        logging.getLogger("sidequest.receipts").warning("receipt read failed: %r", exc)
        detail = getattr(exc, "message", None) or str(exc)
        return None, f"Couldn't read it automatically ({type(exc).__name__}: {detail[:160]}). Check it by eye."


def add_receipt(db: Session, quest: Quest, user: User, filename: str, media_type: str, data: bytes,
                host_total_cents: int | None = None, pre_read: tuple[dict | None, str | None] | None = None,
                host_cost_line: str | None = None) -> Receipt:
    """Store a receipt, have Claude read it, then run checks a careful bookkeeper would run."""
    import hashlib

    if quest.status not in {"locked", "completed"}:
        raise QuestError("Add receipts after the quest is charged.")
    if media_type not in RECEIPT_TYPES:
        raise QuestError("Upload a photo of the receipt: JPG, PNG, WebP or GIF.")
    if not data or len(data) > RECEIPT_MAX_BYTES:
        raise QuestError("Receipts must be under 5 MB.")
    digest = hashlib.sha256(data).hexdigest()
    dupe = db.scalar(select(Receipt).where(Receipt.quest_id == quest.id, Receipt.sha256 == digest,
                                           Receipt.status != "removed"))
    if dupe:
        raise QuestError("That receipt was already added.", 409)

    r = Receipt(quest_id=quest.id, uploaded_by=user.id, filename=filename[:200] or "receipt",
                media_type=media_type, data=data, sha256=digest, issues=[])
    shared = {l["label"]: int(l["cents"]) for l in quest.cost_lines if l.get("split") == "shared"}
    reading, read_error = pre_read if pre_read is not None else read_receipt(quest, data, media_type)
    issues: list[str] = [read_error] if read_error else []

    if reading is None:
        r.reader = "host"
        r.total_cents = host_total_cents
        r.cost_line = host_cost_line if host_cost_line in shared else next(iter(shared), None)
        if host_total_cents is None:
            issues.append("Enter the total. Automatic reading is off.")
        status = "unverified"
    else:
        r.reader = "claude"
        r.merchant = reading.get("merchant") or None
        r.purchased_on = reading.get("date") or None
        total = reading.get("total_usd")
        r.total_cents = int(round(float(total) * 100)) if total is not None else None
        line = reading.get("cost_line")
        r.cost_line = line if line in shared else None
        issues += [str(c) for c in (reading.get("concerns") or []) if str(c).strip()]
        if not reading.get("is_receipt"):
            issues.insert(0, "This doesn't look like a receipt.")
        if not reading.get("legible"):
            issues.append("The total or date isn't clearly readable.")
        if r.total_cents is None:
            issues.append("No total could be read.")
        if r.cost_line is None:
            issues.append("It doesn't match any shared cost on this quest.")
        status = "verified"

    # Checks that don't depend on the model.
    if r.purchased_on:
        try:
            bought = datetime.fromisoformat(r.purchased_on).date()
            start = aware(quest.starts_at).date()
            end = trip_ends_at(quest).date()
            if not (start - timedelta(days=7) <= bought <= end + timedelta(days=1)):
                issues.append(f"Dated {r.purchased_on}, outside the trip.")
        except ValueError:
            issues.append("The date isn't a real date.")
    if r.total_cents and r.cost_line and r.total_cents > 3 * shared[r.cost_line]:
        issues.append(f"More than three times the {fmt(shared[r.cost_line])} estimate for {r.cost_line}.")

    if reading is not None and (not reading.get("is_receipt") or r.total_cents is None):
        status = "rejected"
    elif issues and status == "verified":
        status = "flagged"
    r.issues = issues
    r.status = status
    db.add(r)
    db.flush()
    label = {"verified": "verified", "flagged": "flagged for a look",
             "unverified": "added without automatic checks", "rejected": "rejected"}[status]
    source = f" from {r.merchant}" if r.merchant else ""
    amount = f" for {fmt(r.total_cents)}" if r.total_cents else ""
    say(db, quest, f"{user.name} added a receipt{source}{amount}. It was {label}.",
        meta={"event": "receipt", "receipt": r.id})
    return r


def remove_receipt(db: Session, r: Receipt) -> None:
    r.status = "removed"
    db.flush()


def receipt_out(r: Receipt) -> dict:
    return {"id": r.id, "merchant": r.merchant, "purchased_on": r.purchased_on, "total_cents": r.total_cents,
            "cost_line": r.cost_line, "status": r.status, "issues": r.issues or [], "reader": r.reader,
            "filename": r.filename, "created_at": r.created_at.isoformat() if r.created_at else None}


def propose_settle_up(db: Session, quest: Quest, actual_shared_cents: int | None = None, note: str = "") -> Proposal:
    """After the trip, settle the difference between real shared costs and the estimate.

    With receipts, each shared line with receipts costs what its receipts add up to, and lines without
    receipts keep their estimate. Without receipts, the host's total is used and labelled unverified."""
    if quest.status not in {"locked", "completed"}:
        raise QuestError("Settle up after the quest is locked.")
    payers = [m for m in quest.memberships if m.status == "charged"]
    if not payers:
        raise QuestError("Nobody was charged on this quest.")
    planned = sum(int(l["cents"]) for l in quest.cost_lines if l.get("split") == "shared")
    usable = list(db.scalars(select(Receipt).where(
        Receipt.quest_id == quest.id, Receipt.status.in_(["verified", "flagged", "unverified"]),
        Receipt.total_cents.isnot(None), Receipt.cost_line.isnot(None))))
    evidence = None
    if usable:
        shared = {l["label"]: int(l["cents"]) for l in quest.cost_lines if l.get("split") == "shared"}
        covered = sorted({r.cost_line for r in usable})
        actual_shared_cents = planned - sum(shared[c] for c in covered) + sum(r.total_cents for r in usable)
        evidence = [receipt_out(r) for r in usable]
        flagged = [r for r in usable if r.status == "flagged"]
        unchecked = [r for r in usable if r.status == "unverified"]
        per_line = "; ".join(
            f"{c}: {fmt(sum(r.total_cents for r in usable if r.cost_line == c))} on receipts, "
            f"{fmt(shared[c])} estimated" for c in covered)
        count = f"{len(usable)} receipt" + ("s" if len(usable) != 1 else "")
        check = ""
        if flagged:
            check += f" {len(flagged)} {'needs' if len(flagged) == 1 else 'need'} a look before you approve."
        if unchecked:
            check += (f" {len(unchecked)} {'was' if len(unchecked) == 1 else 'were'} entered by the host "
                      f"and not checked automatically.")
        if not check:
            check = " Every receipt was read and checked."
        note = f"From {count}. {per_line}.{check}" + (f" {note}" if note else "")
    elif actual_shared_cents is None:
        raise QuestError("Add a receipt or enter the real total.")
    else:
        note = "Entered by the host without receipts." + (f" {note}" if note else "")
    diff = actual_shared_cents - planned
    if diff == 0:
        raise QuestError("Actual costs match the estimate. Nothing to settle.")
    per = -(-abs(diff) // len(payers))
    if diff < 0:
        actions = [{"type": "refund", "membership_id": m.id, "cents": min(per, m.charged_cents - m.refunded_cents),
                    "note": "Shared costs came in under the estimate."} for m in payers]
        title = f"Refund {fmt(per)} to each of {len(payers)} people"
        why = f"Shared costs were {fmt(actual_shared_cents)}, {fmt(-diff)} under the estimate. {note}".strip()
    else:
        actions = [{"type": "invoice", "membership_id": m.id, "cents": per, "item": f"{quest.code} shared cost overage",
                    "note": f"Shared costs came in {fmt(diff)} over the estimate. Your share is {fmt(per)}."} for m in payers]
        title = f"Invoice {fmt(per)} to each of {len(payers)} people"
        why = f"Shared costs were {fmt(actual_shared_cents)}, {fmt(diff)} over the estimate. {note}".strip()
    p = create_proposal(db, quest, title, why, actions)
    if evidence:
        p.evidence = evidence
        p.rationale = why
        db.flush()
    return p


# ----------------------------------------------------------------------------
# Clock and webhooks
# ----------------------------------------------------------------------------

NUDGE_WINDOW = timedelta(hours=24)


def _nudge(db: Session, q: Quest, now: datetime) -> bool:
    """The agent speaks up once when a quest is short with less than a day to go."""
    short = q.min_people - headcount(q)
    if q.status != "open" or short <= 0 or aware(q.join_by) - now > NUDGE_WINDOW:
        return False
    already = db.scalar(select(func.count(Message.id)).where(Message.quest_id == q.id, Message.role == "agent",
                                                             Message.body.like("Heads up%")))
    if already:
        return False
    hours = max(1, int((aware(q.join_by) - now).total_seconds() // 3600))
    say(db, q, f"Heads up: {short} more {'person' if short == 1 else 'people'} needed in the next {hours} hours or "
               f"this quest won't run. If it doesn't fill, every hold is released and nobody pays. "
               f"Share this link: {settings.frontend_url}/join/{q.id}", role="agent", meta={"event": "nudge"})
    return True


def tick(db: Session) -> dict:
    now = utcnow()
    counts = {"cancelled": 0, "locked": 0, "standby_released": 0, "abandoned": 0, "nudged": 0, "paid_out": 0}
    ids = list(db.scalars(select(Quest.id).where(Quest.status.in_(["open", "on", "locked"]))))
    for qid in ids:
        with quest_lock(qid):
            q = db.get(Quest, qid)
            db.refresh(q)
            try:
                if q.status == "open" and aware(q.join_by) <= now:
                    cancel(db, q, f"The deadline passed with {headcount(q)} of {q.min_people}.")
                    counts["cancelled"] += 1
                elif q.status == "on" and aware(q.join_by) <= now:
                    lock(db, q, reason="The join deadline passed, so the quest locked.")
                    counts["locked"] += 1
                elif q.status == "locked" and payout_due_at(q) <= now and not payout_blocker(db, q):
                    complete(db, q)
                    counts["paid_out"] += 1
                elif q.status == "locked" and aware(q.starts_at) <= now and standby(q):
                    for m in standby(q):
                        release(db, m, note="Trip started, standby hold released")
                        counts["standby_released"] += 1
                elif _nudge(db, q, now):
                    counts["nudged"] += 1
                db.commit()
            except QuestError:
                db.rollback()
                continue
    stale = now - timedelta(hours=3)
    for m in db.scalars(select(Membership).where(Membership.status == "pending")):
        if aware(m.created_at) < stale:
            m.status = "abandoned"
            counts["abandoned"] += 1
    db.flush()
    return counts


def handle_webhook(db: Session, event: dict) -> str:
    kind = event.get("event_type", "")
    res = event.get("resource") or {}
    rid = res.get("id")
    if kind == "CHECKOUT.ORDER.APPROVED" and rid:
        m = db.scalar(select(Membership).where(Membership.order_id == rid))
        if m and m.status == "pending":
            confirm_hold(db, m, rid)
            return "authorized"
        return "ignored"
    confirm_kinds = {
        "PAYMENT.AUTHORIZATION.CREATED": "hold",
        "PAYMENT.AUTHORIZATION.VOIDED": "release",
        "PAYMENT.CAPTURE.COMPLETED": "charge",
        "PAYMENT.CAPTURE.REFUNDED": "refund",
    }
    if kind in confirm_kinds and rid:
        entry = db.scalar(select(LedgerEntry).where(LedgerEntry.paypal_ref == rid,
                                                     LedgerEntry.kind == confirm_kinds[kind]))
        if entry:
            entry.confirmed = True
            return "confirmed"
        return "unknown"
    if kind in {"PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"} and rid:
        m = db.scalar(select(Membership).where(Membership.capture_id == rid))
        if m:
            m.status = "failed"
            say(db, m.quest, f"PayPal reversed {m.user.name}'s charge.", meta={"event": "declined"})
            return "failed"
        return "unknown"
    if kind.startswith("PAYMENT.PAYOUTS"):
        batch = (res.get("batch_header") or {}).get("payout_batch_id") or res.get("payout_batch_id")
        if batch:
            entry = db.scalar(select(LedgerEntry).where(LedgerEntry.paypal_ref == batch, LedgerEntry.kind == "payout"))
            if entry:
                entry.confirmed = True
                return "confirmed"
        return "unknown"
    return "ignored"


def next_number(db: Session) -> int:
    current = db.scalar(select(func.max(Quest.number)))
    return (current or 416) + 1
