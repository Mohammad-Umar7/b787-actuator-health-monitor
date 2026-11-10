"""One place that makes a value safe to store or send as JSON."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def jsonable(value):
    """Missing values (NaN, NA, NaT) and infinities become null, numpy types become plain ones. Strict JSON has
    no NaN, so a single one would make a whole response or a stored log entry unreadable."""
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(v) for v in value]
    if isinstance(value, np.generic):
        value = value.item()
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    try:
        return None if pd.isna(value) else str(value)
    except (TypeError, ValueError):
        return str(value)
