"""Demo data. Five live quests, each parked at a different stage of the lifecycle, two past trips
Hon hosted, so the host desk has a real history, and a few reports and a PayPal dispute so the
admin page has work on it: one waiting on a decision, one PayPal dispute, one already decided."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import cases, engine, fees
from .auth import ensure_personas
from .db import Base, engine as db_engine
import secrets

from .models import AuditLog, Case, CaseMessage, FeeSchedule, Invoice, LedgerEntry, Quest, User, utcnow
from .paypal.gateway import gateway_for

TZ = ZoneInfo("America/New_York")


def _at(d: date, hh: int, mm: int = 0) -> datetime:
    return datetime.combine(d, time(hh, mm), tzinfo=TZ)


def _next_weekday(weekday: int, min_days: int = 2) -> date:
    today = datetime.now(TZ).date()
    d = today + timedelta(days=min_days)
    while d.weekday() != weekday:
        d += timedelta(days=1)
    return d


def _join(db: Session, quest: Quest, user: User):
    """Seeded members are simulated holds, clearly marked as such in the money log."""
    m = engine.Membership(quest=quest, user=user, status="pending", provider="sim",
                          hold_cents=engine.quest_hold(quest))
    db.add(m)
    db.flush()
    auth = gateway_for("sim").card_authorization(m.hold_cents, quest.currency, m.id, "seed")
    m.order_id = auth.order_id
    engine._place(db, quest, m, auth.authorization_id, "card", auth.raw)
    return m


def _quest(db: Session, host: User, **kw) -> Quest:
    q = Quest(number=engine.next_number(db), host_id=host.id, **kw)
    if "fee_bps" not in kw:
        fees.apply_to(db, q)
    db.add(q)
    db.flush()
    db.refresh(q)
    return q


HERO = dict(
    line_code="HV",
    title="Apple picking and cider in the Hudson Valley", area="Hudson Valley",
    summary="A minivan out of Midtown, an orchard, a farm lunch and a cider flight. Back in the city by seven.",
    from_label="Grand Central", to_label="Fishkill, NY",
    meet_point="42nd St and Park Ave, by the Pershing Square corner",
    min_people=5, max_people=7,
    cost_lines=[
        {"label": "Minivan rental", "cents": 18000, "split": "shared"},
        {"label": "Gas and tolls", "cents": 6000, "split": "shared"},
        {"label": "Orchard entry", "cents": 1500, "split": "each"},
        {"label": "Cider flight", "cents": 1800, "split": "each"},
    ],
    itinerary=[
        {"time": "8:10 am", "title": "Meet at the van", "detail": "42nd St and Park Ave, by the Pershing Square corner"},
        {"time": "10:00 am", "title": "Apple picking", "detail": "Orchard entry and a half-peck bag each"},
        {"time": "1:00 pm", "title": "Lunch at the farm cafe", "detail": "Pay your own",
         "note": "Two vegetarian sandwiches and a soup on the menu."},
        {"time": "2:30 pm", "title": "Cider tasting", "detail": "Flight of five, 21 and over"},
        {"time": "5:00 pm", "title": "Drive back to the city", "detail": "Drop-offs in Midtown"},
    ],
)


def _hero(sat: date, now: datetime) -> dict:
    return dict(HERO, starts_at=_at(sat, 8, 10), ends_at=_at(sat, 19),
                join_by=max(_at(sat - timedelta(days=2), 21), now + timedelta(days=1)))


def make_tour(db: Session) -> Quest:
    """A private copy of the hero quest, four of five people in, for the guided demo."""
    p = ensure_personas(db)
    sat = _next_weekday(5, min_days=3)
    now = datetime.now(TZ)
    q = _quest(db, p["hon"], tour=True, **_hero(sat, now))
    for who in ("hon", "maya", "dev", "priya"):
        _join(db, q, p[who])
    db.flush()
    return q


def seed(db: Session) -> None:
    p = ensure_personas(db)
    seed_fee_history(db, p)
    sat = _next_weekday(5)
    sun = sat + timedelta(days=1)
    now = datetime.now(TZ)

    # 1. The hero quest. 4 of 5, one more and it's on.
    hv = _quest(db, p["hon"], **_hero(sat, now))
    for who in ("hon", "maya", "dev", "priya"):
        _join(db, hv, p[who])
    engine.say(db, hv, "Is there anything vegetarian for lunch?", role="user", user=p["priya"])
    engine.say(db, hv, "Yes, Priya. The farm cafe has two vegetarian sandwiches and a soup. I added that to the lunch stop.",
               role="agent", meta={"tools": ["get_quest_state", "add_stop_note"]})

    # 2. Tipped, with room to get cheaper.
    bk = _quest(
        db, p["maya"], line_code="BK",
        title="Brooklyn bakery crawl: the best cinnamon roll", area="Williamsburg and Greenpoint",
        summary="Five bakeries, one pastry each, and a vote at the end. Done by early afternoon.",
        from_label="Bedford Av", to_label="Greenpoint", meet_point="Bedford Av L station, north exit",
        starts_at=_at(sun, 10), ends_at=_at(sun, 14), join_by=_at(sat, 20),
        min_people=4, max_people=10,
        cost_lines=[
            {"label": "Pastry tasting, five stops", "cents": 3200, "split": "each"},
            {"label": "Ballot cards and a tote for the winner", "cents": 2400, "split": "shared"},
        ],
        itinerary=[
            {"time": "10:00 am", "title": "Meet at Bedford Av", "detail": "North exit, by the bike racks"},
            {"time": "10:15 am", "title": "Bakeries one and two", "detail": "Croissants and a morning bun"},
            {"time": "11:30 am", "title": "Coffee stop", "detail": "Pay your own"},
            {"time": "12:15 pm", "title": "Bakeries three to five", "detail": "Cinnamon rolls, then the vote"},
        ],
    )
    for who in ("maya", "priya", "theo", "sam", "jules", "noor"):
        _join(db, bk, p[who])

    # 3. Early, needs people.
    rb = _quest(
        db, p["theo"], line_code="RB",
        title="Rockaway surf lesson and beach day", area="Rockaway Beach",
        summary="Ferry out from Wall St, a two hour group lesson, then the boardwalk. Back by evening.",
        from_label="Pier 11", to_label="Rockaway", meet_point="Pier 11, by the ferry ticket machines",
        starts_at=_at(sat + timedelta(days=7), 9), ends_at=_at(sat + timedelta(days=7), 18),
        join_by=_at(sat + timedelta(days=5), 21), min_people=4, max_people=8,
        cost_lines=[
            {"label": "Surf instructor, two hours", "cents": 24000, "split": "shared"},
            {"label": "Board and wetsuit rental", "cents": 3500, "split": "each"},
            {"label": "Ferry, round trip", "cents": 900, "split": "each"},
        ],
        itinerary=[
            {"time": "9:00 am", "title": "Ferry from Pier 11", "detail": "About an hour"},
            {"time": "10:30 am", "title": "Group surf lesson", "detail": "Boards and wetsuits included"},
            {"time": "1:00 pm", "title": "Tacos on the boardwalk", "detail": "Pay your own"},
            {"time": "4:30 pm", "title": "Ferry back", "detail": "From Beach 108 St"},
        ],
    )
    for who in ("theo", "ana"):
        _join(db, rb, p[who])

    # 4. Locked, with someone on standby. Good for the swap demo.
    hh = _quest(
        db, p["ana"], line_code="HH",
        title="Breakneck Ridge hike and lunch in Beacon", area="Hudson Highlands",
        summary="Train up the Hudson, a steep scramble with river views, then lunch in Beacon. Home by dinner.",
        from_label="Grand Central", to_label="Breakneck Ridge", meet_point="Grand Central, main concourse clock",
        starts_at=_at(sun, 7, 45), ends_at=_at(sun, 18, 30), join_by=now + timedelta(days=1),
        min_people=3, max_people=4,
        cost_lines=[
            {"label": "Metro-North round trip", "cents": 3200, "split": "each"},
            {"label": "Group first aid kit and trail snacks", "cents": 4000, "split": "shared"},
        ],
        itinerary=[
            {"time": "7:45 am", "title": "Meet at the clock", "detail": "Hudson line, off-peak tickets"},
            {"time": "9:30 am", "title": "Breakneck Ridge", "detail": "About four hours, bring two liters of water"},
            {"time": "2:00 pm", "title": "Lunch in Beacon", "detail": "Pay your own"},
            {"time": "5:00 pm", "title": "Train home", "detail": "From Beacon station"},
        ],
    )
    for who in ("ana", "dev", "sam", "maya", "leo"):
        _join(db, hh, p[who])
    db.refresh(hh)
    engine.lock(db, hh, reason="Ana locked the quest early.")
    hh.join_by = now - timedelta(hours=2)

    # 5. Completed last weekend, host paid out.
    last_sat = sat - timedelta(days=7)
    ri = _quest(
        db, p["priya"], line_code="RI",
        title="Newport cliff walk day trip", area="Newport, Rhode Island",
        summary="A rental car to Newport, the full Cliff Walk, lobster rolls by the harbor. Home by ten.",
        from_label="Midtown", to_label="Newport, RI", meet_point="Avis on W 43rd St",
        starts_at=now + timedelta(days=1), ends_at=None, join_by=now + timedelta(hours=12),
        min_people=4, max_people=5,
        cost_lines=[
            {"label": "Car rental", "cents": 16000, "split": "shared"},
            {"label": "Gas and tolls", "cents": 9000, "split": "shared"},
        ],
        itinerary=[
            {"time": "7:00 am", "title": "Pick up the car", "detail": "Avis on W 43rd St"},
            {"time": "11:00 am", "title": "Cliff Walk", "detail": "3.5 miles, rocky at the south end"},
            {"time": "3:00 pm", "title": "Lobster rolls on Bowen's Wharf", "detail": "Pay your own"},
            {"time": "6:00 pm", "title": "Drive home", "detail": "Drop-offs in Midtown"},
        ],
    )
    for who in ("priya", "hon", "jules", "noor", "theo"):
        _join(db, ri, p[who])
    db.refresh(ri)
    engine.lock(db, ri, reason="Priya locked the quest.")
    engine.complete(db, ri)
    ri.starts_at = _at(last_sat, 7)
    ri.ends_at = _at(last_sat, 22)
    ri.join_by = _at(last_sat - timedelta(days=2), 21)
    db.flush()

    seed_history(db, p)
    seed_cases(db, p)


def _past_trip(db: Session, host: User, members: list[User], *, days_ago: int, overage_each: int,
               paid: set[str], reminded: dict[str, int] | None = None, **kw) -> Quest:
    """A finished quest with a settle up already sent. Invoices are simulated and labelled as such."""
    now = datetime.now(TZ)
    # A trip posted before launch pricing kept the beta terms: no fees.
    if days_ago + 9 > LAUNCH_DAYS_AGO:
        kw = {**kw, "fee_bps": 0, "fee_fixed_cents": 0, "host_fee_bps": 0}
    q = _quest(db, host, starts_at=now + timedelta(days=1), ends_at=None, join_by=now + timedelta(hours=12), **kw)
    for m in members:
        _join(db, q, m)
    db.refresh(q)
    engine.lock(db, q, reason=f"{host.name} locked the quest.")
    engine.complete(db, q)
    day = now.date() - timedelta(days=days_ago)
    q.starts_at, q.ends_at = _at(day, 7), _at(day, 20)
    q.join_by = _at(day - timedelta(days=2), 21)
    q.created_at = q.starts_at - timedelta(days=9)
    db.flush()

    reminded = reminded or {}
    for m in [m for m in q.memberships if m.status == "charged" and m.user_id != host.id]:
        ref = "SIM-INV2-" + secrets.token_hex(6).upper()
        engine.log(db, q, "invoice", overage_each, membership=m, ref=ref, provider="sim",
                   note=f"Invoice sent to {m.user.name}: {q.code} shared cost overage")
        inv = Invoice(quest=q, user=m.user, membership_id=m.id, paypal_id=ref, cents=overage_each,
                      item=f"{q.code} shared cost overage", provider="sim",
                      reminders=reminded.get(m.user.persona or "", 0))
        db.add(inv)
        db.flush()
        if m.user.persona in paid:
            engine.mark_invoice(db, inv, "paid")
            inv.paid_at = q.ends_at + timedelta(days=2)

    # Put every money event at a believable time around the trip.
    when = {"hold": -8, "reauthorize": -2, "charge": -1, "release": -1, "refund": 1, "payout": 1,
            "invoice": 1, "invoice_paid": 3}
    for i, e in enumerate(db.scalars(select(LedgerEntry).where(LedgerEntry.quest_id == q.id))):
        e.created_at = q.starts_at + timedelta(days=when.get(e.kind, 0), minutes=7 * i)
    for inv in db.scalars(select(Invoice).where(Invoice.quest_id == q.id)):
        inv.created_at = q.ends_at + timedelta(days=1)
        if inv.reminders:
            inv.last_reminded_at = q.ends_at + timedelta(days=4)
    db.flush()
    return q


def seed_history(db: Session, p: dict[str, User]) -> None:
    _past_trip(
        db, p["hon"], [p[w] for w in ("hon", "maya", "dev", "leo", "sam", "noor")],
        days_ago=19, overage_each=1100, paid={"maya", "dev", "noor"},
        line_code="MT", title="Montauk sunrise surf lesson", area="Montauk, New York",
        summary="A van to Ditch Plains, a two-hour surf lesson at sunrise, lobster rolls after.",
        from_label="Penn Station", to_label="Montauk, NY", meet_point="Penn Station, 7th Ave entrance",
        min_people=5, max_people=6,
        cost_lines=[
            {"label": "Van rental", "cents": 24000, "split": "shared"},
            {"label": "Gas and tolls", "cents": 6000, "split": "shared"},
            {"label": "Surf lesson", "cents": 6500, "split": "each"},
        ],
        itinerary=[
            {"time": "4:30 am", "title": "Van leaves Penn Station", "detail": "Coffee on board"},
            {"time": "7:00 am", "title": "Surf lesson", "detail": "Boards and wetsuits included"},
            {"time": "11:00 am", "title": "Lobster rolls", "detail": "Pay your own"},
        ],
    )
    _past_trip(
        db, p["hon"], [p[w] for w in ("hon", "priya", "jules", "theo", "ana")],
        days_ago=40, overage_each=800, paid={"priya", "jules", "ana"}, reminded={"theo": 2},
        line_code="CK", title="Catskills fire tower hike", area="Catskills, New York",
        summary="A rental car to the Overlook Mountain trailhead, the fire tower, and pie in Woodstock.",
        from_label="Midtown", to_label="Woodstock, NY", meet_point="Hertz on W 40th St",
        min_people=4, max_people=5,
        cost_lines=[
            {"label": "Car rental", "cents": 14000, "split": "shared"},
            {"label": "Parking and gas", "cents": 4000, "split": "shared"},
        ],
        itinerary=[
            {"time": "7:00 am", "title": "Pick up the car", "detail": "Hertz on W 40th St"},
            {"time": "10:00 am", "title": "Overlook Mountain", "detail": "5 miles round trip"},
            {"time": "3:00 pm", "title": "Pie in Woodstock", "detail": "Pay your own"},
        ],
    )


LAUNCH_DAYS_AGO = 30


def seed_fee_history(db: Session, p: dict[str, User]) -> None:
    """Free during the beta, then launch pricing. The newest row is what new quests get."""
    now = utcnow()
    db.add(FeeSchedule(booking_bps=0, booking_fixed_cents=0, host_bps=0,
                       reason="Beta: free while we test with friends", created_at=now - timedelta(days=75)))
    db.flush()
    launch = FeeSchedule(booking_bps=fees.settings.booking_fee_bps,
                         booking_fixed_cents=fees.settings.booking_fee_fixed_cents,
                         host_bps=fees.settings.host_fee_bps, created_by=p["kai"].id,
                         reason="Launch pricing: covers PayPal's fees with a margin. Hosts pay nothing.",
                         created_at=now - timedelta(days=LAUNCH_DAYS_AGO))
    db.add(launch)
    db.flush()
    db.add(AuditLog(actor_id=p["kai"].id, action="fee_change", target=launch.id, created_at=launch.created_at,
                    summary=f"Fees changed to {fees.describe(launch)}. Was free during the beta. {launch.reason}"))
    db.flush()


def _backdate(db: Session, target: str, when: datetime) -> None:
    for a in db.scalars(select(AuditLog).where(AuditLog.target == target)):
        a.created_at = when


def seed_cases(db: Session, p: dict[str, User]) -> None:
    now = datetime.now(TZ)

    # 1. Waiting on a decision. The trip ended this afternoon, so the payout is due tomorrow.
    kb = _quest(
        db, p["theo"], line_code="JB",
        title="Jamaica Bay guided kayak and sunset", area="Jamaica Bay, Queens",
        summary="A two hour guided paddle through the marsh islands, then sunset from the dock.",
        from_label="Broad Channel", to_label="Jamaica Bay", meet_point="Broad Channel A station",
        starts_at=now + timedelta(days=1), ends_at=None, join_by=now + timedelta(hours=12),
        min_people=4, max_people=6,
        cost_lines=[
            {"label": "Kayak outfitter, guided 2 hours", "cents": 30000, "split": "shared"},
            {"label": "Dry bag and snacks", "cents": 1200, "split": "each"},
        ],
        itinerary=[
            {"time": "10:00 am", "title": "Meet at Broad Channel", "detail": "A train to Broad Channel"},
            {"time": "10:30 am", "title": "Guided paddle", "detail": "Two hours through the marsh islands"},
            {"time": "1:00 pm", "title": "Lunch on the dock", "detail": "Pay your own"},
        ],
    )
    for who in ("theo", "jules", "noor", "sam", "ana"):
        _join(db, kb, p[who])
    db.refresh(kb)
    engine.lock(db, kb, reason="Theo locked the quest.")
    trip = now - timedelta(hours=8)
    kb.starts_at, kb.ends_at = trip - timedelta(hours=2), trip + timedelta(hours=3)
    kb.join_by = trip - timedelta(days=2)
    engine.say(db, kb, "Wind picked up around 11 and the guide called it early.", role="user", user=p["sam"])
    engine.say(db, kb, "We were back on the dock by 11:30, so about an hour on the water.", role="user", user=p["noor"])
    db.flush()
    c = cases.report(db, kb, p["jules"], "We only got one hour on the water. The listing said two.")
    cases.respond(db, c, p["theo"], "The outfitter cut it short for a wind advisory. They refunded me $100 "
                                    "for the missed hour, which I'm happy to pass on to the group.")
    c.created_at = now - timedelta(hours=3)
    c.host_responded_at = now - timedelta(hours=2)
    for msg in db.scalars(select(CaseMessage).where(CaseMessage.case_id == c.id)):
        msg.created_at = c.host_responded_at
    _backdate(db, c.id, now - timedelta(hours=2))

    # 2. A PayPal dispute on a trip whose host was already paid. Sidequest is on the hook if it's accepted.
    ri = db.scalar(select(Quest).where(Quest.line_code == "RI", Quest.tour.isnot(True)))
    noor = next((m for m in ri.memberships if m.user_id == p["noor"].id and m.capture_id), None) if ri else None
    if noor:
        d = cases.from_paypal_dispute(db, {
            "dispute_id": "PP-D-" + secrets.token_hex(4).upper(),
            "reason": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
            "status": "WAITING_FOR_SELLER_RESPONSE",
            "dispute_amount": {"currency_code": "USD", "value": f"{noor.charged_cents / 100:.2f}"},
            "disputed_transactions": [{"seller_transaction_id": noor.capture_id}],
            "messages": [{"posted_by": "BUYER", "content": "We skipped the lobster stop and got home at 1 am."}],
        }, provider="sim")
        if d:
            d.created_at = now - timedelta(days=1, hours=4)
            _backdate(db, d.id, d.created_at)

    # 3. Decided weeks ago: a late rental car, but the trip ran in full.
    ck = db.scalar(select(Quest).where(Quest.line_code == "CK", Quest.tour.isnot(True)))
    theo = next((m for m in ck.memberships if m.user_id == p["theo"].id), None) if ck else None
    if theo:
        when = aware_dt(ck.ends_at) + timedelta(hours=3)
        old = Case(quest_id=ck.id, membership_id=theo.id, opened_by=p["theo"].id, source="member", provider="sim",
                   reason="The car was 40 minutes late, so we missed sunrise at the tower.",
                   disputed_cents=theo.charged_cents, status="resolved", decision="release",
                   host_response="Hertz had the car late. I called ahead and we still did the full hike.",
                   host_responded_at=when + timedelta(hours=2),
                   resolution_note="Late pickup, but the trip ran in full and nobody missed a paid stop. Payout released.",
                   resolved_by=p["kai"].id, resolved_at=when + timedelta(hours=6), created_at=when)
        db.add(old)
        db.flush()
        db.add(AuditLog(actor_id=p["theo"].id, action="case_opened", target=old.id, created_at=when,
                        summary=f"Theo reported a problem on {ck.code}: {old.reason}"))
        db.add(AuditLog(actor_id=p["kai"].id, action="case_resolved", target=old.id, created_at=old.resolved_at,
                        summary=f"Kai resolved a report on {ck.code}: released the payout. {old.resolution_note}",
                        detail={"decision": "release"}))
    db.flush()


def aware_dt(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=TZ)


def seed_if_empty(db: Session) -> bool:
    if db.scalar(select(Quest.id).limit(1)):
        p = ensure_personas(db)
        changed = False
        # Databases seeded before the host desk existed get its history once.
        if not db.scalar(select(Quest.id).where(Quest.line_code == "MT", Quest.tour.isnot(True)).limit(1)):
            seed_history(db, p)
            changed = True
        # And before the admin page existed: fee history and a few cases to review.
        if not db.scalar(select(FeeSchedule.id).limit(1)):
            seed_fee_history(db, p)
            seed_cases(db, p)
            changed = True
        return changed
    seed(db)
    return True


def reset(db: Session) -> None:
    db.close()
    Base.metadata.drop_all(db_engine)
    Base.metadata.create_all(db_engine)
