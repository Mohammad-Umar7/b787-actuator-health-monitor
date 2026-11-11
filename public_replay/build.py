"""Build the public replay copy of the dashboard, for a static host such as Vercel.

The real dashboard needs the Python server, the trained model and the agents. A static host runs none of them,
so this script records what the real app produced and writes a copy of the dashboard that replays it:

    .venv\\Scripts\\python public_replay\\build.py            # needs the app running on http://localhost:8787
    .venv\\Scripts\\python public_replay\\build.py --examples  # also runs the four single-record examples first (uses the agents)

It exports the sample file's latest review (every step, the proposals, the parts request, every record) and the
four single-record examples, then writes `public_replay/site/`: the dashboard's own pages and scripts, with
`js/api.js` replaced by `public_replay/api.js`, which answers from the recorded data.

Two things are changed on purpose in the public copy of the sample file:
  - Aircraft and records are relabelled (AC-0001, R-0001, in a shuffled order), and
  - raw readings, dates and actuator IDs are left out.
The sample file is the organisers' test set, and the app's risk for each record is in effect our leaderboard
answer. Relabelled and without the readings, the public copy cannot be matched back to the test file.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "acumain" / "web"
OUT = ROOT / "public_replay" / "site"
OLD_SITE = ROOT / "dashboard" / "static"
BASE = "http://localhost:8787"
SAMPLE = "sample"
CHUNK = 100

COMMON = {"Flight_Hours_Last_7_Days": 95, "Flight_Cycles_Last_7_Days": 16, "Actuator_Age_Hours": 3400, "Days_Since_Last_Service": 180, "Ambient_Temperature_C": 31,
          "Hydraulic_Pressure_PSI": 4950, "Hydraulic_Fluid_Temperature_C": 62, "Reference_Leakage_Flow_mL_Min": 50, "Reference_Actuation_Time_Seconds": 6, "Diagnostic_Load_Ratio": 1}
# The same four examples as the single-record form (acumain/web/js/check.js), and the address each gets in the public copy.
EXAMPLES = {
    "one-worn": {**COMMON, "Aircraft_ID": "B787-102", "Hydraulic_Fluid_Grade": "FG-A", "Pressure_Variation_PSI": 78, "Internal_Leakage_Rate_mL_Min": 24, "Actuation_Time_Seconds": 5.4},
    "one-healthy": {**COMMON, "Aircraft_ID": "B787-101", "Hydraulic_Fluid_Grade": "FG-B", "Flight_Hours_Last_7_Days": 80, "Flight_Cycles_Last_7_Days": 12, "Actuator_Age_Hours": 1500,
                    "Days_Since_Last_Service": 60, "Ambient_Temperature_C": 25, "Hydraulic_Pressure_PSI": 5000, "Pressure_Variation_PSI": 55, "Hydraulic_Fluid_Temperature_C": 55,
                    "Internal_Leakage_Rate_mL_Min": 4, "Actuation_Time_Seconds": 3.9},
    "one-missing": {**COMMON, "Aircraft_ID": "B787-103", "Hydraulic_Fluid_Grade": "FG-A", "Pressure_Variation_PSI": 70, "Internal_Leakage_Rate_mL_Min": "", "Actuation_Time_Seconds": 4.9},
    "one-none": {**COMMON, "Aircraft_ID": "B787-104", "Hydraulic_Fluid_Grade": "FG-C", "Flight_Hours_Last_7_Days": 70, "Flight_Cycles_Last_7_Days": 10, "Actuator_Age_Hours": 2100,
                 "Days_Since_Last_Service": 120, "Ambient_Temperature_C": 28, "Hydraulic_Pressure_PSI": 5010, "Pressure_Variation_PSI": 66, "Hydraulic_Fluid_Temperature_C": 58,
                 "Internal_Leakage_Rate_mL_Min": "", "Actuation_Time_Seconds": ""},
}
REAL_ID = re.compile(r"\b(?:Q|EVAL|COMP)-\d{6,}\b")          # how the organisers' test file names records, aircraft and actuators


def call(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"null")


def wait_for(run_id: str) -> dict:
    while True:
        run = call("GET", f"/api/agent/runs/{run_id}")
        if run["status"] != "running":
            return run
        time.sleep(0.5)


def record_examples() -> None:
    """Run the four examples through the team, as the single-record form does. Each becomes a one-record file."""
    for slug, values in EXAMPLES.items():
        batch = call("POST", "/api/batches/record", {"values": values})
        run = wait_for(call("POST", "/api/agent/runs", {"batch_id": batch["id"], "kind": "review"})["run_id"])
        print(f"  recorded {slug}: {batch['name']} -> {run['status']}, {run['mode']}, ${run['cost_usd']:.4f}")


def local_batches():
    """The app's own store of files, opened read-only from the same data folder the running server uses."""
    import sys
    sys.path.insert(0, str(ROOT))
    from acumain.batches import BatchStore
    from acumain.config import get_settings
    from acumain.model import RiskModel
    store = BatchStore(RiskModel().load(), get_settings().data_dir)
    store.load_saved()
    return store


LOCAL = None


def export_batch(batch: dict, runs_list: list) -> dict:
    """Everything the dashboard shows about one file, as the server gave it."""
    bid = batch["id"]
    rows, offset = [], 0
    while True:
        page = call("GET", f"/api/batches/{bid}/records?limit=500&offset={offset}")
        rows += page["rows"]
        offset += 500
        if not page["rows"] or len(rows) >= page["total"]:
            break
    # The details of every record are worked out here, with the app's own code and saved results, instead of asking
    # the server two thousand times. It gives exactly what the server would send, in seconds instead of minutes.
    local = LOCAL.get(bid)
    details = {}
    for row in rows:
        row.pop("proposal", None)
        detail = LOCAL.detail(local, row["record_id"]) if local is not None else call("GET", f"/api/batches/{bid}/records/{urllib.request.quote(row['record_id'], safe='')}")
        detail.pop("proposal", None)
        details[row["record_id"]] = detail
    mine = [r for r in runs_list if r["batch_id"] == bid and not r.get("archived") and r["status"] != "running"]
    review = next((r for r in mine if r["kind"] == "review"), None)
    question = next((r for r in mine if r["kind"] == "question" and review and r["started_at"] >= review["started_at"]), None)
    keep = [r for r in (question, review) if r]
    # Proposals and the parts request go out undecided: every visitor starts with the list as the team drafted it.
    proposals = call("GET", f"/api/batches/{bid}/proposals")
    for p in proposals:
        p.update(status="pending", decided_at=None, decided_by=None, decision_note=None, work_order_id=None)
    requests = call("GET", f"/api/parts-requests?batch_id={bid}")
    for r in requests:
        r.update(status="pending", decided_at=None, decision_note=None)
    view = {k: v for k, v in batch.items() if k not in ("proposals", "active_run")}
    return {"batch": view, "rows": rows, "details": details, "proposals": proposals, "requests": requests,
            "runs_list": keep, "runs": {r["id"]: call("GET", f"/api/agent/runs/{r['id']}") for r in keep}}


def relabel(data: dict) -> dict:
    """Give the sample file's aircraft, records and actuators new labels, in an order unrelated to the file's."""
    numbers = list(range(1, len(data["rows"]) + 1))
    random.Random(787).shuffle(numbers)
    names = {}
    for row, n in zip(data["rows"], numbers):
        detail = data["details"][row["record_id"]]
        names[row["record_id"]] = f"R-{n:04d}"
        names[str(row["aircraft_id"])] = f"AC-{n:04d}"
        if detail.get("actuator_id"):
            names[str(detail["actuator_id"])] = f"ACT-{n:04d}"
    text = REAL_ID.sub(lambda m: names.get(m.group(0), m.group(0)), json.dumps(data))
    return json.loads(text)


def strip_readings(data: dict) -> None:
    """Leave the raw readings, the dates and the actuator IDs out. What the model concluded from them stays."""
    for row in data["rows"]:
        row["date"] = None
    for detail in data["details"].values():
        detail.update(inputs=[], grade=None, date=None, actuator_id=None)
        for reading in (detail.get("readings") or {}).values():
            for key in ("ratio", "value"):
                if key in reading:
                    reading[key] = None


def rename_batch(data: dict, new_id: str) -> dict:
    old = data["batch"]["id"]
    return json.loads(json.dumps(data).replace(json.dumps(old)[1:-1], new_id)) if old != new_id else data


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--examples", action="store_true", help="run the four single-record examples first (uses the agents; with a key this costs a few cents)")
    parser.add_argument("--keep-examples", action="store_true", help="leave the example files in the local workspace afterwards")
    parser.add_argument("--web-only", action="store_true", help="copy the dashboard's pages and scripts again, keeping the recorded data")
    parser.add_argument("--drop-examples", action="store_true", help="remove example files recorded by an earlier run from the local workspace afterwards")
    args = parser.parse_args()

    global LOCAL
    if args.web_only:
        # Only the pages and scripts changed: copy them again and keep the recorded data as it is.
        build = json.loads((OUT / "data" / "core.json").read_text(encoding="utf-8"))["build"]
        shutil.copy2(WEB / "index.html", OUT / "index.html")
        shutil.copy2(WEB / "styles.css", OUT / "styles.css")
        shutil.rmtree(OUT / "js")
        shutil.copytree(WEB / "js", OUT / "js")
        (OUT / "js" / "api.js").write_text((ROOT / "public_replay" / "api.js").read_text(encoding="utf-8").replace("__BUILD__", build), encoding="utf-8", newline="\n")
        print(f"Pages and scripts refreshed in {OUT} (data of build {build} kept).")
        return
    health = call("GET", "/api/health")
    print(f"App reachable: model {health['model']['version']}, agents: {health['agent']['mode']}")
    if args.examples:
        record_examples()
    LOCAL = local_batches()
    batches = call("GET", "/api/batches")
    runs_list = call("GET", "/api/agent/runs?limit=200")
    by_aircraft = {values["Aircraft_ID"]: slug for slug, values in EXAMPLES.items()}

    exported, examples, made_here = [], {}, []
    sample = next(b for b in batches if b["id"] == SAMPLE)
    if not sample["scored"]:
        raise SystemExit("The sample file has not been reviewed yet. Open the dashboard, review it, then run this again.")
    data = export_batch(sample, runs_list)
    data = relabel(data)
    strip_readings(data)
    exported.append(data)
    print(f"  sample: {len(data['rows'])} records, {len(data['proposals'])} proposals, {len(data['requests'])} parts request(s), {len(data['runs'])} run(s)")
    for b in batches:
        slug = by_aircraft.get(b["name"].replace("Single record · ", "")) if b["source"] == "manual" else None
        if not slug or slug in examples.values() or not b["scored"] and not any(r["batch_id"] == b["id"] for r in runs_list):
            continue
        data = rename_batch(export_batch(b, runs_list), slug)
        exported.append(data)
        examples[EXAMPLES[slug]["Aircraft_ID"]] = slug
        made_here.append(b["id"])
        print(f"  {slug}: {b['name']}, {len(data['proposals'])} proposal(s), {len(data['runs'])} run(s)")
    if len(examples) < len(EXAMPLES):
        print(f"  note: only {len(examples)} of {len(EXAMPLES)} single-record examples are recorded. Run with --examples to record them.")

    # ---- the site
    if OUT.exists():
        for item in OUT.iterdir():
            if item.name != ".vercel":                              # keep the link to the Vercel project
                shutil.rmtree(item) if item.is_dir() else item.unlink()
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copy2(WEB / "index.html", OUT / "index.html")
    shutil.copy2(WEB / "styles.css", OUT / "styles.css")
    shutil.copytree(WEB / "js", OUT / "js")
    build = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    (OUT / "js" / "api.js").write_text((ROOT / "public_replay" / "api.js").read_text(encoding="utf-8").replace("__BUILD__", build), encoding="utf-8", newline="\n")

    health["agent"]["spent_today_usd"] = 0
    core = {"build": build, "health": health, "meta": call("GET", "/api/meta"), "batches": [d["batch"] for d in exported],
            "proposals": [p for d in exported for p in d["proposals"]], "requests": [r for d in exported for r in d["requests"]],
            "runs": sorted((r for d in exported for r in d["runs_list"]), key=lambda r: r["started_at"], reverse=True), "examples": examples}
    write(OUT / "data" / "core.json", core)
    write(OUT / "data" / "history.json", call("GET", "/api/history"))
    for d in exported:
        bid = d["batch"]["id"]
        for i, row in enumerate(d["rows"]):
            row["chunk"] = i // CHUNK
        write(OUT / "data" / "rows" / f"{bid}.json", d["rows"])
        for c in range((len(d["rows"]) + CHUNK - 1) // CHUNK):
            write(OUT / "data" / "records" / bid / f"{c}.json", {r["record_id"]: d["details"][r["record_id"]] for r in d["rows"][c * CHUNK:(c + 1) * CHUNK]})
        for run_id, run in d["runs"].items():
            write(OUT / "data" / "runs" / f"{run_id}.json", run)

    # The first public page (the day-1 fleet replay) stays reachable under /v1/, and the day-1 video keeps its address.
    if OLD_SITE.is_dir():
        (OUT / "v1").mkdir(exist_ok=True)
        for name in ("index.html", "app.js", "styles.css", "state.json"):
            if (OLD_SITE / name).is_file():
                shutil.copy2(OLD_SITE / name, OUT / "v1" / name)
        if (OLD_SITE / "demo.mp4").is_file():
            shutil.copy2(OLD_SITE / "demo.mp4", OUT / "demo.mp4")

    # ---- nothing of the organisers' test file may be left in the public copy
    leaks = []
    for path in (OUT / "data").rglob("*.json"):
        found = REAL_ID.findall(path.read_text(encoding="utf-8"))
        if found:
            leaks.append(f"{path.relative_to(OUT)}: {found[:3]}")
    if leaks:
        raise SystemExit("STOP: original IDs of the test file are still in the public copy:\n  " + "\n  ".join(leaks[:10]))
    size = sum(p.stat().st_size for p in (OUT / "data").rglob("*") if p.is_file())
    print(f"Built {OUT} (build {build}): {len(exported)} file(s), data {size / 1e6:.1f} MB, no original IDs left.")

    if (args.examples or args.drop_examples) and not args.keep_examples:
        for bid in made_here:
            call("DELETE", f"/api/batches/{bid}")
        print("  The example files were removed from the local workspace again.")


if __name__ == "__main__":
    main()
