"""Take the screenshots the Day 2 deck uses, with headless Chrome driven over its debugging port.

    .venv\\Scripts\\python deliverables\\day2\\capture.py [names...]

It only LOOKS at the running dashboard (http://localhost:8787): it opens pages and windows and never approves,
rejects, resets or starts anything there. The two failure pictures (a record with both key readings missing, and
a model outage) are made on a separate copy of the app on port 8795 with its own empty data folder and the free
built-in planner, so the real workspace is never touched:

    set ACUMAIN_DATA_DIR=<an empty folder>  &  set ACUMAIN_AGENT_MODE=offline  &  .venv\\Scripts\\python -m acumain --port 8795
"""
from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333
LIVE = "http://localhost:8787"
SANDBOX = "http://localhost:8795"
OUT = Path(__file__).resolve().parent / "screens"
WIDTH, HEIGHT, SCALE = 1500, 844, 1.6

BOTH_MISSING = {"Aircraft_ID": "B787-104", "Hydraulic_Fluid_Grade": "FG-C", "Flight_Hours_Last_7_Days": 70, "Flight_Cycles_Last_7_Days": 10, "Actuator_Age_Hours": 2100,
                "Days_Since_Last_Service": 120, "Ambient_Temperature_C": 28, "Hydraulic_Pressure_PSI": 5010, "Pressure_Variation_PSI": 66, "Hydraulic_Fluid_Temperature_C": 58,
                "Internal_Leakage_Rate_mL_Min": "", "Actuation_Time_Seconds": "", "Reference_Leakage_Flow_mL_Min": 50, "Reference_Actuation_Time_Seconds": 6, "Diagnostic_Load_Ratio": 1}


def api(base: str, method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


def review(base: str, batch_id: str) -> dict:
    run_id = api(base, "POST", "/api/agent/runs", {"batch_id": batch_id, "kind": "review"})["run_id"]
    while True:
        run = api(base, "GET", f"/api/agent/runs/{run_id}")
        if run["status"] != "running":
            return run
        time.sleep(0.3)


class Page:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def send(self, method: str, **params):
        self.n += 1
        mine = self.n
        await self.ws.send(json.dumps({"id": mine, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mine:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def goto(self, url: str, wait: float = 2.5):
        await self.send("Page.navigate", url=url)
        await asyncio.sleep(wait)

    async def js(self, expression: str):
        out = await self.send("Runtime.evaluate", expression=expression, awaitPromise=True, returnByValue=True)
        if out.get("exceptionDetails"):
            raise RuntimeError(out["exceptionDetails"].get("exception", {}).get("description", "script error"))
        return out.get("result", {}).get("value")

    async def shot(self, name: str, clip: dict | None = None):
        params = {"format": "png"}
        if clip:
            params["clip"] = {**clip, "scale": 1}
        data = (await self.send("Page.captureScreenshot", **params))["data"]
        (OUT / f"{name}.png").write_bytes(base64.b64decode(data))
        print("  saved", name)

    async def box(self, selector: str, pad: int = 0) -> dict | None:
        r = await self.js(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + scrollX, b.y + scrollY, b.width, b.height, scrollX, scrollY]; }})()")
        if not r or r[2] < 20 or r[3] < 20:                # not there, or not laid out yet
            return None
        # The clip is measured on the whole page, so the part of the page scrolled out of view is added back.
        x, y = max(r[4], r[0] - pad), max(r[5], r[1] - pad)
        return {"x": x, "y": y, "width": min(r[4] + WIDTH - x, r[2] + 2 * pad), "height": min(r[5] + HEIGHT - y, r[3] + 2 * pad)}


async def main(wanted: set):
    OUT.mkdir(parents=True, exist_ok=True)
    want = lambda name: not wanted or name in wanted
    profile = tempfile.mkdtemp(prefix="acumain-deck-")
    chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}", f"--window-size={WIDTH},{HEIGHT}",
                               "--hide-scrollbars", "--no-first-run", "--disable-gpu", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = None
        for _ in range(60):
            try:
                pages = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=2).read())
                target = next(p["webSocketDebuggerUrl"] for p in pages if p["type"] == "page")
                break
            except Exception:
                await asyncio.sleep(0.5)
        async with websockets.connect(target, max_size=None) as ws:
            page = Page(ws)
            await page.send("Page.enable")
            await page.send("Runtime.enable")
            await page.send("Emulation.setDeviceMetricsOverride", width=WIDTH, height=HEIGHT, deviceScaleFactor=SCALE, mobile=False)
            stamp = int(time.time())

            if want("start"):
                await page.goto(f"{LIVE}/?c={stamp}#review")
                await page.shot("start")
            if want("result"):
                await page.goto(f"{LIVE}/?c={stamp}a#review/sample")
                await page.shot("result")
            if want("decide") or want("sure") or want("panel"):
                await page.goto(f"{LIVE}/?c={stamp}b#review/sample")
                # Only opens windows. The buttons that carry out a decision ("confirm-...") are never clicked.
                opened = await page.js("(() => { const b = [...document.querySelectorAll('.arow [data-r=decision]')].find((x) => x.textContent.trim() === 'Decide'); if (!b) return false; b.scrollIntoView({block: 'center'}); b.click(); return true; })()")
                await asyncio.sleep(1.2)
                if opened and want("decide"):
                    await page.shot("decide")
                    clip = await page.box(".modal-decide", 26)
                    if clip:
                        await page.shot("decide-window", clip)
                if opened and want("sure"):
                    await page.js("document.querySelector('[data-r=ask-reject]').click()")
                    await asyncio.sleep(0.9)
                    clip = await page.box(".modal-decide", 26)
                    if clip:
                        await page.shot("sure-window", clip)
                    await page.js("document.querySelector('[data-r=decision-back]').click()")
                    await asyncio.sleep(0.3)
                await page.js("document.querySelector('#modal-root [data-r=close-window]')?.click()")
                if want("panel"):
                    await page.js("window.scrollTo(0, 0); document.querySelector('.arow-main').click()")
                    await asyncio.sleep(6.5)                    # the hologram, if there is one, has moved in on the actuator by now
                    has = await page.js("!!document.querySelector('.drawer .holo canvas')")
                    print("  hologram in the side panel:", has)
                    clip = await page.box(".drawer")
                    await page.shot("panel", clip)
                    clip = await page.box(".drawer .holo") if has else None
                    if clip:
                        await page.shot("hologram", clip)
                    else:
                        print("  no hologram picture: it is not on the page, or has no size yet")
                    await page.js("document.querySelector('[data-r=close-drawer]')?.click()")
            if want("team"):
                await page.goto(f"{LIVE}/?replay=1&motion=1&c={stamp}c#review/sample", wait=1.0)
                started = time.time()
                for at in (7, 12, 17, 23, 29):
                    await asyncio.sleep(max(0, at - (time.time() - started)))
                    count = await page.js("document.querySelector('#team-count')?.textContent")
                    await page.shot(f"team-{at}")
                    print("   ", at, "s:", count)

            if want("missing") or want("outage"):
                try:
                    api(SANDBOX, "GET", "/api/health")
                except Exception:
                    print("  the separate copy on port 8795 is not running: skipping the two failure pictures")
                else:
                    if want("missing"):
                        batch = api(SANDBOX, "POST", "/api/batches/record", {"values": BOTH_MISSING})
                        review(SANDBOX, batch["id"])
                        await page.goto(f"{SANDBOX}/?c={stamp}d#review/{batch['id']}")
                        await page.shot("missing")
                    if want("outage"):
                        api(SANDBOX, "POST", "/api/demo/outage", {"enabled": True})
                        api(SANDBOX, "POST", "/api/batches/sample/reset")
                        review(SANDBOX, "sample")
                        await page.goto(f"{SANDBOX}/?c={stamp}e#review/sample")
                        await page.shot("outage")
                        await page.goto(f"{SANDBOX}/?replay=1&motion=1&c={stamp}f#review/sample", wait=1.0)
                        await page.js("document.querySelector('[data-r=replay]')?.click()")
                        await asyncio.sleep(9)
                        await page.shot("outage-team")
                        api(SANDBOX, "POST", "/api/demo/outage", {"enabled": False})
    finally:
        chrome.terminate()


if __name__ == "__main__":
    asyncio.run(main(set(sys.argv[1:])))
