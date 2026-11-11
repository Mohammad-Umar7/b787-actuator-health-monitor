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
from ..stock import PART, SOURCES, SimulatedStock, StockUnavailable
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
            "records that run_failure_model returned, to look at one risk level, or to find records with missing readings. "
            "Each record shows any decision the planner has already taken on it."),
        "input_schema": {
            "type": "object",
            "properties": {
                "level": {"type": "string", "enum": list(LEVELS), "description": "Risk level to list. Use Any for all levels."},
                "only_missing_readings": {"type": "boolean", "description": "True to list only records with a missing or unusable reading."},
                "undecided_only": {"type": "boolean", "description": "True to leave out records the planner has already approved or rejected an action for. "
                                                                     "Use true when choosing what to propose, so a new list moves on to the next records."},
                "limit": {"type": "integer", "description": f"How many records to return, at most {MAX_LIST}."},
                "offset": {"type": "integer", "description": "How many records to skip from the top. Use 0 to start at the highest risk."},
            },
            "required": ["level", "only_missing_readings", "undecided_only", "limit", "offset"],
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

# ---------------------------------------------------------------------------- the team's other tools
# In a team review the tools above belong to the Risk agent. The Stock agent, the Supply agent and the
# orchestrator each get their own short list, and an agent can call nothing outside its list.
_SIMULATED = "The stock and the supply department are simulated for this demonstration; nothing is connected to a real inventory system."

STOCK_TOOLS = [
    {
        "name": "check_stock",
        "description": (
            "Read the spare-parts store for the nose landing gear actuator: units in the hangar store, units already set "
            "aside for approved work orders, units free now, and how many proposed repairs are waiting for a part. Call "
            "it first. " + _SIMULATED + " If it returns an error, nothing is known about parts and nothing may be assumed."),
        "input_schema": _NO_INPUT,
    },
    {
        "name": "reserve_parts",
        "description": (
            "Set the free units in the hangar store aside for the proposed repairs, most urgent first, and mark the "
            "repairs that are left without a part. Call it once, after check_stock. A unit is only taken from the "
            "store when the planner approves the repair."),
        "input_schema": _NO_INPUT,
    },
]

SUPPLY_TOOLS = [
    {
        "name": "get_supply_options",
        "description": (
            "List where more spare actuators can come from and how long each source takes: the central warehouse "
            "(limited units, a few days), a supplier order (longer), or a backorder with no delivery date. Also returns "
            "how many units are needed and when the repairs waiting for them are due. Call it first. " + _SIMULATED),
        "input_schema": _NO_INPUT,
    },
    {
        "name": "request_parts",
        "description": (
            "File one parts request to the supply department for the repairs that have no part. Give one line per "
            "source with the quantity to take from it. Units are matched to repairs most urgent first, fastest source "
            "first. The result says how many parts arrive in time and how many arrive after the repair is due. This "
            "orders nothing: the request waits for the planner's approval."),
        "input_schema": {
            "type": "object",
            "properties": {
                "lines": {
                    "type": "array",
                    "description": "One line per source. Together they should cover the units needed, and no more.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string", "enum": ["warehouse", "supplier", "backorder"],
                                       "description": "warehouse is fastest but limited. supplier is slower. backorder has no delivery date: use it only when nothing else can deliver."},
                            "quantity": {"type": "integer", "description": "How many units to request from this source. At least 1."},
                        },
                        "required": ["source", "quantity"],
                        "additionalProperties": False,
                    },
                },
                "note": {"type": "string", "description": "One short sentence for the supply department: why these units are needed and how urgent they are."},
            },
            "required": ["lines", "note"],
            "additionalProperties": False,
        },
    },
]

LEAD_TOOLS = [
    {
        "name": "assign_risk_agent",
        "description": (
            "Hand the records to the Risk agent. It checks the data, runs the trained failure model and files the proposed "
            "actions (repairs, inspections, repeat tests) for the planner. Always the first step of a review. Returns its "
            "report and the facts: whether the model ran, the counts by risk level, and how many actions of each kind it proposed."),
        "input_schema": _NO_INPUT,
    },
    {
        "name": "assign_stock_agent",
        "description": (
            "Ask the Stock agent to check the spare-parts store for the proposed repairs and set the free units aside. Use "
            "it only when the Risk agent proposed at least one repair. Returns how many repairs have a part and how many do not."),
        "input_schema": _NO_INPUT,
    },
    {
        "name": "assign_supply_agent",
        "description": (
            "Ask the Supply agent to find a source for the parts the hangar store does not have and to draft a request to "
            "the supply department, with delivery times. Use it only when the Stock agent reports repairs without a part. "
            "Returns what was requested from where, when it arrives, and how many parts would arrive after the repair is due."),
        "input_schema": _NO_INPUT,
    },
]
TOOLSETS = {"risk": TOOLS, "stock": STOCK_TOOLS, "supply": SUPPLY_TOOLS, "lead": LEAD_TOOLS}


def names(which: str = "risk") -> list:
    return [t["name"] for t in TOOLSETS[which]]


def definitions(strict: bool, which: str = "risk") -> list:
    """Tool definitions for the API. With strict on, the API guarantees the arguments match the schema."""
    # A tool that takes no input has nothing to validate, so it is left without the flag.
    return [{**tool, "strict": True} if strict and tool["input_schema"]["properties"] else dict(tool) for tool in TOOLSETS[which]]


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
    stock: SimulatedStock | None = None  # the simulated spare-parts supply; only the Stock and Supply agents read it
    delegate: object = None              # in a team review: delegate(role) runs one specialist and returns its report


def execute(name: str, args, ctx: ToolContext, call_id: str = "", allowed: list | None = None) -> tuple[str, bool]:
    """Run one tool call. Returns the result as JSON text, and whether it is an error. Never raises.
    `allowed` is the calling agent's own list of tools; anything outside it is refused."""
    allowed = allowed or TOOL_NAMES
    canonical = next((t for t in allowed if t.lower() == str(name).lower()), None)   # tolerate a letter-case slip
    if canonical is None:
        return json.dumps({"error": f"Unknown tool '{name}'. Available tools: {', '.join(allowed)}."}), True
    try:
        if not isinstance(args, dict):
            raise ToolError("The tool input must be a JSON object.")
        payload = _HANDLERS[canonical](args, ctx)
        result, is_error = payload, False
    except ModelUnavailable as err:
        result, is_error = {"error": "MODEL_UNAVAILABLE", "message": str(err),
                            "instruction": "No predictions exist for these records. Do not estimate or assume any risk. "
                                           "Tell the planner the model call failed and that they can retry."}, True
    except StockUnavailable as err:
        result, is_error = {"error": "STOCK_UNAVAILABLE", "message": str(err),
                            "instruction": "Nothing is known about spare parts for these repairs. Do not assume any stock or "
                                           "delivery time. Say the stock could not be checked and that the planner can retry."}, True
    except ToolError as err:
        result, is_error = {"error": str(err)}, True
    except Exception as err:  # a bug in a tool must reach the log and the agent, not crash the run
        result, is_error = {"error": f"The tool failed unexpectedly ({type(err).__name__}: {err})."}, True
    result = jsonable(result)
    ctx.calls.setdefault(canonical, []).append({"args": args, "result": result, "is_error": is_error, "call_id": call_id})
    # allow_nan=False: a tool result must be strict JSON, or the run stops here rather than send something malformed.
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False), is_error


# ---------------------------------------------------------------------------- handlers
def _scope_note(ctx: ToolContext) -> str:
    return f"{len(ctx.scope_ids)} records selected by the planner" if ctx.scope_ids else "all records in the batch"


def _decisions(ctx: ToolContext) -> dict:
    """record_id -> 'approved', 'rejected' or 'awaiting approval', from the newest proposal on each record."""
    latest: dict = {}
    for p in ctx.store.list_proposals(batch_id=ctx.batch.id):
        if p["record_id"] not in latest or p["created_at"] >= latest[p["record_id"]]["created_at"]:
            latest[p["record_id"]] = p
    return {rid: ("awaiting approval" if p["status"] == "pending" else p["status"]) for rid, p in latest.items()}


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
    decisions = _decisions(ctx)
    decided = {rid for rid, state in decisions.items() if state in ("approved", "rejected")}
    high = ctx.batches.rows(ctx.batch, level="High", ids=ctx.scope_ids, limit=500)["rows"] if decided else []
    return {
        "model_version": ctx.model.version, "yes_from_risk_percent": ctx.model.cutoff, "medium_from_risk_percent": ctx.model.medium,
        "scope": _scope_note(ctx), "scored": summary["records"] - summary["not_scorable"], "not_scored": summary["not_scorable"],
        "by_level": summary["levels"], "predicted_yes": summary["levels"]["High"],
        "expected_failures_in_30_days": summary["expected_failures"],
        "high_risk_missing_a_key_reading": summary["high_missing_key_reading"],
        "medium_risk_missing_a_key_reading": summary["medium_missing_key_reading"],
        "high_risk_already_decided_by_planner": sum(r["record_id"] in decided for r in high),
        "highest_risk": [_agent_row(r, decisions) for r in top],
        "reading_the_result": "High means the model predicts Yes (failure within 30 days). A Yes is a reason to review, not a confirmed "
                              "failure, and a No does not guarantee safety.",
    }


def _agent_row(row: dict, decisions: dict | None = None) -> dict:
    out = {"record_id": row["record_id"], "aircraft": row["aircraft_id"], "level": row["level"]}
    if decisions and row["record_id"] in decisions:
        out["planner_decision"] = decisions[row["record_id"]]
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
    decisions = _decisions(ctx)
    decided = {rid for rid, state in decisions.items() if state in ("approved", "rejected")} if args.get("undecided_only") else None
    page = ctx.batches.rows(ctx.batch, level=level, only_issues=bool(args.get("only_missing_readings")), ids=ctx.scope_ids, offset=offset, limit=limit,
                            exclude=decided)
    return {"matching": page["total"], "offset": offset, "returned": len(page["rows"]), "records": [_agent_row(r, decisions) for r in page["rows"]]}


def _get_record(args, ctx: ToolContext) -> dict:
    record_id = str(args.get("record_id", "")).strip()
    detail = ctx.batches.detail(ctx.batch, record_id)
    if detail is None:
        raise ToolError(f"No record '{record_id}' in this batch. Use the record_id exactly as another tool returned it.")
    out = {"record_id": record_id, "aircraft": detail["aircraft_id"], "date": detail["date"], "data_problems": detail["issues"]}
    if not detail["scored"]:
        out["model_result"] = "none yet: the model has not run on this batch"
        return out
    planner_steps = lambda action: [s["do"] for s in detail["plans"][action]["steps"]]
    if not detail["scorable"]:
        out["model_result"] = "not scored: both key readings are missing, so no prediction was made"
        out["suggested_action"] = "retest"
        out["planner_steps_for_suggested_action"] = planner_steps("retest")
        return out
    ev = detail["evidence"]
    seen = lambda e, what: f"{e['failed']} of {e['n']} training records with {what} were followed by a failure within 30 days" if e else None
    out.update({
        "prediction": detail["prediction"], "risk_percent": int(detail["risk"]), "level": detail["level"], "reason": detail["reason"],
        "typically_fails_in": detail["time_left"], "confidence": detail["confidence"], "suggested_action": detail["suggested_action"],
        "planner_steps_for_suggested_action": planner_steps(detail["suggested_action"]),
        "do_by": detail["plans"][detail["suggested_action"]]["when"],
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


# ---------------------------------------------------------------------------- spare parts (simulated)
def _stock(ctx: ToolContext) -> SimulatedStock:
    if ctx.stock is None:
        raise ToolError("No stock system is connected to this run.")
    return ctx.stock


def _repairs(ctx: ToolContext) -> list:
    """The repairs waiting for the planner's decision in this batch, most urgent first."""
    rows = [p for p in ctx.store.list_proposals(batch_id=ctx.batch.id, status="pending") if p["action"] == "repair"]
    return sorted(rows, key=lambda p: (-(p["risk"] if p["risk"] is not None else -1.0), p["id"]))


def _part(ctx: ToolContext, proposal: dict, status: str, source: str | None = None, eta_days=None, request_id: str | None = None) -> dict:
    """Where one repair's part comes from. `late` means it arrives after the repair is due, or has no date at all."""
    due = ctx.model.deadline_days(proposal["risk"])
    late = status == "none" or (status == "requested" and (eta_days is None or (due is not None and eta_days > due)))
    return {"status": status, "source": source, "source_name": SOURCES.get(source), "eta_days": eta_days, "due_days": due,
            "late": bool(late), "request_id": request_id}


def _brief(ctx: ToolContext, proposal: dict) -> dict:
    out = {"aircraft": proposal["aircraft_id"], "repair_due_in_days": ctx.model.deadline_days(proposal["risk"])}
    if proposal["risk"] is not None:
        out["risk_percent"] = int(proposal["risk"])
    return out


def _without_part(ctx: ToolContext) -> list:
    return [p for p in _repairs(ctx) if (p.get("part") or {}).get("status") in (None, "none")]


def _check_stock(_args, ctx: ToolContext) -> dict:
    levels = _stock(ctx).check()                       # raises StockUnavailable
    repairs = _repairs(ctx)
    return {"part": PART, "in_hangar_store": levels["store"], "set_aside_for_approved_work_orders": levels["reserved"],
            "free_now": levels["free"], "repairs_waiting_for_a_part": len(repairs), "shortage": max(0, len(repairs) - levels["free"]),
            "simulated": _SIMULATED}


def _reserve_parts(_args, ctx: ToolContext) -> dict:
    levels = _stock(ctx).check()
    repairs = _repairs(ctx)
    if not repairs:
        raise ToolError("No repair is waiting for approval in this review, so there is nothing to set parts aside for.")
    covered, rest = repairs[:levels["free"]], repairs[levels["free"]:]
    for p in covered:
        ctx.store.set_part(p["id"], _part(ctx, p, "in_store", "store", 0))
    for p in rest:
        ctx.store.set_part(p["id"], _part(ctx, p, "none"))
    due = [d for d in (ctx.model.deadline_days(p["risk"]) for p in rest) if d is not None]
    return {"set_aside_from_hangar_store": len(covered), "for_the_most_urgent_repairs": [p["aircraft_id"] for p in covered[:5]],
            "repairs_still_without_a_part": len(rest), "their_earliest_due_date_in_days": min(due) if due else None,
            "examples_without_a_part": [_brief(ctx, p) for p in rest[:5]],
            "status": "Set aside only. A unit leaves the store when the planner approves the repair."}


def _get_supply_options(_args, ctx: ToolContext) -> dict:
    options = _stock(ctx).options()
    need = _without_part(ctx)
    by_due: dict = {}
    for p in need:
        due = ctx.model.deadline_days(p["risk"])
        by_due[due] = by_due.get(due, 0) + 1
    return {"units_needed": len(need),
            "repairs_due_within": [{"days": d, "repairs": n} for d, n in sorted(by_due.items(), key=lambda kv: (kv[0] is None, kv[0] or 0))],
            "sources": options,
            "how_to_choose": "A part arrives in time when its delivery days are no more than the days until the repair is due. "
                             "Take the fastest source first, up to what it has. Use backorder only for units no other source can deliver.",
            "simulated": _SIMULATED}


def _request_parts(args, ctx: ToolContext) -> dict:
    lines = args.get("lines")
    if not isinstance(lines, list) or not lines:
        raise ToolError("lines must be a non-empty list of {source, quantity}.")
    options = {o["source"]: o for o in _stock(ctx).options()}
    need = _without_part(ctx)
    if not need:
        raise ToolError("Every proposed repair already has a part. There is nothing to request.")
    wanted: dict = {}
    for line in lines:
        source = str((line or {}).get("source", "")).strip().lower()
        if source not in ("warehouse", "supplier", "backorder"):
            raise ToolError("source must be one of warehouse, supplier, backorder.")
        try:
            quantity = int((line or {}).get("quantity"))
        except (TypeError, ValueError):
            raise ToolError("quantity must be a whole number.") from None
        if quantity < 1:
            raise ToolError("quantity must be at least 1.")
        wanted[source] = wanted.get(source, 0) + quantity
    in_warehouse = options["warehouse"]["units_available"]
    if wanted.get("warehouse", 0) > in_warehouse:
        raise ToolError(f"The central warehouse has only {in_warehouse} unit(s). Request at most that many from it and the rest from another source.")
    if wanted.get("supplier") and options["supplier"]["units_available"] == 0:
        raise ToolError("The supplier has no stock and no delivery date. Use 'backorder' for those units, so the planner sees the gap.")
    total = sum(wanted.values())
    if total > len(need):
        raise ToolError(f"Only {len(need)} unit(s) are needed. Request no more than that.")
    # Units are matched to repairs most urgent first, fastest source first. A source with no date comes last.
    order = sorted(wanted, key=lambda s: (options[s]["delivery_days"] is None, options[s]["delivery_days"] or 0))
    queue = [s for s in order for _ in range(wanted[s])]
    filed = {s: {"source": s, "source_name": SOURCES[s], "quantity": wanted[s], "delivery_days": options[s]["delivery_days"], "aircraft": [], "late": 0} for s in order}
    matched = []
    for proposal, source in zip(need, queue):
        part = _part(ctx, proposal, "requested", source, options[source]["delivery_days"])
        filed[source]["aircraft"].append(proposal["aircraft_id"])
        filed[source]["late"] += int(part["late"])
        matched.append((proposal, part))
    note = str(args.get("note") or "").strip()[:300]
    request_id = ctx.store.add_parts_request(ctx.run_id, ctx.batch.id, list(filed.values()), note)
    for proposal, part in matched:
        ctx.store.set_part(proposal["id"], {**part, "request_id": request_id})
    uncovered = need[len(queue):]
    for proposal in uncovered:
        ctx.store.set_part(proposal["id"], _part(ctx, proposal, "none"))
    late = [(p, part) for p, part in matched if part["late"]]
    return {"request_id": request_id, "units_requested": total,
            "lines": [{"from": line["source_name"], "quantity": line["quantity"],
                       "arrives_in_days": line["delivery_days"] if line["delivery_days"] is not None else "no delivery date"} for line in filed.values()],
            "arrive_in_time_for": len(matched) - len(late), "arrive_after_the_repair_is_due_for": len(late),
            "late_examples": [{**_brief(ctx, p), "part_arrives_in_days": part["eta_days"] if part["eta_days"] is not None else "no delivery date"} for p, part in late[:5]],
            "repairs_still_without_any_source": len(uncovered),
            "status": "Waiting for the planner's approval. Nothing has been ordered. The supply department is simulated."}


# ---------------------------------------------------------------------------- the orchestrator hands work to a specialist
def _assign(role: str):
    def handler(_args, ctx: ToolContext) -> dict:
        if ctx.delegate is None:
            raise ToolError("No team is attached to this run.")
        return ctx.delegate(role)
    return handler


_HANDLERS = {
    "check_records": _check_records,
    "run_failure_model": _run_failure_model,
    "list_records": _list_records,
    "get_record": _get_record,
    "get_model_track_record": _get_model_track_record,
    "propose_actions": _propose_actions,
    "check_stock": _check_stock,
    "reserve_parts": _reserve_parts,
    "get_supply_options": _get_supply_options,
    "request_parts": _request_parts,
    "assign_risk_agent": _assign("risk"),
    "assign_stock_agent": _assign("stock"),
    "assign_supply_agent": _assign("supply"),
}
