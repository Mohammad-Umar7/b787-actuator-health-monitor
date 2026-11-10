#!/usr/bin/env python
"""B787 nose landing gear actuator: 30-day failure risk model.

Usage
  python risk_model.py train   DATA.xlsx [MORE.xlsx ...] [--out artifacts]
  python risk_model.py predict NEW.xlsx  [--model artifacts/model.json] [--out artifacts/predictions.csv]

The model is a monotone, regularised logistic regression (a "risk scorecard").
Every warning sign adds to the risk and none can lower it, so the score stays
sensible on combinations of readings the training data never contained.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize

TARGET = "Failure_Next_30_Days"
ID_COL = "Aircraft_ID"

# canonical column -> other spellings (compared lower-case with punctuation removed)
COLUMN_ALIASES = {
    "Aircraft_ID": ["aircraft", "tail", "tailnumber"],
    "Month": [],
    "Flight_Hours": [],
    "Flight_Cycles": [],
    "Actuator_Age_Months": ["actuatorage"],
    "Previous_Failures": [],
    "Maintenance_Events": ["maintenancecount"],
    "Leakage_Level": ["leakage"],
    "Operation_Time": ["actuationtime"],
    TARGET: ["failurewithin30days", "failure"],
}

LEVEL_NAMES = ["Normal", "Slightly High", "High", "Very High"]
_LEVEL_EXACT = {
    "normal": 0, "low": 0, "ok": 0, "good": 0, "none": 0,
    "slightly high": 1, "slight": 1, "elevated": 1, "moderate": 1, "medium": 1,
    "high": 2,
    "very high": 3, "severe": 3, "critical": 3, "extreme": 3,
}
_MISSING_WORDS = {"", "nan", "na", "n/a", "null", "?", "-"}

FEATURES = {
    "leak": {"col": "Leakage_Level", "label": "leakage", "kind": "level"},
    "op": {"col": "Operation_Time", "label": "operation time", "kind": "level"},
    "age": {"col": "Actuator_Age_Months", "label": "actuator age", "kind": "number", "unit": " months"},
    "prev": {"col": "Previous_Failures", "label": "previous failures", "kind": "number", "unit": ""},
    "hours": {"col": "Flight_Hours", "label": "flight hours in the month", "kind": "number", "unit": " h"},
    "maint": {"col": "Maintenance_Events", "label": "maintenance events", "kind": "number", "unit": ""},
}
CORE = ["leak", "op", "age"]
EXTENDED = ["leak", "op", "age", "prev", "hours", "maint"]

# How far a weight may stray from zero before the penalty bites, per standard
# deviation of an input. 1.25 is the default weakly informative scale of Gelman
# et al. (2008): 2.5 on inputs scaled to two standard deviations. It is fixed in
# advance, not tuned to this data, and its pull fades as more rows arrive.
PRIOR_SD = 1.25
PRIOR_SD_CHECK = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


# ----------------------------------------------------------------------------
# Reading and cleaning
# ----------------------------------------------------------------------------
def _key(name) -> str:
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def canonicalise(df: pd.DataFrame) -> pd.DataFrame:
    """Rename columns to their canonical spelling, whatever the case or punctuation."""
    lookup = {}
    for canon, aliases in COLUMN_ALIASES.items():
        lookup[_key(canon)] = canon
        for alias in aliases:
            lookup[alias] = canon
    rename, used = {}, set()
    for col in df.columns:
        canon = lookup.get(_key(col))
        if canon and canon not in used:
            rename[col] = canon
            used.add(canon)
    return df.rename(columns=rename)


def read_table(path) -> pd.DataFrame:
    """Read a CSV, or the sheet of an Excel file that looks like Case 1 data."""
    path = Path(path)
    if path.suffix.lower() in (".csv", ".txt"):
        return canonicalise(pd.read_csv(path))
    sheets = pd.read_excel(path, sheet_name=None)
    wanted = ("Leakage_Level", "Operation_Time", "Actuator_Age_Months")
    best, best_score = None, -1
    for df in sheets.values():
        df = canonicalise(df)
        score = sum(col in df.columns for col in wanted)
        if score > best_score:
            best, best_score = df, score
    if best_score < 2:
        raise ValueError(f"{path.name}: no sheet has the Case 1 columns {wanted}")
    return best


def parse_level(value):
    """Turn a condition label into 0..3. Returns (level, note); note is None when the label was clean."""
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return np.nan, "missing"
    if isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool):
        if 0 <= value <= 3:
            return float(round(value)), None
        return np.nan, f"unrecognised value {value!r}"
    text = " ".join(str(value).strip().lower().replace("-", " ").replace("_", " ").split())
    if text in _MISSING_WORDS:
        return np.nan, "missing"
    if text in _LEVEL_EXACT:
        clean = str(value).strip() in LEVEL_NAMES
        return float(_LEVEL_EXACT[text]), None if clean else f"read {value!r} as {LEVEL_NAMES[_LEVEL_EXACT[text]]}"
    try:
        number = float(text)
        if 0 <= number <= 3:
            return float(round(number)), None
    except ValueError:
        pass
    if any(word in text for word in ("very", "extreme", "severe", "critical")):
        level = 3
    elif any(word in text for word in ("slight", "moderate", "elevated", "medium", "mild")):
        level = 1
    elif "high" in text:
        level = 2
    elif any(word in text for word in ("normal", "low", "ok")):
        level = 0
    else:
        return np.nan, f"unrecognised label {value!r}"
    return float(level), f"read {value!r} as {LEVEL_NAMES[level]}"


def parse_target(series) -> np.ndarray:
    out = []
    for value in series:
        text = str(value).strip().lower()
        if text in ("yes", "y", "true", "1", "1.0", "fail", "failed", "failure"):
            out.append(1.0)
        elif text in ("no", "n", "false", "0", "0.0"):
            out.append(0.0)
        else:
            out.append(np.nan)
    return np.array(out)


def month_number(value) -> float:
    if isinstance(value, (pd.Timestamp, datetime)):
        return float(value.year * 12 + value.month)
    text = str(value).strip().lower()
    if text[:3] in MONTHS:
        return float(MONTHS[text[:3]])
    try:
        return float(text)
    except ValueError:
        return np.nan


def prepare(df: pd.DataFrame, feature_names, fill=None):
    """Clean a raw table into a numeric feature matrix.

    Returns (table, X, notes). `fill` holds the value used for a missing reading
    per feature; when None the column median of this table is used (training).
    """
    df = canonicalise(df).dropna(how="all").reset_index(drop=True)
    absent = [FEATURES[f]["col"] for f in feature_names if FEATURES[f]["col"] not in df.columns]
    if absent:
        raise ValueError("Missing column(s): " + ", ".join(absent))
    notes = [[] for _ in range(len(df))]
    X = np.zeros((len(df), len(feature_names)))
    for j, name in enumerate(feature_names):
        spec = FEATURES[name]
        if spec["kind"] == "level":
            values = np.empty(len(df))
            for i, raw in enumerate(df[spec["col"]]):
                values[i], note = parse_level(raw)
                if note:
                    notes[i].append(f"{spec['col']}: {note}")
        else:
            values = pd.to_numeric(df[spec["col"]], errors="coerce").to_numpy(dtype=float)
            for i in np.where(np.isnan(values))[0]:
                notes[i].append(f"{spec['col']}: missing or not a number")
        gaps = np.isnan(values)
        if gaps.any():
            if fill is not None:
                typical = fill[name]
            elif gaps.all():
                raise ValueError(f"{spec['col']}: no usable values")
            else:
                typical = float(np.nanmedian(values))
            values = np.where(gaps, typical, values)
            for i in np.where(gaps)[0]:
                notes[i].append(f"{spec['col']}: used the typical value {typical:g}")
        X[:, j] = values
    return df, X, notes


# ----------------------------------------------------------------------------
# The model
# ----------------------------------------------------------------------------
def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -40, 40)))


class MonotoneLogit:
    """Logistic regression with an L2 penalty and weights that cannot go below zero.

    The penalty is 1 / (rows * prior_sd^2), so it weakens by itself as data grows.
    """

    def __init__(self, prior_sd: float = PRIOR_SD):
        self.prior_sd = prior_sd

    def fit(self, X, y):
        X = np.asarray(X, float)
        y = np.asarray(y, float)
        mu = X.mean(axis=0)
        sd = X.std(axis=0)
        sd = np.where(sd > 0, sd, 1.0)
        Z = (X - mu) / sd
        n, p = Z.shape
        lam = 1.0 / (n * self.prior_sd ** 2)

        def objective(theta):
            z = theta[0] + Z @ theta[1:]
            loss = np.mean(np.logaddexp(0.0, z) - y * z) + 0.5 * lam * np.sum(theta[1:] ** 2)
            resid = _sigmoid(z) - y
            grad = np.concatenate(([resid.mean()], Z.T @ resid / n + lam * theta[1:]))
            return loss, grad

        base = float(np.clip(y.mean(), 1e-3, 1 - 1e-3))
        start = np.concatenate(([np.log(base / (1 - base))], np.zeros(p)))
        bounds = [(None, None)] + [(0.0, None)] * p
        result = minimize(objective, start, jac=True, method="L-BFGS-B", bounds=bounds)
        self.penalty_ = lam
        self.coef_ = result.x[1:] / sd
        self.intercept_ = float(result.x[0] - np.sum(self.coef_ * mu))
        return self

    def predict_proba(self, X):
        return _sigmoid(self.intercept_ + np.asarray(X, float) @ self.coef_)


class _BaseRate:
    """No model at all: everyone gets the fleet's average failure rate."""

    def fit(self, X, y):
        self.rate_ = float(np.mean(y))
        return self

    def predict_proba(self, X):
        return np.full(len(X), self.rate_)


def _proba(model, X):
    p = model.predict_proba(X)
    return p[:, 1] if getattr(p, "ndim", 1) == 2 else p


# ----------------------------------------------------------------------------
# Validation
# ----------------------------------------------------------------------------
def grouped_folds(groups):
    """Folds that keep every aircraft whole: one aircraft per fold, or 10 folds of aircraft for big fleets."""
    unique = pd.unique(groups)
    if len(unique) <= 30:
        return [(groups != g, groups == g) for g in unique]
    chunks = np.array_split(np.random.default_rng(0).permutation(unique), 10)
    return [(~np.isin(groups, c), np.isin(groups, c)) for c in chunks]


def cv_predict(make_model, X, y, groups):
    """Score every row with a model that never saw that row's aircraft."""
    p = np.full(len(y), np.nan)
    for train, test in grouped_folds(groups):
        if len(np.unique(y[train])) < 2:
            p[test] = y[train].mean()
        else:
            p[test] = _proba(make_model().fit(X[train], y[train]), X[test])
    return p


def auc(y, p):
    pos, neg = p[y == 1], p[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return None
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def metrics(y, p, groups, high):
    clipped = np.clip(p, 1e-6, 1 - 1e-6)
    row_loss = -(y * np.log(clipped) + (1 - y) * np.log(1 - clipped))
    group_sum = pd.Series(row_loss).groupby(np.asarray(groups)).sum()
    n_groups = len(group_sum)
    se = float(np.sqrt(n_groups) * group_sum.std(ddof=1) / len(y)) if n_groups > 1 else 0.0
    flagged = p >= high
    return {
        "log_loss": float(row_loss.mean()),
        "log_loss_se": se,
        "brier": float(np.mean((p - y) ** 2)),
        "auc": auc(y, p),
        "failures": int((y == 1).sum()),
        "caught": int((flagged & (y == 1)).sum()),
        "missed": int((~flagged & (y == 1)).sum()),
        "false_alarms": int((flagged & (y == 0)).sum()),
        "rows": int(len(y)),
    }


def sensitivity(X, y, groups, high):
    """Does the result hinge on the penalty? Repeat the unseen-aircraft test across a range of settings."""
    rows = []
    for sd in PRIOR_SD_CHECK:
        p = cv_predict(lambda: MonotoneLogit(sd), X, y, groups)
        rows.append({"prior_sd": sd, **metrics(y, p, groups, high)})
    return rows


def bootstrap_fits(X, y, groups, n_boot=500, seed=7):
    """Refit on resampled fleets (whole aircraft drawn with replacement) to see how much the answer moves."""
    rng = np.random.default_rng(seed)
    unique = pd.unique(groups)
    rows_of = {g: np.where(groups == g)[0] for g in unique}
    fits, tries = [], 0
    while len(fits) < n_boot and tries < n_boot * 5:
        tries += 1
        idx = np.concatenate([rows_of[g] for g in rng.choice(unique, size=len(unique), replace=True)])
        if len(np.unique(y[idx])) < 2:
            continue
        model = MonotoneLogit().fit(X[idx], y[idx])
        fits.append([model.intercept_, *model.coef_])
    return np.array(fits)


# ----------------------------------------------------------------------------
# Scoring and explaining
# ----------------------------------------------------------------------------
def level_of(p, thresholds):
    if p >= thresholds["high"]:
        return "High"
    return "Medium" if p >= thresholds["medium"] else "Low"


def score(model: dict, X):
    """Return (risk, low, high): the estimate and its 10th-90th percentile range."""
    coef = np.array(model["coef"])
    p = _sigmoid(model["intercept"] + X @ coef)
    boot = np.array(model["bootstrap"])
    if boot.size:
        spread = _sigmoid(boot[:, :1] + boot[:, 1:] @ X.T)
        low = np.minimum(np.percentile(spread, 10, axis=0), p)
        high = np.maximum(np.percentile(spread, 90, axis=0), p)
    else:
        low, high = p.copy(), p.copy()
    return p, low, high


def _value_text(name, value):
    spec = FEATURES[name]
    if spec["kind"] == "level":
        return f"{spec['label']} {LEVEL_NAMES[int(min(max(round(value), 0), 3))]}"
    return f"{spec['label']} {value:g}{spec.get('unit', '')}"


def explain_parts(model: dict, x):
    """Which readings push this risk above a healthy actuator, and by what share."""
    names = model["features"]
    added = {n: model["coef"][j] * (x[j] - model["reference"][n]) for j, n in enumerate(names)}
    total = sum(v for v in added.values() if v > 0)
    if total <= 0:
        return []
    parts = [(v / total, n) for n, v in added.items() if v / total >= 0.05]
    parts.sort(reverse=True)
    return [{"factor": _value_text(n, x[names.index(n)]), "share": float(share)} for share, n in parts]


def explain(model: dict, x):
    parts = explain_parts(model, x)
    if not parts:
        return "all readings at or below normal"
    return ", ".join(f"{p['factor']} ({p['share']:.0%})" for p in parts)


def _score_table(model: dict, raw: pd.DataFrame):
    names = model["features"]
    table, X, notes = prepare(raw, names, fill=model["fill"])
    for j, name in enumerate(names):
        lo, hi = model["trained_range"][name]
        for i in np.where((X[:, j] < lo) | (X[:, j] > hi))[0]:
            notes[i].append(f"{FEATURES[name]['col']} is outside what the model was trained on")
    risk, low, high = score(model, X)
    return table, X, notes, risk, low, high


def score_records(model: dict, raw: pd.DataFrame) -> list:
    """Scored rows as plain dictionaries, for the dashboard."""
    names = model["features"]
    table, X, notes, risk, low, high = _score_table(model, raw)
    n = len(table)
    ids = table[ID_COL].astype(str).tolist() if ID_COL in table.columns else [f"Record {i + 1}" for i in range(n)]
    months = table["Month"].tolist() if "Month" in table.columns else [None] * n
    order = np.array([month_number(m) for m in months]) if "Month" in table.columns else np.zeros(n)
    if np.isnan(order).any():  # unreadable months: keep the order they first appear in the file
        seen = {}
        order = np.array([seen.setdefault(str(m), len(seen)) for m in months], dtype=float)
    actual = parse_target(table[TARGET]) if TARGET in table.columns else np.full(n, np.nan)
    extra = {key: pd.to_numeric(table[col], errors="coerce").to_numpy(dtype=float)
             for key, col in (("hours", "Flight_Hours"), ("cycles", "Flight_Cycles"),
                              ("previous_failures", "Previous_Failures"),
                              ("maintenance_events", "Maintenance_Events")) if col in table.columns}
    records = []
    for i in range(n):
        month = months[i]
        if isinstance(month, (pd.Timestamp, datetime)):
            month = month.strftime("%b %Y")
        record = {
            "row": i, "id": ids[i], "month": None if month is None else str(month), "order": float(order[i]),
            "leak": int(X[i, names.index("leak")]), "op": int(X[i, names.index("op")]),
            "age": float(X[i, names.index("age")]),
            "risk": round(float(risk[i]) * 100, 1), "low": round(float(low[i]) * 100, 1),
            "high": round(float(high[i]) * 100, 1), "level": level_of(risk[i], model["thresholds"]),
            "factors": explain_parts(model, X[i]), "notes": notes[i],
            "actual": None if np.isnan(actual[i]) else bool(actual[i]),
        }
        for key, values in extra.items():
            record[key] = None if np.isnan(values[i]) else float(values[i])
        records.append(record)
    return records


def predict_table(model: dict, raw: pd.DataFrame) -> pd.DataFrame:
    table, X, notes, risk, low, high = _score_table(model, raw)
    out = pd.DataFrame()
    for col in (ID_COL, "Month", "Leakage_Level", "Operation_Time", "Actuator_Age_Months"):
        if col in table.columns:
            out[col] = table[col]
    out["Risk_Percent"] = np.round(risk * 100, 1)
    out["Range_Low"] = np.round(low * 100, 1)
    out["Range_High"] = np.round(high * 100, 1)
    out["Risk_Level"] = [level_of(p, model["thresholds"]) for p in risk]
    out["Main_Factors"] = [explain(model, X[i]) for i in range(len(X))]
    out["Data_Notes"] = ["; ".join(n) for n in notes]
    if TARGET in table.columns:
        out["Actual_Failure"] = table[TARGET]
    return out


def evaluate_predictions(scored: pd.DataFrame, thresholds):
    """Compare predictions with the answers, when the file has them."""
    if "Actual_Failure" not in scored.columns:
        return None
    y = parse_target(scored["Actual_Failure"])
    known = ~np.isnan(y)
    if not known.any():
        return None
    p = scored["Risk_Percent"].to_numpy()[known] / 100
    groups = scored[ID_COL].to_numpy()[known] if ID_COL in scored.columns else np.arange(known.sum())
    return metrics(y[known], p, groups, thresholds["high"])


def latest_per_aircraft(scored: pd.DataFrame) -> pd.DataFrame:
    if ID_COL not in scored.columns:
        return scored
    order = scored["Month"].map(month_number) if "Month" in scored.columns else pd.Series(np.arange(len(scored)))
    ranked = scored.assign(_order=order.fillna(-1).to_numpy(), _row=np.arange(len(scored)))
    latest = ranked.sort_values(["_order", "_row"]).groupby(ID_COL, sort=False).tail(1)
    return latest.sort_values("Risk_Percent", ascending=False).drop(columns=["_order", "_row"])


# ----------------------------------------------------------------------------
# Training
# ----------------------------------------------------------------------------
# (description, leakage level, operation level, age or None for the fleet's typical age)
STRESS_CASES = [
    ("Leakage Very High, operation only Slightly High", 3, 1, None),
    ("Leakage Normal, operation High", 0, 2, None),
    ("Leakage High, operation Slightly High, age 40", 2, 1, 40),
    ("Leakage Slightly High, operation Slightly High", 1, 1, None),
    ("Everything Normal, age 40", 0, 0, 40),
    ("Leakage Very High, operation High, age 10", 3, 2, 10),
]


def _rivals(n_rows):
    from sklearn.ensemble import (GradientBoostingClassifier, HistGradientBoostingClassifier,
                                  RandomForestClassifier)
    from sklearn.tree import DecisionTreeClassifier
    return {
        "Decision tree": lambda: DecisionTreeClassifier(max_depth=2, random_state=0),
        "Random forest": lambda: RandomForestClassifier(n_estimators=300, random_state=0),
        "Gradient boosting": lambda: GradientBoostingClassifier(random_state=0),
        "Monotone gradient boosting": lambda: HistGradientBoostingClassifier(
            monotonic_cst=[1, 1, 1], max_depth=2, min_samples_leaf=max(2, n_rows // 25),
            early_stopping=False, random_state=0),
    }


def train(paths, out_dir, medium=0.05, high=0.50, n_boot=500):
    raw = pd.concat([read_table(p) for p in paths], ignore_index=True)
    if TARGET not in raw.columns:
        raise ValueError(f"Training data needs the answer column {TARGET}")
    has_extended = all(FEATURES[f]["col"] in raw.columns for f in EXTENDED)
    table, X_all, _ = prepare(raw, EXTENDED if has_extended else CORE)
    y_all = parse_target(table[TARGET])
    keep = ~np.isnan(y_all)
    table, X_all, y = table[keep].reset_index(drop=True), X_all[keep], y_all[keep]
    groups = table[ID_COL].astype(str).to_numpy() if ID_COL in table.columns else np.arange(len(y)).astype(str)
    if len(np.unique(y)) < 2:
        raise ValueError("Training data needs both failures and non-failures")
    thresholds = {"medium": medium, "high": high}
    X_core = X_all[:, : len(CORE)]

    # --- the scorecard on the three core readings, scored on aircraft it never saw
    unseen = cv_predict(MonotoneLogit, X_core, y, groups)
    chosen_metrics = metrics(y, unseen, groups, high)
    features, X = CORE, X_core
    board = [{"model": "Risk scorecard (ours): leakage, operation time, age", **chosen_metrics}]

    # --- would the extra columns help? Only switch if clearly better.
    if has_extended:
        extended_p = cv_predict(MonotoneLogit, X_all, y, groups)
        extended_metrics = metrics(y, extended_p, groups, high)
        board.append({"model": "Risk scorecard with all six columns", **extended_metrics})
        if extended_metrics["log_loss"] < chosen_metrics["log_loss"] - chosen_metrics["log_loss_se"]:
            features, X, chosen_metrics, unseen = EXTENDED, X_all, extended_metrics, extended_p

    # --- rivals and ablations on the same test
    rivals = _rivals(len(y))
    for name, make in rivals.items():
        board.append({"model": name, **metrics(y, cv_predict(make, X_core, y, groups), groups, high)})
    rule = (X_core[:, 1] >= 2).astype(float)
    board.append({"model": "One rule: operation time High", **metrics(y, rule, groups, high),
                  "log_loss": None, "brier": None, "auc": None})
    no_op = cv_predict(MonotoneLogit, X_core[:, [0, 2]], y, groups)
    board.append({"model": "Scorecard without operation time", **metrics(y, no_op, groups, high)})
    base = cv_predict(_BaseRate, X_core, y, groups)
    board.append({"model": "No model: fleet average for everyone", **metrics(y, base, groups, high)})

    # --- train on the past, test on the newest month
    time_test = None
    if "Month" in table.columns:
        month = table["Month"].map(month_number).to_numpy()
        if not np.isnan(month).any() and len(np.unique(month)) >= 3:
            past, newest = month < month.max(), month == month.max()
            if len(np.unique(y[past])) == 2:
                p_new = MonotoneLogit().fit(X[past], y[past]).predict_proba(X[newest])
                time_test = {"test_month": str(table["Month"][newest].iloc[0]),
                             **metrics(y[newest], p_new, groups[newest], high)}

    # --- final fit on everything, plus the uncertainty refits
    final = MonotoneLogit().fit(X, y)
    boot = bootstrap_fits(X, y, groups, n_boot=n_boot)
    reference = {n: 0.0 if FEATURES[n]["kind"] == "level" else float(np.median(X[:, j]))
                 for j, n in enumerate(features)}
    fill = {n: float(np.median(X[:, j])) for j, n in enumerate(features)}
    model = {
        "model_type": "monotone regularised logistic regression",
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "trained_on": [Path(p).name for p in paths],
        "rows": int(len(y)), "aircraft": int(len(np.unique(groups))), "failures": int(y.sum()),
        "features": features,
        "intercept": final.intercept_, "coef": [float(c) for c in final.coef_],
        "prior_sd": PRIOR_SD, "penalty": final.penalty_, "thresholds": thresholds,
        "reference": reference, "fill": fill,
        "trained_range": {n: [float(X[:, j].min()), float(X[:, j].max())] for j, n in enumerate(features)},
        "bootstrap": np.round(boot, 6).tolist(),
        "validation": {"unseen_aircraft": chosen_metrics, "time_test": time_test, "board": board,
                       "sensitivity": sensitivity(X, y, groups, high)},
    }

    # --- how each model behaves on readings the data never contained
    typical_age = fill["age"]
    fitted = {name: make().fit(X_core, y) for name, make in rivals.items()}
    stress = []
    for label, leak, op, age in STRESS_CASES:
        core_row = np.array([[leak, op, typical_age if age is None else age]])
        full_row = np.hstack([core_row, [[fill[n] for n in features[len(CORE):]]]])
        stress.append({"case": label, "ours": float(score(model, full_row)[0][0]),
                       **{name: float(_proba(m, core_row)[0]) for name, m in fitted.items()}})
    model["validation"]["stress"] = stress

    # --- a more complex model is only worth testing once there is real evidence
    challenger = next(r for r in board if r["model"] == "Monotone gradient boosting")
    model["validation"]["challenger_better"] = bool(
        model["failures"] >= 30
        and challenger["log_loss"] < chosen_metrics["log_loss"] - chosen_metrics["log_loss_se"])

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "model.json").write_text(json.dumps(model, indent=1), encoding="utf-8")

    scored = predict_table(model, table)
    scored.insert(scored.columns.get_loc("Risk_Percent"), "Unseen_Test_Risk_Percent", np.round(unseen * 100, 1))
    scored.to_csv(out_dir / "training_scores.csv", index=False)
    latest_per_aircraft(scored).to_csv(out_dir / "fleet_risk.csv", index=False)
    (out_dir / "validation_report.md").write_text(_report(model, scored), encoding="utf-8")
    return model, scored


def _fmt(value, pattern="{:.3f}"):
    return "n/a" if value is None else pattern.format(value)


def _report(model, scored) -> str:
    v = model["validation"]
    h = v["unseen_aircraft"]
    t = model["thresholds"]
    lines = [
        "# Risk model validation report",
        "",
        f"Trained {model['trained_at']} on {', '.join(model['trained_on'])}: "
        f"{model['rows']} rows, {model['aircraft']} aircraft, {model['failures']} failures.",
        "",
        "## The model",
        f"- Type: {model['model_type']}.",
        f"- Inputs: {', '.join(FEATURES[n]['col'] for n in model['features'])}.",
        "- Each input can only raise the risk, never lower it.",
        f"- Penalty: fixed in advance (prior scale {model['prior_sd']} per standard deviation of an input), "
        "not tuned to this data. It weakens automatically as more rows arrive.",
        f"- Risk levels: Low below {t['medium']:.0%}, Medium from {t['medium']:.0%}, High from {t['high']:.0%}.",
        "",
        "| Input | Weight per step or unit |",
        "|---|---|",
    ]
    lines += [f"| {FEATURES[n]['col']} | {c:.3f} |" for n, c in zip(model["features"], model["coef"])]
    lines += [
        f"| (starting point) | {model['intercept']:.3f} |",
        "",
        "## Test on aircraft the model never saw",
        "Each aircraft is held out in turn. The model is rebuilt from the other aircraft and then scores "
        "the held-out one.",
        "",
        f"- Failures caught: **{h['caught']} of {h['failures']}**. Missed: {h['missed']}. "
        f"False alarms: {h['false_alarms']} of {h['rows'] - h['failures']} healthy records.",
        f"- Brier score {h['brier']:.3f}, log loss {h['log_loss']:.3f}, AUC {_fmt(h['auc'], '{:.2f}')}.",
    ]
    if v["time_test"]:
        tt = v["time_test"]
        lines += [
            "",
            "## Test on the future",
            f"Trained only on the months before {tt['test_month']}, then scored {tt['test_month']}: "
            f"caught **{tt['caught']} of {tt['failures']}** failures with {tt['false_alarms']} false alarms "
            f"across {tt['rows']} records.",
        ]
    lines += [
        "",
        "## Compared with other models (same unseen-aircraft test)",
        "",
        "| Model | Caught | False alarms | Brier | Log loss |",
        "|---|---|---|---|---|",
    ]
    lines += [f"| {r['model']} | {r['caught']}/{r['failures']} | {r['false_alarms']} | "
              f"{_fmt(r['brier'])} | {_fmt(r['log_loss'])} |" for r in v["board"]]
    rivals = [k for k in v["stress"][0] if k not in ("case", "ours")]
    lines += [
        "",
        "## Readings the data never contained",
        "Predicted failure risk from each model after training on all rows.",
        "",
        "| Situation | Ours | " + " | ".join(rivals) + " |",
        "|---|---|" + "---|" * len(rivals),
    ]
    lines += [f"| {s['case']} | {s['ours']:.0%} | " + " | ".join(f"{s[k]:.0%}" for k in rivals) + " |"
              for s in v["stress"]]
    lines += [
        "",
        "## Does the result depend on the penalty setting?",
        f"We use {model['prior_sd']}. The same unseen-aircraft test at other settings:",
        "",
        "| Prior scale | Caught | False alarms | Brier | Log loss |",
        "|---|---|---|---|---|",
    ]
    lines += [f"| {r['prior_sd']}{' (ours)' if r['prior_sd'] == model['prior_sd'] else ''} | "
              f"{r['caught']}/{r['failures']} | {r['false_alarms']} | {r['brier']:.3f} | {r['log_loss']:.3f} |"
              for r in v["sensitivity"]]
    lines += [
        "",
        "## Current fleet (latest record per aircraft)",
        "",
        "| Aircraft | Month | Leakage | Operation time | Age | Risk | Range | Level | Main factors |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for _, r in latest_per_aircraft(scored).iterrows():
        lines.append(
            f"| {r.get(ID_COL, '')} | {r.get('Month', '')} | {r.get('Leakage_Level', '')} | "
            f"{r.get('Operation_Time', '')} | {r.get('Actuator_Age_Months', '')} | {r['Risk_Percent']:.0f}% | "
            f"{r['Range_Low']:.0f}-{r['Range_High']:.0f}% | {r['Risk_Level']} | {r['Main_Factors']} |")
    lines += [
        "",
        "## Limits",
        f"- {model['failures']} failures is very little evidence. The ranges above show how much the answer "
        "moves when the fleet is resampled.",
        "- Leakage and operation time arrive as labels, so the model treats each step up as the same size.",
        "- The risk is for the next 30 days only. A low score with rising readings still needs watching.",
        "- A more complex model: "
        f"{'worth testing now' if v['challenger_better'] else 'not justified by this much data'}.",
        "",
    ]
    return "\n".join(lines)


# ----------------------------------------------------------------------------
# Command line
# ----------------------------------------------------------------------------
def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    t = sub.add_parser("train", help="train and validate on one or more labelled files")
    t.add_argument("data", nargs="+")
    t.add_argument("--out", default=str(here / "artifacts"))
    t.add_argument("--medium", type=float, default=0.05, help="risk at which a record becomes Medium")
    t.add_argument("--high", type=float, default=0.50, help="risk at which a record becomes High")
    p = sub.add_parser("predict", help="score a new file with the saved model")
    p.add_argument("data")
    p.add_argument("--model", default=str(here / "artifacts" / "model.json"))
    p.add_argument("--out", default=None)
    args = parser.parse_args(argv)

    if args.command == "train":
        model, scored = train(args.data, args.out, medium=args.medium, high=args.high)
        h = model["validation"]["unseen_aircraft"]
        print(f"Trained on {model['rows']} rows, {model['aircraft']} aircraft, {model['failures']} failures.")
        print(f"Unseen-aircraft test: caught {h['caught']}/{h['failures']}, false alarms {h['false_alarms']}, "
              f"Brier {h['brier']:.3f}.")
        print(f"Inputs: {', '.join(model['features'])}.")
        print(latest_per_aircraft(scored).drop(columns=["Data_Notes", "Unseen_Test_Risk_Percent"],
                                               errors="ignore").to_string(index=False))
        print(f"Saved model, scores and report in {args.out}")
        return 0

    model = json.loads(Path(args.model).read_text(encoding="utf-8"))
    scored = predict_table(model, read_table(args.data))
    out = Path(args.out) if args.out else Path(args.model).parent / "predictions.csv"
    scored.to_csv(out, index=False)
    print(scored.drop(columns=["Data_Notes"]).to_string(index=False))
    flagged = scored[scored["Data_Notes"] != ""]
    if len(flagged):
        print(f"\n{len(flagged)} row(s) needed cleaning or are outside the trained range. See Data_Notes in {out}.")
    result = evaluate_predictions(scored, model["thresholds"])
    if result:
        print(f"\nAgainst the answers in this file: caught {result['caught']}/{result['failures']} failures, "
              f"missed {result['missed']}, false alarms {result['false_alarms']}, Brier {result['brier']:.3f}.")
    print(f"Saved {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
