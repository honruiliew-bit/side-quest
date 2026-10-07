"""Demo data. Five quests, each parked at a different stage of the lifecycle."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import engine
from .auth import ensure_personas
from .db import Base, engine as db_engine
from .models import Quest, User
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
    db.add(q)
    db.flush()
    db.refresh(q)
    return q


def seed(db: Session) -> None:
    p = ensure_personas(db)
    sat = _next_weekday(5)
    sun = sat + timedelta(days=1)
    now = datetime.now(TZ)

    # 1. The hero quest. 4 of 5, one more and it's on.
    hv = _quest(
        db, p["hon"], line_code="HV",
        title="Apple picking and cider in the Hudson Valley", area="Hudson Valley",
        summary="A minivan out of Midtown, an orchard, a farm lunch and a cider flight. Back in the city by seven.",
        from_label="Grand Central", to_label="Fishkill, NY",
        meet_point="42nd St and Park Ave, by the Pershing Square corner",
        starts_at=_at(sat, 8, 10), ends_at=_at(sat, 19), join_by=max(_at(sat - timedelta(days=2), 21), now + timedelta(days=1)),
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


def seed_if_empty(db: Session) -> bool:
    if db.scalar(select(Quest.id).limit(1)):
        ensure_personas(db)
        return False
    seed(db)
    return True


def reset(db: Session) -> None:
    db.close()
    Base.metadata.drop_all(db_engine)
    Base.metadata.create_all(db_engine)
