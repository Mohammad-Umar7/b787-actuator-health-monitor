"""Prepare the separate copy of the app that the Day 2 demo video is recorded from.

    .venv\\Scripts\\python demo\\day2\\prepare.py http://127.0.0.1:8796 fleet     (the copy runs with Claude: about 7 cents)
    .venv\\Scripts\\python demo\\day2\\prepare.py http://127.0.0.1:8796 rest      (the copy runs with ACUMAIN_AGENT_MODE=offline: free)

"fleet": one team review of the sample file. "rest": a single record with both key readings blank, reviewed, and a
worn single record that is left unreviewed (the recorder starts its review during a simulated model outage and then
tries again). It writes demo/day2/work/prepared.json with the addresses the recorder opens.
"""
import json
import pathlib
import sys
import time
import urllib.request

BASE = sys.argv[1].rstrip("/")
STAGE = sys.argv[2] if len(sys.argv) > 2 else "fleet"
FILE = pathlib.Path(__file__).with_name("work").joinpath("prepared.json")
COMMON = {"Flight_Hours_Last_7_Days": 95, "Flight_Cycles_Last_7_Days": 16, "Actuator_Age_Hours": 3400, "Days_Since_Last_Service": 180, "Ambient_Temperature_C": 31,
          "Hydraulic_Pressure_PSI": 4950, "Hydraulic_Fluid_Temperature_C": 62, "Reference_Leakage_Flow_mL_Min": 50, "Reference_Actuation_Time_Seconds": 6, "Diagnostic_Load_Ratio": 1}
NONE = {**COMMON, "Aircraft_ID": "B787-104", "Hydraulic_Fluid_Grade": "FG-C", "Pressure_Variation_PSI": 66, "Internal_Leakage_Rate_mL_Min": "", "Actuation_Time_Seconds": ""}
WORN = {**COMMON, "Aircraft_ID": "B787-102", "Hydraulic_Fluid_Grade": "FG-A", "Pressure_Variation_PSI": 78, "Internal_Leakage_Rate_mL_Min": 24, "Actuation_Time_Seconds": 5.4}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"null")


def review(batch_id):
    run_id = call("POST", "/api/agent/runs", {"batch_id": batch_id, "kind": "review", "list_size": 25})["run_id"]
    while True:
        run = call("GET", f"/api/agent/runs/{run_id}")
        if run["status"] != "running":
            return run
        time.sleep(0.5)


for _ in range(80):
    try:
        health = call("GET", "/api/health")
        break
    except Exception:
        time.sleep(0.5)
print("agents:", health["agent"]["mode"])
out = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() and STAGE != "fleet" else {}
call("POST", "/api/demo/stock", {"preset": "short", "outage": False})
call("POST", "/api/demo/outage", {"enabled": False})
if STAGE == "fleet":
    fleet = review("sample")
    print("fleet review:", fleet["status"], fleet["mode"], [s["name"] for s in fleet["steps"] if s["type"] == "tool"])
    props = call("GET", "/api/batches/sample/proposals")
    out = {"fleet_run": fleet["id"], "first_record": props[0]["record_id"], "spent_usd": round(fleet["cost_usd"], 4), "proposals": len(props),
           "requests": len(call("GET", "/api/parts-requests?batch_id=sample"))}
else:
    none = call("POST", "/api/batches/record", {"values": NONE})
    r = review(none["id"])
    print("both readings blank:", r["status"], r["mode"], "cost", r["cost_usd"])
    worn = call("POST", "/api/batches/record", {"values": WORN})
    out.update({"none": none["id"], "retry": worn["id"]})
FILE.write_text(json.dumps(out, indent=1), encoding="utf-8")
print(json.dumps(out))
