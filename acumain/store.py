"""What the app remembers between requests: agent runs with every step, proposed actions, and work orders.

Work orders are simulated. Approving a proposal writes a row here and nowhere else; no real maintenance
system is contacted.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .jsonsafe import jsonable

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, kind TEXT, task TEXT, batch_id TEXT, status TEXT, mode TEXT, model TEXT,
  started_at TEXT, finished_at TEXT, context TEXT, final_text TEXT, error TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
  archived INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT, seq INTEGER, type TEXT, name TEXT, status TEXT, input TEXT, output TEXT, is_error INTEGER DEFAULT 0,
  started_at TEXT, duration_ms INTEGER, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
  PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, run_id TEXT, batch_id TEXT, record_id TEXT, aircraft_id TEXT, action TEXT, note TEXT,
  reason TEXT, risk REAL, level TEXT, time_left TEXT, status TEXT, created_at TEXT, decided_at TEXT,
  decided_by TEXT, decision_note TEXT, work_order_id TEXT);
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY, proposal_id TEXT, batch_id TEXT, record_id TEXT, aircraft_id TEXT, action TEXT,
  status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS parts_requests (
  id TEXT PRIMARY KEY, run_id TEXT, batch_id TEXT, status TEXT, lines TEXT, note TEXT,
  created_at TEXT, decided_at TEXT, decision_note TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"""
MAX_STORED = 12000   # characters of a step's input or output kept in the log


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(value) -> str:
    text = json.dumps(jsonable(value), ensure_ascii=False, allow_nan=False)
    return text if len(text) <= MAX_STORED else json.dumps({"truncated": True, "preview": text[:MAX_STORED]}, ensure_ascii=False)


def _load(text):
    if text is None:
        return None
    try:
        return jsonable(json.loads(text))
    except json.JSONDecodeError:
        return text


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._db.executescript(SCHEMA)
            # Columns added after the first version: a database from before then gets them here.
            for table, column, kind in (("runs", "archived", "INTEGER DEFAULT 0"), ("steps", "agent", "TEXT"), ("proposals", "part", "TEXT"),
                                        ("work_orders", "cancelled_at", "TEXT")):
                if column not in [row[1] for row in self._db.execute(f"PRAGMA table_info({table})")]:
                    self._db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            # A run left "running" by a previous process can never finish.
            self._db.execute("UPDATE runs SET status='failed', error='The server stopped before this run finished.', finished_at=? WHERE status='running'", (now(),))
            self._db.execute("UPDATE steps SET status='failed' WHERE status='running'")
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _all(self, sql, args=()):
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def _one(self, sql, args=()):
        rows = self._all(sql, args)
        return rows[0] if rows else None

    def _run(self, sql, args=()):
        with self._lock:
            self._db.execute(sql, args)
            self._db.commit()

    # ------------------------------------------------------------------ runs and steps
    def create_run(self, kind: str, task: str, batch_id: str, mode: str, model: str, context: dict) -> str:
        run_id = "run_" + uuid.uuid4().hex[:10]
        self._run("INSERT INTO runs (id, kind, task, batch_id, status, mode, model, started_at, context) VALUES (?,?,?,?,?,?,?,?,?)",
                  (run_id, kind, task, batch_id, "running", mode, model, now(), _json(context)))
        return run_id

    def start_step(self, run_id: str, type_: str, name: str, input_=None, agent: str | None = None) -> int:
        """`agent` says which member of the team took the step: lead, risk, stock or supply. None for a single agent."""
        with self._lock:
            seq = self._db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE run_id=?", (run_id,)).fetchone()[0]
            self._db.execute("INSERT INTO steps (run_id, seq, type, name, status, input, started_at, agent) VALUES (?,?,?,?,?,?,?,?)",
                             (run_id, seq, type_, name, "running", _json(input_), now(), agent))
            self._db.commit()
        return seq

    def finish_step(self, run_id: str, seq: int, output=None, is_error: bool = False, duration_ms: int = 0,
                    tokens_in: int = 0, tokens_out: int = 0, cost_usd: float = 0.0) -> None:
        self._run("UPDATE steps SET status=?, output=?, is_error=?, duration_ms=?, tokens_in=?, tokens_out=?, cost_usd=? WHERE run_id=? AND seq=?",
                  ("failed" if is_error else "done", _json(output), int(is_error), duration_ms, tokens_in, tokens_out, cost_usd, run_id, seq))

    def note(self, run_id: str, text: str, is_error: bool = False, agent: str | None = None) -> None:
        seq = self.start_step(run_id, "notice", "notice", agent=agent)
        self.finish_step(run_id, seq, output={"text": text}, is_error=is_error)

    def add_usage(self, run_id: str, input_tokens: int, output_tokens: int, cache_write: int, cache_read: int, cost: float) -> None:
        self._run("UPDATE runs SET input_tokens=input_tokens+?, output_tokens=output_tokens+?, cache_write_tokens=cache_write_tokens+?, "
                  "cache_read_tokens=cache_read_tokens+?, cost_usd=cost_usd+? WHERE id=?",
                  (input_tokens, output_tokens, cache_write, cache_read, cost, run_id))

    def set_mode(self, run_id: str, mode: str) -> None:
        self._run("UPDATE runs SET mode=? WHERE id=?", (mode, run_id))

    def finish_run(self, run_id: str, status: str, final_text: str | None = None, error: str | None = None) -> None:
        self._run("UPDATE runs SET status=?, final_text=?, error=?, finished_at=? WHERE id=?", (status, final_text, error, now(), run_id))

    def get_run(self, run_id: str) -> dict | None:
        run = self._one("SELECT * FROM runs WHERE id=?", (run_id,))
        if not run:
            return None
        run["context"], run["archived"] = _load(run["context"]), bool(run["archived"])
        steps = self._all("SELECT * FROM steps WHERE run_id=? ORDER BY seq", (run_id,))
        for step in steps:
            step["input"], step["output"], step["is_error"] = _load(step["input"]), _load(step["output"]), bool(step["is_error"])
        run["steps"] = steps
        run["proposals"] = self.list_proposals(run_id=run_id)
        return run

    def list_runs(self, limit: int = 50) -> list:
        runs = self._all("SELECT r.*, (SELECT COUNT(*) FROM steps s WHERE s.run_id=r.id AND s.type='tool') AS tool_calls, "
                         "(SELECT COUNT(*) FROM steps s WHERE s.run_id=r.id AND s.type='model') AS model_calls, "
                         "(SELECT COUNT(*) FROM proposals p WHERE p.run_id=r.id) AS proposals "
                         "FROM runs r ORDER BY r.started_at DESC LIMIT ?", (limit,))
        for run in runs:
            run["context"], run["archived"] = _load(run["context"]), bool(run["archived"])
        return runs

    def active_run(self, batch_id: str) -> str | None:
        row = self._one("SELECT id FROM runs WHERE batch_id=? AND status='running' ORDER BY started_at DESC LIMIT 1", (batch_id,))
        return row["id"] if row else None

    def spend_today(self) -> float:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        row = self._one("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM runs WHERE substr(started_at, 1, 10)=?", (today,))
        return float(row["usd"])

    # ------------------------------------------------------------------ proposals and work orders
    def _next_id(self, table: str, prefix: str) -> str:
        # Highest number used so far, so an ID is never reused after a batch is cleared.
        highest = self._db.execute(f"SELECT MAX(CAST(substr(id, ?) AS INTEGER)) FROM {table}", (len(prefix) + 2,)).fetchone()[0]
        return f"{prefix}-{(highest or 0) + 1:04d}"

    def add_proposals(self, run_id: str, batch_id: str, items: list) -> dict:
        """Each item needs record_id, aircraft_id, action, note, reason, risk, level, time_left.
        A record keeps one open proposal: a new one replaces a pending one, and never overrides a decision."""
        created, replaced, skipped = [], 0, []
        with self._lock:
            for item in items:
                existing = self._db.execute("SELECT id, status, work_order_id FROM proposals WHERE batch_id=? AND record_id=? AND status IN ('pending','approved') "
                                            "ORDER BY created_at DESC LIMIT 1", (batch_id, item["record_id"])).fetchone()
                if existing and existing["status"] == "approved":
                    skipped.append({"record_id": item["record_id"], "why": f"already approved as work order {existing['work_order_id']}"})
                    continue
                if existing:
                    self._db.execute("UPDATE proposals SET status='superseded', decided_at=? WHERE id=?", (now(), existing["id"]))
                    replaced += 1
                pid = self._next_id("proposals", "P")
                self._db.execute("INSERT INTO proposals (id, run_id, batch_id, record_id, aircraft_id, action, note, reason, risk, level, time_left, status, created_at) "
                                 "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                 (pid, run_id, batch_id, item["record_id"], item.get("aircraft_id"), item["action"], item.get("note"),
                                  item.get("reason"), item.get("risk"), item.get("level"), item.get("time_left"), "pending", now()))
                created.append(pid)
            self._db.commit()
        return {"created": created, "replaced": replaced, "skipped": skipped}

    def list_proposals(self, batch_id: str | None = None, status: str | None = None, run_id: str | None = None) -> list:
        sql, args = "SELECT * FROM proposals WHERE status != 'superseded'", []
        for column, value in (("batch_id", batch_id), ("status", status), ("run_id", run_id)):
            if value:
                sql += f" AND {column}=?"
                args.append(value)
        rows = self._all(sql + " ORDER BY CASE action WHEN 'repair' THEN 0 WHEN 'retest' THEN 1 ELSE 2 END, risk DESC, id", args)
        for row in rows:
            row["part"] = _load(row.get("part"))
        return rows

    def set_part(self, proposal_id: str, part: dict | None) -> None:
        """Where the spare part for a proposed repair comes from, and when it arrives. Simulated."""
        self._run("UPDATE proposals SET part=? WHERE id=?", (None if part is None else _json(part), proposal_id))

    def decide(self, proposal_id: str, decision: str, by: str = "planner", note: str | None = None, override: bool = False) -> dict | None:
        """Approve or reject. Approval is the only thing that creates a (simulated) work order.

        Without `override` only a pending proposal can be decided. With it, the planner changes a decision already
        taken: rejecting an approved action cancels its work order (the order stays on record, marked cancelled),
        and approving a rejected one creates a new work order. A proposal that a newer review replaced can never
        be decided. Returns the proposal as it now stands, so the caller can tell whether the decision applied."""
        with self._lock:
            row = self._db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone()
            if not row:
                return None
            status = row["status"]
            if status == decision or status == "superseded" or (status != "pending" and not override):
                return self._proposal(row)
            if status == "rejected":
                # The record may have been proposed again since. Two open actions for one aircraft would be a mistake.
                other = self._db.execute("SELECT id FROM proposals WHERE batch_id=? AND record_id=? AND id!=? AND status IN ('pending','approved') LIMIT 1",
                                         (row["batch_id"], row["record_id"], proposal_id)).fetchone()
                if other:
                    return {**self._proposal(row), "blocked_by": other["id"]}
            if status == "approved" and row["work_order_id"]:
                self._db.execute("UPDATE work_orders SET status=?, cancelled_at=? WHERE id=?", ("Cancelled (simulated)", now(), row["work_order_id"]))
            work_order = None
            if decision == "approved":
                work_order = self._next_id("work_orders", "WO-SIM")
                self._db.execute("INSERT INTO work_orders (id, proposal_id, batch_id, record_id, aircraft_id, action, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
                                 (work_order, proposal_id, row["batch_id"], row["record_id"], row["aircraft_id"], row["action"], "Created (simulated)", now()))
            self._db.execute("UPDATE proposals SET status=?, decided_at=?, decided_by=?, decision_note=?, work_order_id=? WHERE id=?",
                             (decision, now(), by, note, work_order, proposal_id))
            self._db.commit()
            return self._proposal(self._db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone())

    @staticmethod
    def _proposal(row) -> dict:
        out = dict(row)
        out["part"] = _load(out.get("part"))
        return out

    def list_work_orders(self, batch_id: str | None = None) -> list:
        if batch_id:
            return self._all("SELECT * FROM work_orders WHERE batch_id=? ORDER BY created_at DESC", (batch_id,))
        return self._all("SELECT * FROM work_orders ORDER BY created_at DESC")

    def clear_batch(self, batch_id: str) -> None:
        """Forget a batch's proposals and work orders. Its runs stay in the activity log, marked as archived,
        so the review queue no longer shows a summary of results that are gone."""
        with self._lock:
            self._db.execute("DELETE FROM work_orders WHERE batch_id=?", (batch_id,))
            self._db.execute("DELETE FROM proposals WHERE batch_id=?", (batch_id,))
            self._db.execute("DELETE FROM parts_requests WHERE batch_id=?", (batch_id,))
            self._db.execute("UPDATE runs SET archived=1 WHERE batch_id=?", (batch_id,))
            self._db.commit()

    # ------------------------------------------------------------------ parts requests (simulated)
    def add_parts_request(self, run_id: str, batch_id: str, lines: list, note: str | None = None) -> str:
        """File a request to the supply department. A batch keeps one open request: a new one replaces a pending one."""
        with self._lock:
            self._db.execute("UPDATE parts_requests SET status='superseded', decided_at=? WHERE batch_id=? AND status='pending'", (now(), batch_id))
            rid = self._next_id("parts_requests", "PR-SIM")
            self._db.execute("INSERT INTO parts_requests (id, run_id, batch_id, status, lines, note, created_at) VALUES (?,?,?,?,?,?,?)",
                             (rid, run_id, batch_id, "pending", _json(lines), note, now()))
            self._db.commit()
        return rid

    def list_parts_requests(self, batch_id: str | None = None, run_id: str | None = None) -> list:
        sql, args = "SELECT * FROM parts_requests WHERE status != 'superseded'", []
        for column, value in (("batch_id", batch_id), ("run_id", run_id)):
            if value:
                sql += f" AND {column}=?"
                args.append(value)
        rows = self._all(sql + " ORDER BY created_at DESC, id DESC", args)
        for row in rows:
            row["lines"] = _load(row["lines"]) or []
        return rows

    def decide_parts_request(self, request_id: str, decision: str, note: str | None = None, override: bool = False) -> dict | None:
        """Approve or reject a parts request. With `override`, a decision already taken can be changed.
        Returns it as it now stands, or None if it does not exist."""
        with self._lock:
            row = self._db.execute("SELECT * FROM parts_requests WHERE id=?", (request_id,)).fetchone()
            if not row:
                return None
            if row["status"] == "pending" or (override and row["status"] in ("approved", "rejected") and row["status"] != decision):
                self._db.execute("UPDATE parts_requests SET status=?, decided_at=?, decision_note=? WHERE id=?", (decision, now(), note, request_id))
                self._db.commit()
                row = self._db.execute("SELECT * FROM parts_requests WHERE id=?", (request_id,)).fetchone()
            out = dict(row)
            out["lines"] = _load(out["lines"]) or []
            return out

    # ------------------------------------------------------------------ small settings kept between restarts
    def get_setting(self, key: str, default=None):
        row = self._one("SELECT value FROM settings WHERE key=?", (key,))
        return default if row is None else _load(row["value"])

    def set_setting(self, key: str, value) -> None:
        self._run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, _json(value)))
