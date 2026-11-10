"""Who decides the agent's next step.

  ClaudeLLM       Claude through the Anthropic API. Used when an API key is configured.
  OfflinePlanner  A fixed, rule-based planner that needs no key and costs nothing. It calls the same tools in a
                  sensible order, so the dashboard, the model tools, the approvals and the log all work without
                  a language model. It is also what a run falls back to if Claude cannot be reached.
  ScriptedLLM     Replays prepared replies. Used by the tests to exercise the loop without spending credits.

All three return the same Reply, so the loop in loop.py does not know which one it is talking to.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field

from ..config import Settings, cost_usd
from ..model import ACTIONS

FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass
class Block:
    type: str                 # "text" or "tool_use"
    text: str = ""
    id: str = ""
    name: str = ""
    input: dict | None = None


@dataclass
class Reply:
    blocks: list                       # the parts the loop acts on
    content: object                    # the assistant turn exactly as it must be sent back (thinking blocks included)
    stop_reason: str = "end_turn"
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    cost: float = 0.0
    refusal: str | None = None
    notices: list = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(b.text for b in self.blocks if b.type == "text" and b.text).strip()

    @property
    def tool_calls(self) -> list:
        return [b for b in self.blocks if b.type == "tool_use"]


class LLMError(Exception):
    """The language model could not be used. The message is safe to show to the user."""


# ---------------------------------------------------------------------------- Claude
class ClaudeLLM:
    billable = True

    def __init__(self, settings: Settings):
        self.settings = settings
        self.label = settings.model
        self._client = None
        self.plain = False        # set after the API rejects an optional request feature; later calls leave them out

    @property
    def client(self):
        if self._client is None:
            import anthropic
            # Reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) from the environment. Retries 429, 5xx and
            # connection errors twice with backoff before giving up.
            self._client = anthropic.Anthropic(timeout=self.settings.request_timeout, max_retries=2)
        return self._client

    def _request(self, system: str, tools: list, messages: list) -> dict:
        return {
            "model": self.settings.model,
            "max_tokens": self.settings.max_output_tokens,
            # The system prompt and tool list never change, so they are cached and re-read at a tenth of the price.
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "tools": tools,
            "messages": messages,
            # Thinking is adaptive on this model; effort is the control for how much it thinks and spends.
            "output_config": {"effort": self.settings.effort},
        }

    def _send(self, request: dict):
        if self.plain:
            request = {**request, "tools": [{k: v for k, v in tool.items() if k != "strict"} for tool in request["tools"]]}
            return self.client.messages.create(**request)
        # Caches the growing conversation inside a run, so each step re-reads the earlier steps cheaply.
        request = {**request, "cache_control": {"type": "ephemeral"}}
        if self.settings.use_fallbacks:
            # If a safety classifier declines a request, the API retries it on the fallback model in the same call.
            return self.client.beta.messages.create(**request, betas=[FALLBACK_BETA], fallbacks="default")
        return self.client.messages.create(**request)

    def reply(self, system: str, tools: list, messages: list, ctx=None) -> Reply:
        import anthropic
        request, notices = self._request(system, tools, messages), []
        try:
            try:
                response = self._send(request)
            except anthropic.BadRequestError as err:
                if self.plain:
                    raise
                # An optional feature (strict tool schemas, automatic caching, server-side fallback) was not
                # accepted. Drop them for the rest of this process and try the plain request once.
                self.plain = True
                notices.append(f"The API did not accept an optional request feature ({_short(err)}). Continuing without strict schemas, automatic caching and fallback.")
                response = self._send(request)
        except anthropic.AuthenticationError as err:
            raise LLMError("the API key was rejected") from err
        except anthropic.PermissionDeniedError as err:
            raise LLMError("the API key does not have access to this model") from err
        except anthropic.NotFoundError as err:
            raise LLMError(f"the model '{self.settings.model}' was not found") from err
        except anthropic.RateLimitError as err:
            raise LLMError("Claude's rate limit was reached") from err
        except anthropic.APITimeoutError as err:
            raise LLMError("Claude did not answer in time") from err
        except anthropic.APIConnectionError as err:
            raise LLMError("the Claude API could not be reached (is there an internet connection?)") from err
        except anthropic.BadRequestError as err:
            raise LLMError(f"the API rejected the request ({_short(err)})") from err
        except anthropic.APIStatusError as err:
            raise LLMError(f"Claude is temporarily unavailable (status {err.status_code})" if err.status_code >= 500
                           else f"the API returned an error ({_short(err)})") from err

        blocks = []
        for block in response.content:
            if block.type == "text":
                blocks.append(Block("text", text=block.text))
            elif block.type == "tool_use":
                blocks.append(Block("tool_use", id=block.id, name=block.name, input=block.input))
            elif block.type == "fallback":
                notices.append("A safety classifier declined the request on the main model, so the fallback model answered.")
        usage = response.usage
        tokens = {"input_tokens": usage.input_tokens or 0, "output_tokens": usage.output_tokens or 0,
                  "cache_write": getattr(usage, "cache_creation_input_tokens", 0) or 0, "cache_read": getattr(usage, "cache_read_input_tokens", 0) or 0}
        refusal = None
        if response.stop_reason == "refusal":
            details = getattr(response, "stop_details", None)
            refusal = (getattr(details, "explanation", None) or getattr(details, "category", None) or "no reason given") if details else "no reason given"
        return Reply(blocks=blocks, content=response.content, stop_reason=response.stop_reason or "end_turn", model=response.model,
                     input_tokens=tokens["input_tokens"], output_tokens=tokens["output_tokens"],
                     cache_write_tokens=tokens["cache_write"], cache_read_tokens=tokens["cache_read"],
                     cost=cost_usd(self.settings.model, **tokens), refusal=refusal, notices=notices)


def _short(err) -> str:
    message = getattr(err, "message", None) or str(err)
    return message.replace("\n", " ")[:220]


# ---------------------------------------------------------------------------- built-in planner
class OfflinePlanner:
    """Decides the next tool call from what the tools have already returned. No language model involved."""
    billable = False
    label = "built-in planner"

    def __init__(self, kind: str, list_size: int = 25, selected: str | None = None):
        self.kind, self.list_size, self.selected = kind, max(1, min(int(list_size), 60)), selected
        self._ids = itertools.count(1)

    def _call(self, name: str, **args) -> Reply:
        call_id = f"offline_{next(self._ids)}"
        return Reply(blocks=[Block("tool_use", id=call_id, name=name, input=args)],
                     content=[{"type": "tool_use", "id": call_id, "name": name, "input": args}], stop_reason="tool_use", model=self.label)

    def _say(self, text: str) -> Reply:
        text += "\n\n_Prepared by the built-in planner. No language model was used for this run._"
        return Reply(blocks=[Block("text", text=text)], content=[{"type": "text", "text": text}], model=self.label)

    def reply(self, system: str, tools: list, messages: list, ctx) -> Reply:
        return self._review(ctx.calls) if self.kind == "review" else self._question(ctx.calls)

    # ---- preparing the action list
    def _review(self, calls: dict) -> Reply:
        if "check_records" not in calls:
            return self._call("check_records")
        if "run_failure_model" not in calls:
            return self._call("run_failure_model")
        run = calls["run_failure_model"][-1]
        if run["is_error"]:
            return self._say("**The prediction model could not be reached, so there are no predictions.**\n\n"
                             f"- What happened: {run['result'].get('message') or run['result'].get('error')}\n"
                             "- Nothing was proposed. No risk was estimated in its place.\n"
                             "- Try again once the model is back.")
        result = run["result"]
        listed = [c for c in calls.get("list_records", []) if not c["is_error"]]
        ranked = [c for c in listed if c["args"].get("level") == "Any"]
        records = [r for c in ranked for r in c["result"]["records"]]
        more_to_read = ranked and ranked[-1]["result"]["matching"] > len(records) if ranked else True
        actionable = [r for r in records if r.get("suggested_action") in ("repair", "inspect", "retest")]
        if "propose_actions" not in calls:
            if len(actionable) < self.list_size and more_to_read and len(ranked) < 4 and (not records or records[-1].get("suggested_action") != "monitor"):
                return self._call("list_records", level="Any", only_missing_readings=False, limit=min(30, self.list_size), offset=len(records))
            # A few places on the list are kept for records that could not be scored: a repeat test is cheap,
            # and until it is done nobody knows how urgent those aircraft are.
            reserved = min(int(result.get("not_scored") or 0), max(1, self.list_size // 8), 5)
            unscored_listed = any(c["args"].get("level") == "Not scored" for c in listed)
            if reserved and not unscored_listed:
                return self._call("list_records", level="Not scored", only_missing_readings=False, limit=reserved, offset=0)
            unscored = [r for c in listed if c["args"].get("level") == "Not scored" for r in c["result"]["records"]]
            scored_actions = [r for r in actionable if r["level"] != "Not scored"][: max(self.list_size - len(unscored), 0)]
            chosen = scored_actions + unscored[: self.list_size - len(scored_actions)]
            if not chosen:
                return self._say(f"**No aircraft in this review needs action.** All {result['scored']} scored records are Low risk.")
            return self._call("propose_actions", actions=[
                {"record_id": r["record_id"], "action": r.get("suggested_action", "retest"),
                 "note": "No prediction was possible; both key readings are missing." if r["level"] == "Not scored" else ""} for r in chosen])
        return self._say(self._summary(calls, result, actionable))

    def _summary(self, calls: dict, result: dict, actionable: list) -> str:
        proposed, check = calls["propose_actions"][-1], calls["check_records"][-1]["result"]
        if proposed["is_error"]:
            return f"**The action list could not be filed.** {proposed['result'].get('error')}"
        filed, levels = proposed["result"], result["by_level"]
        top = [r for r in actionable if r.get("suggested_action") == "repair"][:3]
        selected = result["scope"] != "all records in the batch"
        expected = round(result["expected_failures_in_30_days"])
        lines = [f"**{levels['High']:,} of the {result['scored']:,} {'selected' if selected else 'scored'} aircraft "
                 f"{'is' if levels['High'] == 1 else 'are'} predicted to fail within 30 days.** "
                 f"About {expected:,} failure{' is' if expected == 1 else 's are'} expected in that time if nothing is done.", "",
                 "**Proposed for your approval**"]
        for label in (ACTIONS["repair"], ACTIONS["inspect"], ACTIONS["retest"]):
            if filed["by_action"].get(label):
                lines.append(f"- {label}: {filed['by_action'][label]} aircraft.")
        if top:
            lines.append("- Most urgent: " + "; ".join(f"{r['aircraft']} ({r['risk_percent']:.0f}%, {r['reason'].lower()})" for r in top) + ".")
        notes = []
        if check["with_missing_or_unusable_readings"]:
            notes.append(f"- {check['with_missing_or_unusable_readings']} records have a missing or unusable reading. The model still predicted for them.")
        if result["not_scored"]:
            notes.append(f"- {result['not_scored']} could not be scored because both key readings are missing. They need a repeat test.")
        if result["high_risk_missing_a_key_reading"]:
            notes.append(f"- {result['high_risk_missing_a_key_reading']} High-risk predictions were made without one key reading.")
        if notes:
            lines += ["", "**Data to be aware of**", *notes]
        beyond = levels["High"] - filed["by_action"].get(ACTIONS["repair"], 0)
        if beyond > 0:
            lines += ["", "**Not covered**", f"- {beyond} more High-risk aircraft are beyond this list of {self.list_size}. Raise the list size, or run again after deciding on these."]
        lines += ["", "A Yes from the model is a reason to review, not a confirmed failure."]
        return "\n".join(lines)

    # ---- answering a question
    def _question(self, calls: dict) -> Reply:
        intro = "Free-text questions need the Claude connection, which is not active. Here is what the model shows."
        if self.selected:
            if "get_record" not in calls:
                return self._call("get_record", record_id=self.selected)
            got = calls["get_record"][-1]
            if got["is_error"]:
                return self._say(f"{intro}\n\n{got['result'].get('error')}")
            r = got["result"]
            if "risk_percent" not in r:
                return self._say(f"{intro}\n\n**{r['aircraft']}**: {r['model_result']}.")
            lines = [intro, "", f"**{r['aircraft']}: {r['level']} risk, {r['risk_percent']:.0f}%** ({r['reason'].lower()}).",
                     f"- Operation time is {r['operation_time']['compared_with_new'] or 'not recorded'}.",
                     f"- Leakage is {r['leakage']['compared_with_failure_level'] or 'not recorded'}.",
                     f"- Of past records at this risk, {r['records_at_this_risk']}.", f"- Confidence: {r['confidence']}"]
            return self._say("\n".join(lines))
        if "get_model_track_record" not in calls:
            return self._call("get_model_track_record")
        t = calls["get_model_track_record"][-1]["result"]
        return self._say(f"{intro}\n\n**How far the model can be trusted**\n- On aircraft it never saw: F1 {t['f1_percent']}, precision {t['precision_percent']}%, recall {t['recall_percent']}%.\n"
                         f"- It flagged {t['failures_flagged_in_their_final_30_days']} real failures in their final 30 days, typically {t['typical_first_flag_weeks_before_failure']} weeks ahead.\n"
                         f"- {t['limits'][1]}")


# ---------------------------------------------------------------------------- for tests
class ScriptedLLM:
    """Replays a fixed list of replies. Each item is a Reply, an Exception to raise, or a callable(messages) -> Reply."""
    billable = True
    label = "scripted"

    def __init__(self, script: list):
        self.script, self.requests = list(script), []

    def reply(self, system: str, tools: list, messages: list, ctx=None) -> Reply:
        self.requests.append({"system": system, "tools": tools, "messages": [dict(m) for m in messages]})
        if not self.script:
            raise LLMError("the script ran out of replies")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item(messages) if callable(item) else item


def tool_reply(*calls, text: str = "", tokens: tuple = (900, 60), cost: float = 0.0024) -> Reply:
    """Build a Reply that requests tools. Each call is (id, name, input)."""
    blocks = ([Block("text", text=text)] if text else []) + [Block("tool_use", id=i, name=n, input=a) for i, n, a in calls]
    content = ([{"type": "text", "text": text}] if text else []) + [{"type": "tool_use", "id": i, "name": n, "input": a} for i, n, a in calls]
    return Reply(blocks=blocks, content=content, stop_reason="tool_use", model="scripted", input_tokens=tokens[0], output_tokens=tokens[1], cost=cost)


def text_reply(text: str, stop_reason: str = "end_turn", tokens: tuple = (1200, 150), cost: float = 0.0039) -> Reply:
    return Reply(blocks=[Block("text", text=text)], content=[{"type": "text", "text": text}], stop_reason=stop_reason, model="scripted",
                 input_tokens=tokens[0], output_tokens=tokens[1], cost=cost)
