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
