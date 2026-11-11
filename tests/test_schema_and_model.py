"""Input checks and the model service."""
import numpy as np
import pandas as pd
import pytest

from acumain import schema
from acumain.config import ARTIFACTS, ROOT
from acumain.model import ModelUnavailable, RiskModel


def one_row(**changes):
    row = {"Case_ID": "T-1", "Aircraft_ID": "AC-1", "Hydraulic_Fluid_Grade": "FG-B", "Flight_Hours_Last_7_Days": "80", "Flight_Cycles_Last_7_Days": "12",
           "Actuator_Age_Hours": "2500", "Days_Since_Last_Service": "90", "Ambient_Temperature_C": "25", "Hydraulic_Pressure_PSI": "5000",
           "Pressure_Variation_PSI": "60", "Hydraulic_Fluid_Temperature_C": "55", "Internal_Leakage_Rate_mL_Min": "6", "Actuation_Time_Seconds": "4.2",
           "Reference_Leakage_Flow_mL_Min": "50", "Reference_Actuation_Time_Seconds": "6", "Diagnostic_Load_Ratio": "1.0"}
    row.update(changes)
    return pd.DataFrame([row])


# ---------------------------------------------------------------------------- schema
def test_sample_file_is_accepted_whole(sample_frame):
    checked = schema.check(sample_frame)
    assert len(checked.frame) == 2000 and checked.frame["Record_ID"].is_unique
    assert int((~checked.scorable).sum()) == 8          # both key readings blank
    assert len(checked.issues) == 448 and not checked.has_answers


def test_missing_columns_are_named():
    with pytest.raises(schema.SchemaError) as err:
        schema.check(one_row().drop(columns=["Actuation_Time_Seconds", "Diagnostic_Load_Ratio"]))
    assert "Actuation_Time_Seconds" in str(err.value) and "Diagnostic_Load_Ratio" in str(err.value)


def test_headers_match_whatever_the_capitalisation_or_spacing():
    frame = one_row().rename(columns={"Actuation_Time_Seconds": "actuation time seconds", "Hydraulic_Fluid_Grade": " HYDRAULIC_FLUID_GRADE "})
    assert schema.check(frame).frame["Actuation_Time_Seconds"].iloc[0] == 4.2


def test_bad_values_become_missing_and_are_reported():
    checked = schema.check(one_row(Actuation_Time_Seconds="fast", Hydraulic_Pressure_PSI="9999", Hydraulic_Fluid_Grade="fg-x", Ambient_Temperature_C=""))
    row, notes = checked.frame.iloc[0], " ".join(checked.issues["T-1"])
    assert pd.isna(row["Actuation_Time_Seconds"]) and pd.isna(row["Hydraulic_Pressure_PSI"]) and pd.isna(row["Ambient_Temperature_C"])
    assert row["Hydraulic_Fluid_Grade"] is None or pd.isna(row["Hydraulic_Fluid_Grade"])
    assert "not a number" in notes and "outside the allowed range" in notes and "FG-A, FG-B, FG-C" in notes and "Ambient temperature is missing" in notes
    assert bool(checked.scorable.iloc[0])               # leakage is still there, so a prediction is possible


def test_record_without_both_key_readings_is_not_scorable():
    checked = schema.check(one_row(Actuation_Time_Seconds="", Internal_Leakage_Rate_mL_Min=""))
    assert not bool(checked.scorable.iloc[0]) and any("no prediction is made" in n for n in checked.issues["T-1"])


def test_ids_are_filled_and_kept_unique():
    frame = pd.concat([one_row(), one_row(), one_row(Case_ID="")], ignore_index=True)
    checked = schema.check(frame)
    assert checked.frame["Record_ID"].is_unique and any("repeated an ID" in n for n in checked.notes)


def test_answer_column_is_recognised():
    checked = schema.check(one_row(Failure_Next_30_Days="yes"))
    assert checked.has_answers and checked.frame["Failure_Next_30_Days"].iloc[0] == "Yes"


@pytest.mark.parametrize("content, name, expect", [(b"", "a.csv", "empty"), (b"a,b\n", "a.csv", "no records"), (b"x", "a.xlsx", "CSV"),
                                                   (b"x" * (schema.MAX_BYTES + 1), "a.csv", "larger than")])
def test_unusable_files_get_a_plain_message(content, name, expect):
    with pytest.raises(schema.SchemaError) as err:
        schema.read_table(content, name)
    assert expect in str(err.value)


# ---------------------------------------------------------------------------- model
@pytest.fixture(scope="module")
def model():
    return RiskModel().load()


def test_app_model_reproduces_the_submitted_predictions(model, sample_frame):
    """The deployed bundle, with its fitted preprocessing, gives exactly the labels in the leaderboard file."""
    checked = schema.check(sample_frame)
    code = model._code
    risk = model._bundle["model"].predict_proba(code.features(checked.frame))
    labels = np.where(risk >= model._bundle["cutoff"], "Yes", "No")
    submitted = pd.read_csv(ROOT / "submission" / "case_1_predictions.csv")
    assert list(submitted["Case_ID"]) == list(checked.frame["Case_ID"])
    assert (labels == submitted["Failure_Next_30_Days"].to_numpy()).all() and int((labels == "Yes").sum()) == 203


def test_levels_follow_the_exact_cutoff(model, sample_frame):
    checked = schema.check(sample_frame)
    out = model.score(checked.frame, checked.scorable)
    counts = out["level"].value_counts().to_dict()
    assert counts == {"Low": 1645, "High": 203, "Medium": 144, "Not scored": 8}
    assert out.loc[out["level"] == "Not scored", "risk"].isna().all() and out.loc[out["level"] == "Not scored", "prediction"].isna().all()
    assert (out.loc[out["level"] == "High", "prediction"] == "Yes").all()
    assert out.loc[out["level"] == "High", "risk"].min() >= model.cutoff          # a shown risk never contradicts its level


def test_a_missing_reading_still_gets_a_prediction(model):
    checked = schema.check(one_row(Internal_Leakage_Rate_mL_Min=""))
    out = model.score(checked.frame, checked.scorable)
    assert out["level"].iloc[0] in ("High", "Medium", "Low") and pd.isna(out["leak_level"].iloc[0])
    assert "leakage not recorded" in model.reason(out["op_level"].iloc[0], out["leak_level"].iloc[0])


def test_worn_readings_score_high_and_explain_themselves(model):
    checked = schema.check(one_row(Actuation_Time_Seconds="5.5", Internal_Leakage_Rate_mL_Min="26", Pressure_Variation_PSI="80"))
    out = model.score(checked.frame, checked.scorable).iloc[0]
    assert out["level"] == "High" and out["prediction"] == "Yes" and out["f_op"] + out["f_leak"] + out["f_pv"] in (99, 100, 101)
    assert model.reason(out["op_level"], out["leak_level"]) == "Very slow operation and very high leakage"
    assert model.time_left(out["risk"]).startswith("under") and model.suggested_action("High", out["op_level"], out["leak_level"]) == "repair"


def test_simulated_outage_raises_instead_of_guessing(model, sample_frame):
    checked = schema.check(sample_frame.head(5))
    model.simulated_outage = True
    try:
        with pytest.raises(ModelUnavailable):
            model.score(checked.frame, checked.scorable)
    finally:
        model.simulated_outage = False


def test_missing_model_file_is_reported_not_fatal(tmp_path):
    broken = RiskModel(bundle_path=tmp_path / "nothing.joblib", reference_path=ARTIFACTS / "reference.json").load()
    assert not broken.available and "could not be loaded" in broken.status_message()
    with pytest.raises(ModelUnavailable):
        broken.score(pd.DataFrame({"Record_ID": []}), pd.Series([], dtype=bool))


# ---------------------------------------------------------------------------- awkward files people really upload
HEADER = list(one_row().columns)


def as_file(rows, separator=",", encoding="utf-8"):
    return "\n".join(separator.join(r) for r in rows).encode(encoding)


def test_semicolon_file_with_decimal_commas_is_read_correctly():
    values = [v.replace(".", ",") for v in one_row().iloc[0].astype(str)]
    checked = schema.check(schema.read_table(as_file([HEADER, values], separator=";")))
    row = checked.frame.iloc[0]
    assert row["Actuation_Time_Seconds"] == 4.2 and row["Diagnostic_Load_Ratio"] == 1.0 and not checked.issues


def test_tab_separated_and_windows_encoded_files_are_read():
    values = list(one_row(Aircraft_ID="Aéro-1").iloc[0].astype(str))
    checked = schema.check(schema.read_table(as_file([HEADER, values], separator="\t", encoding="cp1252")))
    assert checked.frame["Aircraft_ID"].iloc[0] == "Aéro-1" and checked.frame["Actuation_Time_Seconds"].iloc[0] == 4.2


def test_blank_lines_and_a_byte_order_mark_are_ignored():
    values = list(one_row().iloc[0].astype(str))
    content = b"\xef\xbb\xbf" + as_file([HEADER, values, [""] * len(HEADER), values]) + b"\n\n\n"
    assert len(schema.read_table(content)) == 2


def test_infinite_negative_and_padded_values():
    checked = schema.check(one_row(Actuation_Time_Seconds="inf", Internal_Leakage_Rate_mL_Min="-5", Pressure_Variation_PSI="  60  ", Hydraulic_Fluid_Grade=" fg-b "))
    row = checked.frame.iloc[0]
    assert pd.isna(row["Actuation_Time_Seconds"]) and pd.isna(row["Internal_Leakage_Rate_mL_Min"]) and row["Pressure_Variation_PSI"] == 60
    assert row["Hydraulic_Fluid_Grade"] == "FG-B" and not bool(checked.scorable.iloc[0])


def test_too_many_rows_is_refused():
    values = list(one_row().iloc[0].astype(str))
    with pytest.raises(schema.SchemaError) as err:
        schema.read_table(as_file([HEADER] + [values] * (schema.MAX_ROWS + 1)))
    assert "limit" in str(err.value)


def test_a_file_of_only_unusable_records_still_loads_and_scores_nothing(model):
    frame = pd.concat([one_row(Case_ID=f"T-{i}", Actuation_Time_Seconds="", Internal_Leakage_Rate_mL_Min="") for i in range(3)], ignore_index=True)
    checked = schema.check(frame)
    out = model.score(checked.frame, checked.scorable)
    assert list(out["level"]) == ["Not scored"] * 3 and out["risk"].isna().all()


def test_extra_columns_are_ignored_and_said_so():
    frame = one_row()
    frame["Technician"] = "A. Person"
    checked = schema.check(frame)
    assert "Technician" not in checked.frame.columns and "Ignored 1 column" in checked.notes[0]


def test_repeated_ids_stay_unique_even_when_the_suffix_is_already_taken():
    frame = pd.concat([one_row(Case_ID="A"), one_row(Case_ID="A"), one_row(Case_ID="A#2"), one_row(Case_ID="x" * 300, Aircraft_ID="y" * 300)], ignore_index=True)
    checked = schema.check(frame)
    ids = list(checked.frame["Record_ID"])
    assert ids[:3] == ["A", "A#2", "A#2#2"] and len(set(ids)) == 4 and "2 record(s) repeated an ID" in checked.notes[0]
    assert len(ids[3]) == schema.MAX_ID_LENGTH and len(checked.frame["Aircraft_ID"].iloc[3]) == schema.MAX_ID_LENGTH


# ---------------------------------------------------------------------------- the planner's steps for an action
def test_next_steps_say_what_to_do_by_when_and_why(model):
    checked = schema.check(one_row(Actuation_Time_Seconds="5.5", Internal_Leakage_Rate_mL_Min="26", Pressure_Variation_PSI="80"))
    out = model.score(checked.frame, checked.scorable).iloc[0]
    plan = model.next_steps("repair", out["risk"], out["op_level"], out["leak_level"], [], [{"name": "Operation time", "share": 55}])
    assert plan["title"] == "Schedule repair" and plan["when"] == "This week"
    assert plan["steps"][0] == {"do": "Book a hangar slot this week.", "why": f"Aircraft at this risk have typically failed in {model.time_left(out['risk'])}."}
    finding = next(s for s in plan["steps"] if "job card" in s["do"])
    assert "very slow operation and very high leakage" in finding["do"] and finding["why"] == "Share of the added risk: operation time 55%."
    assert "repeat the diagnostic test" in plan["steps"][-1]["do"] and "maintenance manual" in plan["scope"]


def test_next_steps_fit_each_kind_of_result(model):
    retest = model.next_steps("retest", None, None, None, ["actuation time", "leakage"])
    assert retest["when"] == "At the next opportunity" and "no prediction was made" in retest["steps"][0]["why"]
    assert "actuation time and leakage readings are recorded" in retest["steps"][1]["do"] and "unknown, not as safe" in retest["steps"][-1]["do"]
    inspect = model.next_steps("inspect", 20.0, 1, 2)
    assert inspect["when"].startswith("Within") and "at the next planned stop" in inspect["when"] and "32% risk or more" in inspect["steps"][-1]["do"]
    reduced = model.next_steps("repair", 60.0, 2, None, ["leakage"])                     # one key reading missing
    assert any(s["do"] == "Have the leakage reading taken at the same visit." and "reduced confidence" in s["why"] for s in reduced["steps"])
    assert all(s["do"] for s in reduced["steps"])
    monitor = model.next_steps("anything unknown", 1.0, 0, 0)                            # falls back to the safest plan
    assert monitor["action"] == "monitor" and monitor["when"] == "No deadline" and monitor["steps"][0]["do"].startswith("No action")
