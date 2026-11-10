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

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, kind TEXT, task TEXT, batch_id TEXT, status TEXT, mode TEXT, model TEXT,
  started_at TEXT, finished_at TEXT, context TEXT, final_text TEXT, error TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0);
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
"""
MAX_STORED = 12000   # characters of a step's input or output kept in the log


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(value) -> str:
    text = json.dumps(value, default=str, ensure_ascii=False)
    return text if len(text) <= MAX_STORED else json.dumps({"truncated": True, "preview": text[:MAX_STORED]}, ensure_ascii=False)


def _load(text):
    if text is None:
        return None
    try:
        return json.loads(text)
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

    def start_step(self, run_id: str, type_: str, name: str, input_=None) -> int:
        with self._lock:
            seq = self._db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE run_id=?", (run_id,)).fetchone()[0]
            self._db.execute("INSERT INTO steps (run_id, seq, type, name, status, input, started_at) VALUES (?,?,?,?,?,?,?)",
                             (run_id, seq, type_, name, "running", _json(input_), now()))
            self._db.commit()
        return seq

    def finish_step(self, run_id: str, seq: int, output=None, is_error: bool = False, duration_ms: int = 0,
                    tokens_in: int = 0, tokens_out: int = 0, cost_usd: float = 0.0) -> None:
        self._run("UPDATE steps SET status=?, output=?, is_error=?, duration_ms=?, tokens_in=?, tokens_out=?, cost_usd=? WHERE run_id=? AND seq=?",
                  ("failed" if is_error else "done", _json(output), int(is_error), duration_ms, tokens_in, tokens_out, cost_usd, run_id, seq))

    def note(self, run_id: str, text: str, is_error: bool = False) -> None:
        seq = self.start_step(run_id, "notice", "notice")
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
        run["context"] = _load(run["context"])
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
            run["context"] = _load(run["context"])
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
        return self._all(sql + " ORDER BY CASE action WHEN 'repair' THEN 0 WHEN 'retest' THEN 1 ELSE 2 END, risk DESC, id", args)

    def decide(self, proposal_id: str, decision: str, by: str = "planner", note: str | None = None) -> dict | None:
        """Approve or reject. Approval is the only thing that creates a (simulated) work order."""
        with self._lock:
            row = self._db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone()
            if not row:
                return None
            if row["status"] != "pending":
                return dict(row)
            work_order = None
            if decision == "approved":
                work_order = self._next_id("work_orders", "WO-SIM")
                self._db.execute("INSERT INTO work_orders (id, proposal_id, batch_id, record_id, aircraft_id, action, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
                                 (work_order, proposal_id, row["batch_id"], row["record_id"], row["aircraft_id"], row["action"], "Created (simulated)", now()))
            self._db.execute("UPDATE proposals SET status=?, decided_at=?, decided_by=?, decision_note=?, work_order_id=? WHERE id=?",
                             (decision, now(), by, note, work_order, proposal_id))
            self._db.commit()
            return dict(self._db.execute("SELECT * FROM proposals WHERE id=?", (proposal_id,)).fetchone())

    def list_work_orders(self, batch_id: str | None = None) -> list:
        if batch_id:
            return self._all("SELECT * FROM work_orders WHERE batch_id=? ORDER BY created_at DESC", (batch_id,))
        return self._all("SELECT * FROM work_orders ORDER BY created_at DESC")

    def clear_batch(self, batch_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM work_orders WHERE batch_id=?", (batch_id,))
            self._db.execute("DELETE FROM proposals WHERE batch_id=?", (batch_id,))
            self._db.commit()
