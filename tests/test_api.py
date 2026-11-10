"""Approvals, simulated work orders and the HTTP API, driven the way the dashboard drives them."""
import time

import pytest
from fastapi.testclient import TestClient

from acumain import schema
from acumain.api import create_app
from acumain.config import ARTIFACTS
from acumain.services import SAMPLE_ID


@pytest.fixture
def client(svc):
    return TestClient(create_app(svc))


def wait_for(client, run_id, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        run = client.get(f"/api/agent/runs/{run_id}").json()
        if run["status"] != "running":
            return run
        time.sleep(0.05)
    raise AssertionError("the run did not finish in time")


def review(client, **body):
    started = client.post("/api/agent/runs", json={"batch_id": SAMPLE_ID, "kind": "review", **body})
    assert started.status_code == 202
    return wait_for(client, started.json()["run_id"])


# ---------------------------------------------------------------------------- approvals
def test_nothing_is_executed_until_a_person_approves(svc):
    svc.start_run(SAMPLE_ID, "review", list_size=6, wait=True)
    pending = svc.store.list_proposals(batch_id=SAMPLE_ID, status="pending")
    assert len(pending) == 6 and svc.store.list_work_orders() == []
    approved = svc.decide(pending[0]["id"], "approved")
    rejected = svc.decide(pending[1]["id"], "rejected", note="Aircraft is leaving the fleet.")
    assert approved["status"] == "approved" and approved["work_order_id"] == "WO-SIM-0001" and approved["decided_by"] == "planner"
    assert rejected["status"] == "rejected" and rejected["work_order_id"] is None and rejected["decision_note"] == "Aircraft is leaving the fleet."
    orders = svc.store.list_work_orders()
    assert len(orders) == 1 and orders[0]["status"] == "Created (simulated)" and orders[0]["record_id"] == pending[0]["record_id"]
    assert svc.decide(pending[0]["id"], "rejected")["status"] == "approved"        # a decision is final
    assert len(svc.store.list_work_orders()) == 1


def test_a_new_review_replaces_pending_proposals_but_never_a_decision(svc):
    svc.start_run(SAMPLE_ID, "review", list_size=4, wait=True)
    first = svc.store.list_proposals(batch_id=SAMPLE_ID)
    svc.decide(first[0]["id"], "approved")
    run = svc.store.get_run(svc.start_run(SAMPLE_ID, "review", list_size=4, wait=True))
    filed = [s for s in run["steps"] if s["name"] == "propose_actions"][0]["output"]
    assert filed["replaced_earlier_pending_proposals"] == 3 and "already approved" in filed["not_filed"][0]["why"]
    now = svc.store.list_proposals(batch_id=SAMPLE_ID)
    assert len(now) == 4 and sum(p["status"] == "approved" for p in now) == 1 and sum(p["status"] == "pending" for p in now) == 3


def test_bulk_decisions_can_target_one_kind_of_action(svc):
    svc.start_run(SAMPLE_ID, "review", list_size=25, wait=True)
    done = svc.decide_many(SAMPLE_ID, "approved", action="repair")
    assert len(done) == 22 and len(svc.store.list_work_orders(SAMPLE_ID)) == 22
    assert [p["action"] for p in svc.store.list_proposals(batch_id=SAMPLE_ID, status="pending")] == ["retest"] * 3


# ---------------------------------------------------------------------------- HTTP API
def test_health_meta_and_static_page(client):
    health = client.get("/api/health").json()
    assert health["status"] == "ok" and health["model"]["available"] and health["agent"]["mode"] == "offline"
    meta = client.get("/api/meta").json()
    assert meta["thresholds"] == {"medium": 10.0, "high": 32.0} and len(meta["fields"]) == 14 and meta["validation"]["caught"] == 185
    assert client.get("/api/history").json()["model"]["failures"] == 187
    assert client.get("/api/files/template.csv").text.startswith("Case_ID,Aircraft_ID")
    assert "<title>" in client.get("/").text


def test_a_review_through_the_api_then_browse_and_decide(client):
    before = client.get(f"/api/batches/{SAMPLE_ID}").json()
    assert before["records"] == 2000 and not before["scored"]
    unscored_page = client.get(f"/api/batches/{SAMPLE_ID}/records", params={"limit": 3}).json()
    assert unscored_page["total"] == 2000 and unscored_page["rows"][0]["level"] in ("Awaiting model", "Not scored")

    run = review(client, list_size=10, screen={"page": "Review queue", "filter": "Any", "secret": "dropped"})
    assert run["status"] == "completed" and run["context"]["screen"] == {"page": "Review queue", "filter": "Any"}
    after = client.get(f"/api/batches/{SAMPLE_ID}").json()
    assert after["scored"] and after["levels"]["High"] == 203 and after["proposals"]["pending"] == 10 and after["active_run"] is None

    high = client.get(f"/api/batches/{SAMPLE_ID}/records", params={"level": "High", "limit": 5}).json()
    assert high["total"] == 203 and high["rows"][0]["proposal"]["status"] == "pending" and high["rows"][0]["risk"] > 90
    found = client.get(f"/api/batches/{SAMPLE_ID}/records", params={"q": high["rows"][0]["aircraft_id"].lower()}).json()
    assert found["total"] == 1
    assert client.get(f"/api/batches/{SAMPLE_ID}/records", params={"issues": True}).json()["total"] == 448

    detail = client.get(f"/api/batches/{SAMPLE_ID}/records/{high['rows'][0]['record_id']}").json()
    assert detail["level"] == "High" and detail["factors"] and detail["band"]["in_30_days"] > 50 and detail["proposal"]["action"] == "repair"
    assert client.get(f"/api/batches/{SAMPLE_ID}/records/NOPE").status_code == 404

    proposals = client.get(f"/api/batches/{SAMPLE_ID}/proposals").json()
    one = client.post(f"/api/proposals/{proposals[0]['id']}/decision", json={"decision": "approved"}).json()
    assert one["work_order_id"].startswith("WO-SIM-")
    assert client.post(f"/api/proposals/{proposals[1]['id']}/decision", json={"decision": "maybe"}).status_code == 400
    rest = client.post(f"/api/batches/{SAMPLE_ID}/proposals/decision", json={"decision": "rejected"}).json()
    assert len(rest) == 9 and len(client.get("/api/work-orders").json()) == 1
    assert len(client.get("/api/agent/runs").json()) == 1

    reset = client.post(f"/api/batches/{SAMPLE_ID}/reset").json()
    assert not reset["scored"] and reset["proposals"] == {"pending": 0, "approved": 0, "rejected": 0} and client.get("/api/work-orders").json() == []


def test_upload_a_file_and_review_it(client):
    content = (ARTIFACTS / "sample_upload.csv").read_bytes()
    made = client.post("/api/batches", files={"file": ("this_week.csv", content, "text/csv")}, data={"name": "This week"})
    assert made.status_code == 201
    batch = made.json()
    assert batch["name"] == "This week" and batch["records"] == 30 and batch["source"] == "upload" and batch["with_issues"] >= 8
    started = client.post("/api/agent/runs", json={"batch_id": batch["id"], "kind": "review", "list_size": 5})
    run = wait_for(client, started.json()["run_id"])
    assert run["status"] == "completed" and client.get(f"/api/batches/{batch['id']}").json()["scored"]
    assert len(client.get("/api/batches").json()) == 2
    assert client.delete(f"/api/batches/{batch['id']}").json() == {"removed": batch["id"]}
    assert client.delete(f"/api/batches/{SAMPLE_ID}").status_code == 400          # the built-in sample stays


def test_a_file_with_answers_is_scored_honestly(client, sample_frame):
    frame = sample_frame.head(40).copy()
    frame[schema.ANSWER_COLUMN] = ["Yes" if i % 9 == 0 else "No" for i in range(len(frame))]
    made = client.post("/api/batches", files={"file": ("labelled.csv", frame.to_csv(index=False).encode(), "text/csv")}).json()
    wait_for(client, client.post("/api/agent/runs", json={"batch_id": made["id"], "kind": "review"}).json()["run_id"])
    check = client.get(f"/api/batches/{made['id']}").json()["answer_check"]
    assert check["records"] == check["caught"] + check["missed"] + check["false_alarms"] + check["correct_no"] and 0 <= check["f1"] <= 100


@pytest.mark.parametrize("name, content, expect", [
    ("bad.csv", b"a,b\n1,2\n", "14 required column(s)"), ("empty.csv", b"", "empty"), ("sheet.xlsx", b"PK\x03\x04", "CSV")])
def test_unusable_uploads_are_refused_with_a_reason(client, name, content, expect):
    answer = client.post("/api/batches", files={"file": (name, content, "text/csv")})
    assert answer.status_code == 422 and expect in answer.json()["detail"]


def test_single_record_check(client):
    values = {"Hydraulic_Fluid_Grade": "FG-A", "Flight_Hours_Last_7_Days": 80, "Flight_Cycles_Last_7_Days": 12, "Actuator_Age_Hours": 2500,
              "Days_Since_Last_Service": 90, "Ambient_Temperature_C": 25, "Hydraulic_Pressure_PSI": 5000, "Pressure_Variation_PSI": 80,
              "Hydraulic_Fluid_Temperature_C": 55, "Internal_Leakage_Rate_mL_Min": 26, "Actuation_Time_Seconds": 5.5,
              "Reference_Leakage_Flow_mL_Min": 50, "Reference_Actuation_Time_Seconds": 6, "Diagnostic_Load_Ratio": 1.0}
    worn = client.post("/api/predict", json={"values": values}).json()
    assert worn["level"] == "High" and worn["prediction"] == "Yes" and worn["confidence"].startswith("Normal")
    partial = client.post("/api/predict", json={"values": {**values, "Internal_Leakage_Rate_mL_Min": None}}).json()
    assert partial["level"] in ("High", "Medium", "Low") and partial["confidence"].startswith("Reduced") and "Internal leakage rate is missing." in partial["issues"]
    nothing = client.post("/api/predict", json={"values": {**values, "Internal_Leakage_Rate_mL_Min": "", "Actuation_Time_Seconds": "abc"}}).json()
    assert nothing["level"] == "Not scored" and nothing["risk"] is None and nothing["prediction"] is None


def test_model_outage_is_visible_everywhere_and_recoverable(client):
    assert client.post("/api/demo/outage", json={"enabled": True}).json()["available"] is False
    assert client.get("/api/health").json()["model"]["simulated_outage"] is True
    failed = client.post("/api/predict", json={"values": {}})
    assert failed.status_code == 503 and failed.json()["code"] == "MODEL_UNAVAILABLE"
    run = review(client)
    assert run["proposals"] == [] and "no predictions" in run["final_text"] and not client.get(f"/api/batches/{SAMPLE_ID}").json()["scored"]
    client.post("/api/demo/outage", json={"enabled": False})
    assert len(review(client, list_size=5)["proposals"]) == 5                       # the retry works


def test_bad_run_requests_are_refused(client, svc):
    post = lambda **body: client.post("/api/agent/runs", json=body)
    assert post(batch_id="nope", kind="review").status_code == 404
    assert post(batch_id=SAMPLE_ID, kind="delete").status_code == 400
    assert post(batch_id=SAMPLE_ID, kind="question", question=" ").status_code == 400
    assert post(batch_id=SAMPLE_ID, kind="question", question="x" * 601).status_code == 400
    assert post(batch_id=SAMPLE_ID, kind="review", record_ids=["nope"]).status_code == 400
    svc.store.create_run("review", "busy", SAMPLE_ID, "test", "test", {})
    assert post(batch_id=SAMPLE_ID, kind="review").status_code == 409
    assert client.post(f"/api/batches/{SAMPLE_ID}/reset").status_code == 409
    assert client.get("/api/agent/runs/run_nope").status_code == 404


def test_uploaded_batches_and_results_survive_a_restart(svc, settings):
    from acumain.services import Services
    batch = svc.upload((ARTIFACTS / "sample_upload.csv").read_bytes(), "kept.csv", None)
    svc.start_run(batch.id, "review", list_size=3, wait=True)
    svc.start_run(SAMPLE_ID, "review", list_size=3, wait=True)
    again = Services(settings)
    assert again.batch(batch.id).scored and again.batch(SAMPLE_ID).scored and again.batch(batch.id).name == "kept"
    assert len(again.store.list_proposals(batch_id=batch.id)) == 3 and len(again.batches.all()) == 2


def test_only_one_of_many_simultaneous_starts_is_accepted(svc):
    """Found by stress-testing the running app: two reviews could start on one batch at the same instant."""
    import threading
    from acumain.services import RequestError
    outcomes, barrier = [], threading.Barrier(8)

    def start():
        barrier.wait()
        try:
            outcomes.append(svc.start_run(SAMPLE_ID, "review", list_size=5))
        except RequestError as err:
            outcomes.append(err.status)

    threads = [threading.Thread(target=start) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    started = [o for o in outcomes if isinstance(o, str)]
    assert len(started) == 1 and outcomes.count(409) == 7
    svc._threads[started[0]].join(timeout=20)
    assert svc.store.get_run(started[0])["status"] == "completed" and len(svc.store.list_runs()) == 1


def test_racing_decisions_create_exactly_one_work_order(svc):
    import threading
    svc.start_run(SAMPLE_ID, "review", list_size=3, wait=True)
    target = svc.store.list_proposals(batch_id=SAMPLE_ID)[0]["id"]
    barrier = threading.Barrier(10)

    def decide(i):
        barrier.wait()
        svc.decide(target, "approved" if i % 2 else "rejected")

    threads = [threading.Thread(target=decide, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    final = svc.store.list_proposals(batch_id=SAMPLE_ID)[0]
    orders = [o for o in svc.store.list_work_orders() if o["proposal_id"] == target]
    assert final["status"] in ("approved", "rejected") and len(orders) == (1 if final["status"] == "approved" else 0)
