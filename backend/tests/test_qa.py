"""Regression tests for the QA pass: races, closed quests, resets, limits, migrations."""

import os
import sqlite3
import sys
import threading
from pathlib import Path

DB = Path(__file__).parent / "test_qa.db"
if DB.exists():
    DB.unlink()
# An "old" database without the newest column, to prove startup upgrades it in place.
con = sqlite3.connect(DB)
con.execute("CREATE TABLE quests (id VARCHAR(40) PRIMARY KEY, number INTEGER, title VARCHAR(160), summary TEXT, "
            "area VARCHAR(80), line_code VARCHAR(4), from_label VARCHAR(80), to_label VARCHAR(80), meet_point VARCHAR(200), "
            "starts_at DATETIME, ends_at DATETIME, join_by DATETIME, tz VARCHAR(40), min_people INTEGER, max_people INTEGER, "
            "currency VARCHAR(3), fee_bps INTEGER, cost_lines JSON, itinerary JSON, status VARCHAR(16), host_id VARCHAR(40), "
            "tipped_at DATETIME, locked_at DATETIME, completed_at DATETIME, cancelled_at DATETIME, created_at DATETIME)")
con.commit()
con.close()

os.environ.update({
    "DATABASE_URL": f"sqlite:///{DB}",
    "PAYPAL_MODE": "mock",
    "ANTHROPIC_API_KEY": "",
    "DEMO_MODE": "1",
    "SEED_ON_START": "1",
    "SCHEDULER_SECONDS": "3600",
    "CHAT_PER_MINUTE": "3",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def login(client, persona):
    return {"Authorization": f"Bearer {client.post('/auth/demo', json={'persona': persona}).json()['token']}"}


def test_old_database_gets_new_column(client):
    cols = [r[1] for r in sqlite3.connect(DB).execute("PRAGMA table_info(quests)")]
    assert "tour" in cols


def test_tour_creates_private_copy(client):
    a = client.post("/demo/tour").json()["id"]
    b = client.post("/demo/tour").json()["id"]
    assert a != b
    q = client.get(f"/quests/{a}").json()
    assert q["tour"] is True and q["headcount"] == 4 and q["status"] == "open"


def test_two_people_racing_for_the_last_seat(client):
    qid = client.post("/demo/tour").json()["id"]
    hon = login(client, "hon")
    client.post(f"/demo/quests/{qid}/crowd", json={"count": 2}, headers=hon)  # 6 of 7 seats
    racers = []
    for persona in ("sam", "jules"):
        h = login(client, persona)
        racers.append((h, client.post(f"/quests/{qid}/holds", headers=h).json()))
    results = []

    def confirm(h, hold):
        results.append(client.post(f"/holds/{hold['membership_id']}/confirm", json={"order_id": hold["order_id"]}, headers=h))

    threads = [threading.Thread(target=confirm, args=r) for r in racers]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert all(r.status_code == 200 for r in results)
    q = client.get(f"/quests/{qid}").json()
    seats = [s["member"]["seat"] for s in q["seats"] if s["member"]]
    assert len(seats) == 7 and len(set(seats)) == 7
    assert len(q["standby"]) == 1


def test_hold_is_not_placed_on_a_closed_quest(client):
    qid = client.post("/demo/tour").json()["id"]
    leo = login(client, "leo")
    hold = client.post(f"/quests/{qid}/holds", headers=leo).json()
    hon = login(client, "hon")
    client.post(f"/demo/quests/{qid}/deadline", headers=hon)  # 4 of 5: the quest is cancelled
    r = client.post(f"/holds/{hold['membership_id']}/confirm", json={"order_id": hold["order_id"]}, headers=leo)
    assert r.status_code == 409
    q = client.get(f"/quests/{qid}").json()
    assert q["status"] == "cancelled"
    assert not any(e["kind"] == "hold" and e["user"]["name"] == "Leo" for e in q["ledger"])


def test_session_survives_demo_reset(client):
    leo = login(client, "leo")
    assert client.get("/me", headers=leo).status_code == 200
    client.post("/demo/reset")
    assert client.get("/me", headers=leo).status_code == 200


def test_deadline_must_fit_in_paypal_hold_window(client):
    hon = login(client, "hon")
    draft = client.post("/quests/draft", json={"prompt": "bakery crawl"}, headers=hon).json()
    draft["date"] = "2027-03-01"
    r = client.post("/quests", json=draft, headers=hon)
    assert r.status_code == 422 and "29 days" in r.json()["detail"]


def test_chat_is_rate_limited(client):
    qid = client.post("/demo/tour").json()["id"]
    maya = login(client, "maya")
    codes = [client.post(f"/quests/{qid}/chat", json={"text": "who's going?"}, headers=maya).status_code for _ in range(4)]
    assert codes[:3] == [200, 200, 200] and codes[3] == 429


def test_agent_nudges_once_when_short_near_deadline(client):
    from datetime import timedelta

    from app.db import session_scope
    from app.engine import tick
    from app.models import Quest, utcnow

    qid = client.post("/demo/tour").json()["id"]
    with session_scope() as db:
        db.get(Quest, qid).join_by = utcnow() + timedelta(hours=5)
    with session_scope() as db:
        tick(db)
        tick(db)
    q = client.get(f"/quests/{qid}").json()
    nudges = [m for m in q["messages"] if m["role"] == "agent" and m["body"].startswith("Heads up")]
    assert len(nudges) == 1 and "1 more person" in nudges[0]["body"]


def _locked_tour(client):
    qid = client.post("/demo/tour").json()["id"]
    hon = login(client, "hon")
    client.post(f"/demo/quests/{qid}/crowd", json={"count": 1}, headers=hon)
    assert client.post(f"/quests/{qid}/lock", headers=hon).json()["status"] == "locked"
    return qid, hon


def test_payout_releases_itself_after_the_trip_unless_paused(client):
    from datetime import timedelta

    from app.db import session_scope
    from app.engine import tick
    from app.models import Quest, utcnow

    qid, hon = _locked_tour(client)
    # A member who paid reports a problem. That pauses the payout.
    maya = login(client, "maya")
    d = client.post(f"/quests/{qid}/problem", json={"reason": "The van never showed up"}, headers=maya).json()
    assert d["payout"]["paused_reason"].startswith("Maya")
    # Someone who didn't pay can't pause it.
    assert client.post(f"/quests/{qid}/problem", json={"reason": "spite"}, headers=login(client, "noor")).status_code == 403
    with session_scope() as db:
        q = db.get(Quest, qid)
        q.starts_at = utcnow() - timedelta(days=3)
        q.ends_at = utcnow() - timedelta(days=2)
    with session_scope() as db:
        tick(db)
    assert client.get(f"/quests/{qid}").json()["status"] == "locked"  # paused, not paid
    client.post(f"/quests/{qid}/problem/resolve", json={"note": "Refunded the van"}, headers=hon)
    with session_scope() as db:
        tick(db)
    d = client.get(f"/quests/{qid}").json()
    assert d["status"] == "completed"
    assert any(e["kind"] == "payout" for e in d["ledger"])


def test_receipts_drive_the_settle_up(client):
    import base64
    import io

    qid, hon = _locked_tour(client)
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"fake receipt one").decode()
    # The AI is off in this suite, so the host gives the total and the receipt is labelled unverified.
    r = client.post(f"/quests/{qid}/receipts", headers=hon,
                    json={"filename": "gas.png", "media_type": "image/png", "data_base64": png, "total_cents": 9500})
    assert r.status_code == 200, r.text
    assert r.json()["receipt"]["status"] == "unverified"
    dupe = client.post(f"/quests/{qid}/receipts", headers=hon,
                       json={"filename": "gas.png", "media_type": "image/png", "data_base64": png, "total_cents": 9500})
    assert dupe.status_code == 409
    # Only the host can add receipts.
    assert client.post(f"/quests/{qid}/receipts", headers=login(client, "maya"),
                       json={"filename": "x.png", "media_type": "image/png", "data_base64": png}).status_code == 403
    d = client.post(f"/quests/{qid}/settle", json={}, headers=hon).json()
    p = [x for x in d["proposals"] if x["status"] == "pending"][0]
    assert p["evidence"] and p["evidence"][0]["total_cents"] == 9500
    assert "receipt" in p["rationale"]
    img = client.get(f"/receipts/{p['evidence'][0]['id']}/image")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"


def test_books_show_hosts_everything_and_members_only_their_own(client):
    hon = client.get("/me/ledger", headers=login(client, "hon")).json()
    hv = [r for r in hon if r["quest"]["line_code"] == "HV" and not r["quest"]["tour"]]
    assert hv and all(r["quest"]["role"] == "host" for r in hv)
    assert len({r["user"]["id"] for r in hv if r["user"]}) > 1  # the host sees every traveler's holds

    dev_headers = login(client, "dev")
    dev_id = client.get("/me", headers=dev_headers).json()["user"]["id"]
    dev = client.get("/me/ledger", headers=dev_headers).json()
    assert dev, "dev joined seeded quests, so he has entries"
    assert all(r["user"]["id"] == dev_id for r in dev if r["quest"]["role"] == "member")
    assert client.get("/me/ledger").status_code == 401
