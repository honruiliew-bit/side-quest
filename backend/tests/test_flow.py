"""End-to-end lifecycle in mock PayPal mode with the offline agent."""

import os
import sys
from pathlib import Path

DB = Path(__file__).parent / "test.db"
if DB.exists():
    DB.unlink()
os.environ.update({
    "DATABASE_URL": f"sqlite:///{DB}",
    "PAYPAL_MODE": "mock",
    "ANTHROPIC_API_KEY": "",
    "DEMO_MODE": "1",
    "SEED_ON_START": "1",
    "SCHEDULER_SECONDS": "3600",
    "CRON_SECRET": "tick",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.pricing import price_cents  # noqa: E402
from main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def login(client, persona):
    r = client.post("/auth/demo", json={"persona": persona})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


SEEDED = {"HV": "HV-0417", "BK": "BK-0418", "RB": "RB-0419", "HH": "HH-0420", "RI": "RI-0421"}


def quest_by_code(client, prefix):
    for q in client.get("/quests?status=all").json():
        if q["code"] == SEEDED[prefix]:
            return q
    raise AssertionError(prefix)


def test_pricing_only_goes_down():
    lines = [{"label": "Van", "cents": 24000, "split": "shared"}, {"label": "Entry", "cents": 3300, "split": "each"}]
    assert price_cents(lines, 5) == 8100
    assert price_cents(lines, 6) == 7300
    assert price_cents(lines, 7) == 6729
    assert price_cents(lines, 7) < price_cents(lines, 6) < price_cents(lines, 5)


def test_full_lifecycle(client):
    hv = quest_by_code(client, "HV")
    qid = hv["id"]
    assert hv["status"] == "open" and hv["headcount"] == 4 and hv["hold_cents"] == 8100

    # Leo holds a spot through the PayPal flow: create order, approve, authorize.
    leo = login(client, "leo")
    r = client.post(f"/quests/{qid}/holds", headers=leo)
    assert r.status_code == 200, r.text
    hold = r.json()
    assert hold["hold_cents"] == 8100 and hold["approve_url"]
    looked = client.get(f"/paypal/orders/{hold['order_id']}").json()
    assert looked["membership"]["status"] == "pending"
    r = client.post(f"/holds/{hold['membership_id']}/confirm", json={"order_id": hold["order_id"]}, headers=leo)
    d = r.json()
    assert d["status"] == "on" and d["headcount"] == 5 and d["share_cents"] == 8100
    # Confirm is idempotent (redirect, JS SDK and webhook may all call it).
    assert client.post(f"/holds/{hold['membership_id']}/confirm", json={}, headers=leo).status_code == 200

    # Two more join, the share drops.
    hon = login(client, "hon")
    d = client.post(f"/demo/quests/{qid}/crowd", json={"count": 2}, headers=hon).json()
    assert d["headcount"] == 7 and d["share_cents"] == 6729

    # One more goes to standby.
    d = client.post(f"/demo/quests/{qid}/crowd", json={"count": 1}, headers=hon).json()
    assert len(d["standby"]) == 1
    standby_name = d["standby"][0]["user"]["name"]

    # Only the host can lock.
    assert client.post(f"/quests/{qid}/lock", headers=leo).status_code == 403
    d = client.post(f"/quests/{qid}/lock", headers=hon).json()
    assert d["status"] == "locked" and d["stage"] == 3
    charged = [s["member"] for s in d["seats"] if s["member"]]
    assert all(m["status"] == "charged" and m["charged_cents"] == 6729 for m in charged)
    assert all(m["charged_cents"] <= m["hold_cents"] for m in charged)
    assert d["money"]["charged_cents"] == 6729 * 7

    # Leo drops out after lock through the agent. It becomes a swap proposal for the host.
    r = client.post(f"/quests/{qid}/chat", json={"text": "Sorry everyone, I can't make it anymore"}, headers=leo).json()
    assert "leave_quest" in r["reply"]["tools"]
    pending = [p for p in r["quest"]["proposals"] if p["status"] == "pending"]
    assert pending and pending[0]["title"] == f"Swap Leo for {standby_name}"

    # Leo can't approve his own refund.
    assert client.post(f"/proposals/{pending[0]['id']}/decide", json={"approve": True}, headers=leo).status_code == 403
    d = client.post(f"/proposals/{pending[0]['id']}/decide", json={"approve": True}, headers=hon).json()
    assert [p for p in d["proposals"] if p["id"] == pending[0]["id"]][0]["status"] == "executed"
    names = [s["member"]["user"]["name"] for s in d["seats"] if s["member"]]
    assert "Leo" not in names and standby_name in names and len(names) == 7
    assert d["money"]["refunded_cents"] == 6729

    # Costs ran over by $35. Settle up becomes PayPal invoices through the Agent Toolkit.
    d = client.post(f"/quests/{qid}/settle", json={"actual_shared_cents": 27500}, headers=hon).json()
    settle = [p for p in d["proposals"] if p["status"] == "pending"][0]
    assert all(a["type"] == "invoice" for a in settle["actions"]) and len(settle["actions"]) == 7
    d = client.post(f"/proposals/{settle['id']}/decide", json={"approve": True}, headers=hon).json()
    assert sum(1 for e in d["ledger"] if e["kind"] == "invoice") == 7
    dues = [x for x in client.get("/me/books", headers=hon).json()["dues"] if x["quest_id"] == qid]
    assert len(dues) == 7 and all(x["status"] == "Open" and x["can_remind"] for x in dues)

    # The host can't take the money before the trip. It releases on its own after the dispute window.
    early = client.post(f"/quests/{qid}/complete", headers=hon)
    assert early.status_code == 409 and "on its own" in early.json()["detail"]
    d = client.post(f"/demo/quests/{qid}/payout", headers=hon).json()
    assert d["status"] == "completed" and d["stage"] == 4
    payout = [e for e in d["ledger"] if e["kind"] == "payout"][0]
    assert payout["cents"] == 6729 * 7 - 6729 + 6729  # refund for Leo, charge for the standby swap


def test_leave_before_lock_is_instant_and_promotes_standby(client):
    rb = quest_by_code(client, "RB")
    qid = rb["id"]
    hon = login(client, "hon")
    client.post(f"/demo/quests/{qid}/crowd", json={"count": 6}, headers=hon)
    d = client.post(f"/demo/quests/{qid}/crowd", json={"count": 1}, headers=hon).json()
    assert d["headcount"] == 8 and len(d["standby"]) == 1
    waiting = d["standby"][0]["user"]["name"]
    seated = [s["member"]["user"]["persona"] for s in d["seats"] if s["member"]]
    who = [p for p in seated if p not in ("theo",)][0]
    r = client.post(f"/quests/{qid}/leave", headers=login(client, who)).json()
    assert r["result"]["done"] is True
    names = [s["member"]["user"]["name"] for s in r["quest"]["seats"] if s["member"]]
    assert waiting in names and len(r["quest"]["standby"]) == 0
    assert any(e["kind"] == "release" for e in r["quest"]["ledger"])


def test_deadline_without_enough_people_releases_everyone(client):
    hon = login(client, "hon")
    r = client.post("/quests/draft", json={"prompt": "bakery crawl for 6 people this weekend"}, headers=hon)
    draft = r.json()
    assert draft["cost_lines"] and draft["source"] == "offline"
    draft["join_by_hours_before"] = 1
    r = client.post("/quests", json=draft, headers=hon)
    assert r.status_code == 200, r.text
    qid = r.json()["id"]
    client.post(f"/demo/quests/{qid}/crowd", json={"count": 2}, headers=hon)
    d = client.post(f"/demo/quests/{qid}/deadline", headers=hon).json()
    assert d["status"] == "cancelled"
    assert d["money"]["charged_cents"] == 0
    assert all(s["member"] is None for s in d["seats"])


def test_webhook_confirms_ledger(client):
    hv = quest_by_code(client, "BK")
    d = client.get(f"/quests/{hv['id']}").json()
    entry = [e for e in d["ledger"] if e["kind"] == "hold"][0]
    event = {"id": "WH-1", "event_type": "PAYMENT.AUTHORIZATION.CREATED", "resource": {"id": entry["ref"]}}
    assert client.post("/webhooks/paypal", json=event).json()["status"] == "confirmed"
    assert client.post("/webhooks/paypal", json=event).json()["status"] == "duplicate"
    d = client.get(f"/quests/{hv['id']}").json()
    assert [e for e in d["ledger"] if e["id"] == entry["id"]][0]["confirmed"] is True


def test_approved_order_webhook_authorizes(client):
    bk = quest_by_code(client, "BK")
    dev = login(client, "dev")
    hold = client.post(f"/quests/{bk['id']}/holds", headers=dev).json()
    event = {"id": "WH-2", "event_type": "CHECKOUT.ORDER.APPROVED", "resource": {"id": hold["order_id"]}}
    assert client.post("/webhooks/paypal", json=event).json()["status"] == "authorized"


def test_mcp_lists_quests(client):
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
    r = client.post("/mcp/", json=init, headers=headers)
    assert r.status_code == 200, r.text
    r = client.post("/mcp/", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=headers)
    names = [t["name"] for t in r.json()["result"]["tools"]]
    assert {"list_quests", "get_quest", "hold_spot", "check_my_spot"} <= set(names)
    r = client.post("/mcp/", json={"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                   "params": {"name": "hold_spot", "arguments": {
                                       "quest_id": quest_by_code(client, "BK")["id"], "name": "Riley",
                                       "email": "riley@example.com"}}}, headers=headers)
    body = r.json()["result"]
    assert "approve_url" in str(body)


def test_tick_requires_secret(client):
    assert client.post("/cron/tick").status_code == 403
    assert client.post("/cron/tick", headers={"X-Cron-Secret": "tick"}).status_code == 200


def test_proposal_runs_once_and_duplicates_collapse(client):
    from app.db import session_scope
    from app.models import Quest
    from app import engine

    hh = quest_by_code(client, "HH")
    with session_scope() as db:
        q = db.get(Quest, hh["id"])
        dev = [m for m in q.memberships if m.user.persona == "dev"][0]
        leo = [m for m in q.memberships if m.user.persona == "leo"][0]
        acts = [{"type": "promote", "membership_id": leo.id},
                {"type": "refund", "membership_id": dev.id, "cents": dev.charged_cents, "note": "a"}]
        p1 = engine.create_proposal(db, q, "Swap", "why", acts)
        acts[1]["note"] = "different wording"
        p2 = engine.create_proposal(db, q, "Swap again", "why", acts)
        assert p1.id == p2.id
        pid = p1.id
    ana = login(client, "ana")
    assert client.post(f"/proposals/{pid}/decide", json={"approve": True}, headers=ana).status_code == 200
    second = client.post(f"/proposals/{pid}/decide", json={"approve": True}, headers=ana)
    assert second.status_code == 409
    d = client.get(f"/quests/{hh['id']}").json()
    assert sum(1 for e in d["ledger"] if e["kind"] == "refund") == 1
    assert sum(1 for e in d["ledger"] if e["kind"] == "charge" and e["user"]["name"] == "Leo") == 1
