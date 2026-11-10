#!/usr/bin/env python
"""Builds the data file the dashboard shows: the stage 2 fleet (100 aircraft, 100 weekly records each),
scored by the stage 2 model.

  python dashboard/build_state.py        writes dashboard/static/state.json   (about half a minute)

Every risk on the page comes from a model that never saw that aircraft during training (the same
cross-validation as risk_model/stage2/case1.py), so the page can be replayed against what really happened.
The 2,000 test aircraft are not included: their predictions stay in the submission file.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "risk_model" / "stage2"))
import case1 as c1  # noqa: E402

STATE = Path(__file__).resolve().parent / "static" / "state.json"
MEDIUM = 0.10                      # Medium risk starts here; High starts at the model's Yes/No cut-off
WEAR_STEPS = (0.50, 0.75, 0.95)    # share of the way from a new actuator's reading to the typical reading at failure
FIELDS = ["risk", "t", "l", "pv", "age", "fh", "fc", "dss", "act", "y", "op", "leak", "f_op", "f_leak", "f_pv"]


def reading_level(values, new, failing):
    """0 Normal, 1 Slightly High, 2 High, 3 Very High; -1 when the reading is missing."""
    wear = (values - new) / (failing - new)
    level = np.digitize(wear, WEAR_STEPS).astype(int)
    return np.where(np.isnan(values), -1, level)


def build_state() -> dict:
    raw_train, raw_test, _ = c1.load()
    train, test = c1.clean(raw_train, "training", []), c1.clean(raw_test, "test", [])
    X, y, groups = c1.features(train), train[c1.TARGET].eq("Yes").to_numpy(int), train[c1.GROUP].to_numpy()

    # Same scores and same cut-off rule as the submission pipeline (rows kept in file order so they match exactly).
    scores = c1.out_of_fold(X, y, groups)
    like, like_weights = c1.test_like_rows(train, test)
    cutoff = c1.pick_cutoff(y, scores, groups, like, like_weights)[0]
    risk = scores.mean(0)
    check = [c1.confusion(y, s >= cutoff) for s in scores]

    dates = pd.to_datetime(train["Observation_Date"])
    actuator = train["Actuator_ID"].astype(str)
    position = dates.groupby(actuator).rank(method="first").to_numpy() - 1
    size = actuator.map(actuator.value_counts()).to_numpy()
    last_label = train.assign(_d=dates).sort_values("_d").groupby("Actuator_ID")[c1.TARGET].last()
    failed = actuator.map(last_label).eq("Yes").to_numpy()        # this actuator's last record was a Yes: it failed
    follow = size - 1 - position                                  # weekly records still to come on this actuator
    weeks_left = np.where(failed, follow, np.nan)

    # Reference readings: a new actuator, and the typical reading in the last record before a failure.
    age = train["Actuator_Age_Hours"].to_numpy(float)
    new = like & (age < 500)
    last_record = failed & (follow == 0)
    names = {"t": "t_norm", "l": "leak_norm", "pv": "pv"}
    baseline = {k: float(X[col][new].median()) for k, col in names.items()}
    failing = {k: float(X[col][last_record].median()) for k, col in names.items()}
    op = reading_level(X["t_norm"].to_numpy(), baseline["t"], failing["t"])
    leak = reading_level(X["leak_norm"].to_numpy(), baseline["l"], failing["l"])

    # How much each reading adds: the final model's risk with that reading set back to a new actuator's value.
    model = c1.Blend(seeds=(0, 1, 2, 3, 4)).fit(X, y)
    full = model.predict_proba(X)

    def added(changes, measured):
        Z = X.copy()
        for col, value in changes.items():
            Z[col] = value
        return np.where(measured, np.clip(full - model.predict_proba(Z), 0, None), 0.0)

    parts = np.vstack([
        added({"t_norm": baseline["t"], "log_t_norm": np.log(baseline["t"])}, X["t_norm"].notna().to_numpy()),
        added({"leak_norm": baseline["l"], "sqrt_leak_norm": np.sqrt(baseline["l"])}, X["leak_norm"].notna().to_numpy()),
        added({"pv": baseline["pv"]}, X["pv"].notna().to_numpy()),
    ])
    total = parts.sum(0)
    share = np.where((total > 0) & (risk >= 0.02), np.round(100 * parts / np.where(total > 0, total, 1)), 0).astype(int)

    # The model per failure: was each failing actuator flagged in its final 30 days, and how early was the first flag?
    flagged = risk >= cutoff
    caught, leads = 0, []
    for name in actuator[failed].unique():
        rows = (actuator == name).to_numpy()
        caught += bool((flagged & rows & (y == 1)).any())
        near = flagged & rows & (weeks_left <= 11)
        if near.any():
            leads.append(int(weeks_left[near].max()))
    false_alarm = flagged & (y == 0)
    early = false_alarm & (weeks_left <= 12)

    # What a risk level has meant in time, from records whose next three months are known.
    known = ~np.isnan(weeks_left) | (follow >= 13)
    left = np.where(np.isnan(weeks_left), 99, weeks_left)
    timeframe = []
    for low, high in zip((0, 0.02, MEDIUM, cutoff, 0.50, 0.80), (0.02, MEDIUM, cutoff, 0.50, 0.80, 1.01)):
        rows = known & (risk >= low) & (risk < high)
        q25, q75 = np.percentile(left[rows], [25, 75])
        timeframe.append({"from": round(low * 100, 1), "to": round(min(high, 1) * 100, 1), "n": int(rows.sum()),
                          "weeks_low": int(q25) if q25 < 99 else None, "weeks_high": int(q75) if q75 < 99 else None,
                          "in_30_days": round(float(y[rows].mean()) * 100), "in_12_weeks": round(float(np.mean(left[rows] <= 11)) * 100)})

    # One compact row per aircraft per week.
    week_dates = sorted(dates.unique())
    week_of = dates.map({d: i for i, d in enumerate(week_dates)}).to_numpy()
    number = lambda v, digits: None if pd.isna(v) else (int(round(v)) if digits == 0 else round(float(v), digits))
    fleet = []
    for aircraft in sorted(set(groups)):
        idx = np.where(groups == aircraft)[0]
        idx = idx[np.argsort(week_of[idx])]
        assert list(week_of[idx]) == list(range(len(week_dates))), f"{aircraft} does not have one record per week"
        acts = list(dict.fromkeys(actuator.iloc[idx]))
        rows = [[number(risk[i] * 100, 1), number(X["t_norm"].iloc[i], 3), number(X["leak_norm"].iloc[i], 3), number(X["pv"].iloc[i], 0),
                 number(age[i], 0), number(X["fh"].iloc[i], 1), number(X["fc"].iloc[i], 0), number(X["dss"].iloc[i], 0),
                 acts.index(actuator.iloc[i]), int(y[i]), int(op[i]), int(leak[i]), int(share[0, i]), int(share[1, i]), int(share[2, i])]
                for i in idx]
        fleet.append({"id": aircraft, "grade": train["Hydraulic_Fluid_Grade"].iloc[idx[0]],
                      "acts": [a.replace(aircraft + "-", "") for a in acts], "rows": rows})

    mean = lambda key: float(np.mean([c[key] for c in check]))
    return {
        "source": "Stage 2 fleet", "weeks": [pd.Timestamp(d).strftime("%Y-%m-%d") for d in week_dates], "fields": FIELDS, "fleet": fleet,
        "thresholds": {"medium": MEDIUM * 100, "high": round(cutoff * 100, 1)},
        "baseline": baseline, "failing": failing, "wear_steps": list(WEAR_STEPS), "timeframe": timeframe,
        "model": {"rows": int(len(y)), "aircraft": len(fleet), "failures": int(actuator[failed].nunique()), "caught": int(caught),
                  "lead_weeks": int(np.median(leads)), "false_alarm_rows": int(false_alarm.sum()),
                  "false_alarms_early": round(float(early.sum() / max(false_alarm.sum(), 1)) * 100),
                  "f1": round(mean("f1") * 100, 1), "accuracy": round(mean("accuracy") * 100, 1), "cutoff": cutoff},
    }


def write_state(path: Path = STATE) -> dict:
    state = build_state()
    path.write_text(json.dumps(state, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    return state


if __name__ == "__main__":
    built = write_state()
    m = built["model"]
    latest = [a["rows"][-1][0] for a in built["fleet"]]
    high, medium = built["thresholds"]["high"], built["thresholds"]["medium"]
    print(f"Wrote {STATE} ({STATE.stat().st_size / 1024:.0f} KB): {m['aircraft']} aircraft, {m['rows']:,} records, {len(built['weeks'])} weeks")
    print(f"Cut-off {m['cutoff']}: F1 {m['f1']}, accuracy {m['accuracy']}%. Failures flagged in their final 30 days: {m['caught']} of {m['failures']}, "
          f"typical first flag {m['lead_weeks']} weeks before the last record. False-alarm rows {m['false_alarm_rows']}, {m['false_alarms_early']}% failed within 12 weeks.")
    print(f"Latest week {built['weeks'][-1]}: High {sum(r >= high for r in latest)}, Medium {sum(medium <= r < high for r in latest)}, Low {sum(r < medium for r in latest)}")
    print("New actuator readings:", {k: round(v, 3) for k, v in built["baseline"].items()}, "| at failure:", {k: round(v, 3) for k, v in built["failing"].items()})
    for band in built["timeframe"]:
        print("  risk", band)
