"""The trained Stage 2 model as a service: load it once, score cleaned records, and explain every result.

The saved bundle holds the fitted model together with its fitted preprocessing (imputers, scalers, the
feature recipe in risk_model/stage2/case1.py) and the Yes/No cut-off chosen in validation. Nothing is refitted
here, so a record gets exactly the treatment the leaderboard predictions got.
"""
from __future__ import annotations

import hashlib
import json
import sys
import threading
from pathlib import Path

import numpy as np
import pandas as pd

from . import schema
from .config import ARTIFACTS, ROOT

STAGE2_CODE = ROOT / "risk_model" / "stage2"
LEVEL_NAMES = ["Normal", "Slightly High", "High", "Very High"]
OP_PHRASE = [None, "operation starting to slow", "slow operation", "very slow operation"]
LEAK_PHRASE = [None, "leakage starting to rise", "high leakage", "very high leakage"]
ACTIONS = {
    "repair": "Schedule repair",
    "inspect": "Plan inspection",
    "retest": "Repeat diagnostic test",
    "monitor": "Keep monitoring",
}


class ModelUnavailable(RuntimeError):
    """The model could not produce predictions. Callers must show this; they must never substitute a guess."""


def training_code():
    """The module that defines the model classes and the feature recipe. The saved model needs it to load."""
    if str(STAGE2_CODE) not in sys.path:
        sys.path.insert(0, str(STAGE2_CODE))
    import case1
    return case1


class RiskModel:
    def __init__(self, bundle_path: Path = ARTIFACTS / "model_bundle.joblib", reference_path: Path = ARTIFACTS / "reference.json"):
        self.bundle_path, self.reference_path = Path(bundle_path), Path(reference_path)
        self._lock = threading.Lock()
        self._bundle = None
        self._code = None
        self.reference: dict = {}
        self.version = "not loaded"
        self.load_error: str | None = None
        self.simulated_outage = False          # demo control: makes every prediction call fail, to show the failure path

    # ------------------------------------------------------------------ loading
    def load(self) -> "RiskModel":
        try:
            import joblib
            self._code = training_code()
            self.reference = json.loads(self.reference_path.read_text(encoding="utf-8"))
            raw = self.bundle_path.read_bytes()
            self._bundle = joblib.load(self.bundle_path)
            self.version = hashlib.sha256(raw).hexdigest()[:10]
            self.load_error = None
        except Exception as err:  # a missing or unreadable model must not stop the dashboard from starting
            self._bundle, self.load_error = None, f"{type(err).__name__}: {err}"
        return self

    @property
    def available(self) -> bool:
        return self._bundle is not None and not self.simulated_outage

    @property
    def cutoff(self) -> float:
        return float(self.reference.get("thresholds", {}).get("high", 32.0))

    @property
    def medium(self) -> float:
        return float(self.reference.get("thresholds", {}).get("medium", 10.0))

    def info(self) -> dict:
        return {"available": self.available, "version": self.version, "error": self.status_message(),
                "simulated_outage": self.simulated_outage, "cutoff": self.cutoff, "medium": self.medium,
                "validation": self.reference.get("validation", {}), "training": self.reference.get("training", {})}

    def status_message(self) -> str | None:
        if self.simulated_outage:
            return "The prediction model is switched off (simulated outage)."
        if self._bundle is None:
            return f"The prediction model could not be loaded ({self.load_error})."
        return None

    # ------------------------------------------------------------------ scoring
    def score(self, frame: pd.DataFrame, scorable: pd.Series) -> pd.DataFrame:
        """One row out per record in, same order. Records that are not scorable get no risk and no prediction."""
        if not self.available:
            raise ModelUnavailable(self.status_message() or "The prediction model is unavailable.")
        ref, c1 = self.reference, self._code
        with self._lock:  # LightGBM prediction is not guaranteed to be thread-safe
            X = c1.features(frame)
            model = self._bundle["model"]
            ok = scorable.to_numpy(bool)
            risk = np.full(len(frame), np.nan)
            parts = np.zeros((3, len(frame)))
            if ok.any():
                risk[ok] = model.predict_proba(X[ok])
                parts[:, ok] = self._added_risk(model, X[ok], risk[ok])
        out = pd.DataFrame({"Record_ID": frame["Record_ID"].to_numpy()})
        percent = risk * 100
        # Shown rounded down to one decimal, so a displayed risk never appears to cross a line it did not cross.
        out["risk"] = np.floor(percent * 10) / 10
        out["time_ratio"] = X["t_norm"].to_numpy()
        out["leak_ratio"] = X["leak_norm"].to_numpy()
        out["pressure_variation"] = X["pv"].to_numpy()
        out["op_level"] = self._level(out["time_ratio"], ref["baseline"]["t"], ref["failing"]["t"])
        out["leak_level"] = self._level(out["leak_ratio"], ref["baseline"]["l"], ref["failing"]["l"])
        total = parts.sum(0)
        share = np.where(total > 0, parts / np.where(total > 0, total, 1), 0)
        show = (percent >= 2) & (total > 0)
        for i, key in enumerate(("f_op", "f_leak", "f_pv")):
            out[key] = np.where(show, np.round(share[i] * 100), 0).astype(int)
        # The Yes/No decision uses the exact cut-off stored with the model, as the submitted predictions did.
        yes = np.zeros(len(frame), bool)
        yes[ok] = risk[ok] >= float(self._bundle["cutoff"])
        medium = np.zeros(len(frame), bool)
        medium[ok] = risk[ok] >= float(self._bundle["medium"])
        out["level"] = np.where(~ok, "Not scored", np.where(yes, "High", np.where(medium, "Medium", "Low")))
        out["prediction"] = np.where(~ok, None, np.where(yes, "Yes", "No"))
        return out

    def _added_risk(self, model, X, base):
        """How much each reading adds: the risk with that reading set back to a new actuator's value."""
        b = self.reference["baseline"]

        def without(changes, column):
            Z = X.copy()
            for name, value in changes.items():
                Z[name] = value
            return np.where(X[column].notna().to_numpy(), np.clip(base - model.predict_proba(Z), 0, None), 0.0)

        return np.vstack([
            without({"t_norm": b["t"], "log_t_norm": np.log(b["t"])}, "t_norm"),
            without({"leak_norm": b["l"], "sqrt_leak_norm": np.sqrt(b["l"])}, "leak_norm"),
            without({"pv": b["pv"]}, "pv"),
        ])

    def _level(self, values: pd.Series, new: float, failing: float) -> np.ndarray:
        v = values.to_numpy(float)
        level = np.digitize((v - new) / (failing - new), self.reference["wear_steps"]).astype(float)
        level[np.isnan(v)] = np.nan
        return level

    # ------------------------------------------------------------------ explaining
    def band(self, risk: float) -> dict:
        bands = self.reference["timeframe"]
        return next((b for b in bands if b["from"] <= risk < b["to"]), bands[-1])

    def time_left(self, risk) -> str | None:
        if risk is None or pd.isna(risk):
            return None
        b = self.band(float(risk))
        low, high = b.get("weeks_low"), b.get("weeks_high")
        if low is None or high is None or high > 26:
            return f"more than {low if low is not None else 26} weeks"
        # A failure comes up to a week after an actuator's last record, so the upper end is one week later.
        return f"under {high + 1} weeks" if low == 0 else f"{low} to {high + 1} weeks"

    def slower_text(self, ratio) -> str | None:
        if ratio is None or pd.isna(ratio):
            return None
        pct = round((float(ratio) / self.reference["baseline"]["t"] - 1) * 100)
        return "same as a new actuator" if pct <= 2 else f"{pct}% slower than a new actuator"

    def leak_text(self, ratio) -> str | None:
        if ratio is None or pd.isna(ratio):
            return None
        b, f = self.reference["baseline"]["l"], self.reference["failing"]["l"]
        pct = round(max(0.0, (float(ratio) - b) / (f - b)) * 100)
        return "at or above the level seen at failure" if pct >= 100 else f"{pct}% of the way to the level seen at failure"

    @staticmethod
    def reason(op, leak, scorable: bool = True) -> str:
        if not scorable:
            return "Both key readings missing"
        op_i = None if op is None or pd.isna(op) else int(op)
        leak_i = None if leak is None or pd.isna(leak) else int(leak)
        parts = [p for p in (OP_PHRASE[op_i or 0], LEAK_PHRASE[leak_i or 0]) if p]
        if op_i is not None and leak_i is not None and ((op_i >= 2 and leak_i == 0) or (leak_i >= 2 and op_i == 0)):
            text = f"{parts[0]}, {'leakage' if op_i >= 2 else 'operation'} normal"
        elif parts:
            text = " and ".join(parts)
        else:
            text = "readings normal"
        if op_i is None or leak_i is None:
            text += f" ({'actuation time' if op_i is None else 'leakage'} not recorded)"
        return text[0].upper() + text[1:]

    def suggested_action(self, level: str, op, leak) -> str:
        """The default next step for a result. The planner (and the agent) may choose differently."""
        if level == "Not scored":
            return "retest"
        key_missing = op is None or pd.isna(op) or leak is None or pd.isna(leak)
        if level == "High":
            return "repair"
        if level == "Medium":
            return "retest" if key_missing else "inspect"
        return "monitor"

    def deadline_days(self, risk) -> int | None:
        """How many days a repair has before the early end of the typical time to failure. None without a prediction."""
        if risk is None or pd.isna(risk):
            return None
        weeks = self.band(float(risk)).get("weeks_low")
        return None if weeks is None else 7 * max(1, int(weeks))

    def next_steps(self, action: str, risk=None, op=None, leak=None, missing: list | None = None, factors: list | None = None) -> dict:
        """The planner's steps for one action on one record: what to do, by when, and why.

        Written by fixed rules from the model's own result (risk, typical time to failure, the readings behind it).
        Nothing here is generated text, and it is planning guidance: the maintenance work itself follows the manual.
        """
        missing = list(missing or [])
        has_risk = risk is not None and not pd.isna(risk)
        when = self.time_left(risk) if has_risk else None
        weeks = self.band(float(risk)).get("weeks_low") if has_risk else None
        # A deadline that falls before the early end of the typical time to failure.
        deadline = ("at the next opportunity" if weeks is None else "this week" if weeks <= 0
                    else "within 1 week" if weeks == 1 else f"within {int(weeks)} weeks")
        thresholds = self.reference.get("thresholds", {})
        high, medium = thresholds.get("high", self.cutoff), thresholds.get("medium", self.medium)
        seen = self.reason(op, leak, scorable=has_risk)
        seen = seen[0].lower() + seen[1:]
        drivers = ", ".join(f"{f['name'].lower()} {f['share']}%" for f in (factors or []) if f.get("share"))
        typical = f"Aircraft at this risk have typically failed in {when}." if when else None
        retake = ((f"Have the {' and '.join(missing)} reading taken at the same visit.",
                   "This prediction was made without it, so it carries reduced confidence.") if missing and has_risk else None)

        if action == "repair":
            goal = "Repair or replace the actuator before it fails."
            due = deadline[0].upper() + deadline[1:]
            steps = [
                (f"Book a hangar slot {deadline}.", typical),
                ("Reserve a replacement actuator and confirm it is in the store before the slot.", "So the job does not start late waiting for the part."),
                ("Assign a technician and the tooling for the nose landing gear actuator.", None),
                (f"Put the model's finding on the job card: {seen}.", f"Share of the added risk: {drivers}." if drivers else None),
                retake,
                ("Take the aircraft out of the flying programme for that slot and tell operations.", "So the stop is planned, not a surprise."),
                ("After the work, repeat the diagnostic test and load the new record here.", "The risk should fall back to Low. If it does not, the job is not finished."),
            ]
        elif action == "inspect":
            goal = "Look at the actuator before the risk reaches the failure line."
            due = f"{deadline[0].upper() + deadline[1:]}, at the next planned stop"
            steps = [
                (f"Add an inspection of the nose landing gear actuator to the next planned stop, {deadline}.", typical),
                ("Ask for the two readings behind the risk to be checked: actuation time and internal leakage.", f"The model saw: {seen}."),
                retake,
                ("Repeat the diagnostic test at that stop and load the new record here.", None),
                (f"Decide from the new result: at {high:g}% risk or more, schedule a repair. Below {medium:g}%, go back to routine monitoring.", None),
            ]
        elif action == "retest":
            names = " and ".join(missing) if missing else "actuation time and leakage"
            goal = "Get a usable reading, so the model can make a reliable prediction."
            due = deadline[0].upper() + deadline[1:]
            steps = [
                (f"Repeat the diagnostic test on this aircraft {deadline}.",
                 typical if has_risk else "Both key readings are missing, so no prediction was made."),
                (f"Make sure the {names} reading{'s are' if ' and ' in names else ' is'} recorded this time.",
                 "The model needs at least one of the two, and is most reliable with both."),
                ("If a reading is missing again, have the test equipment checked.", None),
                ("Load the new record here. The model scores it straight away.", None),
                ("Until then, treat this aircraft as unknown, not as safe.", "No prediction is not the same as low risk."),
            ]
        else:
            action = "monitor"
            lead = self.reference.get("validation", {}).get("lead_weeks")
            goal = "Nothing to do now. Keep the records coming."
            due = "No deadline"
            steps = [
                ("No action is needed on this aircraft now.", f"Its risk is below the watch line of {medium:g}%."),
                ("Keep the routine diagnostic test in the schedule.",
                 f"The model typically flags a failing actuator {lead} weeks ahead, but only if records keep arriving." if lead else None),
                ("Look again when the next record is loaded.", None),
            ]
        return {"action": action, "title": ACTIONS[action], "goal": goal, "when": due,
                "steps": [{"do": do, "why": why} for do, why in (s for s in steps if s)],
                "scope": "Planning steps for the maintenance planner. The work on the aircraft follows the approved maintenance manual; nothing here replaces it."}

    def evidence(self, op, leak) -> dict:
        """How often training records with these reading levels were followed by a failure within 30 days."""
        ev = self.reference.get("evidence", {})
        out = {}
        if op is not None and not pd.isna(op):
            out["op"] = ev.get("op", [None] * 4)[int(op)]
        if leak is not None and not pd.isna(leak):
            out["leak"] = ev.get("leak", [None] * 4)[int(leak)]
        if "op" in out and "leak" in out:
            out["pair"] = ev.get("pair", {}).get(f"{int(op)}-{int(leak)}")
        return out


def number(value, digits: int = 3):
    """JSON-safe number: None for missing, rounded otherwise."""
    if value is None or (isinstance(value, float) and np.isnan(value)) or pd.isna(value):
        return None
    return int(value) if digits == 0 else round(float(value), digits)
