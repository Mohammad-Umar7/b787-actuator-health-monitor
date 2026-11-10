"""Start the dashboard:  python -m acumain [--host 127.0.0.1] [--port 8787] [--open]"""
from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from .api import create_app
from .config import get_settings


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(description="AcuMain dashboard and agent")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--open", action="store_true", help="open the dashboard in the browser")
    args = parser.parse_args()
    app = create_app()
    agent = app.state.services.agent_status()
    shown_host = "localhost" if args.host in ("0.0.0.0", "127.0.0.1") else args.host
    url = f"http://{shown_host}:{args.port}/"
    print(f"AcuMain is running at {url}")
    print(f"Agent: {'Claude (' + agent['model'] + ')' if agent['mode'] == 'claude' else 'built-in planner, no API key in use'}")
    if args.open:
        threading.Timer(1.0, webbrowser.open, args=[url]).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
