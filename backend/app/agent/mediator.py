"""Claude reads a case and suggests a decision. The admin decides; Claude can't move money."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Case, LedgerEntry, Message, Receipt
from ..pricing import fmt
from . import llm

TOOL = {
    "name": "recommend",
    "description": "Give the admin a short, fair read of this case and one suggested decision.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "Two sentences: what each side says."},
            "facts": {"type": "array", "items": {"type": "string"},
                      "description": "Facts the records support, each with where it comes from (chat, receipt, ledger)."},
            "missing": {"type": "array", "items": {"type": "string"},
                        "description": "What the admin can't tell from the records."},
            "decision": {"type": "string",
                         "enum": ["release", "refund_reporter", "refund_everyone", "accept_claim", "need_more_info"]},
            "refund_cents_each": {"type": "integer", "description": "Cents to refund each person, 0 if none."},
            "reasoning": {"type": "string", "description": "Why, in two or three plain sentences."},
        },
        "required": ["summary", "facts", "missing", "decision", "refund_cents_each", "reasoning"],
    },
}

SYSTEM = """You help a Sidequest admin decide a report on a small group trip. Sidequest held everyone's money
and pays the host after the trip. A member who paid reported a problem, or opened a PayPal dispute.
Be fair to both sides. Use only what the records show. Never invent facts. Prefer the smallest remedy that
fixes the harm: a partial refund for a partial problem, a full refund only if the trip didn't happen.
If the host hasn't replied and the report is serious, suggest need_more_info.
Amounts are in cents. Never suggest refunding more than someone paid."""


def _context(db: Session, c: Case) -> str:
    q = c.quest
    payers = [m for m in q.memberships if m.charged_cents]
    lines = [
        f"Quest {q.code}: {q.title}. Status {q.status}. Host {q.host.name}.",
        f"Planned costs: " + "; ".join(f"{l['label']} {fmt(int(l['cents']))} ({l['split']})" for l in q.cost_lines),
        f"People who paid: " + "; ".join(f"{m.user.name} paid {m.charged_cents}c, refunded {m.refunded_cents}c"
                                          for m in payers),
        f"Case from {'a PayPal dispute' if c.source == 'paypal' else 'a member report'}"
        f" by {c.reporter.name if c.reporter else 'unknown'}, disputing {c.disputed_cents}c: {c.reason}",
        f"Host's reply: {c.host_response or 'none yet'}",
    ]
    receipts = db.scalars(select(Receipt).where(Receipt.quest_id == q.id, Receipt.status != "removed")).all()
    if receipts:
        lines.append("Receipts: " + "; ".join(
            f"{r.merchant or 'unknown'} {fmt(r.total_cents or 0)} for {r.cost_line or 'no line'}, {r.status}"
            + (f" (issues: {', '.join(r.issues)})" if r.issues else "") for r in receipts))
    chat = db.scalars(select(Message).where(Message.quest_id == q.id).order_by(Message.created_at.desc()).limit(25)).all()
    lines.append("Recent group chat, oldest first:")
    lines += [f"- {(m.user.name if m.user else m.role)}: {m.body[:240]}" for m in reversed(chat)]
    money = db.scalars(select(LedgerEntry).where(LedgerEntry.quest_id == q.id)).all()
    paid_out = sum(e.cents for e in money if e.kind == "payout")
    lines.append(f"Already paid to host: {paid_out}c.")
    return "\n".join(lines)


def _offline(c: Case) -> dict:
    """Rule of thumb when the AI is off, labelled as such."""
    q = c.quest
    serious = any(w in c.reason.lower() for w in ("never", "didn't happen", "cancel", "no show", "not received"))
    if c.source == "paypal":
        decision = "accept_claim" if serious or q.status == "completed" else "need_more_info"
    elif not c.host_response:
        decision = "need_more_info"
    else:
        decision = "refund_reporter" if serious else "release"
    refund = c.disputed_cents if decision in {"refund_reporter", "accept_claim"} else 0
    return {
        "summary": f"{c.reporter.name if c.reporter else 'A member'} says: {c.reason.rstrip('.')}. "
                   f"{q.host.name} says: {(c.host_response or 'no reply yet').rstrip('.')}.",
        "facts": [f"{c.reporter.name if c.reporter else 'They'} paid {fmt(c.disputed_cents)} (ledger)."],
        "missing": ["Claude is off, so this is a simple rule of thumb, not a reading of the chat and receipts."],
        "decision": decision, "refund_cents_each": refund,
        "reasoning": "No reply from the host yet." if decision == "need_more_info" else
        "A trip that didn't happen gets a refund. Otherwise the payout goes ahead.",
        "source": "offline",
    }


def review(db: Session, c: Case) -> dict:
    if not llm.enabled():
        return _offline(c)
    out = llm.call_tool(SYSTEM, _context(db, c), TOOL, max_tokens=900)
    cap = c.disputed_cents or 0
    out["refund_cents_each"] = max(0, min(int(out.get("refund_cents_each") or 0), cap or 10**9))
    out["source"] = "claude"
    return out
