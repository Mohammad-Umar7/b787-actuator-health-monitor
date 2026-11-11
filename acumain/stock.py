"""A simulated spare-parts supply for the nose landing gear actuator.

The hackathon datasets contain no inventory, so this is a stand-in for the store system a real planner would
have: how many spare actuators are in the hangar store, how many more the central warehouse can send and how
fast, and how long a supplier order takes. Every number here is invented, is labelled "simulated" wherever it
is shown, and can be changed from the dashboard's Demo menu to show how the agents behave when stock is
plentiful, short or gone. Nothing is connected to a real inventory system and nothing is ever ordered.
"""
from __future__ import annotations

from .store import Store

PART = "Nose landing gear actuator, spare unit"
SOURCES = {"store": "Hangar store", "warehouse": "Central warehouse", "supplier": "Supplier order", "backorder": "Backorder, no delivery date"}
DEFAULT = {"store": 12, "warehouse": 8, "warehouse_days": 2, "supplier_days": 14, "supplier_available": True}
# One click in the Demo menu sets a whole situation.
PRESETS = {
    "plenty": {"store": 60, "warehouse": 20, "warehouse_days": 2, "supplier_days": 14, "supplier_available": True},
    "short": dict(DEFAULT),
    "none": {"store": 0, "warehouse": 0, "warehouse_days": 2, "supplier_days": 14, "supplier_available": False},
}
LIMITS = {"store": (0, 500), "warehouse": (0, 500), "warehouse_days": (1, 60), "supplier_days": (1, 180)}


class StockUnavailable(RuntimeError):
    """The stock system could not be read. Nothing may be assumed about parts."""


class SimulatedStock:
    def __init__(self, store: Store):
        self.store = store
        self.simulated_outage = False     # switched on from the Demo menu to show how a failed stock check is handled

    # ------------------------------------------------------------------ the situation
    def levels(self) -> dict:
        saved = self.store.get_setting("stock") or {}
        return {**DEFAULT, **{k: v for k, v in saved.items() if k in DEFAULT}}

    def set_levels(self, values: dict | None = None, preset: str | None = None) -> dict:
        current = dict(PRESETS[preset]) if preset in PRESETS else self.levels()
        for key, (low, high) in LIMITS.items():
            if values and values.get(key) is not None:
                try:
                    current[key] = max(low, min(high, int(values[key])))
                except (TypeError, ValueError):
                    pass
        if values and values.get("supplier_available") is not None:
            current["supplier_available"] = bool(values["supplier_available"])
        self.store.set_setting("stock", current)
        return current

    def reserved(self) -> int:
        """Units in the hangar store already promised to approved repairs."""
        return sum(1 for p in self.store.list_proposals(status="approved")
                   if p["action"] == "repair" and (p.get("part") or {}).get("source") == "store")

    def status(self) -> dict:
        """For the dashboard. Never raises: the Demo menu must work even while an outage is simulated."""
        levels = self.levels()
        reserved = self.reserved()
        return {**levels, "reserved": reserved, "free": max(0, levels["store"] - reserved), "part": PART,
                "simulated": True, "simulated_outage": self.simulated_outage}

    # ------------------------------------------------------------------ what the agents' tools read
    def _guard(self) -> None:
        if self.simulated_outage:
            raise StockUnavailable("The stock system is switched off (simulated outage).")

    def check(self) -> dict:
        self._guard()
        levels = self.levels()
        reserved = self.reserved()
        return {"store": levels["store"], "reserved": reserved, "free": max(0, levels["store"] - reserved)}

    def options(self) -> list:
        """Where more units can come from, fastest first. A source with nothing to offer is still listed, so the gap is visible."""
        self._guard()
        levels = self.levels()
        return [
            {"source": "warehouse", "name": SOURCES["warehouse"], "units_available": levels["warehouse"], "delivery_days": levels["warehouse_days"]},
            {"source": "supplier", "name": SOURCES["supplier"], "units_available": "no limit" if levels["supplier_available"] else 0,
             "delivery_days": levels["supplier_days"] if levels["supplier_available"] else None},
            {"source": "backorder", "name": SOURCES["backorder"], "units_available": "no limit", "delivery_days": None},
        ]
