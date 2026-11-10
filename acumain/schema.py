"""The Stage 2 input schema: which columns a record needs, what is allowed in them, and how a file is checked.

Nothing here drops a row quietly. A value that cannot be used becomes "missing" and is reported, and a record
that lacks both key readings is marked as not scorable, so the model is never asked to guess from nothing.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

GRADES = ["FG-A", "FG-B", "FG-C"]
ID_COLUMNS = ["Case_ID", "Aircraft_ID", "Actuator_ID", "Observation_Date"]
ANSWER_COLUMN = "Failure_Next_30_Days"

# name -> (label, unit, lowest allowed, highest allowed). Ranges come from the organisers' data dictionary.
NUMERIC = {
    "Flight_Hours_Last_7_Days": ("Flight hours, last 7 days", "h", 0, 140),
    "Flight_Cycles_Last_7_Days": ("Flight cycles, last 7 days", "", 0, 35),
    "Actuator_Age_Hours": ("Actuator age", "flight hours", 0, 30000),
    "Days_Since_Last_Service": ("Days since last service", "days", 0, 1095),
    "Ambient_Temperature_C": ("Ambient temperature", "°C", 5, 50),
    "Hydraulic_Pressure_PSI": ("Hydraulic pressure", "PSI", 4300, 5200),
    "Pressure_Variation_PSI": ("Pressure variation", "PSI", 20, 250),
    "Hydraulic_Fluid_Temperature_C": ("Hydraulic fluid temperature", "°C", 30, 100),
    "Internal_Leakage_Rate_mL_Min": ("Internal leakage rate", "mL/min", 0, 135),
    "Actuation_Time_Seconds": ("Actuation time", "s", 1.275, 18.82),
    "Reference_Leakage_Flow_mL_Min": ("Reference leakage flow", "mL/min", 37.041, 67.493),
    "Reference_Actuation_Time_Seconds": ("Reference actuation time", "s", 4.445, 8.099),
    "Diagnostic_Load_Ratio": ("Diagnostic load ratio", "", 0.861, 1.162),
}
REQUIRED = ["Hydraulic_Fluid_Grade", *NUMERIC]            # the columns the model was trained on
TIME_PARTS = ["Actuation_Time_Seconds", "Reference_Actuation_Time_Seconds", "Diagnostic_Load_Ratio"]
LEAK_PARTS = ["Internal_Leakage_Rate_mL_Min", "Reference_Leakage_Flow_mL_Min"]
MAX_ROWS = 20000
MAX_ID_LENGTH = 64
MAX_BYTES = 8_000_000


class SchemaError(ValueError):
    """The file as a whole cannot be used. The message is written for the person who uploaded it."""


@dataclass
class Checked:
    frame: pd.DataFrame                       # cleaned records, one row each, with a Record_ID column
    issues: dict = field(default_factory=dict)   # Record_ID -> list of plain-language notes
    scorable: pd.Series | None = None         # False where both key readings are missing
    notes: list = field(default_factory=list)    # file-level notes
    has_answers: bool = False


def _canonical(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def read_table(content: bytes, filename: str = "upload.csv") -> pd.DataFrame:
    if len(content) > MAX_BYTES:
        raise SchemaError(f"The file is larger than {MAX_BYTES // 1_000_000} MB. Split it into smaller files.")
    if not content.strip():
        raise SchemaError("The file is empty.")
    if filename.lower().endswith((".xlsx", ".xls")):
        raise SchemaError("Please upload a CSV file. Save the Excel sheet as CSV first.")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("cp1252", errors="replace")      # what Excel on Windows writes by default
    header = text.lstrip().split("\n", 1)[0]
    # Spreadsheets in many countries export with semicolons (and decimal commas) or tabs instead of commas.
    separator = max(",;\t", key=header.count)
    try:
        frame = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False, sep=separator, skip_blank_lines=True)
    except Exception as err:  # pandas raises several unrelated types for a malformed file
        raise SchemaError(f"The file could not be read as CSV ({type(err).__name__}).") from err
    frame = frame[~frame.apply(lambda row: all(str(v).strip() == "" for v in row), axis=1)].reset_index(drop=True)
    if frame.empty:
        raise SchemaError("The file has a header but no records.")
    if len(frame) > MAX_ROWS:
        raise SchemaError(f"The file has {len(frame):,} records. The limit is {MAX_ROWS:,}.")
    if separator == ";":
        # With semicolons as the separator, a comma inside a number is the decimal mark: 4,2 means 4.2.
        frame = frame.apply(lambda col: col.astype(str).str.strip().str.replace(r"^(-?\d+),(\d+)$", r"\1.\2", regex=True))
    return frame


def check(raw: pd.DataFrame, id_prefix: str = "R") -> Checked:
    """Match the columns to the schema, clean every value, and say what was wrong with each record."""
    known = {_canonical(c): c for c in [*ID_COLUMNS, *REQUIRED, ANSWER_COLUMN]}
    rename, extra = {}, []
    for col in raw.columns:
        target = known.get(_canonical(col))
        if target and target not in rename.values():
            rename[col] = target
        else:
            extra.append(str(col))
    frame = raw.rename(columns=rename)[list(rename.values())].copy()
    missing_columns = [c for c in REQUIRED if c not in frame.columns]
    if missing_columns:
        shown = ", ".join(missing_columns[:5]) + (f" and {len(missing_columns) - 5} more" if len(missing_columns) > 5 else "")
        raise SchemaError(f"The file is missing {len(missing_columns)} required column(s): {shown}. "
                          "It needs the same columns as the Stage 2 test file. Download the template to see them.")
    notes = []
    if extra:
        notes.append(f"Ignored {len(extra)} column(s) that the model does not use: {', '.join(extra[:6])}"
                     + ("..." if len(extra) > 6 else "") + ".")

    for col in ID_COLUMNS:
        if col in frame.columns:
            frame[col] = frame[col].astype(str).str.strip().replace({"": None, "nan": None, "None": None})
        else:
            frame[col] = None
    blank_id = frame["Case_ID"].isna()
    frame.loc[blank_id, "Case_ID"] = [f"{id_prefix}-{i + 1:05d}" for i in np.flatnonzero(blank_id.to_numpy())]
    frame["Case_ID"] = frame["Case_ID"].astype(str).str.slice(0, MAX_ID_LENGTH)
    taken, unique, repeats = set(), [], 0
    for cid in frame["Case_ID"]:
        candidate, n = cid, 1
        while candidate in taken:           # also covers a file that already contains "A", "A" and "A#2"
            n += 1
            candidate = f"{cid}#{n}"
        repeats += candidate != cid
        taken.add(candidate)
        unique.append(candidate)
    if repeats:
        notes.append(f"{repeats} record(s) repeated an ID that was already in the file; a suffix was added to keep them apart.")
    frame["Case_ID"] = unique
    frame.insert(0, "Record_ID", frame["Case_ID"])
    frame["Aircraft_ID"] = frame["Aircraft_ID"].fillna(frame["Record_ID"]).astype(str).str.slice(0, MAX_ID_LENGTH)

    issues: dict = {rid: [] for rid in frame["Record_ID"]}
    ids = frame["Record_ID"].to_numpy()

    def report(mask, text):
        for rid in ids[np.asarray(mask)]:
            issues[rid].append(text)

    grade = frame["Hydraulic_Fluid_Grade"].astype(str).str.strip().str.upper()
    blank = grade.isin(["", "NAN", "NONE", "NA", "N/A"])
    unknown = ~grade.isin(GRADES) & ~blank
    report(blank, "Hydraulic fluid grade is missing.")
    report(unknown, "Hydraulic fluid grade is not one of FG-A, FG-B, FG-C, so it was treated as missing.")
    frame["Hydraulic_Fluid_Grade"] = grade.where(grade.isin(GRADES), None)

    for col, (label, _unit, low, high) in NUMERIC.items():
        text = frame[col].astype(str).str.strip()
        empty = text.isin(["", "nan", "NaN", "None", "NA", "N/A", "null", "-"])
        values = pd.to_numeric(text.where(~empty), errors="coerce")
        values = values.where(np.isfinite(values))            # "inf" parses as a number but is not a reading
        not_number = values.isna() & ~empty
        slack = 0.005 * (high - low)
        out_of_range = values.notna() & ((values < low - slack) | (values > high + slack))
        report(empty, f"{label} is missing.")
        report(not_number, f"{label} is not a number, so it was treated as missing.")
        report(out_of_range, f"{label} is outside the allowed range ({low:g} to {high:g}), so it was treated as missing.")
        frame[col] = values.where(~out_of_range)

    has_answers = False
    if ANSWER_COLUMN in frame.columns:
        answer = frame[ANSWER_COLUMN].astype(str).str.strip().str.capitalize()
        frame[ANSWER_COLUMN] = answer.where(answer.isin(["Yes", "No"]), None)
        has_answers = bool(frame[ANSWER_COLUMN].notna().any())

    no_time = frame[TIME_PARTS].isna().any(axis=1)
    no_leak = frame[LEAK_PARTS].isna().any(axis=1)
    scorable = ~(no_time & no_leak)
    report(~scorable, "Both key readings (actuation time and leakage) are unusable, so no prediction is made. Repeat the diagnostic test.")
    return Checked(frame=frame.reset_index(drop=True), issues={k: v for k, v in issues.items() if v},
                   scorable=scorable.reset_index(drop=True), notes=notes, has_answers=has_answers)


def template_csv() -> str:
    return ",".join([*ID_COLUMNS, *REQUIRED]) + "\n"


def describe() -> list:
    """The schema as the dashboard shows it."""
    fields = [{"name": "Hydraulic_Fluid_Grade", "label": "Hydraulic fluid grade", "kind": "choice", "choices": GRADES}]
    for name, (label, unit, low, high) in NUMERIC.items():
        fields.append({"name": name, "label": label, "kind": "number", "unit": unit, "min": low, "max": high})
    return fields
