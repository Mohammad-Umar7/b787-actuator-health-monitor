"""Batches of records waiting for review: the sample the app starts with, and any file the user uploads.

A batch holds the cleaned records, what was wrong with them, and (after the model has run) the results.
Everything the dashboard and the agent's tools show about a record is produced here, from the model's
output, so both always say the same thing.
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from . import schema
from .jsonsafe import jsonable
from .model import ACTIONS, LEVEL_NAMES, RiskModel, number
from .store import now

LEVEL_ORDER = {"High": 0, "Medium": 1, "Low": 2, "Not scored": 3}
KEY_READINGS = ("op_level", "leak_level")


@dataclass
class Batch:
    id: str
    name: str
    source: str                       # "sample", "upload", or "manual" for one record typed into the form
    created_at: str
    checked: schema.Checked
    results: pd.DataFrame | None = None
    scored_at: str | None = None
    model_version: str | None = None

    @property
    def frame(self) -> pd.DataFrame:
        return self.checked.frame

    @property
    def scored(self) -> bool:
        return self.results is not None


class BatchStore:
    def __init__(self, model: RiskModel, data_dir: Path):
        self.model = model
        self.dir = Path(data_dir) / "batches"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._batches: dict[str, Batch] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ creating and loading
    def add(self, name: str, source: str, raw: pd.DataFrame, batch_id: str | None = None, persist: bool = True) -> Batch:
        checked = schema.check(raw, id_prefix="R")
        batch = Batch(id=batch_id or "b_" + uuid.uuid4().hex[:8], name=name.strip()[:80] or "Uploaded records",
                      source=source, created_at=now(), checked=checked)
        with self._lock:
            self._batches[batch.id] = batch
        if persist:
            folder = self.dir / batch.id
            folder.mkdir(parents=True, exist_ok=True)
            raw.to_csv(folder / "records.csv", index=False, lineterminator="\n")
            (folder / "meta.json").write_text(json.dumps({"name": batch.name, "source": source, "created_at": batch.created_at}), encoding="utf-8")
        return batch

    def load_saved(self) -> None:
        """Bring back uploaded batches (and their results) after a restart."""
        for folder in sorted(self.dir.iterdir()):
            try:
                meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
                raw = pd.read_csv(folder / "records.csv", dtype=str, keep_default_na=False)
                batch = self.add(meta["name"], meta["source"], raw, batch_id=folder.name, persist=False)
                batch.created_at = meta.get("created_at", batch.created_at)
                saved = folder / "results.json"
                if saved.is_file():
                    data = json.loads(saved.read_text(encoding="utf-8"))
                    batch.results = pd.DataFrame(data["rows"])
                    batch.scored_at, batch.model_version = data.get("scored_at"), data.get("model_version")
            except Exception:  # one unreadable folder must not stop the app from starting
                continue

    def get(self, batch_id: str) -> Batch | None:
        return self._batches.get(batch_id)

    def all(self) -> list:
        return sorted(self._batches.values(), key=lambda b: (b.source != "sample", b.created_at))

    def remove(self, batch_id: str) -> bool:
        batch = self._batches.get(batch_id)
        if not batch or batch.source == "sample":
            return False
        with self._lock:
            del self._batches[batch_id]
        folder = self.dir / batch_id
        if re.fullmatch(r"b_[0-9a-f]{8}", batch_id) and folder.is_dir():
            for item in folder.iterdir():
                item.unlink()
            folder.rmdir()
        return True

    # ------------------------------------------------------------------ scoring
    def score(self, batch: Batch) -> pd.DataFrame:
        """Run the model on every scorable record. Raises ModelUnavailable; the batch keeps whatever it had before."""
        results = self.model.score(batch.frame, batch.checked.scorable)
        with self._lock:
            batch.results, batch.scored_at, batch.model_version = results, now(), self.model.version
        folder = self.dir / batch.id
        if folder.is_dir():
            payload = {"scored_at": batch.scored_at, "model_version": batch.model_version,
                       "rows": json.loads(results.to_json(orient="records"))}
            (folder / "results.json").write_text(json.dumps(payload), encoding="utf-8")
        return results

    def clear_results(self, batch: Batch) -> None:
        with self._lock:
            batch.results, batch.scored_at, batch.model_version = None, None, None
        saved = self.dir / batch.id / "results.json"
        if saved.is_file():
            saved.unlink()

    # ------------------------------------------------------------------ views
    def table(self, batch: Batch) -> pd.DataFrame:
        """One row per record with everything the list views need."""
        f = batch.frame
        t = pd.DataFrame({"record_id": f["Record_ID"], "aircraft_id": f["Aircraft_ID"], "actuator_id": f["Actuator_ID"],
                          "date": f["Observation_Date"], "grade": f["Hydraulic_Fluid_Grade"], "age_hours": f["Actuator_Age_Hours"]})
        t["issues"] = [len(batch.checked.issues.get(r, [])) for r in f["Record_ID"]]
        t["scorable"] = batch.checked.scorable.to_numpy()
        if batch.scored:
            r = batch.results
            for col in ("risk", "level", "prediction", "time_ratio", "leak_ratio", "pressure_variation", "op_level", "leak_level", "f_op", "f_leak", "f_pv"):
                t[col] = r[col].to_numpy()
            t["reason"] = [self.model.reason(o, l, s) for o, l, s in zip(t["op_level"], t["leak_level"], t["scorable"])]
            t["time_left"] = [self.model.time_left(v) if lvl in ("High", "Medium") else None for v, lvl in zip(t["risk"], t["level"])]
            t["suggested_action"] = [self.model.suggested_action(lvl, o, l) for lvl, o, l in zip(t["level"], t["op_level"], t["leak_level"])]
        else:
            t["level"] = np.where(t["scorable"], "Awaiting model", "Not scored")
        if schema.ANSWER_COLUMN in f.columns:
            t["actual"] = f[schema.ANSWER_COLUMN].to_numpy()
        return t

    def summary(self, batch: Batch, ids: list | None = None) -> dict:
        t = self.table(batch)
        if ids:
            t = t[t["record_id"].isin(ids)]
        out = {"id": batch.id, "name": batch.name, "source": batch.source, "created_at": batch.created_at,
               "records": int(len(t)), "scored": batch.scored, "scored_at": batch.scored_at, "model_version": batch.model_version,
               "with_issues": int((t["issues"] > 0).sum()), "not_scorable": int((~t["scorable"]).sum()),
               "file_notes": batch.checked.notes, "has_answers": batch.checked.has_answers}
        if batch.scored:
            levels = t["level"].value_counts().to_dict()
            out["levels"] = {k: int(levels.get(k, 0)) for k in ("High", "Medium", "Low", "Not scored")}
            out["expected_failures"] = round(float(t["risk"].fillna(0).sum() / 100), 1)
            key_missing = t["op_level"].isna() | t["leak_level"].isna()
            out["high_missing_key_reading"] = int(((t["level"] == "High") & key_missing).sum())
            out["medium_missing_key_reading"] = int(((t["level"] == "Medium") & key_missing).sum())
            if batch.checked.has_answers:
                out["answer_check"] = self._answer_check(t)
        return out

    @staticmethod
    def _answer_check(t: pd.DataFrame) -> dict:
        """When the uploaded file carries the real answers, say honestly how the model did on it."""
        known = t["actual"].isin(["Yes", "No"]) & t["prediction"].isin(["Yes", "No"])
        actual, predicted = t.loc[known, "actual"].eq("Yes"), t.loc[known, "prediction"].eq("Yes")
        tp, fp, fn, tn = int((actual & predicted).sum()), int((~actual & predicted).sum()), int((actual & ~predicted).sum()), int((~actual & ~predicted).sum())
        return {"records": int(known.sum()), "caught": tp, "missed": fn, "false_alarms": fp, "correct_no": tn,
                "f1": round(200 * tp / max(2 * tp + fp + fn, 1), 1), "accuracy": round(100 * (tp + tn) / max(int(known.sum()), 1), 1),
                "precision": round(100 * tp / max(tp + fp, 1), 1), "recall": round(100 * tp / max(tp + fn, 1), 1)}

    def rows(self, batch: Batch, level: str | None = None, query: str | None = None, only_issues: bool = False,
             ids: list | None = None, sort: str = "risk", descending: bool = True, offset: int = 0, limit: int = 50,
             exclude: set | None = None) -> dict:
        t = self.table(batch)
        if ids:
            t = t[t["record_id"].isin(ids)]
        if exclude:
            t = t[~t["record_id"].isin(exclude)]
        if level and level != "Any":
            t = t[t["level"] == level]
        if only_issues:
            t = t[t["issues"] > 0]
        if query:
            q = query.strip().lower()
            t = t[t["record_id"].str.lower().str.contains(q, regex=False) | t["aircraft_id"].astype(str).str.lower().str.contains(q, regex=False)]
        total = len(t)
        if batch.scored and sort == "risk":
            t = t.assign(_order=t["level"].map(LEVEL_ORDER)).sort_values(["risk", "_order", "record_id"], ascending=[not descending, True, True], na_position="last")
        else:
            t = t.sort_values("aircraft_id" if sort == "aircraft" else "record_id", ascending=not descending if sort != "risk" else True)
        page = t.iloc[max(offset, 0): max(offset, 0) + max(1, min(limit, 500))]
        return {"total": int(total), "offset": offset, "rows": [jsonable(self._compact(row)) for row in page.to_dict("records")]}

    @staticmethod
    def _compact(row: dict) -> dict:
        out = {"record_id": row["record_id"], "aircraft_id": row["aircraft_id"], "date": row.get("date"),
               "level": row["level"], "issues": int(row["issues"]), "scorable": bool(row["scorable"])}
        if "risk" in row:
            out.update(risk=number(row["risk"], 1), reason=row["reason"], time_left=row["time_left"], suggested_action=row["suggested_action"],
                       op_level=number(row["op_level"], 0), leak_level=number(row["leak_level"], 0), prediction=row["prediction"])
        if isinstance(row.get("actual"), str) and row["actual"] in ("Yes", "No"):
            out["actual"] = row["actual"]
        return out

    def detail(self, batch: Batch, record_id: str) -> dict | None:
        found = self._detail(batch, record_id)
        return None if found is None else jsonable(found)

    def _detail(self, batch: Batch, record_id: str) -> dict | None:
        f = batch.frame
        match = np.flatnonzero((f["Record_ID"] == record_id).to_numpy())
        if not len(match):
            return None
        i = int(match[0])
        raw = f.iloc[i]
        m = self.model
        out = {"batch_id": batch.id, "record_id": record_id, "aircraft_id": raw["Aircraft_ID"], "actuator_id": raw["Actuator_ID"],
               "date": raw["Observation_Date"], "scorable": bool(batch.checked.scorable.iloc[i]),
               "issues": batch.checked.issues.get(record_id, []), "scored": batch.scored,
               "inputs": [{"name": name, "label": label, "unit": unit, "value": number(raw[name], 3)}
                          for name, (label, unit, _lo, _hi) in schema.NUMERIC.items()],
               "grade": raw["Hydraulic_Fluid_Grade"]}
        if schema.ANSWER_COLUMN in f.columns and raw[schema.ANSWER_COLUMN] in ("Yes", "No"):
            out["actual"] = raw[schema.ANSWER_COLUMN]
        if not batch.scored:
            return out
        r = batch.results.iloc[i]
        op, leak = r["op_level"], r["leak_level"]
        level_name = lambda v: None if pd.isna(v) else LEVEL_NAMES[int(v)]
        out.update({
            "risk": number(r["risk"], 1), "level": r["level"], "prediction": r["prediction"],
            "reason": m.reason(op, leak, out["scorable"]),
            "time_left": m.time_left(r["risk"]),
            "suggested_action": m.suggested_action(r["level"], op, leak),
            "readings": {
                "operation": {"level": number(op, 0), "level_name": level_name(op), "ratio": number(r["time_ratio"], 3), "text": m.slower_text(r["time_ratio"])},
                "leakage": {"level": number(leak, 0), "level_name": level_name(leak), "ratio": number(r["leak_ratio"], 3), "text": m.leak_text(r["leak_ratio"])},
                "pressure_variation": {"value": number(r["pressure_variation"], 0)},
            },
            "factors": [{"name": name, "share": int(r[key])} for name, key in (("Operation time", "f_op"), ("Leakage", "f_leak"), ("Pressure variation", "f_pv")) if int(r[key]) > 0],
            "evidence": m.evidence(op, leak),
        })
        missing_key = [name for name, v in (("actuation time", op), ("leakage", leak)) if pd.isna(v)]
        if out["scorable"]:
            band = m.band(float(r["risk"]))
            out["band"] = {k: band[k] for k in ("from", "to", "n", "in_30_days", "in_12_weeks")}
            out["confidence"] = (f"Reduced: this prediction was made without the {' and '.join(missing_key)} reading." if missing_key
                                 else "Normal: both key readings were available.")
        # The planner's steps for each action that makes sense here. A record with no prediction can only be re-tested.
        possible = ("repair", "inspect", "retest", "monitor") if out["scorable"] else ("retest",)
        out["plans"] = {a: m.next_steps(a, r["risk"] if out["scorable"] else None, op, leak, missing_key, out["factors"]) for a in possible}
        return out


def action_label(action: str) -> str:
    return ACTIONS.get(action, action)
