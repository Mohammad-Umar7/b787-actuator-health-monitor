#!/usr/bin/env python
"""Writes dashboard/static/state.json for the hosted static replay (acumain.vercel.app).

  python dashboard/build_state.py

The numbers come from acumain.build_artifacts, the same build the app uses, so the hosted replay and the
app's Track record page always agree.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from acumain import build_artifacts  # noqa: E402

STATE = Path(__file__).resolve().parent / "static" / "state.json"


def write_state(path: Path = STATE) -> dict:
    state = build_artifacts.build()["history"]
    path.write_text(json.dumps(state, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    return state


if __name__ == "__main__":
    built = write_state()
    print(f"Wrote {STATE} ({STATE.stat().st_size / 1024:.0f} KB): {built['model']['aircraft']} aircraft, {built['model']['rows']:,} records")
