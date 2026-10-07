"""JSON shapes the frontend and the MCP server read."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import LedgerEntry, Message, Proposal, Quest, User, aware
from .engine import current_share, headcount, quest_hold, seated, standby
from .paypal.gateway import paypal_mode
from .pricing import price_cents, price_table, totals

STAGE = {"open": 1, "on": 2, "locked": 3, "completed": 4, "cancelled": 0}


def iso(dt):
    dt = aware(dt)
    return dt.isoformat() if dt else None


def user_out(u: User | None) -> dict | None:
    if not u:
        return None
    return {"id": u.id, "name": u.name, "initials": u.initials, "color": u.color, "persona": u.persona}


def quest_card(q: Quest) -> dict:
    people = seated(q)
    return {
        "id": q.id,
        "code": q.code,
        "line_code": q.line_code,
        "title": q.title,
        "area": q.area,
        "from_label": q.from_label,
        "to_label": q.to_label,
        "starts_at": iso(q.starts_at),
        "ends_at": iso(q.ends_at),
        "join_by": iso(q.join_by),
        "tz": q.tz,
        "status": q.status,
        "stage": STAGE.get(q.status, 0),
        "min_people": q.min_people,
        "max_people": q.max_people,
        "headcount": len(people),
        "standby_count": len(standby(q)),
        "hold_cents": quest_hold(q),
        "share_cents": current_share(q),
        "lowest_cents": price_cents(q.cost_lines, q.max_people, q.fee_bps),
        "currency": q.currency,
        "host": user_out(q.host),
        "faces": [user_out(m.user) for m in people][:q.max_people],
    }


def membership_out(m) -> dict:
    return {
        "id": m.id,
        "user": user_out(m.user),
        "status": m.status,
        "seat": m.seat,
        "provider": m.provider,
        "funding": m.funding,
        "hold_cents": m.hold_cents,
        "charged_cents": m.charged_cents,
        "refunded_cents": m.refunded_cents,
        "order_id": m.order_id,
        "authorization_id": m.authorization_id,
        "capture_id": m.capture_id,
        "created_at": iso(m.created_at),
    }


def quest_detail(db: Session, q: Quest, viewer: User | None) -> dict:
    out = quest_card(q)
    people = seated(q)
    by_seat = {m.seat: m for m in people if m.seat}
    seats = []
    for n in range(1, q.max_people + 1):
        m = by_seat.get(n)
        seats.append({"seat": n, "is_minimum": n == q.min_people, "member": membership_out(m) if m else None})
    shared, each = totals(q.cost_lines)

    mine = None
    role = "guest"
    if viewer:
        if viewer.id == q.host_id:
            role = "host"
        for m in reversed(q.memberships):
            if m.user_id == viewer.id and m.status not in {"abandoned"}:
                mine = membership_out(m)
                if role != "host" and m.status in {"held", "standby", "charged", "pending"}:
                    role = "member"
                break

    ledger = db.scalars(
        select(LedgerEntry).where(LedgerEntry.quest_id == q.id).order_by(LedgerEntry.created_at.desc()).limit(60)
    ).all()
    messages = db.scalars(
        select(Message).where(Message.quest_id == q.id).order_by(Message.created_at.desc()).limit(80)
    ).all()
    proposals = db.scalars(
        select(Proposal).where(Proposal.quest_id == q.id).order_by(Proposal.created_at.desc()).limit(20)
    ).all()

    held = sum(m.hold_cents for m in q.memberships if m.status in {"held", "standby"})
    charged = sum(m.charged_cents for m in q.memberships)
    refunded = sum(m.refunded_cents for m in q.memberships)
    paid_out = sum(e.cents for e in ledger if e.kind == "payout")

    out.update({
        "summary": q.summary,
        "meet_point": q.meet_point,
        "cost_lines": q.cost_lines,
        "shared_cents": shared,
        "each_cents": each,
        "fee_bps": q.fee_bps,
        "itinerary": q.itinerary,
        "price_table": price_table(q.cost_lines, q.min_people, q.max_people, q.fee_bps),
        "seats": seats,
        "standby": [membership_out(m) for m in standby(q)],
        "money": {"held_cents": held, "charged_cents": charged, "refunded_cents": refunded, "paid_out_cents": paid_out},
        "viewer": {"role": role, "membership": mine},
        "ledger": [{
            "id": e.id, "kind": e.kind, "cents": e.cents, "ref": e.paypal_ref, "provider": e.provider,
            "note": e.note, "confirmed": e.confirmed, "user": user_out(e.user), "created_at": iso(e.created_at),
        } for e in ledger],
        "messages": [{
            "id": msg.id, "role": msg.role, "body": msg.body, "user": user_out(msg.user),
            "meta": msg.meta or {}, "created_at": iso(msg.created_at),
        } for msg in reversed(messages)],
        "proposals": [{
            "id": p.id, "title": p.title, "rationale": p.rationale, "actions": p.actions,
            "status": p.status, "result": p.result, "created_at": iso(p.created_at),
        } for p in proposals],
        "timestamps": {
            "tipped_at": iso(q.tipped_at), "locked_at": iso(q.locked_at),
            "completed_at": iso(q.completed_at), "cancelled_at": iso(q.cancelled_at),
        },
        "paypal_mode": paypal_mode(),
    })
    return out


def agent_state(db: Session, q: Quest, viewer: User | None) -> dict:
    """A compact view for the model. No PayPal ids it doesn't need."""
    d = quest_detail(db, q, viewer)
    return {
        "quest": {k: d[k] for k in ("code", "title", "area", "status", "starts_at", "ends_at", "join_by", "tz",
                                    "min_people", "max_people", "headcount", "hold_cents", "share_cents",
                                    "lowest_cents", "meet_point", "summary", "cost_lines", "itinerary",
                                    "price_table")},
        "host": d["host"]["name"],
        "seats": [{"seat": s["seat"], "name": s["member"]["user"]["name"], "status": s["member"]["status"],
                   "membership_id": s["member"]["id"], "hold_cents": s["member"]["hold_cents"],
                   "charged_cents": s["member"]["charged_cents"], "refunded_cents": s["member"]["refunded_cents"],
                   "order_id": s["member"]["order_id"]}
                  for s in d["seats"] if s["member"]],
        "standby": [{"name": m["user"]["name"], "membership_id": m["id"], "hold_cents": m["hold_cents"]}
                    for m in d["standby"]],
        "money": d["money"],
        "pending_proposals": [{"title": p["title"], "status": p["status"]} for p in d["proposals"] if p["status"] == "pending"],
        "viewer": {"name": viewer.name if viewer else "guest", "role": d["viewer"]["role"],
                   "membership_id": d["viewer"]["membership"]["id"] if d["viewer"]["membership"] else None},
    }
