"""Checks that the risk model survives new, messy and bigger data.

Run:  python risk_model/tests/test_risk_model.py "data/Cases Data.xlsx"
"""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import risk_model as rm  # noqa: E402

REAL_DATA = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parents[2] / "data" / "Cases Data.xlsx")


def simulated_fleet(n_aircraft=60, months=6, seed=1):
    """A made-up bigger fleet for rehearsal only: actuators wear step by step and usually fail once both readings are High."""
    rng = np.random.default_rng(seed)
    names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"][:months]
    rows = []
    for a in range(n_aircraft):
        leak, op, age = 0, 0, int(rng.integers(6, 30))
        for m in names:
            if rng.random() < 0.35:
                leak = min(leak + 1, 3)
            if leak > op and rng.random() < 0.6:
                op = min(op + 1, 2)
            chance = 0.85 if (leak >= 2 and op >= 2) else 0.25 if (leak == 3 or op == 2) else 0.01
            failed = rng.random() < chance
            rows.append({"Aircraft_ID": f"SIM-{a:03d}", "Month": m, "Flight_Hours": int(rng.integers(300, 650)),
                         "Flight_Cycles": int(rng.integers(70, 140)), "Actuator_Age_Months": age,
                         "Previous_Failures": int(rng.integers(0, 2)), "Maintenance_Events": int(rng.integers(1, 5)),
                         "Leakage_Level": rm.LEVEL_NAMES[leak], "Operation_Time": rm.LEVEL_NAMES[op],
                         "Failure_Next_30_Days": "Yes" if failed else "No"})
            age += 1
            if failed:
                break
    return pd.DataFrame(rows)


def test_labels_are_read_however_they_are_typed():
    cases = {"Normal": 0, " high ": 2, "SLIGHTLY HIGH": 1, "slightly-high": 1, "Very_High": 3, "very high": 3,
             "Moderately high": 1, "Extremely high": 3, 2: 2, "1": 1, "low": 0}
    for raw, want in cases.items():
        got, _ = rm.parse_level(raw)
        assert got == want, (raw, got, want)
    for raw in (None, float("nan"), "", "n/a", "banana"):
        assert np.isnan(rm.parse_level(raw)[0]), raw


def test_risk_never_falls_when_a_reading_gets_worse(model):
    names = model["features"]
    base = np.array([[model["fill"][n] for n in names]])
    for j, name in enumerate(names):
        steps = [0, 1, 2, 3] if rm.FEATURES[name]["kind"] == "level" else [0, 10, 20, 40, 80]
        for leak in range(4):
            for op in range(4):
                row = base.copy()
                row[0, 0], row[0, 1] = leak, op
                risks = []
                for s in steps:
                    row[0, j] = s
                    risks.append(rm.score(model, row)[0][0])
                assert all(b >= a - 1e-12 for a, b in zip(risks, risks[1:])), (name, leak, op, risks)


def test_messy_new_file_is_scored_without_crashing(model, tmp):
    messy = pd.DataFrame({
        "operation time": ["HIGH", "slightly-high", "Very High", "normal", "banana", None],
        " LEAKAGE_LEVEL ": ["very high", "High", "Normal", " slightly high", "High", "High"],
        "Extra_Column": list("abcdef"),
        "actuator_age_months": [30, 45, "n/a", 2, 20, 20],
        "aircraft_id": ["B787-099", "B787-100", "B787-101", "B787-102", "B787-103", "B787-104"],
        "Month": ["May", "May", "Jun", "Jun", "Jul", "Jul"],
    })
    path = tmp / "messy.xlsx"
    messy.to_excel(path, index=False, sheet_name="whatever")
    scored = rm.predict_table(model, rm.read_table(path))
    assert len(scored) == 6
    assert scored["Risk_Percent"].between(0, 100).all()
    assert (scored["Range_Low"] <= scored["Risk_Percent"]).all() and (scored["Risk_Percent"] <= scored["Range_High"]).all()
    assert scored["Risk_Level"].isin(["Low", "Medium", "High"]).all()
    assert scored.loc[0, "Risk_Level"] == "High"
    assert scored.loc[3, "Risk_Level"] == "Low"
    assert "unrecognised" in scored.loc[4, "Data_Notes"] and "missing" in scored.loc[5, "Data_Notes"]
    assert "outside" in scored.loc[1, "Data_Notes"]
    assert rm.evaluate_predictions(scored, model["thresholds"]) is None


def test_frozen_model_on_a_bigger_fleet_with_answers(model, tmp):
    fleet = simulated_fleet()
    path = tmp / "bigger.csv"
    fleet.to_csv(path, index=False)
    scored = rm.predict_table(model, rm.read_table(path))
    result = rm.evaluate_predictions(scored, model["thresholds"])
    assert result["rows"] == len(fleet) and result["failures"] > 5
    assert result["auc"] > 0.8, result
    return result


def test_retraining_on_more_data_relaxes_the_penalty(model, tmp):
    path = tmp / "bigger.xlsx"
    simulated_fleet().to_excel(path, index=False)
    out = tmp / "retrained"
    bigger, _ = rm.train([REAL_DATA, path], out, n_boot=50)
    assert bigger["rows"] > model["rows"]
    assert bigger["penalty"] < model["penalty"]
    assert all(c >= 0 for c in bigger["coef"])
    assert (out / "model.json").exists() and (out / "validation_report.md").exists()
    json.loads((out / "model.json").read_text(encoding="utf-8"))
    return bigger


def test_training_refuses_a_file_without_answers(tmp):
    path = tmp / "no_answers.csv"
    simulated_fleet(5).drop(columns=["Failure_Next_30_Days"]).to_csv(path, index=False)
    try:
        rm.train([path], tmp / "x", n_boot=10)
    except ValueError as err:
        assert "answer column" in str(err)
    else:
        raise AssertionError("training without answers should fail")


def main():
    with tempfile.TemporaryDirectory() as folder:
        tmp = Path(folder)
        model, _ = rm.train([REAL_DATA], tmp / "model", n_boot=200)
        test_labels_are_read_however_they_are_typed()
        print("ok  labels are read however they are typed")
        test_risk_never_falls_when_a_reading_gets_worse(model)
        print("ok  risk never falls when a reading gets worse")
        test_messy_new_file_is_scored_without_crashing(model, tmp)
        print("ok  messy new file is scored, with notes on every cleaned row")
        r = test_frozen_model_on_a_bigger_fleet_with_answers(model, tmp)
        print(f"ok  frozen model on a simulated fleet of {r['rows']} rows: caught {r['caught']}/{r['failures']}, "
              f"false alarms {r['false_alarms']}, AUC {r['auc']:.2f}")
        b = test_retraining_on_more_data_relaxes_the_penalty(model, tmp)
        u = b["validation"]["unseen_aircraft"]
        print(f"ok  retrained on {b['rows']} rows: penalty {model['penalty']:.4f} -> {b['penalty']:.4f}, "
              f"unseen-aircraft test caught {u['caught']}/{u['failures']}, false alarms {u['false_alarms']}")
        test_training_refuses_a_file_without_answers(tmp)
        print("ok  training refuses a file without answers")
    print("\nAll checks passed.")


if __name__ == "__main__":
    main()
