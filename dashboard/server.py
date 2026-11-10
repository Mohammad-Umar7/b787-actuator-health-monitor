#!/usr/bin/env python
"""Local dashboard for the actuator risk model.

  python dashboard/server.py [--port 8787] [--open] [--rebuild]

It serves the dashboard page and the data file dashboard/static/state.json. The data file holds the stage 2
fleet scored by the stage 2 model. It is built once (about half a minute) and reused; add --rebuild after the
model or the data changes, or --export to rebuild it and exit (used before updating the hosted copy).
"""
import argparse
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC = Path(__file__).resolve().parent / "static"
STATE = STATIC / "state.json"
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
         ".json": "application/json; charset=utf-8", ".mp4": "video/mp4", ".png": "image/png",
         ".vtt": "text/vtt; charset=utf-8"}


def rebuild_state():
    """Score the fleet again. Imported here so a normal start does not load the modelling libraries."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import build_state
    print("Scoring the fleet with the model. This takes about half a minute...")
    state = build_state.write_state(STATE)
    print(f"Wrote {STATE} ({state['model']['rows']:,} records, {state['model']['aircraft']} aircraft)")


def make_handler():
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
                return self._send(200, STATE.read_bytes(), "application/json; charset=utf-8")
            target = (STATIC / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
            if STATIC.resolve() not in target.parents or not target.is_file() or target.suffix not in TYPES:
                return self._send(404, b"Not found", "text/plain; charset=utf-8")
            self._send(200, target.read_bytes(), TYPES[target.suffix])

        def log_message(self, *args):  # keep the console quiet
            pass

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--open", action="store_true", help="open the dashboard in the browser")
    parser.add_argument("--rebuild", action="store_true", help="score the fleet again before starting")
    parser.add_argument("--export", action="store_true", help="score the fleet again, write static/state.json and exit")
    args = parser.parse_args(argv)

    if args.export or args.rebuild or not STATE.exists():
        rebuild_state()
    if args.export:
        return 0
    url = f"http://127.0.0.1:{args.port}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler())
    except OSError:
        print(f"Port {args.port} is busy. The dashboard may already be running at {url}")
        print(f"To start another one, add: --port {args.port + 1}")
        return 1
    print(f"Dashboard running at {url}")
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
