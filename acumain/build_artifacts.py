#!/usr/bin/env python
"""Builds everything the app loads at start-up, from the organisers' Stage 2 data and the training code.

  python -m acumain.build_artifacts        (about a minute)

Writes into acumain/artifacts/:
  model_bundle.joblib   the fitted model with its fitted preprocessing, and the validated cut-off
  reference.json        numbers used to explain a result: reference readings, what a risk level has meant in
                        time, how often each reading level was followed by a failure, validation scores
  history.json          the 100 training aircraft week by week, each scored by a model that never saw that
                        aircraft. This is the track record the dashboard replays.
  sample_records.csv    the 2,000 unlabelled Stage 2 test records: the review queue the app starts with
  sample_upload.csv     30 of those records, as a small file to try the upload with

The model and the cut-off are produced exactly as in risk_model/stage2/case1.py, so the app and the
submitted predictions agree.
"""
from __future__ import annotations

import json
import platform
import shutil
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

from . import schema
from .config import ARTIFACTS
from .model import training_code

MEDIUM = 0.10                      # Medium risk starts here; High starts at the model's Yes/No cut-off
WEAR_STEPS = (0.50, 0.75, 0.95)    # share of the way from a new actuator's reading to the typical reading at failure
FIELDS = ["risk", "t", "l", "pv", "age", "fh", "fc", "dss", "act", "y", "op", "leak", "f_op", "f_leak", "f_pv"]


def reading_level(values, new, failing):
    """0 Normal, 1 Slightly High, 2 High, 3 Very High; -1 when the reading is missing."""
    level = np.digitize((values - new) / (failing - new), WEAR_STEPS).astype(int)
    return np.where(np.isnan(values), -1, level)


def build() -> dict:
    c1 = training_code()
    raw_train, raw_test, _ = c1.load()
    train, test = c1.clean(raw_train, "training", []), c1.clean(raw_test, "test", [])
    X, y, groups = c1.features(train), train[c1.TARGET].eq("Yes").to_numpy(int), train[c1.GROUP].to_numpy()

    # Same scores and same cut-off rule as the submission pipeline (rows kept in file order so they match exactly).
    scores = c1.out_of_fold(X, y, groups)
    like, like_weights = c1.test_like_rows(train, test)
    cutoff = c1.pick_cutoff(y, scores, groups, like, like_weights)[0]
    risk = scores.mean(0)
    check = [c1.confusion(y, s >= cutoff) for s in scores]
    mean = lambda key: float(np.mean([c[key] for c in check]))

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

    # The model that is deployed: fitted on every training row, the same call as in case1.py.
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
        timeframe.append({"from": round(low * 100, 1), "to": round(min(high, 1) * 100, 1) if high <= 1 else 100.1, "n": int(rows.sum()),
                          "weeks_low": int(q25) if q25 < 99 else None, "weeks_high": int(q75) if q75 < 99 else None,
                          "in_30_days": round(float(y[rows].mean()) * 100), "in_12_weeks": round(float(np.mean(left[rows] <= 11)) * 100)})

    # How often each reading level, and each pair of levels, was followed by a failure within 30 days.
    count = lambda rows: {"n": int(rows.sum()), "failed": int(y[rows].sum())}
    evidence = {"op": [count(op == k) for k in range(4)], "leak": [count(leak == k) for k in range(4)],
                "pair": {f"{a}-{b}": count((op == a) & (leak == b)) for a in range(4) for b in range(4)}}

    # One compact row per aircraft per week, for the track-record replay.
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

    thresholds = {"medium": MEDIUM * 100, "high": round(cutoff * 100, 1)}
    validation = {
        "method": "Cross-validation on aircraft the model never saw: 5 folds, repeated 4 times",
        "f1": round(mean("f1") * 100, 1), "precision": round(mean("precision") * 100, 1), "recall": round(mean("recall") * 100, 1),
        "accuracy": round(mean("accuracy") * 100, 1),
        "auc": round(float(np.mean([roc_auc_score(y, s) for s in scores])), 3),
        "average_precision": round(float(np.mean([average_precision_score(y, s) for s in scores])), 3),
        "failures": int(actuator[failed].nunique()), "caught": int(caught), "lead_weeks": int(np.median(leads)),
        "false_alarm_rows": int(false_alarm.sum()), "false_alarms_early": round(float(early.sum() / max(false_alarm.sum(), 1)) * 100),
        "cutoff": cutoff,
    }
    training = {"rows": int(len(y)), "aircraft": len(fleet), "actuators": int(actuator.nunique()), "yes_rows": int(y.sum()),
                "from": pd.Timestamp(week_dates[0]).strftime("%Y-%m-%d"), "to": pd.Timestamp(week_dates[-1]).strftime("%Y-%m-%d")}
    history = {
        "source": "Stage 2 training fleet", "weeks": [pd.Timestamp(d).strftime("%Y-%m-%d") for d in week_dates], "fields": FIELDS, "fleet": fleet,
        "thresholds": thresholds, "baseline": baseline, "failing": failing, "wear_steps": list(WEAR_STEPS), "timeframe": timeframe,
        "model": {"rows": training["rows"], "aircraft": training["aircraft"], "failures": validation["failures"], "caught": validation["caught"],
                  "lead_weeks": validation["lead_weeks"], "false_alarm_rows": validation["false_alarm_rows"],
                  "false_alarms_early": validation["false_alarms_early"], "f1": validation["f1"], "accuracy": validation["accuracy"], "cutoff": cutoff},
    }
    reference = {"thresholds": thresholds, "baseline": baseline, "failing": failing, "wear_steps": list(WEAR_STEPS), "timeframe": timeframe,
                 "evidence": evidence, "validation": validation, "training": training}
    bundle = {"model": model, "cutoff": cutoff, "medium": MEDIUM, "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "python": platform.python_version(), "feature_module": "case1"}
    return {"bundle": bundle, "reference": reference, "history": history, "test_inputs": c1.CASE_DIR / "case_1_test_inputs.csv"}


def write(out_dir=ARTIFACTS) -> dict:
    built = build()
    out_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(built["bundle"], out_dir / "model_bundle.joblib", compress=3)
    dump = lambda name, obj: (out_dir / name).write_text(json.dumps(obj, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    dump("reference.json", built["reference"])
    dump("history.json", built["history"])
    shutil.copyfile(built["test_inputs"], out_dir / "sample_records.csv")
    write_sample_upload(built["test_inputs"], out_dir)
    return built


def write_sample_upload(test_inputs, out_dir=ARTIFACTS) -> None:
    """A 30-record file to try the upload with: 22 ordinary records and 8 with a blank reading, two of which
    lack both key readings and so cannot be scored."""
    sample = pd.read_csv(test_inputs, dtype=str, keep_default_na=False)
    rest = sample.iloc[22:]
    no_time, no_leak = rest["Actuation_Time_Seconds"] == "", rest["Internal_Leakage_Rate_mL_Min"] == ""
    blanks = pd.concat([rest[no_time & no_leak].head(2), rest[(rest[schema.REQUIRED] == "").any(axis=1) & ~(no_time & no_leak)].head(6)])
    pd.concat([sample.head(22), blanks]).to_csv(out_dir / "sample_upload.csv", index=False, lineterminator="\n")


if __name__ == "__main__":
    result = write()
    v, h = result["reference"]["validation"], result["history"]
    latest = [a["rows"][-1][0] for a in h["fleet"]]
    high, medium = h["thresholds"]["high"], h["thresholds"]["medium"]
    for name in sorted(p.name for p in ARTIFACTS.iterdir()):
        print(f"  {name:22s} {(ARTIFACTS / name).stat().st_size / 1024:8.0f} KB")
    print(f"Cut-off {v['cutoff']}: F1 {v['f1']}, precision {v['precision']}, recall {v['recall']}, accuracy {v['accuracy']}%, AUC {v['auc']}.")
    print(f"Failures flagged in their final 30 days: {v['caught']} of {v['failures']}; typical first flag {v['lead_weeks']} weeks before the last record.")
    print(f"Track record, latest week {h['weeks'][-1]}: High {sum(r >= high for r in latest)}, Medium {sum(medium <= r < high for r in latest)}, Low {sum(r < medium for r in latest)}")
