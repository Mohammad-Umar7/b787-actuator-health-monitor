"""A review done by a team: an orchestrator and three specialists.

  Orchestrator  Decides who works next and writes the planner's summary. It has no access to records or stock.
  Risk agent    Checks the records, runs the failure model, files the proposed actions. (The single agent of loop.py.)
  Stock agent   Checks the simulated spare-parts store and sets the free units aside for the most urgent repairs.
  Supply agent  Finds a source for the missing parts and drafts a request to the supply department, with delivery times.

Each member is one conversation run by loop.run, with its own prompt and its own tools. The orchestrator's tools
are the three hand-overs: calling one runs that specialist to the end and returns its report. So the order of work
is the orchestrator's decision, not a fixed script: it skips the Stock agent when no repair was proposed, and the
Supply agent when every repair has a part.

Without an API key, or once Claude cannot be used, each member is played by a small rule-based planner that calls
the same tools, so the whole team still works at no cost. Every step is logged with the member that took it.
"""
from __future__ import annotations

from ..config import Settings
from ..store import Store
from . import loop, prompts, tools
from .llm import OfflinePlanner, Reply

ROLES = {"lead": "Orchestrator", "risk": "Risk agent", "stock": "Stock agent", "supply": "Supply agent"}
FOOTER = "_Prepared by the built-in planner. No language model was used for this run._"
MAX_STEPS = {"lead": 8, "stock": 6, "supply": 6}      # the Risk agent keeps the configured limit


def clean(text: str) -> str:
    """A specialist's report as the orchestrator should read it: without the built-in planner's footer."""
    return (text or "").replace(FOOTER, "").strip()


# ---------------------------------------------------------------------------- what each specialist's work came to
def _last(ctx: tools.ToolContext, name: str):
    calls = ctx.calls.get(name) or []
    return calls[-1] if calls else None


def risk_facts(ctx: tools.ToolContext) -> dict:
    ran = _last(ctx, "run_failure_model")
    ok = bool(ran) and not ran["is_error"]
    proposed: dict = {}
    for p in ctx.store.list_proposals(run_id=ctx.run_id, status="pending"):
        proposed[p["action"]] = proposed.get(p["action"], 0) + 1
    facts = {"model_ran": ok, "proposed": proposed, "repairs_proposed": proposed.get("repair", 0)}
    if ok:
        facts["by_level"] = ran["result"].get("by_level")
        facts["expected_failures_in_30_days"] = ran["result"].get("expected_failures_in_30_days")
    elif ran:
        facts["why_not"] = ran["result"].get("message") or ran["result"].get("error")
    return facts


def stock_facts(ctx: tools.ToolContext) -> dict:
    check, reserve = _last(ctx, "check_stock"), _last(ctx, "reserve_parts")
    if not check or check["is_error"]:
        return {"stock_checked": False, "why_not": (check or {}).get("result", {}).get("message") if check else "the stock was not checked",
                "repairs_without_a_part": None}
    facts = {"stock_checked": True, "free_units": check["result"]["free_now"], "repairs_waiting": check["result"]["repairs_waiting_for_a_part"]}
    if reserve and not reserve["is_error"]:
        facts["repairs_with_a_part"] = reserve["result"]["set_aside_from_hangar_store"]
        facts["repairs_without_a_part"] = reserve["result"]["repairs_still_without_a_part"]
        facts["earliest_due_date_in_days"] = reserve["result"]["their_earliest_due_date_in_days"]
    else:
        facts["repairs_with_a_part"] = 0
        facts["repairs_without_a_part"] = check["result"]["repairs_waiting_for_a_part"] if check["result"]["repairs_waiting_for_a_part"] else 0
    return facts


def supply_facts(ctx: tools.ToolContext) -> dict:
    options, request = _last(ctx, "get_supply_options"), None
    for call in reversed(ctx.calls.get("request_parts") or []):       # the last request that was actually filed
        if not call["is_error"]:
            request = call
            break
    if not request:
        failed = options and options["is_error"]
        return {"request_filed": False, "why_not": (options["result"].get("message") if failed else None) or "no request was filed"}
    r = request["result"]
    return {"request_filed": True, "request_id": r["request_id"], "units_requested": r["units_requested"], "lines": r["lines"],
            "arrive_in_time_for": r["arrive_in_time_for"], "arrive_after_the_repair_is_due_for": r["arrive_after_the_repair_is_due_for"],
            "repairs_still_without_any_source": r["repairs_still_without_any_source"]}


FACTS = {"risk": risk_facts, "stock": stock_facts, "supply": supply_facts}


# ---------------------------------------------------------------------------- the built-in planners for the team
class StockPlanner(OfflinePlanner):
    def __init__(self):
        super().__init__("stock")

    def reply(self, system: str, definitions: list, messages: list, ctx) -> Reply:
        check = _last(ctx, "check_stock")
        if not check:
            return self._call("check_stock")
        if check["is_error"]:
            return self._say(f"**The spare-parts stock could not be checked.** {check['result'].get('message') or check['result'].get('error')} "
                             "Nothing was assumed about parts.")
        c = check["result"]
        if not c["repairs_waiting_for_a_part"]:
            return self._say("No repair is waiting for a part.")
        reserve = _last(ctx, "reserve_parts")
        if not reserve:
            return self._call("reserve_parts")
        if reserve["is_error"]:
            return self._say(f"**The parts could not be set aside.** {reserve['result'].get('message') or reserve['result'].get('error')}")
        r = reserve["result"]
        text = (f"{c['free_now']} spare actuator{'s are' if c['free_now'] != 1 else ' is'} free in the hangar store (simulated). "
                f"{r['set_aside_from_hangar_store']} of the {c['repairs_waiting_for_a_part']} proposed repairs now have one set aside.")
        if r["repairs_still_without_a_part"]:
            due = r["their_earliest_due_date_in_days"]
            text += (f" {r['repairs_still_without_a_part']} repair{'s have' if r['repairs_still_without_a_part'] != 1 else ' has'} no part"
                     + (f"; the most urgent is due within {due} days." if due else "."))
        return self._say(text)


class SupplyPlanner(OfflinePlanner):
    def __init__(self):
        super().__init__("supply")

    def reply(self, system: str, definitions: list, messages: list, ctx) -> Reply:
        options = _last(ctx, "get_supply_options")
        if not options:
            return self._call("get_supply_options")
        if options["is_error"]:
            return self._say(f"**The supply options could not be read.** {options['result'].get('message') or options['result'].get('error')} "
                             "Nothing was assumed about delivery.")
        o = options["result"]
        if not o["units_needed"]:
            return self._say("Every proposed repair has a part. There is nothing to request.")
        request = _last(ctx, "request_parts")
        if not request:
            lines, left = [], o["units_needed"]
            for source in o["sources"]:                       # fastest first, as listed
                take = left if source["units_available"] == "no limit" else min(left, int(source["units_available"]))
                if take > 0:
                    lines.append({"source": source["source"], "quantity": take})
                    left -= take
                if left <= 0:
                    break
            return self._call("request_parts", lines=lines, note="Spare actuators for repairs the hangar store cannot cover, fastest source first.")
        if request["is_error"]:
            return self._say(f"**The parts request could not be filed.** {request['result'].get('error')}")
        r = request["result"]
        parts = [f"{line['quantity']} from the {line['from'].lower()} ({line['arrives_in_days']} days)" if isinstance(line["arrives_in_days"], int)
                 else f"{line['quantity']} on {line['from'].lower()}" for line in r["lines"]]
        text = f"Requested {'; '.join(parts)} (simulated supply department). Request {r['request_id']} waits for your approval; nothing has been ordered."
        if r["arrive_after_the_repair_is_due_for"]:
            n = r["arrive_after_the_repair_is_due_for"]
            text += f" {n} part{'s' if n != 1 else ''} would arrive after the repair {'they are' if n != 1 else 'it is'} for is due."
        return self._say(text)


class LeadPlanner(OfflinePlanner):
    """The orchestrator without a language model: the same hand-overs, decided from the specialists' facts."""

    def __init__(self):
        super().__init__("lead")

    def reply(self, system: str, definitions: list, messages: list, ctx) -> Reply:
        risk = _last(ctx, "assign_risk_agent")
        if not risk:
            return self._call("assign_risk_agent")
        if risk["is_error"]:
            return self._say(f"**The review could not be completed.** {risk['result'].get('error')}")
        facts = risk["result"]["facts"]
        if not facts["model_ran"] or not facts["repairs_proposed"]:
            return self._say(risk["result"]["report"])                 # no predictions, or nothing that needs a part
        stock = _last(ctx, "assign_stock_agent")
        if not stock:
            return self._call("assign_stock_agent")
        stock_ok = not stock["is_error"] and stock["result"]["facts"]["stock_checked"]
        supply = _last(ctx, "assign_supply_agent")
        if stock_ok and stock["result"]["facts"]["repairs_without_a_part"] and not supply:
            return self._call("assign_supply_agent")
        return self._say(_with_parts(risk["result"]["report"], facts["repairs_proposed"], stock, supply))


def _with_parts(report: str, repairs: int, stock: dict, supply: dict | None) -> str:
    """The Risk agent's summary with a Parts section added, placed before the data notes."""
    lines = ["**Parts (simulated stock)**"]
    if stock["is_error"] or not stock["result"]["facts"]["stock_checked"]:
        lines.append("- The stock system could not be reached, so it is not known which repairs have a part. Nothing was assumed. Run the review again once it is back.")
    else:
        s = stock["result"]["facts"]
        if repairs == 1:
            lines.append("- A spare actuator is set aside for the repair in the hangar store." if s["repairs_with_a_part"]
                         else "- The hangar store has no spare actuator for the repair.")
        else:
            lines.append(f"- {s['repairs_with_a_part']} of the {repairs} repairs "
                         f"{'have' if s['repairs_with_a_part'] != 1 else 'has'} a spare actuator set aside in the hangar store.")
        f = supply["result"]["facts"] if supply and not supply["is_error"] else None
        if f and f["request_filed"]:
            what = "; ".join(f"{line['quantity']} from the {line['from'].lower()} ({line['arrives_in_days']} days)" if isinstance(line["arrives_in_days"], int)
                             else f"{line['quantity']} on {line['from'].lower()}" for line in f["lines"])
            lines.append(f"- Requested for the rest: {what}. Request {f['request_id']} waits for your approval.")
            undated = sum(line["quantity"] for line in f["lines"] if not isinstance(line["arrives_in_days"], int))
            dated_late = f["arrive_after_the_repair_is_due_for"] - undated
            if dated_late > 0:
                lines.append(f"- {dated_late} of those part{'s' if dated_late != 1 else ''} would arrive after the repair is due. "
                             "Those aircraft stay at risk until the part is in.")
            if undated:
                lines.append(f"- {undated} part{'s have' if undated != 1 else ' has'} no delivery date from any source. "
                             "Those aircraft stay at risk until a part is found.")
            if f["repairs_still_without_any_source"]:
                lines.append(f"- {f['repairs_still_without_any_source']} repair(s) have no source for a part at all.")
        elif s["repairs_without_a_part"]:
            lines.append(f"- {s['repairs_without_a_part']} repair(s) have no part, and no request could be filed for them.")
    block = "\n".join(lines)
    for marker in ("**Data to be aware of**", "**Not covered**", "A Yes from the model"):
        at = report.find(marker)
        if at >= 0:
            return f"{report[:at].rstrip()}\n\n{block}\n\n{report[at:]}"
    return f"{report}\n\n{block}"


# ---------------------------------------------------------------------------- running a review as a team
def run_review(run_id: str, user_text: str, ctx: tools.ToolContext, settings: Settings, store: Store, primary, list_size: int) -> str:
    """`primary` is Claude, or None to play every member with the built-in planners. Returns the orchestrator's summary."""
    budget = {"spent": 0.0, "claude_failed": False}
    planners = {"lead": LeadPlanner(), "risk": OfflinePlanner("review", list_size), "stock": StockPlanner(), "supply": SupplyPlanner()}

    def brain(role: str):
        return planners[role] if primary is None or budget["claude_failed"] else primary

    def task(role: str) -> str:
        if role == "risk":
            return user_text
        if role == "stock":
            return prompts.stock_task(risk_facts(ctx)["repairs_proposed"])
        return prompts.supply_task(stock_facts(ctx).get("repairs_without_a_part") or 0)

    systems = {"risk": prompts.SYSTEM, "stock": prompts.STOCK, "supply": prompts.SUPPLY}

    def delegate(role: str) -> dict:
        text = loop.run(run_id, task(role), ctx, settings, store, brain(role), planners[role], system=systems[role],
                        definitions=tools.definitions(settings.strict_tools, role), allowed=tools.names(role), agent=role,
                        max_steps=MAX_STEPS.get(role), budget=budget)
        return {"agent": ROLES[role], "report": clean(text), "facts": FACTS[role](ctx)}

    ctx.delegate = delegate
    return loop.run(run_id, user_text, ctx, settings, store, brain("lead"), planners["lead"], system=prompts.LEAD,
                    definitions=tools.definitions(settings.strict_tools, "lead"), allowed=tools.names("lead"), agent="lead",
                    max_steps=MAX_STEPS["lead"], budget=budget)
