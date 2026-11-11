"""The agent loop: ask for the next step, run the tools it requests, give the results back, repeat.

The loop is written by hand rather than with the SDK's tool runner for three reasons: every step is written
to the activity log as it happens, the spend cap is checked before each paid call, and the very same loop
runs against the built-in planner and against scripted replies in the tests, so it can be verified end to end
without an API key.

The conversation is append-only. The system prompt and tool list are fixed, and each assistant turn is sent
back exactly as it was received, thinking blocks included, which is what the API requires.
"""
from __future__ import annotations

import json
import time

from ..config import Settings
from ..store import Store
from . import tools
from .llm import LLMError, OfflinePlanner, Reply
from .prompts import SYSTEM


def run(run_id: str, user_text: str, ctx: tools.ToolContext, settings: Settings, store: Store, primary, planner: OfflinePlanner, *,
        system: str = SYSTEM, definitions: list | None = None, allowed: list | None = None, agent: str | None = None,
        max_steps: int | None = None, budget: dict | None = None) -> str:
    """Run one agent's conversation to the end and return its final text. Everything is recorded in the store as it goes.

    A single agent uses the defaults. In a team review each member is one call of this function with its own
    system prompt, its own tools (`definitions`, `allowed`) and its name (`agent`), and they share one `budget`,
    so the spend limit and a hand-over to the built-in planner hold for the whole run, not per member."""
    definitions = definitions if definitions is not None else tools.definitions(settings.strict_tools)
    budget = budget if budget is not None else {"spent": 0.0, "claude_failed": False}
    limit = max_steps or settings.max_steps
    messages = [{"role": "user", "content": user_text}]
    llm = primary
    final_text = None

    def hand_over(reason: str) -> None:
        nonlocal llm
        store.note(run_id, f"{reason} Continuing with the built-in planner. The model tools run exactly as before.", is_error=True, agent=agent)
        store.set_mode(run_id, "claude, then built-in planner")
        budget["claude_failed"] = True
        llm = planner

    for _ in range(limit):
        if llm is primary and llm.billable:
            if store.spend_today() >= settings.daily_usd_limit:
                hand_over(f"Today's spend limit of ${settings.daily_usd_limit:.2f} for Claude has been reached.")
            elif budget["spent"] >= settings.run_usd_limit:
                hand_over(f"This run reached its spend limit of ${settings.run_usd_limit:.2f}.")

        seq = store.start_step(run_id, "model", llm.label, {"messages_sent": len(messages)}, agent=agent)
        started = time.monotonic()
        try:
            reply: Reply = llm.reply(system, definitions, messages, ctx)
        except LLMError as err:
            store.finish_step(run_id, seq, output={"error": str(err)}, is_error=True, duration_ms=_ms(started))
            if llm is planner:
                raise
            hand_over(f"Claude could not be used: {err}.")
            continue
        if not llm.billable and settings.planner_pace:
            time.sleep(settings.planner_pace)       # the planner answers instantly; this only makes its steps visible
        budget["spent"] += reply.cost
        store.add_usage(run_id, reply.input_tokens, reply.output_tokens, reply.cache_write_tokens, reply.cache_read_tokens, reply.cost)
        store.finish_step(run_id, seq, duration_ms=_ms(started), tokens_in=reply.input_tokens + reply.cache_write_tokens + reply.cache_read_tokens,
                          tokens_out=reply.output_tokens, cost_usd=reply.cost,
                          output={"stop_reason": reply.stop_reason, "text": reply.text or None, "served_by": reply.model,
                                  "requested_tools": [{"name": c.name, "input": c.input} for c in reply.tool_calls],
                                  "tokens": {"input": reply.input_tokens, "output": reply.output_tokens,
                                             "cache_write": reply.cache_write_tokens, "cache_read": reply.cache_read_tokens}})
        for notice in reply.notices:
            store.note(run_id, notice, agent=agent)

        if reply.stop_reason == "refusal":
            if llm is planner:
                raise LLMError("the planner declined the request")
            hand_over(f"Claude declined this request ({reply.refusal}).")
            continue
        if reply.stop_reason == "max_tokens":
            # A reply cut off mid-way may contain an incomplete tool call. Do not run it.
            if llm is planner:
                raise LLMError("the reply was cut off")
            hand_over("Claude's reply was cut off before it finished.")
            continue

        messages.append({"role": "assistant", "content": reply.content})
        if not reply.tool_calls:
            final_text = reply.text
            break

        results = []
        for call in reply.tool_calls:   # a turn may request several tools; all results go back in one message
            seq = store.start_step(run_id, "tool", call.name, call.input, agent=agent)
            started = time.monotonic()
            content, is_error = tools.execute(call.name, call.input, ctx, call.id, allowed=allowed)
            store.finish_step(run_id, seq, output=json.loads(content), is_error=is_error, duration_ms=_ms(started))
            result = {"type": "tool_result", "tool_use_id": call.id, "content": content}
            if is_error:
                result["is_error"] = True
            results.append(result)
        messages.append({"role": "user", "content": results})
    else:
        store.note(run_id, f"Stopped after {limit} steps without a final answer.", is_error=True, agent=agent)
        final_text = ("The assistant did not finish within its step limit. Any actions it filed before stopping are listed "
                      "for your review; run it again to continue.")

    return final_text or "The assistant finished without a written summary. Any proposed actions are listed for your review."


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
