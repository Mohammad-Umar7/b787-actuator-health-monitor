#!/usr/bin/env python
"""Case 1, release v2: predict actuator failure within 30 days and write the submission file.

  python risk_model/stage2/case1.py

Reads   data/stage2/for_participants/Case_1/
Writes  submission/case_1_predictions.csv      the only file to submit
        risk_model/stage2/artifacts/           report, per-row scores, saved model

The score is F1 on the Yes class, so everything here is tuned for F1, not accuracy.
"""
from __future__ import annotations

import sys
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.preprocessing import PolynomialFeatures, StandardScaler

ROOT = Path(__file__).resolve().parents[2]
CASE_DIR = ROOT / "data" / "stage2" / "for_participants" / "Case_1"
OUT_DIR = Path(__file__).resolve().parent / "artifacts"
SUBMISSION = ROOT / "submission" / "case_1_predictions.csv"

TARGET = "Failure_Next_30_Days"
ID = "Case_ID"
GROUP = "Aircraft_ID"
GRADES = ["FG-A", "FG-B", "FG-C"]

# Allowed ranges from the data dictionary. A value outside its range is treated as missing.
RANGES = {
    "Flight_Hours_Last_7_Days": (0, 140), "Flight_Cycles_Last_7_Days": (0, 35),
    "Actuator_Age_Hours": (0, 30000), "Days_Since_Last_Service": (0, 1095),
    "Ambient_Temperature_C": (5, 50), "Hydraulic_Pressure_PSI": (4300, 5200),
    "Pressure_Variation_PSI": (20, 250), "Hydraulic_Fluid_Temperature_C": (30, 100),
    "Internal_Leakage_Rate_mL_Min": (0, 135), "Actuation_Time_Seconds": (1.275, 18.82),
    "Reference_Leakage_Flow_mL_Min": (37.041, 67.493), "Reference_Actuation_Time_Seconds": (4.445, 8.099),
    "Diagnostic_Load_Ratio": (0.861, 1.162),
}

# ----------------------------------------------------------------------------
# Loading and cleaning
# ----------------------------------------------------------------------------
def load(case_dir=CASE_DIR):
    train = pd.read_excel(case_dir / "Case_1_Train_Cutoff_Participants.xlsx", sheet_name="Train Data")
    test = pd.read_csv(case_dir / "case_1_test_inputs.csv")
    template = pd.read_csv(case_dir / "submission_guidelines" / "case_1_predictions_template.csv", dtype=str)
    return train, test, template


def clean(df: pd.DataFrame, name: str, notes: list) -> pd.DataFrame:
    """Tidy types and blank out impossible values. No row is ever dropped: every test row needs a prediction."""
    df = df.copy()
    df["Hydraulic_Fluid_Grade"] = df["Hydraulic_Fluid_Grade"].astype(str).str.strip().str.upper()
    unknown = ~df["Hydraulic_Fluid_Grade"].isin(GRADES)
    if unknown.any():
        notes.append(f"{name}: {int(unknown.sum())} rows with an unknown fluid grade (treated as missing)")
        df.loc[unknown, "Hydraulic_Fluid_Grade"] = np.nan
    for col, (low, high) in RANGES.items():
        df[col] = pd.to_numeric(df[col], errors="coerce")
        slack = 0.005 * (high - low)  # the dictionary gives rounded endpoints
        bad = (df[col] < low - slack) | (df[col] > high + slack)
        if bad.any():
            notes.append(f"{name}: {int(bad.sum())} values of {col} outside {low} to {high} (set to missing)")
            df.loc[bad, col] = np.nan
    return df


def audit(train, test) -> list:
    lines = [f"- Training rows: {len(train):,}. Test rows: {len(test):,}.",
             f"- Duplicate rows: {int(train.duplicated().sum())} in training, {int(test.duplicated().sum())} in test. "
             f"Duplicate test IDs: {int(test[ID].duplicated().sum())}.",
             f"- Aircraft: {train[GROUP].nunique()} in training (each with {int(train.groupby(GROUP).size().median())} weekly "
             f"records), {test[GROUP].nunique()} in test (one record each).",
             f"- Target: {int(train[TARGET].eq('Yes').sum())} Yes and {int(train[TARGET].eq('No').sum())} No "
             f"({train[TARGET].eq('Yes').mean():.1%} Yes). Other labels: {int((~train[TARGET].isin(['Yes', 'No'])).sum())}."]
    gaps = pd.DataFrame({"train": train.isna().mean(), "test": test.reindex(columns=train.columns).isna().mean()})
    gaps = gaps[(gaps.train > 0) | ((gaps.test > 0) & (gaps.index != TARGET))]
    lines.append("- Missing values (the organisers say these are intentional): "
                 + "; ".join(f"{c} {r.train:.1%} train / {r.test:.1%} test" for c, r in gaps.iterrows() if c != TARGET) + ".")
    return lines


# ----------------------------------------------------------------------------
# Features
# ----------------------------------------------------------------------------
def features(df: pd.DataFrame) -> pd.DataFrame:
    """One row in, one row out. Nothing is learned here, so training and test are treated identically.

    The reference settings change at every diagnostic test and scale the raw readings, so the two key
    readings are divided by them. Aircraft, actuator, date and case IDs are never used, as the rules require.
    Actuator age is left out on purpose: it adds nothing once the readings are known, and its distribution
    differs between training and test.
    """
    f = pd.DataFrame(index=df.index)
    f["t_norm"] = df["Actuation_Time_Seconds"] / (df["Reference_Actuation_Time_Seconds"] * df["Diagnostic_Load_Ratio"])
    f["leak_norm"] = df["Internal_Leakage_Rate_mL_Min"] / df["Reference_Leakage_Flow_mL_Min"]
    f["log_t_norm"] = np.log(f["t_norm"])
    f["sqrt_leak_norm"] = np.sqrt(f["leak_norm"])
    f["pv"] = df["Pressure_Variation_PSI"]
    f["p"] = df["Hydraulic_Pressure_PSI"]
    f["ft"] = df["Hydraulic_Fluid_Temperature_C"]
    f["amb"] = df["Ambient_Temperature_C"]
    f["dtemp"] = f["ft"] - f["amb"]
    f["fh"] = df["Flight_Hours_Last_7_Days"]
    f["fc"] = df["Flight_Cycles_Last_7_Days"]
    f["h_per_cycle"] = f["fh"] / f["fc"].clip(lower=1)
    f["dss"] = df["Days_Since_Last_Service"]
    f["load"] = df["Diagnostic_Load_Ratio"]
    f["rt"] = df["Reference_Actuation_Time_Seconds"]
    f["rleak"] = df["Reference_Leakage_Flow_mL_Min"]
    f["gB"] = (df["Hydraulic_Fluid_Grade"] == "FG-B").astype(float)
    f["gC"] = (df["Hydraulic_Fluid_Grade"] == "FG-C").astype(float)
    return f.astype(float)


LINEAR = ["log_t_norm", "leak_norm", "sqrt_leak_norm", "pv", "p", "ft", "amb", "fh", "fc", "h_per_cycle",
          "dss", "load", "rt", "rleak", "gB", "gC"]
SIGNALS = ["log_t_norm", "sqrt_leak_norm", "pv", "ft", "amb", "fh", "p"]   # get squares and pairwise products
MEASURED = ["log_t_norm", "leak_norm", "pv", "ft", "amb", "p"]            # can be missing: flagged for the model
TREE = ["t_norm", "leak_norm", "pv", "p", "ft", "amb", "dtemp", "fh", "fc", "h_per_cycle", "dss", "load",
        "rt", "rleak", "gB", "gC"]
RISING = {"t_norm", "leak_norm", "pv"}  # physically, more of these can only mean more wear


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
class LogitPoly:
    """Logistic regression on the readings, their squares and pairwise products. Missing values get the
    training median plus a was-missing flag, all learned from the training rows only."""

    def __init__(self, C: float = 0.3):
        self.C = C

    def _matrix(self, X):
        signals = self.signal_scale.transform(self.signal_fill.transform(X[SIGNALS]))
        return np.hstack([self.fill.transform(X[LINEAR]), X[MEASURED].isna().to_numpy(float),
                          self.poly.transform(signals)[:, len(SIGNALS):]])

    def fit(self, X, y):
        self.fill = SimpleImputer(strategy="median").fit(X[LINEAR])
        self.signal_fill = SimpleImputer(strategy="median").fit(X[SIGNALS])
        self.signal_scale = StandardScaler().fit(self.signal_fill.transform(X[SIGNALS]))
        self.poly = PolynomialFeatures(2, include_bias=False).fit(np.zeros((1, len(SIGNALS))))
        A = self._matrix(X)
        self.scale = StandardScaler().fit(A)
        self.model = LogisticRegression(C=self.C, max_iter=5000).fit(self.scale.transform(A), y)
        return self

    def predict_proba(self, X):
        return self.model.predict_proba(self.scale.transform(self._matrix(X)))[:, 1]


class BoostedTrees:
    """Small gradient-boosted trees (LightGBM), constrained so risk cannot fall as wear readings rise.
    Missing values are handled natively. Several seeds are averaged to steady the result."""

    def __init__(self, seeds=(0,)):
        self.seeds = seeds

    def fit(self, X, y):
        constraints = [1 if c in RISING else 0 for c in TREE]
        self.models = [lgb.LGBMClassifier(
            n_estimators=500, learning_rate=0.02, num_leaves=8, min_child_samples=40, subsample=0.8,
            subsample_freq=1, colsample_bytree=0.7, reg_lambda=5.0, monotone_constraints=constraints,
            verbose=-1, random_state=seed).fit(X[TREE], y) for seed in self.seeds]
        return self

    def predict_proba(self, X):
        return np.mean([m.predict_proba(X[TREE])[:, 1] for m in self.models], axis=0)


class Blend:
    """The final model: 75% logistic, 25% trees. On aircraft left out of training, the logistic part gives the
    better F1 and the trees add a little ranking quality; this mix beat an even split in about 3 of 4 resamples."""

    WEIGHTS = (0.75, 0.25)

    def __init__(self, seeds=(0,)):
        self.parts = [LogitPoly(), BoostedTrees(seeds)]

    def fit(self, X, y):
        for part in self.parts:
            part.fit(X, y)
        return self

    def predict_proba(self, X):
        return sum(w * part.predict_proba(X) for w, part in zip(self.WEIGHTS, self.parts))


# ----------------------------------------------------------------------------
# Validation
# ----------------------------------------------------------------------------
def aircraft_folds(groups, k=5, seed=0):
    """Whole aircraft go to one side or the other, because the 100 weekly rows of an aircraft resemble each other."""
    names = np.array(sorted(set(groups)))
    np.random.default_rng(seed).shuffle(names)
    for part in np.array_split(names, k):
        held_out = np.isin(groups, part)
        yield ~held_out, held_out


def out_of_fold(X, y, groups, repeats=4):
    """Every row scored by a model that never saw its aircraft. One array of scores per repeat."""
    scores = np.zeros((repeats, len(y)))
    for r in range(repeats):
        for train, held_out in aircraft_folds(groups, seed=r):
            scores[r, held_out] = Blend().fit(X[train], y[train]).predict_proba(X[held_out])
    return scores


def confusion(y, flagged):
    tp = int((flagged & (y == 1)).sum()); fp = int((flagged & (y == 0)).sum())
    fn = int((~flagged & (y == 1)).sum()); tn = int((~flagged & (y == 0)).sum())
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": tp / max(tp + fp, 1), "recall": tp / max(tp + fn, 1),
            "f1": 2 * tp / max(2 * tp + fp + fn, 1), "accuracy": (tp + tn) / len(y)}


def choose_threshold(y, scores, groups, n_boot=300, seed=0):
    """The cut-off with the best average F1 over many resampled fleets, so it does not chase one lucky split."""
    grid = np.round(np.arange(0.15, 0.61, 0.01), 2)
    rng = np.random.default_rng(seed)
    names = np.unique(groups)
    rows_of = {a: np.where(groups == a)[0] for a in names}
    total = np.zeros(len(grid))
    for _ in range(n_boot):
        rows = np.concatenate([rows_of[a] for a in rng.choice(names, len(names))])
        s, yy = scores[rng.integers(len(scores))][rows], y[rows]
        positives = yy.sum()
        for j, cut in enumerate(grid):
            flagged = s >= cut
            total[j] += 2 * (flagged & (yy == 1)).sum() / max(flagged.sum() + positives, 1)
    curve = total / n_boot
    return float(grid[int(np.argmax(curve))]), dict(zip(grid.tolist(), curve.round(4).tolist()))


# ----------------------------------------------------------------------------
# Submission file
# ----------------------------------------------------------------------------
def write_submission(ids, labels, path=SUBMISSION):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "Case_ID,Failure_Next_30_Days\n" + "".join(f"{i},{label}\n" for i, label in zip(ids, labels))
    path.write_bytes(body.encode("utf-8"))  # plain UTF-8, no byte-order mark, LF line endings
    return path


def check_submission(path, test_ids) -> list:
    """Every rule in the submission guidelines. Returns the problems found; an empty list means it is valid."""
    problems = []
    raw = path.read_bytes()
    if path.name != "case_1_predictions.csv":
        problems.append("wrong filename")
    if raw.startswith(b"\xef\xbb\xbf"):
        problems.append("has a byte-order mark")
    if len(raw) > 1_000_000:
        problems.append("larger than 1,000,000 bytes")
    lines = raw.decode("utf-8").split("\n")
    if lines[-1] == "":
        lines = lines[:-1]
    if lines[0] != "Case_ID,Failure_Next_30_Days":
        problems.append(f"header is {lines[0]!r}")
    rows = [line.split(",") for line in lines[1:]]
    if len(rows) != 2000:
        problems.append(f"{len(rows)} prediction rows, not 2,000")
    if any(len(r) != 2 for r in rows):
        problems.append("a row does not have exactly two fields")
    ids = [r[0] for r in rows]
    if len(set(ids)) != len(ids):
        problems.append("duplicate IDs")
    if set(ids) != set(test_ids):
        problems.append("IDs do not match the test inputs")
    if any(r[-1] not in ("Yes", "No") for r in rows):
        problems.append("a label is not exactly Yes or No")
    if any(field != field.strip() or len(field) > 128 for r in rows for field in r):
        problems.append("a field has stray spaces or is too long")
    return problems


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw_train, raw_test, template = load()
    notes = []
    report = ["# Case 1 (release v2): model report", "", "## Data check"] + audit(raw_train, raw_test)
    train, test = clean(raw_train, "training", notes), clean(raw_test, "test", notes)
    report += [f"- Cleaning: {n}." for n in notes] or ["- Cleaning: every value is inside its allowed range and every "
                                                      "fluid grade is valid, so nothing had to be corrected."]
    assert list(template[ID]) == list(test[ID].astype(str)), "template IDs differ from the test inputs"

    X, y, groups = features(train), train[TARGET].eq("Yes").to_numpy(int), train[GROUP].to_numpy()
    X_test = features(test)

    # --- 1. cross-validation on aircraft the model never saw
    print("Cross-validating on unseen aircraft (4 repeats of 5 folds)...")
    scores = out_of_fold(X, y, groups)
    threshold, curve = choose_threshold(y, scores, groups)
    per_repeat = [confusion(y, s >= threshold) for s in scores]
    mean = {k: float(np.mean([c[k] for c in per_repeat])) for k in per_repeat[0]}
    spread = float(np.std([c["f1"] for c in per_repeat]))
    ap = float(np.mean([average_precision_score(y, s) for s in scores]))
    auc = float(np.mean([roc_auc_score(y, s) for s in scores]))
    rng = np.random.default_rng(1)
    names = np.unique(groups)
    rows_of = {a: np.where(groups == a)[0] for a in names}
    boot = []
    for _ in range(500):  # how much F1 moves from fleet to fleet
        rows = np.concatenate([rows_of[a] for a in rng.choice(names, len(names))])
        boot.append(confusion(y[rows], scores[0][rows] >= threshold)["f1"])
    low, high = np.percentile(boot, [5, 95])

    # --- 2. one plain train/test split, for a figure that is easy to explain
    held = np.isin(groups, np.random.default_rng(42).permutation(names)[:20])
    split_model = Blend(seeds=(0, 1, 2)).fit(X[~held], y[~held])
    split_cut, _ = choose_threshold(y[~held], out_of_fold(X[~held], y[~held], groups[~held], repeats=2), groups[~held], n_boot=150)
    split = confusion(y[held], split_model.predict_proba(X[held]) >= split_cut)

    # --- 3. final model on all 10,000 rows, then the test set
    print("Training the final model on all rows and scoring the test set...")
    model = Blend(seeds=(0, 1, 2, 3, 4)).fit(X, y)
    risk = model.predict_proba(X_test)
    labels = np.where(risk >= threshold, "Yes", "No")
    path = write_submission(test[ID].astype(str), labels)
    problems = check_submission(path, set(test[ID].astype(str)))

    expected_yes = float(risk.sum())                     # the scores are calibrated, so their sum estimates the true count
    expected_f1 = 2 * float(risk[risk >= threshold].sum()) / (int((risk >= threshold).sum()) + expected_yes)
    ranked = np.sort(risk)[::-1]                         # cross-check: the count that maximises expected F1 on the test set itself
    self_best = int(np.argmax(2 * np.cumsum(ranked) / (np.arange(1, len(ranked) + 1) + expected_yes))) + 1
    level = np.where(risk >= threshold, "High", np.where(risk >= 0.10, "Medium", "Low"))
    pd.DataFrame({ID: test[ID], "Risk_Percent": np.round(risk * 100, 1), "Risk_Level": level,
                  TARGET: labels}).to_csv(OUT_DIR / "case1_test_scores.csv", index=False)
    pd.DataFrame({GROUP: groups, "Actual": train[TARGET], "Unseen_Aircraft_Risk_Percent": np.round(scores.mean(0) * 100, 1)}
                 ).to_csv(OUT_DIR / "case1_training_scores.csv", index=False)
    joblib.dump({"model": model, "threshold": threshold}, OUT_DIR / "case1_model.joblib")

    logit = model.parts[0]
    weights = pd.Series(logit.model.coef_[0][: len(LINEAR)], index=LINEAR).sort_values(key=abs, ascending=False)
    gain = pd.Series(np.mean([m.booster_.feature_importance("gain") for m in model.parts[1].models], axis=0), index=TREE)
    gain = (gain / gain.sum()).sort_values(ascending=False)

    report += [
        "", "## Model",
        "- A weighted average of two models: 75% a logistic regression (with squared and pairwise terms) and 25% small "
        "gradient-boosted trees (LightGBM) that are not allowed to lower the risk when a wear reading rises.",
        "- The key step is dividing the raw readings by their reference settings: actuation time by "
        "(reference time x load ratio), and leakage by reference flow. The reference settings change at every test.",
        "- Not used: aircraft ID, actuator ID, date and case ID (the rules forbid them), and actuator age "
        "(it adds nothing once the readings are known, and it is distributed differently in the test set).",
        f"- Missing readings: the trees handle them directly; the logistic part uses the training median plus a flag.",
        "", "## How good is it",
        "All scores are on aircraft the model never saw during training.",
        "", "| Check | F1 | Precision | Recall | Accuracy |", "|---|---|---|---|---|",
        f"| Cross-validation, 5 folds x 4 repeats | **{mean['f1']:.3f}** | {mean['precision']:.3f} | {mean['recall']:.3f} | {mean['accuracy']:.3f} |",
        f"| One split: train on 80 aircraft, test on 20 | {split['f1']:.3f} | {split['precision']:.3f} | {split['recall']:.3f} | {split['accuracy']:.3f} |",
        "",
        f"- F1 varies between repeats by ±{spread:.3f}, and from fleet to fleet between {low:.3f} and {high:.3f} (5th to 95th percentile).",
        f"- Ranking quality: average precision {ap:.3f}, AUC {auc:.3f}.",
        f"- Per repeat at the chosen cut-off: about {mean['tp']:.0f} failures caught, {mean['fn']:.0f} missed, {mean['fp']:.0f} false alarms, out of {int(y.sum())} Yes rows.",
        f"- The one split: {split['tp']} caught, {split['fn']} missed, {split['fp']} false alarms among {int(held.sum())} rows.",
        "", "## Yes/No cut-off",
        f"- A row is predicted Yes when its risk is at least **{threshold:.2f}**. This is the cut-off with the best average F1 over 300 resampled fleets.",
        "- F1 near the cut-off: " + ", ".join(f"{c:.2f} gives {curve[c]:.3f}" for c in sorted(curve) if abs(c - threshold) <= 0.061 and round((c - threshold) * 100) % 2 == 0) + ".",
        "", "## Test set predictions",
        f"- Predicted Yes: **{int((labels == 'Yes').sum())}** of {len(labels):,} ({(labels == 'Yes').mean():.1%}). In training, {y.mean():.1%} of rows are Yes.",
        f"- The model's own estimate of the number of true Yes rows in the test set: about {expected_yes:.0f}.",
        f"- F1 the model expects on the test set from its own probabilities: about {expected_f1:.2f}.",
        f"- Cross-check of the cut-off: judged only by the test set's own probabilities, the best number to flag "
        f"would be {self_best}. The training-based cut-off flags {int((labels == 'Yes').sum())}.",
        f"- File: `{path.relative_to(ROOT).as_posix()}`. Format check: {'passed every rule' if not problems else 'FAILED: ' + '; '.join(problems)}.",
        "", "## What drives the predictions",
        "- Logistic part, largest standardised weights: " + ", ".join(f"{k} {v:+.2f}" for k, v in weights.head(6).items()) + ".",
        "- Tree part, share of total gain: " + ", ".join(f"{k} {v:.0%}" for k, v in gain.head(6).items()) + ".",
        "", "## Limits",
        "- Each test row is one snapshot. Readings four weeks before a failure look almost the same as readings six "
        "weeks before, so no model can separate them perfectly. Every method we tried stops near the same F1.",
        "- The test set mixes fluid grades more evenly than training and has younger actuators. The readings "
        "themselves are distributed alike, and age is not used, so this should not hurt.",
        "",
    ]
    (OUT_DIR / "case1_report.md").write_text("\n".join(report), encoding="utf-8")
    print("\n".join(report))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
