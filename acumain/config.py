"""Settings, read once from the environment (and from a .env file next to the project, if there is one)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
ROOT = PACKAGE.parent
ARTIFACTS = PACKAGE / "artifacts"
WEB = PACKAGE / "web"

# US dollars per million tokens. Used only to show what a run cost and to enforce the spend cap.
PRICES = {
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_write": 2.50, "cache_read": 0.10},
    "claude-sonnet-5": {"input": 2.00, "output": 10.00, "cache_write": 2.50, "cache_read": 0.20},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_write": 0.125, "cache_read": 0.01},
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_write": 5.00, "cache_read": 0.20},
}
DEFAULT_PRICE = PRICES["claude-sonnet-5-5"]


def load_env_file(path: Path = ROOT / ".env") -> None:
    """Minimal KEY=VALUE reader, so the app needs no extra package. Real environment variables win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


def _flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ("1", "true", "yes", "on")


def _number(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    api_key_present: bool
    agent_mode: str          # "auto": Claude when a key is set, otherwise the built-in planner. "offline": never call Claude.
    model: str
    effort: str
    max_steps: int
    max_output_tokens: int
    daily_usd_limit: float
    run_usd_limit: float
    use_fallbacks: bool
    strict_tools: bool
    request_timeout: float
    planner_pace: float      # seconds the built-in planner waits between steps, so its work can be followed on screen
    data_dir: Path
    host: str
    port: int

    @property
    def claude_enabled(self) -> bool:
        return self.agent_mode != "offline" and self.api_key_present


def get_settings() -> Settings:
    load_env_file()
    effort = os.environ.get("ACUMAIN_EFFORT", "medium").strip().lower()
    return Settings(
        # Only an explicit key or token turns Claude on. A login profile on the host is never used, so the
        # app cannot spend credits unless it was told to.
        api_key_present=bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
        agent_mode=os.environ.get("ACUMAIN_AGENT_MODE", "auto").strip().lower(),
        model=os.environ.get("ACUMAIN_MODEL", "claude-sonnet-5-5").strip(),
        effort=effort if effort in ("low", "medium", "high") else "medium",
        max_steps=int(_number("ACUMAIN_MAX_STEPS", 12)),
        max_output_tokens=int(_number("ACUMAIN_MAX_OUTPUT_TOKENS", 4000)),
        daily_usd_limit=_number("ACUMAIN_DAILY_USD_LIMIT", 10.0),
        run_usd_limit=_number("ACUMAIN_RUN_USD_LIMIT", 0.50),
        use_fallbacks=_flag("ACUMAIN_FALLBACKS", True),
        strict_tools=_flag("ACUMAIN_STRICT_TOOLS", True),
        request_timeout=_number("ACUMAIN_REQUEST_TIMEOUT", 90.0),
        planner_pace=max(0.0, _number("ACUMAIN_PLANNER_PACE_MS", 450)) / 1000,
        data_dir=Path(os.environ.get("ACUMAIN_DATA_DIR", ROOT / "runtime")),
        host=os.environ.get("ACUMAIN_HOST", "127.0.0.1"),
        port=int(_number("ACUMAIN_PORT", 8787)),
    )


def cost_usd(model: str, input_tokens: int = 0, output_tokens: int = 0, cache_write: int = 0, cache_read: int = 0) -> float:
    price = PRICES.get(model, DEFAULT_PRICE)
    return (input_tokens * price["input"] + output_tokens * price["output"]
            + cache_write * price["cache_write"] + cache_read * price["cache_read"]) / 1_000_000
