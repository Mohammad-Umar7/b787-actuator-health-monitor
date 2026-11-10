"""Everything the web layer needs, built once at start-up: the model, the batches, the store and the agent."""
from __future__ import annotations

import threading

import pandas as pd

from . import schema
from .agent import loop, prompts, tools
from .agent.llm import ClaudeLLM, OfflinePlanner
from .batches import Batch, BatchStore
from .config import ARTIFACTS, Settings, get_settings
from .model import RiskModel
from .store import Store, now

SAMPLE_ID = "sample"
SAMPLE_NAME = "Fleet diagnostics, Jan to May 2026 (sample)"
MAX_SELECTED = 100
MAX_LIST_SIZE = 60


class RequestError(ValueError):
    """The request cannot be carried out. `status` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class Services:
    def __init__(self, settings: Settings | None = None, claude=None):
        self.settings = settings or get_settings()
        self.model = RiskModel().load()
        self.store = Store(self.settings.data_dir / "acumain.db")
        self.batches = BatchStore(self.model, self.settings.data_dir)
        self.batches.load_saved()
        if self.batches.get(SAMPLE_ID) is None:
            raw = pd.read_csv(ARTIFACTS / "sample_records.csv", dtype=str, keep_default_na=False)
            self.batches.add(SAMPLE_NAME, "sample", raw, batch_id=SAMPLE_ID)
        # `claude` can be injected by the tests; otherwise it exists only when a key was configured.
        self.claude = claude if claude is not None else (ClaudeLLM(self.settings) if self.settings.claude_enabled else None)
        self._threads: dict[str, threading.Thread] = {}

    # ------------------------------------------------------------------ status
    def agent_status(self) -> dict:
        spent = self.store.spend_today()
        if self.claude is None:
            reason = ("Claude is switched off in the configuration." if self.settings.agent_mode == "offline"
                      else "No API key is configured, so the built-in planner is used. It costs nothing.")
            mode = "offline"
        elif spent >= self.settings.daily_usd_limit:
            mode, reason = "offline", f"Today's Claude spend limit (${self.settings.daily_usd_limit:.2f}) is used up, so the built-in planner is used."
        else:
            mode, reason = "claude", None
        return {"mode": mode, "model": self.settings.model if mode == "claude" else "built-in planner", "reason": reason,
                "spent_today_usd": round(spent, 4), "daily_limit_usd": self.settings.daily_usd_limit,
                "run_limit_usd": self.settings.run_usd_limit, "effort": self.settings.effort}

    # ------------------------------------------------------------------ batches
    def batch(self, batch_id: str) -> Batch:
        batch = self.batches.get(batch_id)
        if batch is None:
            raise RequestError("That batch does not exist.", 404)
        return batch

    def upload(self, content: bytes, filename: str, name: str | None) -> Batch:
        try:
            raw = schema.read_table(content, filename)
            return self.batches.add(name or filename.rsplit(".", 1)[0], "upload", raw)
        except schema.SchemaError as err:
            raise RequestError(str(err), 422) from err

    def preview(self, values: dict) -> dict:
        """Check and score one record typed into the form. Nothing is stored."""
        row = {col: ("" if values.get(col) is None else str(values.get(col))) for col in schema.REQUIRED}
        row["Case_ID"] = "manual-check"
        row["Aircraft_ID"] = str(values.get("Aircraft_ID") or "Manual check")
        try:
            checked = schema.check(pd.DataFrame([row]))
        except schema.SchemaError as err:
            raise RequestError(str(err), 422) from err
        temp = Batch(id="preview", name="Manual check", source="manual", created_at=now(), checked=checked)
        temp.results = self.model.score(temp.frame, temp.checked.scorable)        # raises ModelUnavailable
        return self.batches.detail(temp, "manual-check")

    def reset(self, batch_id: str) -> None:
        batch = self.batch(batch_id)
        if self.store.active_run(batch_id):
            raise RequestError("The assistant is still working on this batch.", 409)
        self.batches.clear_results(batch)
        self.store.clear_batch(batch_id)

    def proposals_by_record(self, batch_id: str) -> dict:
        """The open or decided proposal for each record, newest first."""
        out: dict = {}
        for p in self.store.list_proposals(batch_id=batch_id):
            if p["record_id"] not in out or p["created_at"] > out[p["record_id"]]["created_at"]:
                out[p["record_id"]] = p
        return out

    # ------------------------------------------------------------------ agent runs
    def start_run(self, batch_id: str, kind: str, question: str | None = None, record_ids: list | None = None,
                  list_size: int = 25, selected: str | None = None, screen: dict | None = None, wait: bool = False) -> str:
        batch = self.batch(batch_id)
        if kind not in ("review", "question"):
            raise RequestError("kind must be 'review' or 'question'.")
        if self.store.active_run(batch_id):
            raise RequestError("The assistant is already working on this batch. Wait for it to finish.", 409)
        question = (question or "").strip()
        if kind == "question" and not question:
            raise RequestError("Type a question first.")
        if len(question) > 600:
            raise RequestError("The question is too long. Keep it under 600 characters.")
        known = set(batch.frame["Record_ID"])
        scope = [r for r in dict.fromkeys(record_ids or []) if r in known] or None
        if record_ids and not scope:
            raise RequestError("None of the selected records are in this batch.")
        if scope and len(scope) > MAX_SELECTED:
            raise RequestError(f"Select at most {MAX_SELECTED} records, or review the whole batch.")
        list_size = max(1, min(int(list_size or 25), MAX_LIST_SIZE))
        selected = selected if selected in known else None
        screen = {k: v for k, v in (screen or {}).items() if k in ("page", "filter", "search") and isinstance(v, (str, int, float))}

        status = self.agent_status()
        primary = self.claude if status["mode"] == "claude" else None
        planner = OfflinePlanner(kind, list_size, selected)
        context = {"kind": kind, "question": question or None, "record_ids": scope, "list_size": list_size, "selected": selected, "screen": screen}
        task = "Prepare the action list" if kind == "review" else question
        run_id = self.store.create_run(kind, task, batch_id, "claude" if primary else "built-in planner",
                                       self.settings.model if primary else planner.label, context)
        if status["mode"] != "claude" and status["reason"]:
            self.store.note(run_id, status["reason"])
        if kind == "review":
            user_text = prompts.review_message(batch.name, len(batch.frame), scope, list_size, self.model.available, screen)
        else:
            user_text = prompts.question_message(question, batch.name, self.batches.summary(batch), selected, screen)
        ctx = tools.ToolContext(batches=self.batches, model=self.model, store=self.store, batch=batch, run_id=run_id,
                                scope_ids=scope, list_size=list_size)

        def work():
            try:
                final = loop.run(run_id, user_text, ctx, self.settings, self.store, primary or planner, planner)
                self.store.finish_run(run_id, "completed", final)
            except Exception as err:  # the run must always end in a recorded state
                self.store.finish_run(run_id, "failed", None, error=f"{type(err).__name__}: {err}")

        if wait:
            work()
        else:
            thread = threading.Thread(target=work, name=run_id, daemon=True)
            self._threads[run_id] = thread
            thread.start()
        return run_id

    # ------------------------------------------------------------------ decisions
    def decide(self, proposal_id: str, decision: str, note: str | None = None) -> dict:
        if decision not in ("approved", "rejected"):
            raise RequestError("decision must be 'approved' or 'rejected'.")
        proposal = self.store.decide(proposal_id, decision, note=(note or "").strip()[:300] or None)
        if proposal is None:
            raise RequestError("That proposal does not exist.", 404)
        return proposal

    def decide_many(self, batch_id: str, decision: str, ids: list | None = None, action: str | None = None) -> list:
        self.batch(batch_id)
        pending = [p for p in self.store.list_proposals(batch_id=batch_id, status="pending")
                   if (not ids or p["id"] in ids) and (not action or p["action"] == action)]
        return [self.decide(p["id"], decision) for p in pending]
