"""Proves in a few seconds that the model, the tools, the agent loop and the approvals work together.

  python -m acumain.selfcheck             no API key needed, costs nothing
  python -m acumain.selfcheck --claude    also sends ONE tiny request to Claude to prove the key works (well under $0.01)
  python -m acumain.selfcheck --claude-review   also runs one full review with Claude (a few cents) and prints its cost

It works on a temporary copy of the data, so it never touches what the dashboard has stored.
"""
from __future__ import annotations

import argparse
import dataclasses
import sys
import tempfile
from pathlib import Path

from .agent.llm import ClaudeLLM, LLMError
from .config import get_settings
from .services import SAMPLE_ID, Services


def line(ok: bool, text: str) -> bool:
    print(f"  [{'ok' if ok else 'FAIL'}] {text}")
    return ok


def offline_checks(settings) -> bool:
    svc = Services(dataclasses.replace(settings, agent_mode="offline", planner_pace=0.0))
    good = line(svc.model.available, f"The Stage 2 model loaded (version {svc.model.version}).")
    batch = svc.batch(SAMPLE_ID)
    good &= line(len(batch.frame) == 2000, f"The sample batch has {len(batch.frame):,} records.")

    run = svc.store.get_run(svc.start_run(SAMPLE_ID, "review", list_size=10, wait=True))
    tools = [s["name"] for s in run["steps"] if s["type"] == "tool"]
    summary = svc.batches.summary(batch)
    good &= line(run["status"] == "completed" and tools[:2] == ["check_records", "run_failure_model"], f"The agent ran a review: {' -> '.join(tools)}.")
    good &= line(summary.get("levels", {}).get("High") == 203, f"The model predicts Yes for {summary['levels']['High']} of 2,000 records, the same as the submitted file.")
    good &= line(len(run["proposals"]) == 10 and not svc.store.list_work_orders(), "10 actions were proposed and nothing was executed.")

    approved = svc.decide(run["proposals"][0]["id"], "approved")
    good &= line(approved["work_order_id"] is not None and len(svc.store.list_work_orders()) == 1,
                 f"Approving one proposal created the simulated work order {approved['work_order_id']}.")

    svc.reset(SAMPLE_ID)
    svc.model.simulated_outage = True
    failed = svc.store.get_run(svc.start_run(SAMPLE_ID, "review", wait=True))
    error_steps = [s for s in failed["steps"] if s["type"] == "tool" and s["is_error"]]
    good &= line(bool(error_steps) and not failed["proposals"] and not batch.scored,
                 "With the model switched off, the agent reported the failure, proposed nothing and invented no prediction.")
    svc.model.simulated_outage = False

    partial = svc.preview({"Hydraulic_Fluid_Grade": "FG-A", "Actuation_Time_Seconds": 4.9, "Reference_Actuation_Time_Seconds": 6, "Diagnostic_Load_Ratio": 1,
                           "Reference_Leakage_Flow_mL_Min": 50, "Pressure_Variation_PSI": 70})
    good &= line(partial["level"] != "Not scored" and partial["confidence"].startswith("Reduced"),
                 f"A record with a missing leakage reading still got a prediction ({partial['level']}), marked as reduced confidence.")
    nothing = svc.preview({"Hydraulic_Fluid_Grade": "FG-A"})
    good &= line(nothing["level"] == "Not scored" and nothing["risk"] is None, "A record with both key readings missing got no prediction.")
    svc.store.close()
    return bool(good)


def claude_ping(settings) -> bool:
    if not settings.api_key_present:
        return line(False, "No API key found. Put ANTHROPIC_API_KEY in the .env file first.")
    llm = ClaudeLLM(dataclasses.replace(settings, max_output_tokens=300, effort="low"))
    try:
        reply = llm.reply("You are a connection test. Reply with the single word: ready", [], [{"role": "user", "content": "Are you there?"}])
    except LLMError as err:
        return line(False, f"Claude could not be used: {err}.")
    return line(True, f"Claude answered ({reply.model}): \"{reply.text[:40]}\". Tokens {reply.input_tokens} in, {reply.output_tokens} out, about ${reply.cost:.4f}.")


def claude_review(settings) -> bool:
    svc = Services(dataclasses.replace(settings, agent_mode="auto"))
    if svc.claude is None:
        return line(False, "No API key found, so the full Claude review was skipped.")
    run = svc.store.get_run(svc.start_run(SAMPLE_ID, "review", list_size=10, wait=True))
    tools = [s["name"] for s in run["steps"] if s["type"] == "tool"]
    for step in run["steps"]:
        if step["type"] == "notice":
            print(f"      note: {step['output']['text']}")
    ok = run["status"] == "completed" and run["mode"] == "claude" and bool(run["proposals"])
    line(ok, f"Claude ran a full review: {' -> '.join(tools)}. {len(run['proposals'])} proposals.")
    tokens = run["input_tokens"] + run["output_tokens"] + run["cache_read_tokens"] + run["cache_write_tokens"]
    print(f"      mode: {run['mode']} | tokens: {tokens:,} (cached: {run['cache_read_tokens']:,}) | cost: ${run['cost_usd']:.4f}")
    print("      --- Claude's summary ---")
    print("      " + (run["final_text"] or "").replace("\n", "\n      "))
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--claude", action="store_true", help="also send one tiny request to Claude")
    parser.add_argument("--claude-review", action="store_true", help="also run one full review with Claude")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        settings = dataclasses.replace(get_settings(), data_dir=Path(tmp))
        print("AcuMain self-check (no API key used)")
        good = offline_checks(settings)
        if args.claude or args.claude_review:
            print("Claude connection")
            good &= claude_ping(settings)
        if args.claude_review:
            good &= claude_review(settings)
    print("All checks passed." if good else "Some checks FAILED.")
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
