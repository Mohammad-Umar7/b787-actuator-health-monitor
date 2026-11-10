"""The tools the agent can call, and nothing else it can do.

Every tool reads or writes the batch the run was started on, so the agent never has to pass a batch ID and can
never reach another batch. Results are small JSON summaries: the records themselves stay on the server, which
keeps each request to the language model short and cheap.

No tool executes a maintenance action. `propose_actions` only files proposals for a person to approve.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from ..batches import Batch, BatchStore, jsonable
from ..model import ACTIONS, ModelUnavailable, RiskModel
from ..store import Store

MAX_LIST = 30
MAX_PROPOSALS = 60
PROPOSABLE = ("repair", "inspect", "retest")
LEVELS = ("High", "Medium", "Low", "Not scored", "Any")

_NO_INPUT = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}

TOOLS = [
    {
        "name": "check_records",
        "description": (
            "Check the quality of the records under review before predicting: how many are complete, which readings "
            "are missing or unusable, and which records cannot be scored at all. Call this first in every review, so "
            "missing information is reported to the planner rather than discovered later."),
        "input_schema": _NO_INPUT,
    },
    {
        "name": "run_failure_model",
        "description": (
            "Run the trained Stage 2 actuator failure model on the records under review. For each record it predicts "
            "whether the nose landing gear actuator will fail within 30 days (Yes or No) with a risk percentage. Returns "
            "counts by risk level and the highest-risk records. This is the only source of predictions: if it returns "
            "an error there are no predictions, and none may be estimated or assumed."),
        "input_schema": _NO_INPUT,
    },
    {
        "name": "list_records",
        "description": (
            "List scored records, highest risk first, to choose which ones to act on. Use it to read beyond the top "
            "records that run_failure_model returned, to look at one risk level, or to find records with missing readings."),
        "input_schema": {
            "type": "object",
            "properties": {
                "level": {"type": "string", "enum": list(LEVELS), "description": "Risk level to list. Use Any for all levels."},
                "only_missing_readings": {"type": "boolean", "description": "True to list only records with a missing or unusable reading."},
                "limit": {"type": "integer", "description": f"How many records to return, at most {MAX_LIST}."},
                "offset": {"type": "integer", "description": "How many records to skip from the top. Use 0 to start at the highest risk."},
            },
            "required": ["level", "only_missing_readings", "limit", "offset"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_record",
        "description": (
            "Get everything known about one record: its readings compared with a new actuator, what drives its risk, how "
            "often similar readings were followed by a failure in the training data, and any data problems. Use it when "
            "the planner asks about a specific aircraft, or before recommending an action on a borderline or incomplete record."),
        "input_schema": {
            "type": "object",
            "properties": {"record_id": {"type": "string", "description": "The record ID exactly as returned by the other tools."}},
            "required": ["record_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_model_track_record",
        "description": (
            "Get the model's validation results on aircraft it never saw in training: F1, precision, recall, how many real "
            "failures were flagged in time, and how soon aircraft at each risk level typically failed. Use it when the "
            "planner asks how far the predictions can be trusted, or to state the limits of a recommendation."),
        "input_schema": _NO_INPUT,
    },
    {
        "name": "propose_actions",
        "description": (
            "File proposed maintenance actions for the planner to approve or reject in the dashboard. This does not "
            "execute anything: no work order exists until a person approves. Call it once, after the model has run, with "
            "every action you recommend. Use 'repair' to schedule a repair, 'inspect' to plan an inspection, and 'retest' "
            "to repeat the diagnostic test when a key reading is missing. Records that need no action are simply left out."),
        "input_schema": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "description": f"The proposed actions, most urgent first. At most {MAX_PROPOSALS}.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "record_id": {"type": "string", "description": "The record ID exactly as returned by the other tools."},
                            "action": {"type": "string", "enum": list(PROPOSABLE)},
                            "note": {"type": "string", "description": "One short sentence for the planner: why this action, in plain words. Empty if the model's reason says it all."},
                        },
                        "required": ["record_id", "action", "note"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["actions"],
            "additionalProperties": False,
        },
    },
]
TOOL_NAMES = [t["name"] for t in TOOLS]


def definitions(strict: bool) -> list:
    """Tool definitions for the API. With strict on, the API guarantees the arguments match the schema."""
    return [{**tool, "strict": True} for tool in TOOLS] if strict else [dict(tool) for tool in TOOLS]


class ToolError(Exception):
    """A tool could not do what was asked. The text goes back to the agent as an error result."""


@dataclass
class ToolContext:
    batches: BatchStore
    model: RiskModel
    store: Store
    batch: Batch
    run_id: str
    scope_ids: list | None = None        # records the user selected; None means the whole batch
    list_size: int = 25
    calls: dict = field(default_factory=dict)   # tool name -> list of {"args", "result", "is_error"}; read by the offline planner


def execute(name: str, args, ctx: ToolContext) -> tuple[str, bool]:
    """Run one tool call. Returns the result as JSON text, and whether it is an error. Never raises."""
    canonical = next((t for t in TOOL_NAMES if t.lower() == str(name).lower()), None)   # tolerate a letter-case slip
    if canonical is None:
        return json.dumps({"error": f"Unknown tool '{name}'. Available tools: {', '.join(TOOL_NAMES)}."}), True
    try:
        if not isinstance(args, dict):
            raise ToolError("The tool input must be a JSON object.")
        payload = _HANDLERS[canonical](args, ctx)
        result, is_error = payload, False
    except ModelUnavailable as err:
        result, is_error = {"error": "MODEL_UNAVAILABLE", "message": str(err),
                            "instruction": "No predictions exist for these records. Do not estimate or assume any risk. "
                                           "Tell the planner the model call failed and that they can retry."}, True
    except ToolError as err:
        result, is_error = {"error": str(err)}, True
    except Exception as err:  # a bug in a tool must reach the log and the agent, not crash the run
        result, is_error = {"error": f"The tool failed unexpectedly ({type(err).__name__}: {err})."}, True
    result = jsonable(result)
    ctx.calls.setdefault(canonical, []).append({"args": args, "result": result, "is_error": is_error})
    # allow_nan=False: a tool result must be strict JSON, or the run stops here rather than send something malformed.
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False), is_error


# ---------------------------------------------------------------------------- handlers
def _scope_note(ctx: ToolContext) -> str:
    return f"{len(ctx.scope_ids)} records selected by the planner" if ctx.scope_ids else "all records in the batch"


def _check_records(_args, ctx: ToolContext) -> dict:
    batch, t = ctx.batch, ctx.batches.table(ctx.batch)
    if ctx.scope_ids:
        t = t[t["record_id"].isin(ctx.scope_ids)]
    if t.empty:
        raise ToolError("None of the selected records are in this batch.")
    issues = {rid: batch.checked.issues.get(rid, []) for rid in t["record_id"]}
    by_reading: dict = {}
    for notes in issues.values():
        for note in notes:
            if note.startswith("Both key readings"):
                continue
            label = note.split(" is ")[0]
            kind = "missing" if note.endswith("is missing.") else "unusable (treated as missing)"
            by_reading.setdefault(label, {}).setdefault(kind, 0)
            by_reading[label][kind] += 1
    not_scorable = t[~t["scorable"]]
    examples = [{"record_id": r["record_id"], "aircraft": r["aircraft_id"], "problems": issues[r["record_id"]]}
                for r in not_scorable.head(5).to_dict("records")]
    return {
        "batch": batch.name, "scope": _scope_note(ctx), "records": int(len(t)),
        "complete": int((t["issues"] == 0).sum()), "with_missing_or_unusable_readings": int((t["issues"] > 0).sum()),
        "cannot_be_scored": int(len(not_scorable)), "by_reading": by_reading,
        "cannot_be_scored_examples": examples, "file_notes": batch.checked.notes,
        "how_missing_readings_are_handled": "The model was trained with missing readings and still predicts when one is absent. "
                                            "A record missing both key readings (actuation time and leakage) is not scored; it needs a repeat test.",
    }


def _run_failure_model(_args, ctx: ToolContext) -> dict:
    ctx.batches.score(ctx.batch)                     # raises ModelUnavailable
    summary = ctx.batches.summary(ctx.batch, ctx.scope_ids)
    top = ctx.batches.rows(ctx.batch, ids=ctx.scope_ids, limit=10)["rows"]
    return {
        "model_version": ctx.model.version, "yes_from_risk_percent": ctx.model.cutoff, "medium_from_risk_percent": ctx.model.medium,
        "scope": _scope_note(ctx), "scored": summary["records"] - summary["not_scorable"], "not_scored": summary["not_scorable"],
        "by_level": summary["levels"], "predicted_yes": summary["levels"]["High"],
        "expected_failures_in_30_days": summary["expected_failures"],
        "high_risk_missing_a_key_reading": summary["high_missing_key_reading"],
        "medium_risk_missing_a_key_reading": summary["medium_missing_key_reading"],
        "highest_risk": [_agent_row(r) for r in top],
        "reading_the_result": "High means the model predicts Yes (failure within 30 days). A Yes is a reason to review, not a confirmed "
                              "failure, and a No does not guarantee safety.",
    }


def _agent_row(row: dict) -> dict:
    out = {"record_id": row["record_id"], "aircraft": row["aircraft_id"], "level": row["level"]}
    if row.get("risk") is not None:
        out["risk_percent"] = int(row["risk"])        # whole percent, rounded down, exactly as the dashboard shows it
    for key in ("reason", "time_left", "suggested_action"):
        if row.get(key):
            out["typically_fails_in" if key == "time_left" else key] = row[key]
    if row["issues"]:
        out["data_problems"] = row["issues"]
    return out


def _need_results(ctx: ToolContext) -> None:
    if not ctx.batch.scored:
        raise ToolError("The model has not produced results for this batch. Call run_failure_model first; if it failed, there are no predictions to use.")


def _list_records(args, ctx: ToolContext) -> dict:
    _need_results(ctx)
    level = args.get("level", "Any")
    if level not in LEVELS:
        raise ToolError(f"level must be one of {', '.join(LEVELS)}.")
    limit = max(1, min(int(args.get("limit", 10) or 10), MAX_LIST))
    offset = max(0, int(args.get("offset", 0) or 0))
    page = ctx.batches.rows(ctx.batch, level=level, only_issues=bool(args.get("only_missing_readings")), ids=ctx.scope_ids, offset=offset, limit=limit)
    return {"matching": page["total"], "offset": offset, "returned": len(page["rows"]), "records": [_agent_row(r) for r in page["rows"]]}


def _get_record(args, ctx: ToolContext) -> dict:
    record_id = str(args.get("record_id", "")).strip()
    detail = ctx.batches.detail(ctx.batch, record_id)
    if detail is None:
        raise ToolError(f"No record '{record_id}' in this batch. Use the record_id exactly as another tool returned it.")
    out = {"record_id": record_id, "aircraft": detail["aircraft_id"], "date": detail["date"], "data_problems": detail["issues"]}
    if not detail["scored"]:
        out["model_result"] = "none yet: the model has not run on this batch"
        return out
    if not detail["scorable"]:
        out["model_result"] = "not scored: both key readings are missing, so no prediction was made"
        out["suggested_action"] = "retest"
        return out
    ev = detail["evidence"]
    seen = lambda e, what: f"{e['failed']} of {e['n']} training records with {what} were followed by a failure within 30 days" if e else None
    out.update({
        "prediction": detail["prediction"], "risk_percent": int(detail["risk"]), "level": detail["level"], "reason": detail["reason"],
        "typically_fails_in": detail["time_left"], "confidence": detail["confidence"], "suggested_action": detail["suggested_action"],
        "operation_time": {"level": detail["readings"]["operation"]["level_name"], "compared_with_new": detail["readings"]["operation"]["text"]},
        "leakage": {"level": detail["readings"]["leakage"]["level_name"], "compared_with_failure_level": detail["readings"]["leakage"]["text"]},
        "pressure_variation_psi": detail["readings"]["pressure_variation"]["value"],
        "share_of_added_risk_percent": {f["name"]: f["share"] for f in detail["factors"]},
        "history_of_similar_records": [s for s in (seen(ev.get("pair"), "the same operation time and leakage levels"),
                                                    seen(ev.get("op"), "this operation time level"), seen(ev.get("leak"), "this leakage level")) if s],
        "records_at_this_risk": f"{detail['band']['in_30_days']}% failed within 30 days and {detail['band']['in_12_weeks']}% within 12 weeks "
                                f"({detail['band']['n']} past records)",
    })
    open_proposal = next((p for p in ctx.store.list_proposals(batch_id=ctx.batch.id) if p["record_id"] == record_id and p["status"] in ("pending", "approved")), None)
    if open_proposal:
        out["existing_proposal"] = {"action": open_proposal["action"], "status": open_proposal["status"]}
    return out


def _get_model_track_record(_args, ctx: ToolContext) -> dict:
    v, t = ctx.model.reference.get("validation", {}), ctx.model.reference.get("training", {})
    return {
        "validated_how": v.get("method"), "trained_on": f"{t.get('rows')} weekly records from {t.get('aircraft')} aircraft, {t.get('from')} to {t.get('to')}",
        "f1_percent": v.get("f1"), "precision_percent": v.get("precision"), "recall_percent": v.get("recall"), "accuracy_percent": v.get("accuracy"),
        "failures_flagged_in_their_final_30_days": f"{v.get('caught')} of {v.get('failures')}",
        "typical_first_flag_weeks_before_failure": v.get("lead_weeks"),
        "false_alarm_records_that_failed_within_12_weeks_percent": v.get("false_alarms_early"),
        "what_each_risk_range_has_meant": [{"risk_percent": f"{b['from']:g} to {min(b['to'], 100):g}", "failed_within_30_days_percent": b["in_30_days"],
                                            "failed_within_12_weeks_percent": b["in_12_weeks"], "typically_fails_in": ctx.model.time_left((b["from"] + min(b["to"], 100)) / 2)}
                                           for b in ctx.model.reference.get("timeframe", [])],
        "limits": ["Each prediction uses one diagnostic record, not the actuator's history, so readings four and six weeks before a failure look alike.",
                   "About one in three Yes predictions does not fail within 30 days; most of those fail within the following two months.",
                   "The data is synthetic and for this hackathon. It is not guidance for real aircraft maintenance."],
    }


def _propose_actions(args, ctx: ToolContext) -> dict:
    _need_results(ctx)
    actions = args.get("actions")
    if not isinstance(actions, list) or not actions:
        raise ToolError("actions must be a non-empty list.")
    if len(actions) > MAX_PROPOSALS:
        raise ToolError(f"At most {MAX_PROPOSALS} actions can be proposed in one call. Propose the most urgent ones.")
    table = ctx.batches.table(ctx.batch).set_index("record_id")
    items, rejected, seen = [], [], set()
    for entry in actions:
        record_id = str((entry or {}).get("record_id", "")).strip()
        action = str((entry or {}).get("action", "")).strip().lower()
        if record_id in seen:
            continue
        seen.add(record_id)
        if record_id not in table.index:
            rejected.append({"record_id": record_id, "why": "no such record in this batch"})
        elif ctx.scope_ids and record_id not in ctx.scope_ids:
            rejected.append({"record_id": record_id, "why": "outside the records the planner selected"})
        elif action not in PROPOSABLE:
            rejected.append({"record_id": record_id, "why": f"action must be one of {', '.join(PROPOSABLE)}"})
        elif table.loc[record_id, "level"] == "Not scored" and action != "retest":
            rejected.append({"record_id": record_id, "why": "this record has no prediction; only 'retest' can be proposed for it"})
        else:
            row = jsonable(table.loc[record_id].to_dict())
            items.append({"record_id": record_id, "aircraft_id": row["aircraft_id"], "action": action,
                          "note": str((entry or {}).get("note") or "").strip()[:300], "reason": row["reason"],
                          "risk": row["risk"], "level": row["level"], "time_left": row["time_left"]})
    stored = ctx.store.add_proposals(ctx.run_id, ctx.batch.id, items) if items else {"created": [], "replaced": 0, "skipped": []}
    by_action: dict = {}
    for item in items:
        if not any(s["record_id"] == item["record_id"] for s in stored["skipped"]):
            by_action[ACTIONS[item["action"]]] = by_action.get(ACTIONS[item["action"]], 0) + 1
    return {
        "filed_for_review": len(stored["created"]), "by_action": by_action, "replaced_earlier_pending_proposals": stored["replaced"],
        "not_filed": rejected + stored["skipped"],
        "status": "Nothing has been executed. Each proposal waits for the planner to approve or reject it in the dashboard.",
    }


_HANDLERS = {
    "check_records": _check_records,
    "run_failure_model": _run_failure_model,
    "list_records": _list_records,
    "get_record": _get_record,
    "get_model_track_record": _get_model_track_record,
    "propose_actions": _propose_actions,
}
