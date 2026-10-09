"""Reports and disputes. A Sidequest admin decides, never the host.

A member who paid can report a problem after the quest is charged. That opens a case and pauses the
host's payout. A dispute filed with PayPal opens a case the same way, through the Disputes API or
its webhook. The host can reply, the reporter can withdraw, and only an admin can resolve:

  release          the payout goes ahead
  refund_reporter  refund the person who reported, up to what they paid
  refund_everyone  refund each person who paid the same amount
  accept_claim     PayPal disputes only: accept the claim on PayPal, which refunds the buyer

Claude can read a case and suggest a decision. It can't make one.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AuditLog, Case, LedgerEntry, Membership, Quest, User, utcnow
from .pricing import fmt

DECISIONS = {"release", "refund_reporter", "refund_everyone", "accept_claim"}

PAYPAL_REASONS = {
    "MERCHANDISE_OR_SERVICE_NOT_RECEIVED": "Paid but says the trip never happened",
    "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED": "Says the trip wasn't as described",
    "UNAUTHORISED": "Says they didn't make this payment",
    "CREDIT_NOT_PROCESSED": "Expected a refund that never came",
    "DUPLICATE_TRANSACTION": "Says they were charged twice",
    "INCORRECT_AMOUNT": "Says they were charged the wrong amount",
    "PAYMENT_BY_OTHER_MEANS": "Says they paid another way",
    "PROBLEM_WITH_REMITTANCE": "Problem with the payment",
    "OTHER": "Other",
}


def audit(db: Session, actor: User | None, action: str, target: str | None, summary: str,
          detail: dict | None = None) -> AuditLog:
    row = AuditLog(actor_id=actor.id if actor else None, action=action, target=target, summary=summary[:600],
                   detail=detail)
    db.add(row)
    return row


def open_cases(db: Session, quest: Quest) -> list[Case]:
    return list(db.scalars(select(Case).where(Case.quest_id == quest.id, Case.status == "open")
                           .order_by(Case.created_at)))


def _who(c: Case) -> str:
    if c.source == "paypal":
        return f"PayPal dispute from {c.reporter.name}" if c.reporter else "PayPal dispute"
    return c.reporter.name if c.reporter else "A member"


def sync_pause(db: Session, quest: Quest) -> None:
    """The quest's pause note mirrors the oldest open case, so every payout check sees it."""
    db.flush()
    cases = open_cases(db, quest)
    if cases and quest.status == "locked":
        first = cases[0]
        quest.payout_paused_reason = f"{_who(first)}: {first.reason}"
        quest.payout_paused_by = first.opened_by
    else:
        quest.payout_paused_reason = None
        quest.payout_paused_by = None


def report(db: Session, quest: Quest, user: User, reason: str) -> Case:
    from .engine import QuestError, membership_for, say

    if quest.status != "locked":
        if quest.status == "completed":
            raise QuestError("The host has already been paid. Open a dispute with PayPal and Sidequest will review it.")
        raise QuestError("You can report a problem after the quest is charged and before the host is paid.")
    if user.id == quest.host_id:
        raise QuestError("Hosts can't report their own quest. Reply to a member's report instead.", 403)
    m = membership_for(quest, user.id)
    if not (m and m.status == "charged"):
        raise QuestError("Only people who paid for this quest can report a problem.", 403)
    if db.scalar(select(Case.id).where(Case.quest_id == quest.id, Case.opened_by == user.id, Case.status == "open")):
        raise QuestError("You already reported a problem on this quest. A Sidequest admin is looking at it.", 409)
    reason = reason.strip()[:280] or "No reason given"
    c = Case(quest_id=quest.id, membership_id=m.id, opened_by=user.id, source="member",
             provider="sim" if m.provider == "sim" else "paypal", reason=reason,
             disputed_cents=m.charged_cents - m.refunded_cents)
    db.add(c)
    db.flush()
    sync_pause(db, quest)
    say(db, quest, f"{user.name} reported a problem: {reason.rstrip('.')}. {quest.host.name}'s payout is paused while "
                   f"Sidequest reviews it. {quest.host.name} can reply with their side.", meta={"event": "problem", "case": c.id})
    audit(db, user, "case_opened", c.id, f"{user.name} reported a problem on {quest.code}: {reason}",
          {"quest": quest.id})
    db.flush()
    return c


def respond(db: Session, c: Case, user: User, text: str) -> Case:
    from .engine import QuestError, say

    quest = c.quest
    if user.id != quest.host_id:
        raise QuestError("Only the host can reply to a report.", 403)
    if c.status != "open":
        raise QuestError("This report is already closed.")
    text = text.strip()[:600]
    if len(text) < 3:
        raise QuestError("Write a short reply.")
    c.host_response, c.host_responded_at = text, utcnow()
    say(db, quest, f"{user.name} replied to {_who(c)}'s report. A Sidequest admin will decide.",
        meta={"event": "case_reply", "case": c.id})
    audit(db, user, "host_reply", c.id, f"{user.name} replied on {quest.code}: {text}")
    db.flush()
    return c


def withdraw(db: Session, c: Case, user: User) -> Case:
    from .engine import QuestError, say

    if c.source != "member" or user.id != c.opened_by:
        raise QuestError("Only the person who reported this can withdraw it.", 403)
    if c.status != "open":
        raise QuestError("This report is already closed.")
    c.status, c.resolved_at, c.resolution_note = "withdrawn", utcnow(), "Withdrawn by the person who reported it."
    sync_pause(db, c.quest)
    say(db, c.quest, f"{user.name} withdrew their report. The payout is back on schedule.",
        meta={"event": "case_withdrawn", "case": c.id})
    audit(db, user, "case_withdrawn", c.id, f"{user.name} withdrew their report on {c.quest.code}")
    db.flush()
    return c


def resolve(db: Session, c: Case, admin: User, decision: str, refund_cents_each: int = 0, note: str = "",
            pay_now: bool = False) -> Case:
    """The admin's decision. Refunds go through PayPal before the case closes."""
    from . import engine
    from .engine import QuestError, say
    from .paypal.gateway import PayPalError, gateway_for

    if not admin.is_admin:
        raise QuestError("Only a Sidequest admin can resolve a report.", 403)
    if c.status != "open":
        raise QuestError("This case is already closed.", 409)
    if decision not in DECISIONS:
        raise QuestError("Pick a decision: release, refund the reporter, refund everyone, or accept the PayPal claim.")
    note = note.strip()[:600]
    if len(note) < 3:
        raise QuestError("Write a short note explaining the decision. Everyone on the quest sees it.")
    quest = c.quest
    refunded: list[tuple[str, int]] = []

    if decision == "refund_reporter":
        m = db.get(Membership, c.membership_id) if c.membership_id else None
        if not m:
            raise QuestError("This case isn't tied to a payment, so there's nothing to refund.")
        available = m.charged_cents - m.refunded_cents
        if refund_cents_each <= 0 or refund_cents_each > available:
            raise QuestError(f"Refund {m.user.name} between $0.01 and {fmt(available)}.")
        engine.refund(db, m, refund_cents_each, f"Sidequest reviewed your report: {note}")
        refunded.append((m.user.name, refund_cents_each))
    elif decision == "refund_everyone":
        payers = [m for m in quest.memberships if m.charged_cents - m.refunded_cents > 0]
        if refund_cents_each <= 0 or not payers:
            raise QuestError("Enter an amount to refund each person.")
        for m in payers:
            cents = min(refund_cents_each, m.charged_cents - m.refunded_cents)
            engine.refund(db, m, cents, f"Sidequest reviewed a report on this quest: {note}")
            refunded.append((m.user.name, cents))
    elif decision == "accept_claim":
        if c.source != "paypal" or not c.paypal_dispute_id:
            raise QuestError("Accepting a claim only applies to a PayPal dispute.")
        try:
            gateway_for("sim" if c.provider == "sim" else "paypal").accept_claim(c.paypal_dispute_id, note)
        except PayPalError as exc:
            raise QuestError(f"PayPal didn't accept the claim: {exc}", 502) from exc
        m = db.get(Membership, c.membership_id) if c.membership_id else None
        if m:
            # PayPal refunds the buyer itself. Record it so the books match.
            cents = min(c.disputed_cents or m.charged_cents, m.charged_cents - m.refunded_cents)
            if cents > 0:
                m.refunded_cents += cents
                if m.refunded_cents >= m.charged_cents:
                    m.status, m.seat = "refunded", None
                engine.log(db, quest, "refund", cents, membership=m, ref=c.paypal_dispute_id,
                           provider="sim" if c.provider == "sim" else "paypal",
                           note=f"PayPal dispute accepted. PayPal refunded {m.user.name}.", paypal_fee=0)
                refunded.append((m.user.name, cents))
        c.paypal_status = "RESOLVED"

    c.status, c.decision, c.resolution_note = "resolved", decision, note
    c.refund_cents_each = refund_cents_each or None
    c.resolved_by, c.resolved_at = admin.id, utcnow()
    sync_pause(db, quest)

    if refunded:
        outcome = "refunded " + ", ".join(f"{n} {fmt(x)}" for n, x in refunded)
    else:
        outcome = "released the payout"
    tail = " The payout is back on schedule." if quest.status == "locked" and not quest.payout_paused_reason and not pay_now else ""
    say(db, quest, f"Sidequest reviewed {_who(c)}'s report and {outcome}. {note.rstrip('.')}.{tail}",
        meta={"event": "case_resolved", "case": c.id})
    audit(db, admin, "case_resolved", c.id, f"{admin.name} resolved a report on {quest.code}: {outcome}. {note}",
          {"decision": decision, "refunds": refunded, "quest": quest.id})
    db.flush()

    if pay_now and quest.status == "locked" and not engine.payout_blocker(db, quest):
        engine.complete(db, quest, reason=f"{admin.name} from Sidequest released the payout after reviewing the report.")
        audit(db, admin, "payout_released", quest.id, f"{admin.name} released {quest.code}'s payout early")
    db.flush()
    return c


# --- PayPal disputes ------------------------------------------------------------------------

def _seller_txn(d: dict) -> str | None:
    for t in d.get("disputed_transactions") or []:
        if t.get("seller_transaction_id"):
            return t["seller_transaction_id"]
    return None


def from_paypal_dispute(db: Session, d: dict, provider: str = "paypal") -> Case | None:
    """Open or update a case from a PayPal dispute object (webhook resource or Disputes API)."""
    from .engine import say
    from .paypal.gateway import money_cents

    did = d.get("dispute_id")
    if not did:
        return None
    existing = db.scalar(select(Case).where(Case.paypal_dispute_id == did))
    if existing:
        existing.paypal_status = d.get("status") or existing.paypal_status
        db.flush()
        return existing
    capture = _seller_txn(d)
    m = db.scalar(select(Membership).where(Membership.capture_id == capture)) if capture else None
    if not m:
        entry = db.scalar(select(LedgerEntry).where(LedgerEntry.paypal_ref == capture)) if capture else None
        m = db.get(Membership, entry.membership_id) if entry and entry.membership_id else None
    if not m:
        return None
    quest = m.quest
    code = d.get("reason") or "OTHER"
    buyer_note = next((x.get("content") for x in d.get("messages") or [] if x.get("posted_by") == "BUYER"), None)
    reason = PAYPAL_REASONS.get(code, code.replace("_", " ").capitalize())
    if buyer_note:
        reason += f'. "{buyer_note[:200]}"'
    c = Case(quest_id=quest.id, membership_id=m.id, opened_by=m.user_id, source="paypal", provider=provider,
             paypal_dispute_id=did, paypal_reason=code, paypal_status=d.get("status") or "OPEN",
             reason=reason, disputed_cents=money_cents(d.get("dispute_amount")) or m.charged_cents)
    db.add(c)
    db.flush()
    sync_pause(db, quest)
    paid = " The host was already paid, so Sidequest covers it if the claim is accepted." if quest.status == "completed" else \
        f" {quest.host.name}'s payout is paused while Sidequest reviews it."
    say(db, quest, f"{m.user.name} opened a PayPal dispute for {fmt(c.disputed_cents)}.{paid}",
        meta={"event": "paypal_dispute", "case": c.id})
    audit(db, None, "dispute_opened", c.id, f"PayPal dispute {did} on {quest.code} from {m.user.name}: {reason}",
          {"quest": quest.id, "status": c.paypal_status})
    db.flush()
    return c


def sync_paypal_disputes(db: Session, admin: User) -> dict:
    """Pull disputes from PayPal and open a case for any that match a Sidequest payment."""
    from .paypal.gateway import gateway_for, paypal_mode

    gw = gateway_for("paypal")
    items = gw.list_disputes()
    opened, updated, unmatched = 0, 0, 0
    for item in items[:25]:
        did = item.get("dispute_id")
        known = db.scalar(select(Case).where(Case.paypal_dispute_id == did)) if did else None
        if known:
            known.paypal_status = item.get("status") or known.paypal_status
            updated += 1
            continue
        detail = item if item.get("disputed_transactions") else gw.get_dispute(did)
        if from_paypal_dispute(db, detail):
            opened += 1
        else:
            unmatched += 1
    audit(db, admin, "dispute_sync", None,
          f"{admin.name} checked PayPal for disputes: {len(items)} found, {opened} new, {updated} updated"
          + (f", {unmatched} not tied to a Sidequest payment" if unmatched else ""),
          {"mode": paypal_mode()})
    db.flush()
    return {"found": len(items), "opened": opened, "updated": updated, "unmatched": unmatched}


def case_out(c: Case, full: bool = False) -> dict:
    from .views import iso, user_out

    q = c.quest
    out = {
        "id": c.id, "source": c.source, "provider": c.provider, "status": c.status, "reason": c.reason,
        "disputed_cents": c.disputed_cents, "reporter": user_out(c.reporter),
        "paypal_dispute_id": c.paypal_dispute_id, "paypal_reason": c.paypal_reason, "paypal_status": c.paypal_status,
        "host_response": c.host_response, "host_responded_at": iso(c.host_responded_at),
        "decision": c.decision, "refund_cents_each": c.refund_cents_each, "resolution_note": c.resolution_note,
        "resolved_by": user_out(c.resolver), "resolved_at": iso(c.resolved_at), "created_at": iso(c.created_at),
        "quest": {"id": q.id, "code": q.code, "title": q.title, "status": q.status, "line_code": q.line_code,
                  "host": user_out(q.host), "tz": q.tz},
        "ai_review": c.ai_review,
    }
    return out
