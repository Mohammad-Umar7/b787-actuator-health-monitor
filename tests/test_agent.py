"""The agent, tested end to end without an API key: the tools, the loop, the built-in planner, scripted
stand-ins for Claude, and the real Anthropic SDK pointed at a fake endpoint."""
import json

import anthropic
import httpx2
import pytest

from acumain.agent import tools
from acumain.agent.llm import ClaudeLLM, LLMError, ScriptedLLM, text_reply, tool_reply
from acumain.services import SAMPLE_ID

from conftest import with_claude


def context(svc, **kwargs):
    run_id = svc.store.create_run("review", "test", SAMPLE_ID, "test", "test", {})
    return tools.ToolContext(batches=svc.batches, model=svc.model, store=svc.store, batch=svc.batch(SAMPLE_ID), run_id=run_id, **kwargs)


def call(name, args, ctx):
    content, is_error = tools.execute(name, args, ctx)
    return json.loads(content), is_error


def finished(svc, run_id):
    run = svc.store.get_run(run_id)
    assert run["status"] != "running"
    return run


# ---------------------------------------------------------------------------- tools
def test_check_records_reports_what_is_missing(svc):
    result, is_error = call("check_records", {}, context(svc))
    assert not is_error and result["records"] == 2000 and result["cannot_be_scored"] == 8
    assert result["with_missing_or_unusable_readings"] == 448 and result["by_reading"]["Actuation time"]["missing"] == 89
    assert len(result["cannot_be_scored_examples"]) == 5


def test_model_tool_scores_the_batch_and_summarises(svc):
    ctx = context(svc)
    result, is_error = call("run_failure_model", {}, ctx)
    assert not is_error and result["by_level"] == {"High": 203, "Medium": 144, "Low": 1645, "Not scored": 8}
    assert result["predicted_yes"] == 203 and result["scored"] == 1992 and len(result["highest_risk"]) == 10
    assert result["highest_risk"][0]["risk_percent"] >= result["highest_risk"][-1]["risk_percent"] and svc.batch(SAMPLE_ID).scored
    assert len(json.dumps(result)) < 3500          # stays small: the records themselves never go to the language model


def test_model_failure_is_an_error_result_with_no_numbers(svc):
    svc.model.simulated_outage = True
    result, is_error = call("run_failure_model", {}, context(svc))
    assert is_error and result["error"] == "MODEL_UNAVAILABLE" and "Do not estimate" in result["instruction"]
    assert not svc.batch(SAMPLE_ID).scored


def test_reading_tools_need_results_first(svc):
    ctx = context(svc)
    for name, args in (("list_records", {"level": "High", "only_missing_readings": False, "limit": 5, "offset": 0}),
                       ("propose_actions", {"actions": [{"record_id": "Q-18857260", "action": "repair", "note": ""}]})):
        result, is_error = call(name, args, ctx)
        assert is_error and "run_failure_model first" in result["error"]


def test_list_and_get_record(svc):
    ctx = context(svc)
    call("run_failure_model", {}, ctx)
    page, _ = call("list_records", {"level": "High", "only_missing_readings": False, "limit": 500, "offset": 0}, ctx)
    assert page["matching"] == 203 and page["returned"] == tools.MAX_LIST            # the cap holds whatever is asked for
    second, _ = call("list_records", {"level": "High", "only_missing_readings": False, "limit": 5, "offset": 30}, ctx)
    assert second["records"][0]["risk_percent"] <= page["records"][-1]["risk_percent"]
    unscored, _ = call("list_records", {"level": "Not scored", "only_missing_readings": False, "limit": 10, "offset": 0}, ctx)
    assert unscored["matching"] == 8 and unscored["records"][0]["suggested_action"] == "retest"
    bad, is_error = call("list_records", {"level": "Critical", "only_missing_readings": False, "limit": 5, "offset": 0}, ctx)
    assert is_error and "level must be one of" in bad["error"]
    top = page["records"][0]["record_id"]
    detail, _ = call("get_record", {"record_id": top}, ctx)
    assert detail["prediction"] == "Yes" and detail["history_of_similar_records"] and "failed within 30 days" in detail["records_at_this_risk"]
    missing, is_error = call("get_record", {"record_id": "NOPE"}, ctx)
    assert is_error and "No record 'NOPE'" in missing["error"]
    no_prediction, _ = call("get_record", {"record_id": unscored["records"][0]["record_id"]}, ctx)
    assert "not scored" in no_prediction["model_result"] and "risk_percent" not in no_prediction


def test_propose_actions_checks_every_item(svc):
    ctx = context(svc)
    call("run_failure_model", {}, ctx)
    unscored = svc.batches.rows(svc.batch(SAMPLE_ID), level="Not scored", limit=1)["rows"][0]["record_id"]
    result, is_error = call("propose_actions", {"actions": [
        {"record_id": "Q-18857260", "action": "repair", "note": "Highest risk in the fleet."},
        {"record_id": "Q-18857260", "action": "inspect", "note": "duplicate, ignored"},
        {"record_id": "Q-73316018", "action": "replace", "note": ""},
        {"record_id": "NOPE", "action": "repair", "note": ""},
        {"record_id": unscored, "action": "repair", "note": ""},
        {"record_id": unscored + "x", "action": "retest", "note": ""}]}, ctx)
    assert not is_error and result["filed_for_review"] == 1 and result["by_action"] == {"Schedule repair": 1}
    assert len(result["not_filed"]) == 4 and "Nothing has been executed" in result["status"]
    pending = svc.store.list_proposals(batch_id=SAMPLE_ID, status="pending")
    assert len(pending) == 1 and pending[0]["reason"] and pending[0]["risk"] > 90 and svc.store.list_work_orders() == []
    too_many, is_error = call("propose_actions", {"actions": [{"record_id": f"X{i}", "action": "repair", "note": ""} for i in range(61)]}, ctx)
    assert is_error and "At most 60" in too_many["error"]


def test_selected_records_limit_every_tool(svc):
    chosen = ["Q-18857260", "Q-10012035", "Q-10019530"]
    ctx = context(svc, scope_ids=chosen)
    assert call("check_records", {}, ctx)[0]["records"] == 3
    result, _ = call("run_failure_model", {}, ctx)
    assert result["scored"] == 3 and sum(result["by_level"].values()) == 3
    outside, _ = call("propose_actions", {"actions": [{"record_id": "Q-73316018", "action": "repair", "note": ""}]}, ctx)
    assert outside["filed_for_review"] == 0 and "outside the records the planner selected" in outside["not_filed"][0]["why"]


def test_tool_names_tolerate_case_and_unknown_tools_are_errors(svc):
    ctx = context(svc)
    assert call("Check_Records", {}, ctx)[1] is False
    result, is_error = call("delete_everything", {}, ctx)
    assert is_error and "Unknown tool" in result["error"]
    result, is_error = call("get_record", "not an object", ctx)
    assert is_error and "JSON object" in result["error"]


def test_tool_schemas_are_valid_for_strict_mode():
    def walk(schema):
        if schema.get("type") == "object":
            assert schema["additionalProperties"] is False and set(schema["required"]) == set(schema["properties"])
            for child in schema["properties"].values():
                walk(child)
        if schema.get("type") == "array":
            walk(schema["items"])
        assert not {"minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"} & set(schema)   # not supported with strict
    for tool in tools.definitions(True):
        assert len(tool["description"]) > 80
        assert tool.get("strict", False) is bool(tool["input_schema"]["properties"])      # nothing to be strict about without inputs
        walk(tool["input_schema"])
    assert all("strict" not in tool for tool in tools.definitions(False))


# ---------------------------------------------------------------------------- built-in planner, end to end
def test_offline_review_runs_the_whole_workflow_for_free(svc):
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=25, wait=True))
    assert run["status"] == "completed" and run["mode"] == "built-in planner" and run["cost_usd"] == 0
    called = [s["name"] for s in run["steps"] if s["type"] == "tool"]
    assert called == ["check_records", "run_failure_model", "list_records", "list_records", "propose_actions"]
    assert len(run["proposals"]) == 25 and {p["action"] for p in run["proposals"]} == {"repair", "retest"}
    assert sum(p["action"] == "retest" for p in run["proposals"]) == 3
    assert all(p["status"] == "pending" for p in run["proposals"]) and svc.store.list_work_orders() == []
    text = run["final_text"]
    assert "203 of the 1,992 scored aircraft are" in text and "**Proposed for your approval**" in text and "181 more High-risk aircraft" in text and "built-in planner" in text
    assert any(s["type"] == "notice" and "No API key" in s["output"]["text"] for s in run["steps"])


def test_offline_review_when_the_model_is_down_proposes_nothing(svc):
    svc.model.simulated_outage = True
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", wait=True))
    failed = [s for s in run["steps"] if s["type"] == "tool" and s["is_error"]]
    assert [s["name"] for s in failed] == ["run_failure_model"] and failed[0]["output"]["error"] == "MODEL_UNAVAILABLE"
    assert run["status"] == "completed" and run["proposals"] == [] and "no predictions" in run["final_text"] and "Try again" in run["final_text"]
    assert not svc.batch(SAMPLE_ID).scored


def test_offline_review_of_selected_records(svc):
    chosen = ["Q-18857260", "Q-10012035", "Q-10019530"]
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", record_ids=chosen + ["not-there"], wait=True))
    assert run["context"]["record_ids"] == chosen and [p["record_id"] for p in run["proposals"]] == ["Q-18857260"]


def test_offline_question_about_the_open_record(svc):
    svc.start_run(SAMPLE_ID, "review", wait=True)
    run = finished(svc, svc.start_run(SAMPLE_ID, "question", question="Why is this one first?", selected="Q-18857260", wait=True))
    assert [s["name"] for s in run["steps"] if s["type"] == "tool"] == ["get_record"]
    assert "High risk" in run["final_text"] and "Free-text questions need the Claude connection" in run["final_text"]


# ---------------------------------------------------------------------------- the loop, with scripted stand-ins for Claude
REVIEW_SCRIPT = lambda: [
    tool_reply(("t1", "check_records", {}), ("t2", "run_failure_model", {}), text="Checking the data and running the model."),
    tool_reply(("t3", "propose_actions", {"actions": [{"record_id": "Q-18857260", "action": "repair", "note": "Highest risk."},
                                                       {"record_id": "Q-73316018", "action": "repair", "note": ""}]})),
    text_reply("**203 aircraft are predicted to fail.** Two repairs are proposed."),
]


def test_scripted_run_returns_parallel_tool_results_in_one_message(settings):
    llm = ScriptedLLM(REVIEW_SCRIPT())
    svc = with_claude(settings, llm)
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=2, wait=True))
    assert run["status"] == "completed" and run["mode"] == "claude" and len(run["proposals"]) == 2
    assert run["final_text"].startswith("**203 aircraft") and run["input_tokens"] == 900 + 900 + 1200 and round(run["cost_usd"], 4) == 0.0087
    second = llm.requests[1]["messages"]
    assert [m["role"] for m in second] == ["user", "assistant", "user"]
    results = second[2]["content"]
    assert [r["tool_use_id"] for r in results] == ["t1", "t2"] and all(r["type"] == "tool_result" for r in results)
    assert second[1]["content"] == REVIEW_SCRIPT()[0].content                 # the assistant turn goes back exactly as received
    first_user = llm.requests[0]["messages"][0]["content"]
    assert "Prepare the action list" in first_user and "List size: up to 2" in first_user and "2,000 records" in first_user
    assert llm.requests[0]["system"] == llm.requests[2]["system"] and llm.requests[0]["tools"] == llm.requests[2]["tools"]   # stable prefix, so it caches


def test_tool_errors_go_back_to_the_agent_and_the_run_continues(settings):
    llm = ScriptedLLM([tool_reply(("t1", "make_coffee", {}), ("t2", "get_record", {"record_id": "NOPE"})), text_reply("Could not do that.")])
    svc = with_claude(settings, llm)
    run = finished(svc, svc.start_run(SAMPLE_ID, "question", question="Make coffee", wait=True))
    results = llm.requests[1]["messages"][2]["content"]
    assert all(r["is_error"] for r in results) and "Unknown tool" in results[0]["content"] and run["status"] == "completed"


@pytest.mark.parametrize("first, why", [
    (LLMError("the API key was rejected"), "Claude could not be used: the API key was rejected"),
    (text_reply("", stop_reason="refusal"), "Claude declined this request"),
    (text_reply("partial", stop_reason="max_tokens"), "cut off"),
])
def test_when_claude_fails_the_built_in_planner_finishes_the_job(settings, first, why):
    svc = with_claude(settings, ScriptedLLM([first]))
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=10, wait=True))
    assert run["status"] == "completed" and run["mode"] == "claude, then built-in planner" and len(run["proposals"]) == 10
    assert any(s["type"] == "notice" and why in s["output"]["text"] for s in run["steps"])


def test_claude_failing_midway_hands_over_without_repeating_work(settings):
    svc = with_claude(settings, ScriptedLLM([tool_reply(("t1", "check_records", {}), ("t2", "run_failure_model", {})), LLMError("Claude did not answer in time")]))
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=10, wait=True))
    called = [s["name"] for s in run["steps"] if s["type"] == "tool"]
    assert called.count("check_records") == 1 and called.count("run_failure_model") == 1 and called[-1] == "propose_actions"


def test_step_limit_stops_a_run_that_never_finishes(settings):
    endless = [tool_reply((f"t{i}", "check_records", {})) for i in range(20)]
    svc = with_claude(settings, ScriptedLLM(endless), max_steps=4)
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", wait=True))
    assert sum(s["type"] == "model" for s in run["steps"]) == 4 and "step limit" in run["final_text"]


def test_run_spend_limit_hands_over_to_the_free_planner(settings):
    pricey = [tool_reply(("t1", "check_records", {}), cost=0.30), tool_reply(("t2", "run_failure_model", {}), cost=0.30), text_reply("never reached")]
    svc = with_claude(settings, ScriptedLLM(pricey), run_usd_limit=0.50)
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=5, wait=True))
    assert round(run["cost_usd"], 2) == 0.60 and run["mode"] == "claude, then built-in planner"
    assert any("spend limit of $0.50" in s["output"]["text"] for s in run["steps"] if s["type"] == "notice")


def test_daily_spend_limit_keeps_claude_off(settings):
    llm = ScriptedLLM([tool_reply(("t1", "check_records", {}), cost=6.0), text_reply("done", cost=5.0)])
    svc = with_claude(settings, llm, run_usd_limit=100.0)
    svc.start_run(SAMPLE_ID, "question", question="hello", wait=True)
    status = svc.agent_status()
    assert status["mode"] == "offline" and "spend limit" in status["reason"] and status["spent_today_usd"] == 11.0
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=5, wait=True))
    assert run["mode"] == "built-in planner" and run["cost_usd"] == 0 and len(llm.requests) == 2      # Claude was not called again


def test_a_second_run_on_the_same_batch_is_refused_while_one_is_active(svc):
    from acumain.services import RequestError
    svc.store.create_run("review", "busy", SAMPLE_ID, "test", "test", {})
    with pytest.raises(RequestError) as err:
        svc.start_run(SAMPLE_ID, "review", wait=True)
    assert err.value.status == 409


# ---------------------------------------------------------------------------- the real SDK against a fake endpoint
def fake_claude(replies, seen):
    """An Anthropic client whose HTTP layer answers from `replies` and records every request in `seen`."""
    def handler(request):
        seen.append({"headers": dict(request.headers), "body": json.loads(request.content)})
        status, body = replies.pop(0)
        return httpx2.Response(status, json=body)
    return anthropic.Anthropic(api_key="dry-run-key", max_retries=0, http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler)))


def api_message(content, stop_reason="tool_use", usage=None):
    return 200, {"id": "msg_dry", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5", "content": content, "stop_reason": stop_reason,
                 "stop_sequence": None, "usage": usage or {"input_tokens": 300, "output_tokens": 50, "cache_creation_input_tokens": 1400, "cache_read_input_tokens": 0}}


API_ERROR = lambda status, kind, message: (status, {"type": "error", "error": {"type": kind, "message": message}})


def test_real_sdk_request_shape_and_reply_parsing(settings):
    seen = []
    llm = ClaudeLLM(settings)
    llm._client = fake_claude([
        api_message([{"type": "thinking", "thinking": "", "signature": "sig_1"},
                     {"type": "tool_use", "id": "toolu_1", "name": "check_records", "input": {}},
                     {"type": "tool_use", "id": "toolu_2", "name": "run_failure_model", "input": {}}]),
        api_message([{"type": "text", "text": "All done."}], stop_reason="end_turn",
                    usage={"input_tokens": 500, "output_tokens": 80, "cache_creation_input_tokens": 600, "cache_read_input_tokens": 1400}),
    ], seen)
    svc = with_claude(settings, llm)
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", wait=True))
    first, second = seen[0]["body"], seen[1]["body"]
    assert first["model"] == "claude-sonnet-5-5" and first["max_tokens"] == 4000 and first["output_config"] == {"effort": "medium"}
    assert first["fallbacks"] == "default" and seen[0]["headers"]["anthropic-beta"] == "server-side-fallback-2026-07-01"
    assert first["cache_control"] == {"type": "ephemeral"} and first["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert [t["name"] for t in first["tools"]] == tools.TOOL_NAMES
    assert [t["name"] for t in first["tools"] if t.get("strict")] == ["list_records", "get_record", "propose_actions"]
    assert "temperature" not in first and "thinking" not in first and "tool_choice" not in first          # none of these is accepted or needed
    assert second["system"] == first["system"] and second["tools"] == first["tools"]
    assistant, results = second["messages"][1], second["messages"][2]
    assert assistant["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig_1"}           # thinking goes back unchanged
    assert [r["tool_use_id"] for r in results["content"]] == ["toolu_1", "toolu_2"]
    assert run["status"] == "completed" and run["final_text"] == "All done." and run["mode"] == "claude"
    assert run["input_tokens"] == 800 and run["cache_read_tokens"] == 1400 and run["cache_write_tokens"] == 2000
    expected = (800 * 2.00 + 130 * 10.00 + 2000 * 2.50 + 1400 * 0.10) / 1_000_000
    assert abs(run["cost_usd"] - expected) < 1e-9


def test_real_sdk_optional_features_are_dropped_if_the_api_rejects_them(settings):
    seen = []
    llm = ClaudeLLM(settings)
    llm._client = fake_claude([API_ERROR(400, "invalid_request_error", "fallbacks: Extra inputs are not permitted"),
                               api_message([{"type": "text", "text": "Plain request worked."}], stop_reason="end_turn")], seen)
    reply = llm.reply("system", tools.definitions(True), [{"role": "user", "content": "hi"}])
    assert reply.text == "Plain request worked." and llm.plain and "optional request feature" in reply.notices[0]
    retry = seen[1]["body"]
    assert "fallbacks" not in retry and "cache_control" not in retry and "anthropic-beta" not in seen[1]["headers"]
    assert all("strict" not in t for t in retry["tools"]) and retry["output_config"] == {"effort": "medium"}


@pytest.mark.parametrize("status, kind, expect", [
    (401, "authentication_error", "API key was rejected"), (403, "permission_error", "does not have access"),
    (404, "not_found_error", "was not found"), (429, "rate_limit_error", "rate limit"), (529, "overloaded_error", "temporarily unavailable"),
])
def test_real_sdk_errors_become_plain_messages(settings, status, kind, expect):
    llm = ClaudeLLM(settings)
    llm._client = fake_claude([API_ERROR(status, kind, "nope")], [])
    with pytest.raises(LLMError) as err:
        llm.reply("system", tools.definitions(True), [{"role": "user", "content": "hi"}])
    assert expect in str(err.value)


def test_real_sdk_refusal_is_reported(settings):
    llm = ClaudeLLM(settings)
    body = api_message([], stop_reason="refusal")[1]
    body["stop_details"] = {"type": "refusal", "category": "general_harms", "explanation": "Declined by a safety classifier."}
    llm._client = fake_claude([(200, body)], [])
    reply = llm.reply("system", tools.definitions(True), [{"role": "user", "content": "hi"}])
    assert reply.stop_reason == "refusal" and reply.refusal == "Declined by a safety classifier."


def test_no_key_means_no_claude_client(svc):
    assert svc.claude is None and svc.agent_status()["mode"] == "offline" and "No API key" in svc.agent_status()["reason"]


# ---------------------------------------------------------------------------- found by an independent review
def test_planner_taking_over_ignores_listings_it_did_not_ask_for(settings):
    """Claude listed a filtered page from the middle of the ranking, then failed. The planner must still start from the top."""
    llm = ScriptedLLM([tool_reply(("t1", "check_records", {}), ("t2", "run_failure_model", {})),
                       tool_reply(("t3", "list_records", {"level": "Any", "only_missing_readings": True, "undecided_only": False, "limit": 15, "offset": 10})),
                       LLMError("Claude did not answer in time")])
    svc = with_claude(settings, llm)
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=12, wait=True))
    top = {r["record_id"] for r in svc.batches.rows(svc.batch(SAMPLE_ID), limit=11)["rows"]}
    assert {p["record_id"] for p in run["proposals"] if p["action"] == "repair"} == top and len(run["proposals"]) == 12


def test_preparing_the_list_again_moves_on_past_decided_records(svc):
    first = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=8, wait=True))
    svc.decide_many(SAMPLE_ID, "approved", action="repair")
    svc.decide_many(SAMPLE_ID, "rejected")
    second = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=8, wait=True))
    before, after = {p["record_id"] for p in first["proposals"]}, {p["record_id"] for p in second["proposals"]}
    assert len(before) == 8 and len(after) == 8 and not before & after
    filed = [s for s in second["steps"] if s["name"] == "propose_actions"][0]["output"]
    assert filed["filed_for_review"] == 8 and filed["not_filed"] == []
    assert "already decided on 7 of them" in second["final_text"] and "189 more High-risk aircraft" in second["final_text"]


def test_nothing_new_is_proposed_when_everything_actionable_is_decided(svc):
    chosen = ["Q-18857260", "Q-10012035"]
    svc.start_run(SAMPLE_ID, "review", record_ids=chosen, wait=True)
    svc.decide_many(SAMPLE_ID, "approved")
    again = finished(svc, svc.start_run(SAMPLE_ID, "review", record_ids=chosen, wait=True))
    assert again["proposals"] == [] and "already has a decision from you" in again["final_text"]


def test_a_400_that_is_not_about_an_optional_feature_is_a_real_error(settings):
    seen = []
    llm = ClaudeLLM(settings)
    llm._client = fake_claude([API_ERROR(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")], seen)
    with pytest.raises(LLMError) as err:
        llm.reply("system", tools.definitions(True), [{"role": "user", "content": "hi"}])
    assert "credit balance" in str(err.value) and not llm.plain and len(seen) == 1


def test_optional_features_are_never_dropped_in_the_middle_of_a_run(settings):
    seen = []
    llm = ClaudeLLM(settings)
    llm._client = fake_claude([API_ERROR(400, "invalid_request_error", "tools.0.strict: Extra inputs are not permitted")], seen)
    history = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}, {"role": "user", "content": "more"}]
    with pytest.raises(LLMError):
        llm.reply("system", tools.definitions(True), history)
    assert not llm.plain and len(seen) == 1


def test_later_runs_say_when_optional_features_are_off(settings):
    seen = []
    llm = ClaudeLLM(settings)
    llm._client = fake_claude([API_ERROR(400, "invalid_request_error", "fallbacks: Extra inputs are not permitted"),
                               api_message([{"type": "text", "text": "one"}], stop_reason="end_turn"),
                               api_message([{"type": "text", "text": "two"}], stop_reason="end_turn")], seen)
    llm.reply("system", tools.definitions(True), [{"role": "user", "content": "first run"}])
    again = llm.reply("system", tools.definitions(True), [{"role": "user", "content": "second run"}])
    assert again.text == "two" and "optional request feature" in again.notices[0] and "fallbacks" not in seen[2]["body"]


def test_a_reply_that_cannot_be_read_hands_over_instead_of_failing(settings):
    llm = ClaudeLLM(settings)
    llm._client = anthropic.Anthropic(api_key="dry-run-key", max_retries=0, http_client=anthropic.DefaultHttpxClient(
        transport=httpx2.MockTransport(lambda request: httpx2.Response(200, text="<html>a gateway page, not an API reply</html>"))))
    svc = with_claude(settings, llm)
    run = finished(svc, svc.start_run(SAMPLE_ID, "review", list_size=5, wait=True))
    assert run["status"] == "completed" and run["mode"] == "claude, then built-in planner" and len(run["proposals"]) == 5
    assert any("could not be used" in s["output"]["text"] for s in run["steps"] if s["type"] == "notice")
