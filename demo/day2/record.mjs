// Records the Day 2 demo video: a real browser session on a separate copy of the app, timed to the narration.
//
//   node demo/day2/record.mjs [--url http://127.0.0.1:8796] [--frames <folder>] [--out deliverables/day2]
//
// Before this: `prepare.py` (the three reviews in the recording copy) and `voice.mjs` (the narration audio).
// What it does: opens the dashboard in headless Chrome, plays the story scene by scene with real clicks, and
// records the screen. The subtitles, the scene caption, the highlight box and the pointer are drawn in the page
// itself while it is recorded, so they are part of the picture and need no second pass. Then ffmpeg joins the
// frames, lays the narration under them and writes demo.mp4, demo.srt and demo-narration.txt. No music.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const require = createRequire(join(ROOT, "demo", "work", "package.json"));
const puppeteer = require("puppeteer-core");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const BASE = arg("url", "http://127.0.0.1:8796").replace(/\/$/, "");
const FRAMES = resolve(arg("frames", join(HERE, "work", "frames")));
const OUT = resolve(arg("out", join(ROOT, "deliverables", "day2")));
const HF = join(HERE, "work", "hf");
const chrome = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find((p) => existsSync(p));
if (!chrome) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");

const story = JSON.parse(readFileSync(join(HERE, "narration.json"), "utf8"));
const audio = JSON.parse(readFileSync(join(HF, "audio_meta.json"), "utf8"));
const prepared = JSON.parse(readFileSync(join(HERE, "work", "prepared.json"), "utf8"));
const voice = Object.fromEntries(audio.voices.map((v) => [v.id, v]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- what is drawn over the page while it is recorded
function overlay() {
  const make = () => {
    if (document.getElementById("dm-style")) return;
    const style = document.createElement("style");
    style.id = "dm-style";
    style.textContent = `
      #dm-sub { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 99990; width: max-content; max-width: 1400px; padding: 12px 34px 16px; border-radius: 14px; background: rgba(10,12,16,0.94);
        color: #fff; font: 600 37px/1.24 "Segoe UI", system-ui, sans-serif; text-align: center; text-wrap: balance; box-shadow: 0 8px 30px rgba(0,0,0,0.4); transition: opacity 160ms; opacity: 0; pointer-events: none; }
      #dm-sub.is-top { bottom: auto; top: 128px; }
      #dm-cap { position: fixed; left: 50%; top: 62px; transform: translateX(-50%); z-index: 99990; padding: 9px 26px 11px; border-radius: 999px; background: #1e46c8; color: #fff;
        font: 650 25px/1.2 "Segoe UI", system-ui, sans-serif; white-space: nowrap; box-shadow: 0 6px 22px rgba(30,70,200,0.4); transition: opacity 250ms; opacity: 0; pointer-events: none; }
      #dm-ring { position: fixed; z-index: 99980; border: 4px solid #ffab1a; border-radius: 12px; box-shadow: 0 0 0 9999px rgba(8,10,16,0.36), 0 0 30px rgba(255,171,26,0.7); pointer-events: none; opacity: 0;
        transition: left 420ms cubic-bezier(0.2,0.8,0.2,1), top 420ms cubic-bezier(0.2,0.8,0.2,1), width 420ms cubic-bezier(0.2,0.8,0.2,1), height 420ms cubic-bezier(0.2,0.8,0.2,1), opacity 100ms; }
      #dm-tag { position: fixed; z-index: 99981; padding: 6px 15px 8px; border-radius: 8px; background: #ffab1a; color: #1c1400; font: 700 23px/1.2 "Segoe UI", system-ui, sans-serif; white-space: nowrap; pointer-events: none; opacity: 0;
        transition: left 420ms cubic-bezier(0.2,0.8,0.2,1), top 420ms cubic-bezier(0.2,0.8,0.2,1), opacity 100ms; }
      #dm-cur { position: fixed; z-index: 99995; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: rgba(30,70,200,0.92); border: 3px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.45);
        pointer-events: none; opacity: 0; left: 60%; top: 60%; transition: left 520ms cubic-bezier(0.2,0.8,0.2,1), top 520ms cubic-bezier(0.2,0.8,0.2,1), opacity 200ms; }
      #dm-cur.is-click { animation: dm-click 360ms ease-out; }
      @keyframes dm-click { 40% { transform: scale(2); box-shadow: 0 0 0 10px rgba(30,70,200,0.25); } }
      #dm-card { position: fixed; inset: 0; z-index: 99970; display: grid; place-items: center; background: #fafaf7; color: #16171b; opacity: 0; pointer-events: none; transition: opacity 420ms; font-family: "Segoe UI", system-ui, sans-serif; }
      #dm-card.is-on { opacity: 1; }
      #dm-card .in { width: 1180px; }
      #dm-card .brand { display: flex; align-items: center; gap: 14px; font: 650 30px/1 "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: -0.02em; }
      #dm-card .brand i { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 10px; background: #16171b; }
      #dm-card h1 { margin: 34px 0 0; font: 600 72px/1.08 "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: -0.03em; }
      #dm-card p { margin: 26px 0 0; font-size: 25px; line-height: 1.45; color: #494c54; max-width: 980px; }
      #dm-card .rule { margin-top: 40px; padding-top: 18px; border-top: 1px solid #16171b; font-size: 19px; color: #80838b; }
      #dm-card .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 34px; margin-top: 40px; }
      #dm-card .facts b { display: block; font: 650 56px/1 "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: -0.03em; }
      #dm-card .facts span { display: block; margin-top: 8px; font-size: 19px; line-height: 1.35; color: #494c54; }
      #dm-card code { padding: 3px 10px; border-radius: 6px; background: #f2f2ed; font: 600 23px "Cascadia Mono", Consolas, monospace; color: #16171b; }
      #dm-card .run { margin-top: 36px; font-size: 23px; line-height: 1.9; color: #494c54; }
      #dm-card .run b { color: #1e46c8; font-weight: 650; }`;
    document.documentElement.append(style);
    for (const id of ["dm-card", "dm-ring", "dm-tag", "dm-sub", "dm-cap", "dm-cur"]) { const el = document.createElement("div"); el.id = id; document.documentElement.append(el); }
  };
  const $ = (id) => { make(); return document.getElementById(id); };
  const place = (rect, label, pad = 8) => {
    const ring = $("dm-ring"), tag = $("dm-tag");
    const sub = $("dm-sub");
    if (!rect) { ring.style.opacity = "0"; tag.style.opacity = "0"; sub.classList.remove("is-top"); return false; }
    // A box that was hidden appears where it belongs at once; only a box that is on screen slides to its next place.
    const fresh = ring.style.opacity !== "1";
    if (fresh) { ring.style.transition = "none"; tag.style.transition = "none"; }
    const floor = innerHeight - 150;                             // the subtitles sit below this line
    const x = Math.max(4, rect.left - pad), y = Math.max(4, rect.top - pad), w = Math.min(innerWidth - x - 4, rect.width + pad * 2);
    let h = Math.min(innerHeight - y - 4, rect.height + pad * 2), top = false;
    if (y + h > floor) { if (y < 300 && floor - y > 160) h = floor - y; else top = true; }      // a tall box stops above the subtitles; for a small thing at the bottom the subtitles move up
    sub.classList.toggle("is-top", top);
    Object.assign(ring.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    if (label) {
      tag.textContent = label;
      const above = y > (top ? 270 : 170);
      Object.assign(tag.style, { left: `${Math.max(8, Math.min(x, innerWidth - tag.offsetWidth - 8))}px`, top: `${above ? y - 46 : Math.min(y + h + 10, innerHeight - 50)}px` });
    }
    if (fresh) { void ring.offsetWidth; ring.style.transition = ""; tag.style.transition = ""; }
    ring.style.opacity = "1";
    tag.style.opacity = label ? "1" : "0";
    return true;
  };
  const union = (els) => {
    const rs = els.filter(Boolean).map((el) => el.getBoundingClientRect());
    if (!rs.length) return null;
    const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top));
    return { left, top, width: Math.max(...rs.map((r) => r.right)) - left, height: Math.max(...rs.map((r) => r.bottom)) - top };
  };
  const zone = (name) => {                                    // a part of the team screen's picture, from its drawing grid (1120 by 566)
    const canvas = document.getElementById("team-canvas");
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect(), g = { fleet: [16, 252, 454, 290], list: [488, 252, 226, 290], store: [728, 252, 156, 130], depot: [904, 252, 200, 170] }[name];
    return g ? { left: r.left + g[0] / 1120 * r.width, top: r.top + g[1] / 566 * r.height, width: g[2] / 1120 * r.width, height: g[3] / 566 * r.height } : null;
  };
  window.__dm = {
    // On hiding, the old words stay while the pill fades, so an empty pill is never on screen.
    sub(text) { const el = $("dm-sub"); if (text) el.textContent = text; el.style.opacity = text ? "1" : "0"; },
    cap(text) { const el = $("dm-cap"); if (text) el.textContent = text; el.style.opacity = text ? "1" : "0"; },
    ring(selector, label, pad, index = 0) { const el = typeof selector === "string" ? document.querySelectorAll(selector)[index] : selector; return place(el ? el.getBoundingClientRect() : null, label, pad); },
    zone(name, label) { return place(zone(name), label, 4); },
    ringAll(selectors, label, pad) { return place(union(selectors.map((s) => document.querySelector(s))), label, pad); },
    off() { place(null); },
    // A slow punch-in so a small thing can be read: a window grows where it is, the page grows around the thing.
    zoom(selector, scale = 1.4, index = 0) {
      const el = document.querySelectorAll(selector)[index];
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, b = document.body;
      b.style.transition = "transform 1100ms cubic-bezier(0.3,0.7,0.2,1)";
      b.style.transformOrigin = `${cx + scrollX}px ${cy + scrollY}px`;
      b.style.transform = `translate(${(innerWidth / 2 - cx) * 0.45}px, ${(innerHeight * 0.45 - cy) * 0.4}px) scale(${scale})`;
      return true;
    },
    zoomEl(selector, scale = 1.3) {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.style.transition = "transform 900ms cubic-bezier(0.3,0.7,0.2,1)";
      el.style.transformOrigin = "50% 50%";
      el.style.transform = `scale(${scale})`;
      return true;
    },
    zoomOff() { const b = document.body; b.style.transition = "transform 500ms ease"; b.style.transform = "none"; },
    cur(selector, index = 0) {
      const el = document.querySelectorAll(selector)[index], c = $("dm-cur");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      Object.assign(c.style, { left: `${r.left + Math.min(r.width / 2, 140)}px`, top: `${r.top + r.height / 2}px`, opacity: "1" });
      return true;
    },
    click() { const c = $("dm-cur"); c.classList.remove("is-click"); void c.offsetWidth; c.classList.add("is-click"); },
    curOff() { $("dm-cur").style.opacity = "0"; },
    card(html) { const el = $("dm-card"); el.innerHTML = `<div class="in">${html}</div>`; el.classList.add("is-on"); },
    cardOff() { $("dm-card").classList.remove("is-on"); },
    // Where the team screen stands: the kind of the message being played, its tool, and the member that is working.
    team() {
      const now = document.querySelector("#team-talk li.is-now");
      const kind = now ? [...now.classList].find((c) => c.startsWith("msg-") && c !== "msg-typing")?.slice(4) : null;
      const count = document.getElementById("team-count")?.textContent || "";
      return { kind, tool: now?.querySelector("code")?.textContent || null, count, here: !!document.getElementById("team-canvas") };
    },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make); else make();
}

const MARK = '<i><svg width="30" height="30" viewBox="0 0 32 32"><path d="M16 7v12M16 12l6 5" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"/><circle cx="16" cy="23" r="3.6" fill="none" stroke="#fff" stroke-width="2.6"/></svg></i>';
const TITLE = `<div class="brand">${MARK}<span>AcuMain</span></div>
  <h1>Which aircraft get this week's hangar slots?</h1>
  <p>Actuator failures arrive as surprise groundings. AcuMain turns failure predictions into an action list that a person reviews and approves.</p>
  <div class="rule">AI for Smart Maintenance Hackathon · Case 1: Boeing 787 nose landing gear actuator · Team Maze, Al Ain University</div>`;
const END = `<div class="brand">${MARK}<span>AcuMain</span></div>
  <div class="facts">
    <div><b>185 of 187</b><span>failures flagged in their final 30 days, typically 5 weeks ahead</span></div>
    <div><b>0.709</b><span>F1 on aircraft the model never saw</span></div>
    <div><b>91%</b><span>of failures become planned repairs with 2 hangar slots a week (replay of the training fleet)</span></div>
  </div>
  <div class="run">Run it: <code>docker compose up --build</code> then <b>http://localhost:8787</b><br>Public replay: <b>acumain.vercel.app</b></div>
  <div class="rule">A person approves every action. Work orders, spare-parts stock and the supply department are simulated. · Team Maze, Al Ain University</div>`;

// ---------------------------------------------------------------- recording
mkdirSync(FRAMES, { recursive: true });
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--window-size=1600,900", "--hide-scrollbars", "--force-device-scale-factor=1.2", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.2 });
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
await page.evaluateOnNewDocument(overlay);
page.on("pageerror", (err) => console.log("  page error:", err.message));
const dm = (fn, ...args) => page.evaluate((f, a) => window.__dm[f](...a), fn, args).catch((err) => { console.log(`  (${fn} failed: ${err.message.split("\n")[0]})`); return null; });
const exists = (selector) => page.evaluate((s) => !!document.querySelector(s), selector);
const waitFor = async (selector, ms = 8000) => { try { await page.waitForSelector(selector, { timeout: ms }); return true; } catch { console.log(`  (never appeared: ${selector})`); return false; } };
// Move the pointer to something, show the click, then click it for real.
async function press(selector, index = 0, pause = 620) {
  if (!(await dm("cur", selector, index))) { console.log(`  (nothing to click: ${selector})`); return false; }
  await sleep(pause);
  await dm("click");
  await sleep(160);
  await dm("off");                                                    // the highlight goes before the page changes under it
  await sleep(120);
  await page.evaluate((s, i) => document.querySelectorAll(s)[i]?.click(), selector, index);
  return true;
}

await page.goto(`${BASE}/?motion=1#review`, { waitUntil: "networkidle0" });
await waitFor(".source-main");
await dm("card", TITLE);
await sleep(700);

const frames = [];
const cdp = await page.createCDPSession();
let writing = Promise.resolve();
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  const name = `f${String(frames.length).padStart(6, "0")}.jpg`;
  frames.push({ name, t: metadata.timestamp });
  writing = writing.then(() => writeFile(join(FRAMES, name), Buffer.from(data, "base64")));
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 86, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 2 });
const T0 = Date.now() / 1000;
const marks = [], cues = [];

// Waiting for the app is left out of the video: what happens inside cut() is not shown, and the clock of the video stands still.
const cuts = [];
let cutTotal = 0, cutStart = null, onCut = null;
const wall = () => Date.now() / 1000 - T0;
const clock = () => (cutStart ?? wall()) - cutTotal;
async function cut(wait) {
  cutStart = wall();
  onCut?.(false);
  try { await wait(); } catch (err) { console.log(`  (while waiting: ${err.message.split("\n")[0]})`); }
  await sleep(150);
  const end = wall();
  cuts.push({ from: cutStart, to: end });
  console.log(`  cut ${(end - cutStart).toFixed(1)} s of waiting`);
  cutTotal += end - cutStart;
  cutStart = null;
  onCut?.(true);
}

// One scene: its caption, its subtitles spread over the length of its narration, and what happens on screen.
async function beat(id, act) {
  const b = story.beats.find((x) => x.id === id), length = voice[id].duration_s, start = clock() + 0.25;
  marks.push({ id, start });
  console.log(`${id} at ${start.toFixed(1)} s (${length.toFixed(1)} s of narration)`);
  await dm("cap", b.caption);
  const total = b.cues.reduce((sum, c) => sum + c.length, 0);
  let at = 0, timers = [];
  const plan = b.cues.map((text) => {
    const from = start + length * at / total;
    at += text.length;
    const c = { from, to: start + length * at / total, text };
    cues.push(c);
    return c;
  });
  const schedule = (on) => {
    timers.forEach(clearTimeout);
    timers = on ? plan.filter((c) => c.to > clock()).map((c) => setTimeout(() => dm("sub", c.text), Math.max(0, (c.from - clock()) * 1000))) : [];
  };
  schedule(true);
  onCut = schedule;
  const began = clock();
  const elapsed = () => (clock() - began) * 1000;
  const left = () => length * 1000 + 320 - elapsed();                    // what is left of this scene's narration
  const until = async (ms) => { while (elapsed() < ms) await sleep(Math.min(150, Math.max(10, ms - elapsed()))); };
  try { await act({ left, at: until }); } catch (err) { console.log(`  scene ${id} stumbled: ${err.message.split("\n")[0]}`); }
  if (left() > 0) await sleep(left());
  onCut = null;
  timers.forEach(clearTimeout);
  await dm("sub", "");
}

// 1. title
await beat("b1", async () => {});
await dm("cardOff");
await sleep(320);

// 2. the start page
await beat("b2", async ({ at }) => {
  await dm("ring", ".source-main", "Start here: the sample fleet file", 10);
  await at(2600);
  await dm("cur", ".source-cta");
});
await press(".source-cta", 0, 500);
await dm("off");
await dm("curOff");
await waitFor("#team-canvas");

// 3. the team at work: the highlight follows the message that is being played
await beat("b3", async ({ left }) => {
  const RING = {
    check_records: ["zone", "fleet", "The records are checked"], run_failure_model: ["ring", ".node-model", "Our trained Stage 2 failure model"], list_records: ["zone", "fleet", "Every aircraft has a risk now"],
    propose_actions: ["zone", "list", "The 25 most urgent"], check_stock: ["zone", "store", "Spare actuators in the hangar store (simulated)"], reserve_parts: ["zone", "store", "Parts set aside for the most urgent"],
    get_supply_options: ["zone", "depot", "Where more parts can come from (simulated)"], request_parts: ["zone", "depot", "A parts request with delivery times"],
  };
  let fast = false, paused = false, last = "", sinceModel = 0;
  while (left() > 250) {
    const s = await dm("team");
    if (!s || !s.here) break;
    const [done, all] = s.count.split(" of ").map((x) => parseInt(x, 10));
    const key = `${s.kind}:${s.tool}`;
    if (key !== last) {
      last = key;
      if (s.tool === "run_failure_model") sinceModel = Date.now();
      if (s.kind === "start") await dm("ring", ".node-lead", "The planner asks for a review", 8);
      else if (s.kind === "ask") await dm("ring", ".node.is-working:not(.node-lead):not(.node-you)", "The orchestrator hands over the task", 8);
      else if (s.kind === "tool" && RING[s.tool]) await dm(RING[s.tool][0], RING[s.tool][1], RING[s.tool][2], 8);
      else if (s.kind === "report") await dm("ring", ".node-lead", "The report goes back to the orchestrator", 8);
      else if (s.kind === "final") await dm("ring", ".node-you", "The summary goes to the planner", 8);
    }
    if (s.tool === "run_failure_model" && sinceModel && Date.now() - sinceModel > 2600) { sinceModel = 0; await dm("zone", "fleet", "Red: likely to fail within 30 days"); }
    if (!fast && done >= 3) { fast = true; await page.evaluate(() => document.querySelector('[data-team="rate"]')?.click()); }             // the first messages at normal speed, the rest at double
    if (!paused && all && done >= all - 1) { paused = true; await page.evaluate(() => document.querySelector('[data-team="pause"]')?.click()); }   // hold before the summary
    await sleep(220);
  }
});
// the summary to the planner, then the result
await page.evaluate(() => document.querySelector('[data-team="step"]')?.click());
await dm("ring", ".node-you", "The summary goes to the planner", 8);
await sleep(1100);
await dm("off");
await page.evaluate(() => document.querySelector('[data-team="skip"]')?.click());
await waitFor(".arow");
await sleep(500);

// Wait until no review of this file is running any more (and at least `least` reviews of it exist).
async function reviewsDone(batchId, least = 1, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const runs = await page.evaluate(async (id) => (await (await fetch("/api/agent/runs")).json()).filter((r) => r.batch_id === id && r.kind === "review").map((r) => r.status), batchId).catch(() => []);
    if (runs.length >= least && !runs.includes("running")) return true;
    await sleep(250);
  }
  console.log(`  (the review of ${batchId} did not finish in time)`);
  return false;
}
const batchInAddress = async () => { await page.waitForFunction(() => location.hash.split("/")[1], { timeout: 8000 }).catch(() => {}); return page.evaluate(() => location.hash.split("/")[1] || ""); };
// Stay on the team screen until the review has ended (at least `least` reviews of the file, none running), then go to the result.
async function teamUntilDone(batchId, least = 1, minMs = 1700, maxMs = 90000) {       // a review by Claude takes up to about 45 s; the wait is cut from the video
  const began = Date.now();
  while (Date.now() - began < maxMs) {
    if (!(await exists('[data-team="skip"]'))) break;               // the team screen went on to the result by itself
    const runs = await page.evaluate(async (id) => (await (await fetch("/api/agent/runs")).json()).filter((r) => r.batch_id === id && r.kind === "review").map((r) => r.status), batchId).catch(() => []);
    if (runs.length >= least && !runs.includes("running") && Date.now() - began >= minMs) break;
    await sleep(150);
  }
  await dm("off");
  await page.evaluate(() => document.querySelector('[data-team="skip"]')?.click());
}
const bring = async (selector) => { await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), selector); await sleep(260); };
// A punch-in on a small thing, then the highlight on it.
async function punch(selector, scale, label, pad = 8, index = 0) {
  await dm("off");
  await sleep(130);                                                   // the old highlight is gone before the page moves
  await dm("zoom", selector, scale, index);
  await sleep(1200);
  await dm("ring", selector, label, pad, index);
}
const unpunch = async () => { await dm("off"); await dm("zoomOff"); await sleep(520); };

// 4. the result
await beat("b4", async ({ at }) => {
  await dm("ring", "#head h1", "What the failure model found", 10);
  await at(4000);
  await dm("ring", ".alist", "Each action with its reason and its spare part", 6);
  await at(8000);
  await dm("ring", ".request", "The parts request: some parts would arrive late", 6);
});
await dm("off");

// 5. one aircraft and its hologram
await beat("b5", async ({ at }) => {
  await press(".arow-main", 0, 480);
  await dm("curOff");
  await waitFor(".drawer [data-holo] canvas");
  await sleep(350);
  await dm("ring", ".drawer [data-holo]", "Hologram of this aircraft's nose gear actuator", 6);
  await at(4700);
  await dm("off");
  await press('.drawer [data-r="holo-big"]', 0, 400);
  await dm("curOff");
  await waitFor(".modal-holo canvas");
  await at(8000);
  await dm("ring", ".modal-holo canvas", "Leak at the seal. Dashed: how fast a new actuator swings", 2);
});
await dm("off");
await page.evaluate(() => document.querySelector('.modal-holo [data-r="close-window"]')?.click());
await sleep(250);
await page.evaluate(() => document.querySelector('[data-r="close-drawer"]')?.click());
await sleep(450);

// 6. the person decides
await beat("b6", async ({ at }) => {
  await press('.arow [data-r="decision"]', 0, 460);
  await dm("curOff");
  await waitFor(".modal-decide");
  await dm("zoomEl", ".modal-decide", 1.3);
  await sleep(950);
  await dm("ring", ".modal-decide .decide-facts", "Risk, why, spare part", 6);
  await at(3500);
  await dm("ringAll", ['.modal-decide [data-r="confirm-approve"]', '.modal-decide [data-r="ask-reject"]'], "Approve or Reject: the planner's call", 8);
  await at(4900);
  await dm("off");
  await press('.modal-decide [data-r="confirm-approve"]', 0, 420);
  await dm("curOff");
  await at(6000);
  await dm("ring", ".arow .arow-act", "Approved: a simulated work order", 6);
  await at(7700);
  await dm("off");
  await press(".arow .btn[data-r='decision']", 0, 400);             // the first row is decided now, so this is the next one that still waits
  await waitFor(".modal-decide");
  await dm("zoomEl", ".modal-decide", 1.3);
  await sleep(500);
  await press('.modal-decide [data-r="ask-reject"]', 0, 400);
  await dm("curOff");
  await sleep(250);
  await dm("zoomEl", ".modal-decide", 1.3);
  await sleep(350);
  await dm("ring", ".modal-decide", "Reject asks first: are you sure?", 6);
  await at(11400);
  await dm("off");
  await press('.modal-decide [data-r="confirm-reject"]', 0, 400);
  await dm("curOff");
  await sleep(600);
  await dm("ring", ".arow .link-change", "Change: any decision can be changed", 8, 1);
  await at(13300);
});
await dm("off");
await dm("curOff");

// 7. a blank reading: the form, the same team, the result marked "reduced confidence"
await page.evaluate(() => { location.hash = "#review"; });
await waitFor('[data-r="check-one"]');
await sleep(350);
await beat("b7", async ({ at }) => {
  await press('[data-r="check-one"]', 0, 420);
  await waitFor(".modal-check");
  await sleep(250);
  await press('[data-c="example"][data-key="missing"]', 0, 420);
  await dm("curOff");
  await sleep(250);
  await page.evaluate(() => document.querySelector('[data-c-field="Internal_Leakage_Rate_mL_Min"]')?.scrollIntoView({ block: "center" }));
  await dm("ring", '[data-c-field="Internal_Leakage_Rate_mL_Min"]', "The leakage reading is blank", 8);
  await at(3900);
  await dm("off");
  await press("[data-c-form=check] button[type=submit]", 0, 420);
  await dm("curOff");
  await cut(async () => {
    const id = await batchInAddress();
    await waitFor('[data-team="skip"]');
    await teamUntilDone(id, 1, 0);
    await waitFor(".confidence", 12000);
    await sleep(350);
  });
  await dm("ring", "#head h1", "Still predicted, with one reading blank", 10);
  await sleep(2000);
  await punch(".confidence", 1.45, "Marked: reduced confidence", 8);
  await sleep(2100);
});
await unpunch();

// 7b. both key readings blank: no prediction, a repeat test
await page.evaluate((id) => { location.hash = `#review/${id}`; }, prepared.none);
await waitFor('[data-view="result"] #head h1, [data-view="result"] h1');
await sleep(350);
await beat("b7b", async ({ at }) => {
  await dm("ring", "#head h1", "Both key readings blank: no prediction", 10);
  await at(2900);
  if (!(await dm("ring", ".arow", "The team proposes a repeat test", 6))) await dm("ring", ".callout-warn", "The team proposes a repeat test", 6);
  await at(5600);
});
await dm("off");

// 8. the failure model does not answer
await beat("b8", async () => {
  await press("#demo-menu summary", 0, 360);
  await sleep(250);
  await dm("ring", "#demo-menu label.switch", "Demo: switch the failure model off", 6);
  await sleep(400);
  await press('#demo-menu [data-action="toggle-outage"]', 0, 360);
  await dm("curOff");
  await sleep(750);
  await dm("off");
  await page.evaluate(() => { const m = document.querySelector("#demo-menu"); if (m) m.open = false; });
  await page.evaluate((id) => { location.hash = `#review/${id}`; }, prepared.retry);
  await waitFor('[data-view="ready"] [data-r="review"]');
  await sleep(450);
  await dm("ring", '[data-view="ready"] [data-r="review"]', "Start the review", 8);
  await press('[data-view="ready"] [data-r="review"]', 0, 700);
  await dm("off");
  await dm("curOff");
  await waitFor('[data-team="skip"]');
  await sleep(300);
  await dm("ring", ".node-model", "The failure model does not answer", 8);
  await sleep(1300);
  await dm("off");
  await cut(async () => {
    await teamUntilDone(prepared.retry, 1, 0);
    await waitFor('[data-view="failed"] h1', 12000);
    await sleep(350);
  });
  await dm("ring", '[data-view="failed"] h1', "The review stopped", 10);
  await sleep(1500);
  await dm("off");
  await bring(".tl-row.is-bad");
  await dm("ring", ".tl-row.is-bad", "The model call failed. Nothing proposed, nothing invented", 6);
  await sleep(1900);
});
await dm("off");

// 8b. the model is back: try again, and the review completes
await beat("b8b", async () => {
  await dm("off");
  await bring('[data-view="failed"] [data-action="outage-off"]');
  await dm("ring", '[data-view="failed"] [data-action="outage-off"]', "Switch the failure model back on", 8);
  await press('[data-view="failed"] [data-action="outage-off"]', 0, 650);
  await dm("off");
  await dm("curOff");
  await sleep(350);
  await punch('[data-view="failed"] [data-r="review"]', 1.45, "Try again", 8);
  await sleep(1700);
  await unpunch();
  await dm("ring", '[data-view="failed"] [data-r="review"]', "Try again", 8);
  await press('[data-view="failed"] [data-r="review"]', 0, 520);
  await dm("off");
  await dm("curOff");
  await cut(async () => {
    await waitFor('[data-team="skip"]');
    await teamUntilDone(prepared.retry, 2, 0);
    await waitFor(".confidence", 12000);
    await sleep(350);
  });
  await dm("ring", "#head h1", "Recovered: the review completed", 10);
  await sleep(2000);
});
await dm("off");

// 9. the record
await beat("b9", async ({ at }) => {
  await page.evaluate(() => { location.hash = "#log"; });
  await waitFor('[data-p="run"]');
  await sleep(300);
  await page.evaluate((id) => (document.querySelector(`[data-p="run"][data-id="${id}"]`) || document.querySelector('[data-p="run"]'))?.click(), prepared.fleet_run);
  await waitFor(".run-detail .tl-more", 5000);
  await page.evaluate(() => {
    const all = [...document.querySelectorAll(".run-detail .tl-row.tl-tool")], row = all.find((r) => r.querySelector(".tl-meta code")?.textContent === "run_failure_model") || all[2];
    const more = row?.querySelector("details.tl-more");
    if (more) more.open = true;
    row?.scrollIntoView({ block: "center" });
  });
  await sleep(400);
  await punch(".run-detail details[open]", 1.22, "The model call: exact input and output", 6);
  await at(6000);
  await unpunch();
  await cut(async () => {                                              // the page change is not shown: no "Loading" frame
    await page.evaluate(() => { location.hash = "#orders"; });
    await waitFor("table tbody tr");
    await sleep(350);
  });
  await dm("ring", "table tbody tr", "A work order exists only after an approval (simulated)", 6);
  await at(9300);
});
await dm("off");

// 10. the end card
await dm("card", END);
await dm("cap", "");
await sleep(400);
await beat("b10", async () => {});
await sleep(900);

await cdp.send("Page.stopScreencast");
await sleep(300);
await writing;
await browser.close();
const length = clock();
console.log(`recorded ${frames.length} frames over ${length.toFixed(1)} s (${(frames.length / length).toFixed(1)} a second)`);

// ---------------------------------------------------------------- joining it up
// Frames from a stretch that was cut are dropped, except the last one of each stretch, which is shown at the join.
const kept = [];
for (const f of frames) {
  const w = f.t - T0, inside = cuts.find((c) => w >= c.from && w < c.to), before = cuts.filter((c) => c.to <= w).reduce((sum, c) => sum + c.to - c.from, 0);
  if (!inside) { kept.push({ name: f.name, v: w - before }); continue; }
  const v = inside.from - before, last = kept[kept.length - 1];
  if (last && last.join === inside) last.name = f.name; else kept.push({ name: f.name, v, join: inside });
}
const offset = kept[0].v;                                              // the picture starts at the first frame, a moment after the clock started
const list = kept.map((f, i) => `file '${f.name}'\nduration ${Math.max(0.001, (i + 1 < kept.length ? kept[i + 1].v : f.v + 0.6) - f.v).toFixed(4)}`).join("\n") + `\nfile '${kept[kept.length - 1].name}'\n`;
writeFileSync(join(FRAMES, "frames.txt"), list);
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] }); if (r.status !== 0) throw new Error(`${cmd} failed`); };
const silent = join(FRAMES, "silent.mp4");
run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(FRAMES, "frames.txt"), "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "19", silent]);
const inputs = [], filters = [];
marks.forEach((m, i) => {
  inputs.push("-i", join(HF, voice[m.id].path));
  filters.push(`[${i + 1}:a]aresample=48000,adelay=${Math.round(Math.max(0, m.start - offset) * 1000)}:all=1[a${i}]`);
});
filters.push(`${marks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${marks.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95,apad[a]`);
const out = join(OUT, "demo.mp4");
run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", silent, ...inputs, "-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out]);      // the sound is padded below, so the picture sets the length
const stamp = (s) => { const t = Math.max(0, s - offset), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = Math.floor(t) % 60, ms = Math.round((t - Math.floor(t)) * 1000); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`; };
writeFileSync(join(OUT, "demo.srt"), cues.map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(c.to)}\n${c.text}\n`).join("\n"));
writeFileSync(join(OUT, "demo-narration.txt"), story.beats.map((b) => b.cues.join(" ")).join("\n\n") + "\n");
writeFileSync(join(HERE, "work", "timeline.json"), JSON.stringify({ length, offset, marks, cues }, null, 1));
console.log(`wrote ${out}`);
