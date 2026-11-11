#!/usr/bin/env python
"""AcuMain, Case 1 (Team Maze, Al Ain University): predicts whether a B787 nose landing gear actuator
will fail within 30 days, using our trained model (case1_model.joblib, kept next to this script).

Set up once (Python 3.11):
    pip install joblib==1.6.0 lightgbm==4.7.0 numpy==2.4.6 openpyxl==3.1.5 pandas==3.1.1 scikit-learn==1.9.1 scipy==1.17.1

Run:
    python predict.py case_1_test_inputs.csv                  writes predictions.csv (Case_ID, Yes/No)
    python predict.py your_file.xlsx -o my_predictions.csv     Excel works too
    python predict.py your_file.csv --with-risk                adds Risk_Percent and Risk_Level columns

Input: the same columns as the organisers' case_1_test_inputs.csv. Blank readings are allowed.
Output: Case_ID,Failure_Next_30_Days with Yes or No. Yes when the risk is 0.32 or more.
If the input also has a Failure_Next_30_Days column with the real answers, the F1 score is printed.
On case_1_test_inputs.csv the output is exactly our submitted case_1_predictions.csv (203 Yes).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import PolynomialFeatures, StandardScaler

MODEL_FILE = Path(__file__).resolve().parent / "case1_model.joblib"


# ----------------------------------------------------------------------------
# The model and its input steps, copied unchanged from our training script (case1.py)
# ----------------------------------------------------------------------------
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

# The model was saved from a module named case1. Point that name at this file so the model loads here.
sys.modules.setdefault("case1", sys.modules[__name__])


# ----------------------------------------------------------------------------
# Scoring a file
# ----------------------------------------------------------------------------
ANSWER = "Failure_Next_30_Days"
NOT_USED = ["Actuator_Age_Hours"]   # range-checked, but the model does not use it


def read(path: Path, sheet) -> pd.DataFrame:
    if not path.exists():
        sys.exit(f"File not found: {path}")
    if path.suffix.lower() in (".xlsx", ".xlsm", ".xls"):
        return pd.read_excel(path, sheet_name=sheet, dtype={"Case_ID": str})
    return pd.read_csv(path, dtype={"Case_ID": str}, sep=None, engine="python", encoding="utf-8-sig")


def main() -> int:
    parser = argparse.ArgumentParser(description="Predict B787 nose gear actuator failure within 30 days.")
    parser.add_argument("input", type=Path, help="CSV or Excel file of records")
    parser.add_argument("-o", "--output", type=Path, default=Path("predictions.csv"))
    parser.add_argument("--sheet", default=0, help="Excel sheet name (default: the first sheet)")
    parser.add_argument("--with-risk", action="store_true", help="also write Risk_Percent and Risk_Level")
    args = parser.parse_args()

    df = read(args.input, args.sheet)
    df.columns = [str(c).strip() for c in df.columns]
    needed = ["Hydraulic_Fluid_Grade"] + [c for c in RANGES if c not in NOT_USED]
    missing = [c for c in needed if c not in df.columns]
    if missing:
        sys.exit("These columns are missing (names must match case_1_test_inputs.csv): " + ", ".join(missing))
    if "Case_ID" not in df.columns:
        print("No Case_ID column, so the rows are numbered ROW-1, ROW-2, ... in the output.")
        df.insert(0, "Case_ID", [f"ROW-{i + 1}" for i in range(len(df))])
    for col in NOT_USED:
        if col not in df.columns:
            df[col] = np.nan

    bundle = joblib.load(MODEL_FILE)
    notes: list[str] = []
    risk = bundle["model"].predict_proba(features(clean(df, "input", notes)))
    cutoff, medium = float(bundle["cutoff"]), float(bundle["medium"])
    yes = risk >= cutoff

    out = pd.DataFrame({"Case_ID": df["Case_ID"].astype(str), ANSWER: np.where(yes, "Yes", "No")})
    if args.with_risk:
        out["Risk_Percent"] = np.round(risk * 100, 1)
        out["Risk_Level"] = np.where(yes, "High", np.where(risk >= medium, "Medium", "Low"))
    out.to_csv(args.output, index=False, encoding="utf-8", lineterminator="\n")   # plain UTF-8, no BOM

    print(f"Scored {len(out):,} records: {int(yes.sum()):,} Yes, {int((~yes).sum()):,} No (Yes when risk >= {cutoff:.2f}).")
    for note in notes:
        print(f"Note: {note}.")
    print(f"Wrote {args.output}")

    if ANSWER in df.columns:
        truth = df[ANSWER].astype(str).str.strip().str.capitalize()
        known = truth.isin(["Yes", "No"]).to_numpy()
        if known.any():
            t, p = truth[known].eq("Yes").to_numpy(), yes[known]
            tp, fp, fn, tn = int((t & p).sum()), int((~t & p).sum()), int((t & ~p).sum()), int((~t & ~p).sum())
            f1 = 2 * tp / max(2 * tp + fp + fn, 1)
            print(f"\nAgainst the answers in the file ({int(known.sum()):,} rows): F1 {f1:.3f}, "
                  f"precision {tp / max(tp + fp, 1):.3f}, recall {tp / max(tp + fn, 1):.3f}, "
                  f"accuracy {(tp + tn) / int(known.sum()):.3f}")
            print(f"Caught {tp}, missed {fn}, false alarms {fp}, correct No {tn}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
