"""Shared test set-up. Nothing in the test suite can reach the real Claude API or spend credits."""
import dataclasses
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from acumain.config import ARTIFACTS, get_settings  # noqa: E402
from acumain.services import Services  # noqa: E402


@pytest.fixture(autouse=True)
def no_real_api(monkeypatch):
    """A safety net: even if some code built a real client by mistake, it would talk to a dead local port."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)


@pytest.fixture
def settings(tmp_path):
    return dataclasses.replace(get_settings(), data_dir=tmp_path, agent_mode="auto", api_key_present=False,
                               daily_usd_limit=10.0, run_usd_limit=0.50, max_steps=8, strict_tools=True, use_fallbacks=True,
                               model="claude-sonnet-5-5", effort="medium", max_output_tokens=4000, planner_pace=0.0)


@pytest.fixture
def svc(settings):
    return Services(settings)


@pytest.fixture
def sample_frame():
    return pd.read_csv(ARTIFACTS / "sample_records.csv", dtype=str, keep_default_na=False)


def with_claude(settings, llm, **changes):
    """Services that believe a Claude key is configured, with `llm` standing in for Claude."""
    return Services(dataclasses.replace(settings, agent_mode="auto", api_key_present=True, **changes), claude=llm)
