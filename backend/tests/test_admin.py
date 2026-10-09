"""The admin side: fees, the money each quest makes, reports decided by an admin, PayPal disputes, audit.

Runs with the default launch fees (6% + $0.50 booking fee, no host fee), unlike the other suites.
"""

import os
import sys
from pathlib import Path

DB = Path(__file__).parent / "test_admin.db"
if DB.exists():
    DB.unlink()
os.environ.update({
    "DATABASE_URL": f"sqlite:///{DB}",
    "PAYPAL_MODE": "mock",
    "ANTHROPIC_API_KEY": "",
    "DEMO_MODE": "1",
    "SEED_ON_START": "1",
    "SCHEDULER_SECONDS": "3600",
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


def locked_tour(client):
    qid = client.post("/demo/tour").json()["id"]
    hon = login(client, "hon")
    client.post(f"/demo/quests/{qid}/crowd", json={"count": 1}, headers=hon)
    d = client.post(f"/quests/{qid}/lock", headers=hon).json()
    assert d["status"] == "locked"
    return qid, hon, d


def test_booking_fee_is_inside_the_hold(client):
    hv = next(q for q in client.get("/quests").json() if q["line_code"] == "HV")
    # $81.00 split at 5 people, plus 6% ($4.86) and $0.50.
    assert hv["hold_cents"] == 8100 + 486 + 50
    d = client.get(f"/quests/{hv['id']}").json()
    assert d["fee_bps"] == 600 and d["fee_fixed_cents"] == 50
    assert d["price_table"][0]["cents"] == hv["hold_cents"]


def test_only_admins_see_the_admin_api(client):
    assert client.get("/admin/overview", headers=login(client, "hon")).status_code == 403
    assert client.get("/admin/overview").status_code == 401
    kai = login(client, "kai")
    assert client.get("/admin/overview", headers=kai).status_code == 200
    personas = client.get("/personas").json()
    assert [p for p in personas if p["is_admin"]] == [p for p in personas if p["persona"] == "kai"]


def test_lock_records_the_fee_and_paypals_cut(client):
    qid, hon, d = locked_tour(client)
    charged = [s["member"] for s in d["seats"] if s["member"]]
    assert all(m["charged_cents"] == 8636 for m in charged)
    pay = client.get("/admin/payments?include_tours=true", headers=login(client, "kai")).json()
    charges = [p for p in pay if p["quest"]["id"] == qid and p["kind"] == "charge"]
    # Estimated at PayPal's US rate in mock mode: 3.49% of $86.36 rounded up, plus $0.49.
    assert charges and all(c["fee_cents"] == 302 + 49 and c["fee_source"] == "estimate" for c in charges)


def test_admin_decides_a_report_and_the_payout_follows_the_books(client):
    qid, hon, _ = locked_tour(client)
    # Hon paid for a seat too, but a host can't report their own quest.
    assert client.post(f"/quests/{qid}/problem", json={"reason": "Mine"}, headers=hon).status_code == 403
    maya = login(client, "maya")
    d = client.post(f"/quests/{qid}/problem", json={"reason": "Lunch stop was closed"}, headers=maya).json()
    case = d["cases"][0]
    assert case["status"] == "open" and case["mine"] is True  # Maya is looking at her own report
    assert d["payout"]["paused_reason"].startswith("Maya")
    # Reporting twice is refused, and only the reporter can withdraw.
    assert client.post(f"/quests/{qid}/problem", json={"reason": "again"}, headers=maya).status_code == 409
    assert client.post(f"/cases/{case['id']}/withdraw", headers=hon).status_code == 403
    client.post(f"/cases/{case['id']}/respond", json={"text": "The cafe closed early, sorry"}, headers=hon)

    kai = login(client, "kai")
    review = client.post(f"/admin/cases/{case['id']}/review", headers=kai).json()
    assert review["ai_review"]["source"] == "offline" and review["ai_review"]["decision"]
    # Can't refund more than Maya paid.
    too_much = client.post(f"/admin/cases/{case['id']}/resolve", headers=kai,
                           json={"decision": "refund_reporter", "refund_cents_each": 9000, "note": "x" * 5})
    assert too_much.status_code == 400
    r = client.post(f"/admin/cases/{case['id']}/resolve", headers=kai, json={
        "decision": "refund_reporter", "refund_cents_each": 1000, "note": "Lunch was part of the plan.", "pay_now": True})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "resolved" and out["quest"]["status"] == "completed"
    m = out["money"]
    # 5 x $86.36 charged, $10 back to Maya, Sidequest keeps 5 x $5.36. The host gets the rest.
    assert m["gross_cents"] == 5 * 8636 and m["refunded_cents"] == 1000
    assert m["booking_fees_cents"] == 5 * 536
    assert m["paid_out_cents"] == m["host_due_cents"] == 5 * 8636 - 1000 - 5 * 536
    assert m["escrow_cents"] == 0 and m["owed_back_cents"] == 0
    log = client.get("/admin/audit", headers=kai).json()
    assert {"case_opened", "host_reply", "case_review", "case_resolved", "payout_released"} <= {a["action"] for a in log}


def test_full_refund_gives_the_fee_back_and_pays_nothing_out(client):
    qid, hon, _ = locked_tour(client)
    d = client.post(f"/quests/{qid}/problem", json={"reason": "The van never came"}, headers=login(client, "dev")).json()
    kai = login(client, "kai")
    out = client.post(f"/admin/cases/{d['cases'][0]['id']}/resolve", headers=kai, json={
        "decision": "refund_everyone", "refund_cents_each": 8636, "note": "The trip didn't happen.", "pay_now": True}).json()
    m = out["money"]
    assert m["refunded_cents"] == m["gross_cents"] and m["booking_fees_cents"] == 0
    assert m["paid_out_cents"] == 0 and out["quest"]["status"] == "completed"
    # Sidequest still paid PayPal's fixed fee on each capture, so the trip lost money.
    assert m["net_revenue_cents"] < 0


def test_paypal_dispute_webhook_opens_a_case_and_admin_accepts_the_claim(client):
    qid, hon, d = locked_tour(client)
    priya = next(s["member"] for s in d["seats"] if s["member"] and s["member"]["user"]["name"] == "Priya")
    event = {"id": "WH-DISPUTE-1", "event_type": "CUSTOMER.DISPUTE.CREATED", "resource": {
        "dispute_id": "PP-D-TEST1", "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "status": "OPEN",
        "dispute_amount": {"currency_code": "USD", "value": "86.36"},
        "disputed_transactions": [{"seller_transaction_id": priya["capture_id"]}]}}
    assert client.post("/webhooks/paypal", json=event).json()["status"].startswith("case")
    q = client.get(f"/quests/{qid}").json()
    case = q["cases"][0]
    assert case["source"] == "paypal" and q["payout"]["paused_reason"]
    kai = login(client, "kai")
    out = client.post(f"/admin/cases/{case['id']}/resolve", headers=kai,
                      json={"decision": "accept_claim", "note": "Priya couldn't board. Accepting on PayPal."}).json()
    assert out["status"] == "resolved" and out["paypal_status"] == "RESOLVED"
    q = client.get(f"/quests/{qid}").json()
    assert not q["payout"]["paused_reason"]
    assert any(e["kind"] == "refund" and e["ref"] == "PP-D-TEST1" for e in q["ledger"])


def test_fee_changes_apply_to_new_quests_only_and_are_logged(client):
    kai = login(client, "kai")
    hv = next(q for q in client.get("/quests").json() if q["line_code"] == "HV")
    assert client.post("/admin/fees", headers=kai, json={
        "booking_bps": 800, "booking_fixed_cents": 0, "host_bps": 100, "reason": ""}).status_code == 422
    out = client.post("/admin/fees", headers=kai, json={
        "booking_bps": 800, "booking_fixed_cents": 0, "host_bps": 100, "reason": "Testing a higher fee"}).json()
    assert out["current"]["booking_bps"] == 800 and len(out["history"]) == 3
    assert client.get("/quests").json()[0]["hold_cents"] is not None
    assert next(q for q in client.get("/quests").json() if q["id"] == hv["id"])["hold_cents"] == hv["hold_cents"]
    hon = login(client, "hon")
    draft = client.post("/quests/draft", json={"prompt": "bakery crawl"}, headers=hon).json()
    new = client.post("/quests", json=draft, headers=hon).json()
    d = client.get(f"/quests/{new['id']}").json()
    assert d["fee_bps"] == 800 and d["fee_fixed_cents"] == 0
    preview = client.post("/admin/fees/preview", headers=kai, json={
        "booking_bps": 600, "booking_fixed_cents": 50, "host_bps": 0, "base_cents": 10000, "people": 5}).json()
    assert preview["price_cents"] == 10650 and preview["host_gets_cents"] == 10000
    assert preview["sidequest_net_cents"] == 650 - (372 + 49) - 5
    assert any(a["action"] == "fee_change" for a in client.get("/admin/audit", headers=kai).json())


def test_seeded_admin_data_and_audit_tools(client):
    kai = login(client, "kai")
    cases = client.get("/admin/cases", headers=kai).json()
    seeded = {c["quest"]["code"][:2]: c for c in cases}
    assert seeded["JB"]["status"] == "open" and seeded["JB"]["host_response"]
    assert seeded["RI"]["source"] == "paypal" and seeded["RI"]["quest"]["status"] == "completed"
    assert seeded["CK"]["status"] == "resolved"
    detail = client.get(f"/admin/cases/{seeded['JB']['id']}", headers=kai).json()
    assert detail["chat"] and detail["members"] and detail["money"]["escrow_cents"] > 0
    ov = client.get("/admin/overview", headers=kai).json()
    assert ov["totals"]["booking_fees_cents"] > 0 and ov["open_cases"] >= 2
    mt = next(q for q in ov["quests"] if q["code"].startswith("MT"))
    # Invoices paid after the trip were passed on to the host, so nothing is left sitting with Sidequest.
    assert mt["invoices_collected_cents"] > 0 and mt["escrow_cents"] == 0
    rec = client.post("/admin/reconcile", headers=kai).json()
    assert rec["checked"] == 0 and rec["simulated"] > 0
    st = client.get("/admin/statement", headers=kai).json()
    assert st["ok"] is False and "mock" in st["error"]
    assert client.post("/admin/disputes/sync", headers=kai).status_code == 409


def test_claude_review_is_cleaned_whatever_shape_it_comes_back_in():
    from app.agent.mediator import clean

    r = clean({"summary": "s", "facts": '["Jules paid $76.82", "Wind advisory"]', "missing": "No receipt\n- No photo",
               "decision": "refund", "refund_cents_each": "99999", "reasoning": "r"}, 7682)
    assert r["facts"] == ["Jules paid $76.82", "Wind advisory"] and r["missing"] == ["No receipt", "No photo"]
    assert r["decision"] == "need_more_info" and r["refund_cents"] == 7682
    assert clean({"summary": "s"}, 100)["facts"] == [] and clean(None, 100) is None
    old = clean({"decision": "refund_everyone", "refund_cents_each": 2000}, 7682, people=5)
    assert old["decision"] == "split_refund" and old["refund_cents"] == 10000


def test_split_a_credit_across_everyone_who_went(client):
    qid, hon, _ = locked_tour(client)
    d = client.post(f"/quests/{qid}/problem", json={"reason": "Only an hour on the water"}, headers=login(client, "maya")).json()
    case = d["cases"][0]
    client.post(f"/cases/{case['id']}/respond", headers=hon,
                json={"text": "The outfitter refunded me $100 for the missed hour. Happy to pass it on."})
    kai = login(client, "kai")
    review = client.post(f"/admin/cases/{case['id']}/review", headers=kai).json()["ai_review"]
    assert review["decision"] == "split_refund" and review["refund_cents"] == 10000
    out = client.post(f"/admin/cases/{case['id']}/resolve", headers=kai, json={
        "decision": "split_refund", "refund_total_cents": 10000, "note": "Passing on the outfitter's refund.",
        "pay_now": True}).json()
    assert out["status"] == "resolved" and out["refund_cents_each"] == 2000
    refunds = [e for e in out["ledger"] if e["kind"] == "refund"]
    # Four members get $20 each. Hon is the host, so his $20 share stays in his payout instead.
    assert len(refunds) == 4 and all(e["cents"] == 2000 for e in refunds)
    assert all(e["user"]["name"] != "Hon" for e in refunds)
    m = out["money"]
    # Runs after the fee-change test, so read the quest's own fees from the books.
    assert m["refunded_cents"] == 8000
    assert m["paid_out_cents"] == m["gross_cents"] - 8000 - m["booking_fees_cents"] - m["host_fee_cents"]
