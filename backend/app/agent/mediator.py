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
            "decision": {"type": "string",
                         "enum": ["release", "refund_reporter", "split_refund", "accept_claim", "need_more_info"]},
            "refund_cents": {"type": "integer",
                             "description": "refund_reporter: cents back to the reporter. split_refund: the TOTAL in "
                                            "cents to split equally across everyone who went. 0 otherwise."},
            "reasoning": {"type": "string", "description": "Why, in two plain sentences."},
            "summary": {"type": "string", "description": "Two short sentences: what each side says."},
            "facts": {"type": "array", "items": {"type": "string"}, "maxItems": 4,
                      "description": "Up to four short facts the records support, each naming its source (chat, receipt, ledger)."},
            "missing": {"type": "array", "items": {"type": "string"}, "maxItems": 3,
                        "description": "Up to three things the admin can't tell from the records."},
        },
        "required": ["decision", "refund_cents", "reasoning", "summary", "facts", "missing"],
    },
}

SYSTEM = """You help a Sidequest admin decide a report on a small group trip. Sidequest held everyone's money
and pays the host after the trip. A member who paid reported a problem, or opened a PayPal dispute.
Be fair to both sides. Use only what the records show. Never invent facts. Keep every field short.

Pick the smallest remedy that fixes the harm:
- release: the trip ran as promised, or the problem was minor and nobody lost money.
- split_refund: the problem hit everyone who went, or the host got money back for a cost everyone shared (a credit,
  a partial refund from a vendor). Give the TOTAL to split. Each person, the host included, gets an equal share; the
  host's share simply stays in their payout.
- refund_reporter: only the reporter was harmed. Give the amount for them.
- accept_claim: a PayPal dispute where the buyer is clearly right.
- need_more_info: the host hasn't replied and the report is serious.
Amounts are in cents. Never suggest more than was paid."""


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
    import re

    q = c.quest
    serious = any(w in c.reason.lower() for w in ("never", "didn't happen", "cancel", "no show", "not received"))
    reply = c.host_response or ""
    credit = re.search(r"\$(\d+(?:\.\d{2})?)", reply) if re.search(r"refund|credit|back|pass", reply, re.I) else None
    refund = 0
    if c.source == "paypal":
        decision = "accept_claim" if serious or q.status == "completed" else "need_more_info"
        refund = c.disputed_cents if decision == "accept_claim" else 0
    elif not reply:
        decision = "need_more_info"
    elif credit:
        decision, refund = "split_refund", int(round(float(credit.group(1)) * 100))
    elif serious:
        decision, refund = "refund_reporter", c.disputed_cents
    else:
        decision = "release"
    return {
        "summary": f"{c.reporter.name if c.reporter else 'A member'} says: {c.reason.rstrip('.')}. "
                   f"{q.host.name} says: {(c.host_response or 'no reply yet').rstrip('.')}.",
        "facts": [f"{c.reporter.name if c.reporter else 'They'} paid {fmt(c.disputed_cents)} (ledger)."],
        "missing": ["Claude is off, so this is a simple rule of thumb, not a reading of the chat and receipts."],
        "decision": decision, "refund_cents": refund,
        "reasoning": {
            "need_more_info": "No reply from the host yet.",
            "split_refund": f"The host says they got {fmt(refund)} back for a shared cost, so everyone who went gets an equal share.",
            "refund_reporter": "The reporter says the trip didn't happen for them.",
            "accept_claim": "The buyer's claim is serious and the host has already been paid.",
        }.get(decision, "The trip ran. The payout goes ahead."),
        "source": "offline",
    }


DECISIONS = {"release", "refund_reporter", "split_refund", "accept_claim", "need_more_info"}


def _lines(value) -> list[str]:
    """Models sometimes send a list as a JSON string or as plain text. Always hand back a list of strings."""
    import json

    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()][:8]
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return _lines(parsed)
        except ValueError:
            pass
        return [p.strip(" -*\u2022") for p in value.splitlines() if p.strip(" -*\u2022")][:8]
    return []


def clean(raw: dict | None, cap: int, people: int = 0) -> dict | None:
    """The shape the admin page expects, whatever the model returned. cap limits what one person gets back."""
    if not isinstance(raw, dict):
        return None
    decision = raw.get("decision")
    try:
        cents = int(float(raw.get("refund_cents", raw.get("refund_cents_each")) or 0))
    except (TypeError, ValueError):
        cents = 0
    if decision == "refund_everyone":  # older shape: an amount per person
        decision, cents = "split_refund", cents * max(people, 1)
    if decision not in DECISIONS:
        decision = "need_more_info"
    limit = (cap or 10**9) * max(people, 1) if decision == "split_refund" else (cap or 10**9)
    return {
        "summary": str(raw.get("summary") or "").strip(),
        "facts": _lines(raw.get("facts")),
        "missing": _lines(raw.get("missing")),
        "decision": decision,
        "refund_cents": max(0, min(cents, limit)),
        "reasoning": str(raw.get("reasoning") or "").strip(),
        "source": raw.get("source") if raw.get("source") in {"claude", "offline"} else "claude",
    }


def review(db: Session, c: Case) -> dict:
    if not llm.enabled():
        return _offline(c)
    out = llm.call_tool(SYSTEM, _context(db, c), TOOL, max_tokens=2000)
    return clean({**out, "source": "claude"}, c.disputed_cents or 0, payers(c))


def payers(c: Case) -> int:
    return sum(1 for m in c.quest.memberships if m.charged_cents - m.refunded_cents > 0)
