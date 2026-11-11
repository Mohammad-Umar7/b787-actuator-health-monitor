"""The team of agents: an orchestrator, the Risk agent, the Stock agent and the Supply agent, with a simulated
spare-parts supply. Tested without an API key: the built-in planners, scripted stand-ins for Claude, and the HTTP API."""
import json

import pytest
from fastapi.testclient import TestClient

from acumain.agent import prompts, tools
from acumain.agent.llm import LLMError, ScriptedLLM, text_reply, tool_reply
from acumain.api import create_app
from acumain.services import SAMPLE_ID, RequestError

from conftest import with_claude


def review(svc, **kwargs):
    run = svc.store.get_run(svc.start_run(SAMPLE_ID, "review", wait=True, as_team=True, **kwargs))
    assert run["status"] == "completed"
    return run


def tool_steps(run):
    return [(s["agent"], s["name"]) for s in run["steps"] if s["type"] == "tool"]


def repairs(svc):
    return [p for p in svc.store.list_proposals(batch_id=SAMPLE_ID, status="pending") if p["action"] == "repair"]


# ---------------------------------------------------------------------------- the whole team, no language model
def test_the_team_works_in_order_and_every_step_says_who_took_it(svc):
    run = review(svc, list_size=25)
    assert tool_steps(run) == [
        ("lead", "assign_risk_agent"), ("risk", "check_records"), ("risk", "run_failure_model"), ("risk", "list_records"), ("risk", "list_records"),
        ("risk", "propose_actions"), ("lead", "assign_stock_agent"), ("stock", "check_stock"), ("stock", "reserve_parts"),
        ("lead", "assign_supply_agent"), ("supply", "get_supply_options"), ("supply", "request_parts")]
    assert {s["agent"] for s in run["steps"] if s["type"] == "model"} == {"lead", "risk", "stock", "supply"}
    assert run["context"]["team"] is True and run["mode"] == "built-in planner"


def test_short_stock_parts_go_to_the_most_urgent_and_the_rest_is_requested(svc):
    run = review(svc, list_size=25)
    todo = repairs(svc)
    assert len(todo) == 22 and [p["risk"] for p in todo] == sorted((p["risk"] for p in todo), reverse=True)
    status = [(p["part"]["status"], p["part"]["source"], p["part"]["eta_days"], p["part"]["late"]) for p in todo]
    assert status[:12] == [("in_store", "store", 0, False)] * 12                     # the 12 free units, highest risk first
    assert status[12:20] == [("requested", "warehouse", 2, False)] * 8               # then the fastest source
    assert status[20:] == [("requested", "supplier", 14, True)] * 2                  # 14 days is after a repair due in 7
    (request,) = svc.store.list_parts_requests(batch_id=SAMPLE_ID)
    assert request["status"] == "pending" and request["id"] == "PR-SIM-0001" and all(p["part"]["request_id"] == request["id"] for p in todo[12:])
    assert [(line["source"], line["quantity"], line["delivery_days"], line["late"]) for line in request["lines"]] == [("warehouse", 8, 2, 0), ("supplier", 2, 14, 2)]
    text = run["final_text"]
    assert "**Parts (simulated stock)**" in text and "12 of the 22 repairs have a spare actuator" in text
    assert "8 from the central warehouse (2 days); 2 from the supplier order (14 days)" in text and "2 of those parts would arrive after the repair is due" in text
    assert text.index("**Parts") < text.index("**Data to be aware of**") and "203 of the 1,992 scored aircraft" in text      # the Risk agent's findings are kept
    assert all(p.get("part") is None for p in svc.store.list_proposals(batch_id=SAMPLE_ID) if p["action"] != "repair")      # only a repair needs a part


def test_with_plenty_of_stock_the_supply_agent_is_not_called(svc):
    svc.set_stock(preset="plenty")
    run = review(svc)
    assert ("lead", "assign_supply_agent") not in tool_steps(run) and svc.store.list_parts_requests(batch_id=SAMPLE_ID) == []
    assert {p["part"]["status"] for p in repairs(svc)} == {"in_store"} and "22 of the 22 repairs have a spare actuator" in run["final_text"]


def test_when_no_source_can_deliver_the_gap_is_filed_as_a_backorder_not_hidden(svc):
    svc.set_stock(preset="none")
    run = review(svc)
    (request,) = svc.store.list_parts_requests(batch_id=SAMPLE_ID)
    assert [(line["source"], line["quantity"], line["delivery_days"]) for line in request["lines"]] == [("backorder", 22, None)]
    assert all(p["part"] == {**p["part"], "status": "requested", "source": "backorder", "eta_days": None, "late": True} for p in repairs(svc))
    assert "22 on backorder, no delivery date" in run["final_text"] and "22 parts have no delivery date from any source" in run["final_text"]


def test_a_failed_stock_check_is_reported_and_nothing_is_assumed(svc):
    svc.set_stock(outage=True)
    run = review(svc)
    failed = [s for s in run["steps"] if s["name"] == "check_stock"][0]
    assert failed["is_error"] and failed["output"]["error"] == "STOCK_UNAVAILABLE" and "Do not assume" in failed["output"]["instruction"]
    assert ("lead", "assign_supply_agent") not in tool_steps(run) and svc.store.list_parts_requests(batch_id=SAMPLE_ID) == []
    assert len(repairs(svc)) == 22 and all(p["part"] is None for p in repairs(svc))        # the repairs stand; their part status is simply unknown
    assert "stock system could not be reached" in run["final_text"] and "Nothing was assumed" in run["final_text"]


def test_a_failed_model_call_stops_the_team_before_any_parts_work(svc):
    svc.model.simulated_outage = True
    run = review(svc)
    assert tool_steps(run) == [("lead", "assign_risk_agent"), ("risk", "check_records"), ("risk", "run_failure_model")]
    assert run["proposals"] == [] and "no predictions" in run["final_text"] and svc.store.list_parts_requests() == []


def test_an_approved_repair_keeps_its_part_so_the_next_review_has_fewer_free(svc):
    review(svc, list_size=10)
    first = repairs(svc)
    assert [p["part"]["status"] for p in first] == ["in_store"] * len(first) and svc.stock.status()["free"] == 12
    for p in first[:5]:
        svc.decide(p["id"], "approved")
    svc.decide(first[5]["id"], "rejected", "No hangar slot this week")
    assert svc.stock.status() == {**svc.stock.status(), "store": 12, "reserved": 5, "free": 7}
    review(svc, list_size=10)                                                              # moves on to the next aircraft
    check = svc.store.list_proposals(batch_id=SAMPLE_ID, status="pending")
    assert sum((p["part"] or {}).get("status") == "in_store" for p in check if p["action"] == "repair") == 7


def test_a_small_file_with_no_repairs_needs_no_parts_work(svc, sample_frame):
    low = sample_frame[sample_frame["Case_ID"].isin(["Q-10012035", "Q-10019530"])]
    batch = svc.batches.add("two low ones", "upload", low)
    run = svc.store.get_run(svc.start_run(batch.id, "review", wait=True, as_team=True))
    assert [name for _agent, name in tool_steps(run) if name.startswith("assign_")] == ["assign_risk_agent"]


# ---------------------------------------------------------------------------- the tools the specialists use
def stock_context(svc):
    run_id = svc.start_run(SAMPLE_ID, "review", list_size=25, wait=True)                 # the Risk agent alone files the proposals
    return tools.ToolContext(batches=svc.batches, model=svc.model, store=svc.store, batch=svc.batch(SAMPLE_ID), run_id=run_id, stock=svc.stock)


def use(name, args, ctx, which):
    content, is_error = tools.execute(name, args, ctx, allowed=tools.names(which))
    return json.loads(content), is_error


def test_each_agent_can_call_only_its_own_tools(svc):
    ctx = stock_context(svc)
    refused, is_error = use("propose_actions", {"actions": []}, ctx, "stock")
    assert is_error and "Unknown tool 'propose_actions'" in refused["error"] and "check_stock, reserve_parts" in refused["error"]
    refused, is_error = use("check_stock", {}, ctx, "risk")
    assert is_error and "Unknown tool" in refused["error"]
    assert tools.names("lead") == ["assign_risk_agent", "assign_stock_agent", "assign_supply_agent"]
    no_team, is_error = use("assign_stock_agent", {}, ctx, "lead")
    assert is_error and "No team is attached" in no_team["error"]
    for which in ("stock", "supply", "lead"):
        for tool in tools.definitions(True, which):
            assert len(tool["description"]) > 80 and tool["input_schema"]["additionalProperties"] is False
            assert tool.get("strict", False) is bool(tool["input_schema"]["properties"])


def test_a_parts_request_is_checked_against_what_the_sources_really_have(svc):
    ctx = stock_context(svc)
    use("check_stock", {}, ctx, "stock")
    reserved, _ = use("reserve_parts", {}, ctx, "stock")
    assert reserved["set_aside_from_hangar_store"] == 12 and reserved["repairs_still_without_a_part"] == 10 and reserved["their_earliest_due_date_in_days"] == 7
    options, _ = use("get_supply_options", {}, ctx, "supply")
    assert options["units_needed"] == 10 and [(s["source"], s["units_available"], s["delivery_days"]) for s in options["sources"]] == [
        ("warehouse", 8, 2), ("supplier", "no limit", 14), ("backorder", "no limit", None)]
    for lines, expect in (([{"source": "warehouse", "quantity": 9}], "has only 8 unit(s)"), ([{"source": "supplier", "quantity": 11}], "Only 10 unit(s) are needed"),
                          ([{"source": "moon", "quantity": 1}], "source must be one of"), ([{"source": "warehouse", "quantity": 0}], "at least 1"),
                          ([], "non-empty list")):
        refused, is_error = use("request_parts", {"lines": lines, "note": ""}, ctx, "supply")
        assert is_error and expect in refused["error"]
    assert svc.store.list_parts_requests() == []                                           # nothing was filed by a refused call
    svc.set_stock(values={"supplier_available": False})
    refused, is_error = use("request_parts", {"lines": [{"source": "supplier", "quantity": 2}], "note": ""}, ctx, "supply")
    assert is_error and "Use 'backorder'" in refused["error"]
    filed, is_error = use("request_parts", {"lines": [{"source": "warehouse", "quantity": 8}], "note": "urgent"}, ctx, "supply")   # asks for fewer than needed
    assert not is_error and filed["units_requested"] == 8 and filed["repairs_still_without_any_source"] == 2 and filed["arrive_in_time_for"] == 8
    again, is_error = use("request_parts", {"lines": [{"source": "backorder", "quantity": 2}], "note": ""}, ctx, "supply")          # a second request replaces the first
    assert not is_error and [r["id"] for r in svc.store.list_parts_requests()] == ["PR-SIM-0002"]


def test_the_planner_decides_on_a_parts_request_once(svc):
    review(svc)
    (request,) = svc.store.list_parts_requests(batch_id=SAMPLE_ID)
    assert svc.decide_parts_request(request["id"], "approved", "go ahead")["status"] == "approved"
    with pytest.raises(RequestError) as err:
        svc.decide_parts_request(request["id"], "rejected")
    assert err.value.status == 409 and "already approved" in str(err.value)
    with pytest.raises(RequestError) as err:
        svc.decide_parts_request("PR-SIM-9999", "approved")
    assert err.value.status == 404
    svc.reset(SAMPLE_ID)
    assert svc.store.list_parts_requests() == [] and svc.stock.status()["reserved"] == 0     # a reset clears the request and frees the parts


# ---------------------------------------------------------------------------- the team with a language model
def team_script(extra_lead=None):
    return [
        tool_reply(("L1", "assign_risk_agent", {})),                                                                         # orchestrator
        tool_reply(("R1", "check_records", {}), ("R2", "run_failure_model", {})),                                            # Risk agent
        tool_reply(("R3", "propose_actions", {"actions": [{"record_id": "Q-18857260", "action": "repair", "note": "worst"},
                                                          {"record_id": "Q-73316018", "action": "repair", "note": ""},
                                                          {"record_id": "Q-35222973", "action": "repair", "note": ""}]})),
        text_reply("Three repairs proposed."),
        tool_reply(("L2", "assign_stock_agent", {})),                                                                        # orchestrator
        tool_reply(("S1", "check_stock", {})),                                                                               # Stock agent
        tool_reply(("S2", "reserve_parts", {})),
        text_reply("One part is free; two repairs have none."),
        tool_reply(("L3", "assign_supply_agent", {})),                                                                       # orchestrator
        tool_reply(("P1", "get_supply_options", {})),                                                                        # Supply agent
        tool_reply(("P2", "request_parts", {"lines": [{"source": "warehouse", "quantity": 2}], "note": "two repairs due this week"})),
        text_reply("Two requested from the warehouse, two days."),
        text_reply("**Three repairs are ready for your decision.**\n\n**Parts**\n- One in the store, two arriving in 2 days (simulated)."),   # orchestrator
    ]


def test_claude_as_the_team_each_member_gets_its_own_prompt_and_tools(settings):
    llm = ScriptedLLM(team_script())
    svc = with_claude(settings, llm)
    svc.set_stock(values={"store": 1})
    run = review(svc, list_size=3)
    assert run["mode"] == "claude" and run["final_text"].startswith("**Three repairs are ready") and len(llm.script) == 0
    seen = [(r["system"][:60], [t["name"] for t in r["tools"]]) for r in llm.requests]
    assert seen[0] == (prompts.LEAD[:60], tools.names("lead")) and seen[1] == (prompts.SYSTEM[:60], tools.TOOL_NAMES)
    assert seen[5] == (prompts.STOCK[:60], tools.names("stock")) and seen[9] == (prompts.SUPPLY[:60], tools.names("supply")) and seen[12][0] == prompts.LEAD[:60]
    assert "3 repairs" in llm.requests[5]["messages"][0]["content"] and "2 proposed repairs have no spare actuator" in llm.requests[9]["messages"][0]["content"]
    # what the orchestrator was told after each hand-over: a short report and the facts, never the records
    report = json.loads(llm.requests[4]["messages"][-1]["content"][0]["content"])
    assert report["agent"] == "Risk agent" and report["report"] == "Three repairs proposed." and report["facts"]["repairs_proposed"] == 3 and report["facts"]["model_ran"]
    stock = json.loads(llm.requests[8]["messages"][-1]["content"][0]["content"])
    assert stock["facts"] == {**stock["facts"], "stock_checked": True, "free_units": 1, "repairs_with_a_part": 1, "repairs_without_a_part": 2}
    supply = json.loads(llm.requests[12]["messages"][-1]["content"][0]["content"])
    assert supply["facts"]["request_filed"] and supply["facts"]["units_requested"] == 2 and supply["facts"]["arrive_after_the_repair_is_due_for"] == 0
    assert [(p["part"]["status"], p["part"]["eta_days"]) for p in repairs(svc)] == [("in_store", 0), ("requested", 2), ("requested", 2)]
    assert run["cost_usd"] == pytest.approx(sum(s["cost_usd"] for s in run["steps"])) and run["cost_usd"] > 0     # one budget for the whole team


def test_if_claude_fails_part_way_the_planners_finish_the_job(settings):
    script = team_script()[:5] + [LLMError("Claude did not answer in time")]              # fails when the Stock agent starts
    llm = ScriptedLLM(script)
    svc = with_claude(settings, llm)
    svc.set_stock(values={"store": 1})
    run = review(svc, list_size=3)
    assert run["mode"] == "claude, then built-in planner"
    assert tool_steps(run)[-6:] == [("lead", "assign_stock_agent"), ("stock", "check_stock"), ("stock", "reserve_parts"),
                                    ("lead", "assign_supply_agent"), ("supply", "get_supply_options"), ("supply", "request_parts")]
    assert [p["part"]["status"] for p in repairs(svc)] == ["in_store", "requested", "requested"] and "**Parts (simulated stock)**" in run["final_text"]
    assert any("Claude could not be used" in s["output"]["text"] and s["agent"] == "stock" for s in run["steps"] if s["type"] == "notice")


def test_the_spend_limit_is_shared_by_the_whole_team(settings):
    llm = ScriptedLLM(team_script())
    svc = with_claude(settings, llm, run_usd_limit=0.008)                                 # four paid replies and the run is over its limit
    svc.set_stock(values={"store": 1})
    run = review(svc, list_size=3)
    assert run["mode"] == "claude, then built-in planner" and any("spend limit" in s["output"]["text"] for s in run["steps"] if s["type"] == "notice")
    assert run["cost_usd"] < 0.02 and len(repairs(svc)) == 3


# ---------------------------------------------------------------------------- the HTTP API
@pytest.fixture
def client(svc):
    return TestClient(create_app(svc))


def http_review(client, **body):
    started = client.post("/api/agent/runs", json={"batch_id": SAMPLE_ID, "kind": "review", **body})
    assert started.status_code == 202
    for _ in range(400):
        run = client.get(f"/api/agent/runs/{started.json()['run_id']}").json()
        if run["status"] != "running":
            return run
    raise AssertionError("the run did not finish")


def test_a_review_through_the_api_is_done_by_the_team_unless_asked_otherwise(client):
    run = http_review(client, list_size=6)
    assert run["context"]["team"] is True and {s["agent"] for s in run["steps"] if s["type"] == "tool"} == {"lead", "risk", "stock"}
    alone = http_review(client, list_size=6, team=False)
    assert alone["context"]["team"] is False and {s["agent"] for s in alone["steps"]} == {None}
    question = client.post("/api/agent/runs", json={"batch_id": SAMPLE_ID, "kind": "question", "question": "How sure is the model?"})
    assert question.status_code == 202


def test_stock_controls_and_the_parts_request_over_http(client):
    health = client.get("/api/health").json()
    assert health["stock"] == {**health["stock"], "store": 12, "warehouse": 8, "free": 12, "simulated": True, "simulated_outage": False}
    assert client.post("/api/demo/stock", json={"preset": "none"}).json()["supplier_available"] is False
    assert client.post("/api/demo/stock", json={"preset": "nonsense"}).status_code == 400
    changed = client.post("/api/demo/stock", json={"store": 4, "warehouse": 9999, "warehouse_days": 0, "supplier_available": True}).json()
    assert (changed["store"], changed["warehouse"], changed["warehouse_days"], changed["supplier_available"]) == (4, 500, 1, True)     # kept inside sensible limits
    assert client.post("/api/demo/stock", json={"outage": True}).json()["simulated_outage"] is True
    assert client.get("/api/demo/stock").json()["store"] == 4                               # the Demo menu still reads it during an outage
    client.post("/api/demo/stock", json={"outage": False, "preset": "short"})
    http_review(client, list_size=25)
    (request,) = client.get("/api/parts-requests", params={"batch_id": SAMPLE_ID}).json()
    decided = client.post(f"/api/parts-requests/{request['id']}/decision", json={"decision": "approved"})
    assert decided.status_code == 200 and decided.json()["status"] == "approved"
    assert client.post(f"/api/parts-requests/{request['id']}/decision", json={"decision": "rejected"}).status_code == 409
    assert client.post("/api/parts-requests/PR-SIM-9999/decision", json={"decision": "approved"}).status_code == 404
    assert client.post(f"/api/parts-requests/{request['id']}/decision", json={"decision": "maybe"}).status_code == 400


def test_a_rejection_keeps_the_planners_reason(client):
    http_review(client, list_size=4)
    first, second = client.get(f"/api/batches/{SAMPLE_ID}/proposals").json()[:2]
    rejected = client.post(f"/api/proposals/{first['id']}/decision", json={"decision": "rejected", "note": "No stock available"}).json()
    assert rejected["status"] == "rejected" and rejected["decision_note"] == "No stock available" and rejected["part"]["status"] == "in_store"
    approved = client.post(f"/api/proposals/{second['id']}/decision", json={"decision": "approved", "note": "  at the next stop  "}).json()
    assert approved["work_order_id"] == "WO-SIM-0001" and approved["decision_note"] == "at the next stop"
    listed = {p["id"]: p for p in client.get(f"/api/batches/{SAMPLE_ID}/proposals").json()}
    assert listed[first["id"]]["decision_note"] == "No stock available"
    many = client.post(f"/api/batches/{SAMPLE_ID}/proposals/decision", json={"decision": "rejected", "note": "No hangar slot this week"}).json()
    assert many and all(p["decision_note"] == "No hangar slot this week" for p in many)
