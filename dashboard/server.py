#!/usr/bin/env python
"""Local dashboard for the actuator risk model.

  python dashboard/server.py [--data "data/Cases Data.xlsx"] [--port 8787] [--open]

It scores the data file with the saved model and serves the dashboard page.
To show a new file, stop the server and start it again with --data "new file.xlsx".
"""
import argparse
import json
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "risk_model"))
import risk_model as rm  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
         ".json": "application/json; charset=utf-8", ".mp4": "video/mp4", ".png": "image/png",
         ".vtt": "text/vtt; charset=utf-8"}


def build_state(model: dict, data_paths) -> dict:
    """Everything the page needs: every scored record plus the few model facts it shows."""
    raw = pd.concat([rm.read_table(p) for p in data_paths], ignore_index=True)
    records = rm.score_records(model, raw)
    months = {}
    for r in records:
        if r["month"] is not None:
            months.setdefault(r["order"], r["month"])
    check = model["validation"]["unseen_aircraft"]
    return {
        "source": ", ".join(Path(p).name for p in data_paths),
        "records": records,
        "months": [{"order": order, "label": label} for order, label in sorted(months.items())],
        "has_answers": any(r["actual"] is not None for r in records),
        "thresholds": {k: v * 100 for k, v in model["thresholds"].items()},
        "model": {
            "trained_on": model["trained_on"], "rows": model["rows"], "aircraft": model["aircraft"],
            "failures": model["failures"], "caught": check["caught"], "false_alarms": check["false_alarms"],
        },
    }


def make_handler(payload: bytes):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/state":
                return self._send(200, payload, "application/json; charset=utf-8")
            target = (STATIC / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
            if STATIC.resolve() not in target.parents or not target.is_file() or target.suffix not in TYPES:
                return self._send(404, b"Not found", "text/plain; charset=utf-8")
            self._send(200, target.read_bytes(), TYPES[target.suffix])

        def log_message(self, *args):  # keep the console quiet
            pass

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data", nargs="+", default=[str(ROOT / "data" / "Cases Data.xlsx")])
    parser.add_argument("--model", default=str(ROOT / "risk_model" / "artifacts" / "model.json"))
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--open", action="store_true", help="open the dashboard in the browser")
    parser.add_argument("--export", action="store_true",
                        help="write static/state.json for the hosted copy and exit")
    args = parser.parse_args(argv)

    model = json.loads(Path(args.model).read_text(encoding="utf-8"))
    state = build_state(model, args.data)
    payload = json.dumps(state, allow_nan=False).encode("utf-8")
    if args.export:
        (STATIC / "state.json").write_bytes(payload)
        print(f"Wrote {STATIC / 'state.json'} ({len(state['records'])} records from {state['source']})")
        return 0
    url = f"http://127.0.0.1:{args.port}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(payload))
    except OSError:
        print(f"Port {args.port} is busy. The dashboard may already be running at {url}")
        print(f"To start another one, add: --port {args.port + 1}")
        return 1
    print(f"Dashboard running at {url}  ({len(state['records'])} records from {state['source']})")
    print("Press Ctrl+C to stop.")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
