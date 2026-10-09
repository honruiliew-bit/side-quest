"""Payment audit. Check Sidequest's books against what PayPal has on record, in both directions.

Reconcile    for each ledger entry, fetch the PayPal object (authorization, capture, refund, payout batch,
             invoice) and compare the amount and status. Captures, refunds and payouts also give the
             real PayPal fee, which replaces our estimate.
Statement    PayPal's Transaction Search for the platform account. Anything there that isn't in the
             ledger is money Sidequest didn't record.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import LedgerEntry, Quest, User, utcnow
from .paypal.gateway import PayPalError, gateway_for, money_cents, paypal_mode

CHECKABLE = {"hold", "reauthorize", "release", "charge", "refund", "payout", "invoice", "invoice_paid"}

EVENT_GROUPS = {
    "T00": "Payment", "T01": "Fee", "T02": "Currency conversion", "T03": "Bank deposit", "T04": "Bank withdrawal",
    "T05": "Debit card", "T06": "Credit card withdrawal", "T07": "Credit card deposit", "T08": "Bonus",
    "T09": "Incentive", "T11": "Refund or reversal", "T12": "Adjustment", "T13": "Authorization",
    "T14": "Dividend", "T15": "Hold or release", "T16": "Buyer credit", "T17": "Non-bank withdrawal",
    "T18": "Buyer credit withdrawal", "T19": "Account correction", "T20": "Dispute", "T21": "Reversal",
    "T22": "Transfer", "T30": "Generic instrument", "T50": "Collections", "T97": "Payout", "T98": "Other",
    "T99": "Other",
}


def _expected(entry: LedgerEntry, body: dict) -> tuple[str, str, int | None]:
    """Compare one ledger entry with PayPal's object. Returns (status, note, real fee or None)."""
    k = entry.kind
    if k == "payout":
        header = body.get("batch_header") or {}
        amount = money_cents({"value": (header.get("amount") or {}).get("value")})
        fee = money_cents({"value": (header.get("fees") or {}).get("value")})
        state = header.get("batch_status", "")
        ok = amount == entry.cents and state not in {"DENIED", "CANCELED"}
        return ("matched" if ok else "mismatch", f"PayPal: {state}, {amount or 0}c", fee)
    if k in {"invoice", "invoice_paid"}:
        amount = money_cents(body.get("amount"))
        state = body.get("status", "")
        ok = amount == entry.cents and (k == "invoice" or state in {"PAID", "MARKED_AS_PAID"})
        return ("matched" if ok else "mismatch", f"PayPal: invoice {state}, {amount or 0}c", None)
    amount = money_cents(body.get("amount"))
    state = body.get("status", "")
    fee = None
    if k == "charge":
        fee = money_cents((body.get("seller_receivable_breakdown") or {}).get("paypal_fee"))
    elif k == "refund":
        back = money_cents((body.get("seller_payable_breakdown") or {}).get("paypal_fee"))
        fee = -back if back is not None else None
    if k == "release":
        ok = state == "VOIDED"
    else:
        ok = amount == entry.cents and state not in {"DENIED", "FAILED", "DECLINED"}
    return ("matched" if ok else "mismatch", f"PayPal: {state}, {amount or 0}c", fee)


def reconcile(db: Session, admin: User, limit: int = 60) -> dict:
    from .cases import audit

    entries = list(db.scalars(select(LedgerEntry).where(LedgerEntry.kind.in_(CHECKABLE))
                              .order_by(LedgerEntry.created_at.desc()).limit(limit * 4)))
    simulated = [e for e in entries if e.provider == "sim" or paypal_mode() == "mock" or not e.paypal_ref]
    live = [e for e in entries if e not in simulated][:limit]
    now = utcnow()
    for e in simulated:
        e.recon_status, e.recon_note, e.recon_at = "simulated", "Simulated payment. It never reached PayPal.", now

    gw = gateway_for("paypal")

    def check(e: LedgerEntry):
        try:
            return e, gw.lookup(e.kind, e.paypal_ref), None
        except PayPalError as exc:
            return e, None, exc

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(check, live)) if live else []
    counts = {"matched": 0, "mismatch": 0, "missing": 0, "error": 0, "simulated": len(simulated)}
    fees_updated = 0
    for e, body, err in results:
        e.recon_at = now
        if err is not None:
            e.recon_status = "missing" if err.status == 404 else "error"
            e.recon_note = "PayPal has no record of this id." if err.status == 404 else str(err)[:300]
        else:
            e.recon_status, e.recon_note, fee = _expected(e, body)
            if fee is not None and (e.fee_source != "paypal" or e.fee_cents != fee):
                e.fee_cents, e.fee_source = fee, "paypal"
                fees_updated += 1
        counts[e.recon_status] += 1
    audit(db, admin, "reconcile", None,
          f"{admin.name} checked {len(live)} payments with PayPal: {counts['matched']} matched, "
          f"{counts['mismatch']} mismatched, {counts['missing']} missing, {counts['error']} errors. "
          f"{len(simulated)} simulated payments skipped.", {**counts, "fees_updated": fees_updated})
    db.flush()
    return {**counts, "checked": len(live), "fees_updated": fees_updated, "mode": paypal_mode()}


def statement(db: Session, days: int = 14) -> dict:
    """PayPal's view of the platform account, matched against the ledger."""
    days = max(1, min(days, 31))
    end = utcnow()
    start = end - timedelta(days=days)
    try:
        rows = gateway_for("paypal").search_transactions(start, end)
    except PayPalError as exc:
        hint = ""
        if exc.status in {401, 403}:
            hint = " Turn on Transaction Search for this app in the PayPal Developer Dashboard."
        return {"ok": False, "error": f"{exc}.{hint}".replace("..", "."), "rows": [], "days": days, "mode": paypal_mode()}
    refs = {r for r in db.scalars(select(LedgerEntry.paypal_ref).where(LedgerEntry.paypal_ref.isnot(None)))}
    out = []
    for t in rows:
        info = t.get("transaction_info") or {}
        tid = info.get("transaction_id")
        code = info.get("transaction_event_code") or ""
        related = info.get("paypal_reference_id")
        out.append({
            "id": tid, "event_code": code, "event": EVENT_GROUPS.get(code[:3], "Other"),
            "status": info.get("transaction_status"),
            "cents": money_cents(info.get("transaction_amount")),
            "fee_cents": money_cents(info.get("fee_amount")),
            "at": info.get("transaction_initiation_date"),
            "invoice_id": info.get("invoice_id"),
            "payer": ((t.get("payer_info") or {}).get("email_address")),
            "in_books": tid in refs or (related in refs if related else False),
        })
    out.sort(key=lambda r: r["at"] or "", reverse=True)
    return {"ok": True, "rows": out, "days": days, "mode": paypal_mode(),
            "unmatched": sum(1 for r in out if not r["in_books"])}


def overview(db: Session) -> dict:
    from .fees import quest_money
    from .models import Case

    quests = list(db.scalars(select(Quest).where(Quest.tour.isnot(True))))
    by_quest = {q.id: [] for q in quests}
    for e in db.scalars(select(LedgerEntry).where(LedgerEntry.quest_id.in_(list(by_quest)))):
        by_quest[e.quest_id].append(e)
    totals: dict[str, int] = {}
    rows = []
    estimated = False
    held_now = 0
    for q in quests:
        money = quest_money(q, by_quest[q.id])
        estimated = estimated or money.fees_estimated
        held_now += sum(m.hold_cents for m in q.memberships if m.status in {"held", "standby"})
        for k, v in money.out().items():
            if isinstance(v, int) and not isinstance(v, bool):
                totals[k] = totals.get(k, 0) + v
        rows.append({"id": q.id, "code": q.code, "title": q.title, "status": q.status, "host": q.host.name,
                     "line_code": q.line_code, "starts_at": q.starts_at.isoformat() if q.starts_at else None,
                     "fee_bps": q.fee_bps, "fee_fixed_cents": q.fee_fixed_cents or 0, "host_fee_bps": q.host_fee_bps or 0,
                     **money.out()})
    gross = totals.get("gross_cents", 0)
    open_cases = len(db.scalars(select(Case.id).where(Case.status == "open")).all())
    recon_issues = len(db.scalars(select(LedgerEntry.id).where(LedgerEntry.recon_status.in_(["mismatch", "missing"]))).all())
    return {
        "totals": {**totals, "authorized_cents": held_now,
                   "take_rate_bps": round(totals.get("net_revenue_cents", 0) * 10_000 / gross) if gross else 0},
        "fees_estimated": estimated,
        "quests": sorted(rows, key=lambda r: r["starts_at"] or "", reverse=True),
        "open_cases": open_cases,
        "recon_issues": recon_issues,
        "paypal_mode": paypal_mode(),
    }
