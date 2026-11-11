// The team at work, in one picture with two layers that move together.
//
//   Above: who is talking to whom. The planner, the orchestrator, the three specialists and the failure model are
//   connected, and every real message of the run travels along the wire between its sender and its receiver:
//   a hand-over, a tool call going to a system, the answer coming back, a report.
//   Below: what those messages do to the planner's own fleet. Every aircraft is a dot. The failure model colours and
//   ranks them, the most urgent move onto this week's list, spare parts come off the shelf, missing ones are requested.
//
// Nothing is scripted: each message is read from the run's log, and each dot is a record of the file. So the same
// screen follows a live run and replays a finished one, where it can be paused, stepped, sped up and jumped through.
import { $, $$, esc, fmtInt, fmtRisk, icon, plural } from "./ui.js";
import { AGENTS, describe, firstSentences, partLine, seconds } from "./steps.js";
import { state } from "./main.js";

const W = 1120, H = 566;                                       // drawn on this grid, then scaled to fit
const FLEET = { x: 24, y: 282, w: 438, h: 250 };
const LIST = { x: 496, y: 282, w: 210, h: 250 };
const STORE = { x: 736, y: 308, w: 140, per: 7 };
const DEPOT = { x: 912, y: 308, w: 184, per: 9 };
const RULE = 271;                                              // the rule under each zone's name
const ZIN = 240;                                               // where a wire enters a zone
const AT = { you: [560, 24], lead: [560, 96], model: [120, 168], risk: [360, 168], stock: [806, 168], supply: [1004, 168] };
// The wiring, from the middle of one member to the middle of the next or down into a zone. A message travels along
// its wire as an arrow; an answer travels the same wire the other way.
const ROUTE = {
  "lead>you": [[560, 96], [560, 24]],
  "lead>risk": [[560, 96], [360, 96], [360, 168]],
  "lead>stock": [[560, 96], [806, 96], [806, 168]],
  "lead>supply": [[560, 96], [1004, 96], [1004, 168]],
  "risk>model": [[360, 168], [120, 168]],
  "model>fleet": [[120, 168], [120, ZIN]],
  "risk>fleet": [[322, 168], [322, ZIN]],
  "risk>list": [[398, 168], [398, 222], [601, 222], [601, ZIN]],
  "stock>store": [[806, 168], [806, ZIN]],
  "supply>depot": [[1004, 168], [1004, ZIN]],
};
// Where the label of a travelling message sits next to its wire: x, y, and whether it is centred, left or right of that point.
const TAG = { "lead>you": [574, 59, "l"], "lead>risk": [412, 81, "c"], "lead>stock": [731, 81, "c"], "lead>supply": [906, 81, "c"], "risk>model": [240, 128, "c"],
  "model>fleet": [133, 220, "l"], "risk>fleet": [335, 208, "l"], "risk>list": [500, 209, "c"], "stock>store": [819, 220, "l"], "supply>depot": [991, 220, "r"] };
const WHO = { you: "You", lead: "Orchestrator", risk: "Risk agent", stock: "Stock agent", supply: "Supply agent", model: "Failure model",
  fleet: "Records", list: "Action list", store: "Hangar store", depot: "Supply department", sys: "Note" };
// Which system each tool talks to, and along which wire.
const TOOL = {
  check_records: ["fleet", "risk>fleet"], run_failure_model: ["model", "risk>model"], list_records: ["fleet", "risk>fleet"],
  get_record: ["fleet", "risk>fleet"], get_model_track_record: ["model", "risk>model"], propose_actions: ["list", "risk>list"],
  check_stock: ["store", "stock>store"], reserve_parts: ["store", "stock>store"], get_supply_options: ["depot", "supply>depot"], request_parts: ["depot", "supply>depot"],
};
const DOING = { check_records: "Checking records", run_failure_model: "Calling the model", list_records: "Reading results", get_record: "Reading a record",
  get_model_track_record: "Its track record", propose_actions: "Filing actions", check_stock: "Checking the store", reserve_parts: "Reserving parts",
  get_supply_options: "Finding a source", request_parts: "Drafting a request" };
// A source of spare parts, short enough for the picture.
const SOURCE = (name) => (/warehouse/i.test(name) ? "Warehouse" : /supplier/i.test(name) ? "Supplier" : /backorder/i.test(name) ? "Backorder" : String(name || ""));
const MAX_DOTS = 2400;
const COLOR = { ink: [22, 23, 27], high: [189, 46, 26], medium: [217, 148, 37], low: [201, 202, 205], idle: [126, 129, 137], accent: [30, 70, 200], line: [205, 204, 197] };
// One quiet colour per member, used for its messages on the wires, in the caption and in the conversation.
const HUE = { you: COLOR.ink, lead: COLOR.ink, risk: [112, 72, 190], stock: [14, 124, 102], supply: COLOR.accent, sys: [73, 76, 84] };
const LEVEL = { High: "high", Medium: "medium", Low: "low", "Not scored": "none" };
const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const pc = (x) => `${(x / W * 100).toFixed(2)}%`;
const pv = (y) => `${(y / H * 100).toFixed(2)}%`;
const chip = (id) => `<b class="who who-${AGENTS[id] || id === "you" ? id : "sys"}">${WHO[id]}</b>`;
const arrow = `<i class="to">${icon("arrow")}</i>`;

// ---------------------------------------------------------------- the frame
// `preview` gives the picture and its caption only, with no controls: the landing page plays it as a loop.
export function teamView(run, batch, replay, preview = false) {
  const scope = run.context?.record_ids?.length;
  const what = scope ? plural(scope, "selected record") : plural(batch.records, "record");
  const node = (id, sub) => `<button type="button" class="node node-${id} is-idle" data-node="${id}" style="left:${pc(AT[id][0])};top:${pv(AT[id][1])}">
      <span class="node-name"><i class="node-state"></i>${WHO[id]}</span><span class="node-line">${sub}</span></button>`;
  const zone = (z, name, id, sub) => `<div class="zone" style="left:${pc(z.x)};bottom:${pv(H - RULE + 5)}"><b>${name}</b>${sub === null ? "" : `<span id="${id}">${sub}</span>`}</div>`;
  const stage = () => `<div class="stage-scroll"><div class="stage" id="team-stage">
          <canvas id="team-canvas" width="${W}" height="${H}"></canvas>
          ${node("you", "The planner")}${node("lead", "Hands out the work")}${node("model", "Stage 2 model")}
          ${node("risk", "Records and risk")}${node("stock", "Spare-parts store")}${node("supply", "Missing parts")}
          ${zone(FLEET, batch.records === 1 && !scope ? "The aircraft" : "The fleet", "z-fleet", `${fmtInt(scope || batch.records)} aircraft`)}
          ${zone(LIST, "This week's list", "z-list", `up to ${fmtInt(run.context?.list_size || 25)}`)}
          ${zone(STORE, "Hangar store", "", null)}${zone(DEPOT, "Supply department", "", null)}
          <div class="zone zone-sub" id="z-store" style="left:${pc(STORE.x)};top:${pv(RULE + 6)};width:${pc(STORE.w)}">simulated</div>
          <div class="zone zone-sub" id="z-supply" style="left:${pc(DEPOT.x)};top:${pv(RULE + 6)};width:${pc(DEPOT.w)}">simulated</div>
          <div id="z-lines"></div>
          <div class="zone zone-legend" id="z-legend" style="left:${pc(FLEET.x)};top:${pv(H - 24)}"></div>
          <div class="zone zone-legend" style="left:${pc(LIST.x)};top:${pv(H - 24)}"><i class="k-store"></i>Part in the store<i class="k-sent"></i>Requested, in time<i class="k-late"></i>Late or no part</div>
          <div class="wire-tag" id="team-tag" hidden></div>
          <div class="dot-tip" id="team-tip" hidden></div>
        </div></div>`;
  if (preview) {
    return `<p class="team-caption" id="team-caption" aria-live="off"><span class="route">${chip("lead")}</span><span class="say">Getting the team ready.</span></p>${stage()}`;
  }
  return `
    <p class="kicker">${esc(batch.name)}${replay ? " · replay of the last review" : ""}</p>
    <div class="team-head">
      <h1 class="display display-sm">${replay ? "How the team reviewed" : "The team is reviewing"} ${what}${replay ? "" : '<span class="dots"></span>'}</h1>
      <button type="button" class="btn" data-team="skip">Skip to the result${icon("arrow")}</button>
    </div>
    <p class="team-caption" id="team-caption" aria-live="polite"><span class="route">${chip("lead")}</span><span class="say">Getting the team ready.</span></p>
    <div class="team-grid">
      <div class="team-main">
        ${stage()}
        <div class="transport" role="group" aria-label="Playback">
          <button type="button" class="btn btn-sm" data-team="pause">${icon("pause")}<span>Pause</span></button>
          ${replay ? `<button type="button" class="icon-btn" data-team="back" aria-label="Previous message" data-tip="Previous message">${icon("chevron", "flip")}</button>` : ""}
          <button type="button" class="icon-btn" data-team="step" aria-label="Next message" data-tip="Next message|Plays one message, then waits" disabled>${icon("chevron")}</button>
          <button type="button" class="btn btn-sm btn-rate" data-team="rate" data-tip="Speed">1×</button>
          <ol class="scrub" id="team-scrub" aria-label="The messages of this review"></ol>
          <span class="transport-count" id="team-count"></span>
        </div>
      </div>
      <aside class="talk ${replay ? "is-replay" : ""}" aria-label="The conversation">
        <header><h2>The conversation</h2><span id="team-elapsed" class="elapsed"></span></header>
        <div class="talk-wrap"><ol class="talk-list" id="team-talk"></ol></div>
        <p class="fine">${replay ? "Pick a message to jump to it." : "Every message is a real step of this run."} Stock and supply are simulated.</p>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- reading the run as a conversation
// Each entry is one exchange: the planner's request, the orchestrator asking a specialist, a specialist calling a
// system (with its answer), a specialist reporting back, and the orchestrator's summary for the planner.
function messagesOf(run, batch) {
  const out = [];
  const steps = run.steps || [];
  const role = (name) => name.slice(7).replace("_agent", "");            // "assign_risk_agent" is the Risk agent
  const team = steps.some((s) => s.type === "tool" && s.name.startsWith("assign_")) || !!run.context?.team;
  const size = run.context?.list_size || 25;
  const scope = run.context?.record_ids?.length;
  const what = scope ? plural(scope, "selected record") : batch.records === 1 ? "this record" : plural(batch.records, "record");
  const facts = {};
  const ask = (to) => {
    if (to === "stock") { const n = facts.risk?.repairs_proposed ?? 0; return `${plural(n, "repair")} ${n === 1 ? "is" : "are"} proposed. Is there a spare actuator for ${n === 1 ? "it" : "each"}?`; }
    if (to === "supply") { const n = facts.stock?.repairs_without_a_part ?? 0; return `${plural(n, "repair")} ${n === 1 ? "has" : "have"} no part. Find a source and say when ${n === 1 ? "it" : "each"} arrives.`; }
    if (batch.records === 1 && !scope) return "Check this record, run the failure model and propose what to do.";
    return `Check ${scope ? `the ${what}` : what}, run the failure model and propose up to ${plural(size, "action")}.`;
  };
  out.push({ key: "start", kind: "start", from: "you", to: team ? "lead" : "risk", done: true,
    text: `Review ${what}. ${batch.records === 1 && !scope ? "Does this actuator need attention?" : "Which actuators need attention?"}` });
  let open = null;
  const close = () => {
    if (open && open.status !== "running") {
      const who = role(open.name), o = open.output || {};
      facts[who] = o.facts || {};
      out.push({ key: `${open.seq}:rep`, kind: "report", from: who, to: "lead", done: true, failed: open.is_error,
        text: open.is_error ? (o.error || "The specialist could not finish.") : firstSentences(o.report, 220) });
      open = null;
    }
  };
  for (const s of steps) {
    if (open && s.agent !== role(open.name)) close();                    // the orchestrator moved on: the report is in
    if (s.type === "notice") { out.push({ key: `${s.seq}:note`, kind: "note", from: "sys", done: true, failed: s.is_error, text: s.output?.text || "" }); continue; }
    if (s.type !== "tool") continue;
    if (s.name.startsWith("assign_")) {
      close();
      out.push({ key: `${s.seq}:ask`, kind: "ask", from: "lead", to: role(s.name), done: true, text: ask(role(s.name)) });
      open = s;
    } else if (TOOL[s.name]) {
      out.push({ key: `${s.seq}:tool`, kind: "tool", from: AGENTS[s.agent] ? s.agent : "risk", sys: TOOL[s.name][0], route: TOOL[s.name][1], name: s.name,
        done: s.status !== "running", failed: s.is_error, step: s });
    }
  }
  close();
  if (run.status !== "running") {
    out.push({ key: "final", kind: "final", from: team ? "lead" : "risk", to: "you", done: true, failed: run.status === "failed",
      text: run.status === "failed" ? (run.error || "The run stopped before it finished.") : firstSentences(run.final_text, 220) });
  }
  return out;
}

// ---------------------------------------------------------------- the picture
export function mount(run, batch, { onDone, onSeek, onPick, loadRows, replay = false, from = 0, paused = false, rate = 1, catchUp = false } = {}) {
  const canvas = $("#team-canvas");
  if (!canvas) return null;
  const root = canvas.closest(".wrap") || document.body;
  const g = canvas.getContext("2d");
  // Someone who asked their system for less motion gets the same steps without the movement. "?motion" in the address overrides that.
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches && !new URLSearchParams(location.search).has("motion");
  const scope = run.context?.record_ids?.length ? new Set(run.context.record_ids) : null;
  const T = { dead: false, msgs: [], at: 0, shown: -1, fastTo: from, paused, stepping: paused, rate, scan: null, last: 0, ended: false, finished: false,
    dots: [], chips: [], shelf: [], sent: [], arrow: null, fading: null, listSize: 1, run, filter: null,
    known: false, revealed: false, byId: new Map(), hover: null, dash: 0 };

  // ---- the fleet: one dot per aircraft (or per few aircraft, for a very large file)
  const n = Math.max(1, scope ? scope.size : batch.records);
  const count = Math.min(n, MAX_DOTS);
  T.unit = n / count;
  T.listSize = Math.max(1, Math.min(run.context?.list_size || 25, n));        // a list is never longer than the file
  if ($("#z-list")) $("#z-list").textContent = n === 1 ? "" : `up to ${fmtInt(T.listSize)}`;
  const cap = count <= 4 ? 76 : count <= 16 ? 50 : count <= 60 ? 34 : 26;
  const cols = Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * FLEET.w / FLEET.h))));
  const rows = Math.ceil(count / cols);
  const pitch = Math.min(FLEET.w / cols, FLEET.h / rows, cap);
  const radius = Math.max(1.3, pitch * 0.33);
  const small = count <= 60;                                   // a small fleet sits in the middle of its space
  const ox = FLEET.x + (small ? (FLEET.w - cols * pitch) / 2 : 0), oy = FLEET.y + (small ? Math.max(0, (FLEET.h - rows * pitch) / 2 - 12) : 0);
  const cell = (i) => [ox + ((i % cols) + 0.5) * pitch, oy + (Math.floor(i / cols) + 0.5) * pitch];
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < count; i++) {
    const [x, y] = cell(i);
    T.dots.push({ x, y, tx: x, ty: y, r: radius, c: COLOR.idle.slice(), tc: COLOR.idle, a: 0, ta: 0.8, wait: rand() * 500, level: "idle", hollow: false, order: rand(), rec: null });
  }
  $("#z-fleet").textContent = n === 1 ? "1 aircraft" : `${fmtInt(n)} aircraft, ${T.unit > 1.01 ? `one dot for every ${Math.round(T.unit)}` : "one dot each"}`;
  const byOrder = T.dots.map((_, i) => i).sort((a, b) => T.dots[a].order - T.dots[b].order);     // a fixed random order to pick dots in
  const scaled = (v) => (v ? Math.max(1, Math.round(v / T.unit)) : 0);

  // ---- which record each dot is. Without the records (a very large file, or the server not answering) the picture
  // still shows the right numbers; it just cannot say which aircraft a dot is.
  async function learn() {
    if (!loadRows || T.unit > 1.01) return;
    let rows;
    try { rows = await loadRows(); } catch { return; }
    if (T.dead || !Array.isArray(rows)) return;
    if (scope) rows = rows.filter((r) => scope.has(r.record_id));
    if (rows.length !== count) return;
    rows.sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
    rows.forEach((r, i) => { T.dots[i].rec = r; T.byId.set(r.record_id, i); });
    T.known = true;
    if (n === 1 && $("#z-fleet")) $("#z-fleet").textContent = rows[0].aircraft_id;
  }
  const scoredRows = () => T.known && T.dots.every((d) => LEVEL[d.rec.level]);
  let learning = learn();

  // ---- this week's list: empty places, filled when the actions are proposed
  const listCols = Math.max(1, Math.ceil(Math.sqrt(T.listSize * LIST.w / LIST.h)));
  const listRows = Math.ceil(T.listSize / listCols);
  const slotPitch = Math.min(LIST.w / listCols, LIST.h / listRows, 42);
  const slotR = slotPitch * 0.29;
  const slotAt = (j) => [LIST.x + ((j % listCols) + 0.5) * slotPitch, LIST.y + (Math.floor(j / listCols) + 0.5) * slotPitch];
  const partAt = (c) => [c.tx + slotR * 0.82, c.ty + slotR * 0.82];

  // ---- timing: everything waits through these, so pause, speed and jumping work everywhere
  const fast = () => T.at < T.fastTo;
  const sleep = (ms) => new Promise((resolve) => setTimeout(() => { if (!T.dead) resolve(); }, ms));       // never returns once the screen is gone
  const wait = (ms) => (fast() ? Promise.resolve() : sleep(ms / T.rate));
  const until = async (test, least) => { const t0 = performance.now(); while (!T.dead && (!test() || (!fast() && performance.now() - t0 < least / T.rate))) await sleep(60); };
  const gate = async () => {
    if (fast()) return;                                        // a jump passes straight through
    while (!T.dead && T.paused && !T.stepping) await sleep(80);
    T.stepping = false;
  };
  const settle = () => {                                       // after a jump everything stands where it belongs, at once
    for (const p of [...T.dots, ...T.chips, ...T.shelf, ...T.sent]) {
      p.wait = 0; p.x = p.tx; p.y = p.ty; p.a = p.ta;
      if (p.tr !== undefined) p.r = p.tr;
      if (p.tc && p.c) p.c = p.tc.slice();
    }
  };

  // ---- the nodes, the caption, the conversation and the scrubber
  const nodeEl = (id) => $(`[data-node="${id}"]`, root);
  const setNode = (id, status, line) => {
    const el = nodeEl(id);
    if (!el) return;
    if (el.classList.contains("is-failed") && status !== "failed" && status !== "working") return;      // a member that failed stays marked
    el.className = `node node-${id} is-${status}${T.filter === id ? " is-picked" : ""}`;
    if (line !== undefined) el.querySelector(".node-line").innerHTML = line;
  };
  const ping = (id) => {
    const el = nodeEl(id);
    if (!el || fast()) return;
    el.classList.remove("is-ping");
    void el.offsetWidth;
    el.classList.add("is-ping");
  };
  const say = (a, b, html, bad = false) => {
    const el = $("#team-caption");
    if (!el) return;
    el.classList.remove("is-new");
    void el.offsetWidth;                                       // restart the entrance of the new line
    el.classList.add("is-new");
    el.innerHTML = `<span class="route">${chip(a)}${b ? `${arrow}${chip(b)}` : ""}</span><span class="say ${bad ? "is-bad" : ""}">${html}</span>`;
  };
  const talk = (m, html, extra = "") => {
    const list = $("#team-talk");
    if (!list) return;
    $("#team-typing")?.remove();
    let row = list.querySelector(`[data-key="${m.key}"]`);
    if (!row) {
      row = document.createElement("li");
      row.dataset.key = m.key;
      row.dataset.i = String(T.msgs.findIndex((x) => x.key === m.key));
      row.dataset.who = [m.from, m.to, m.sys].filter(Boolean).join(" ");
      list.append(row);
    }
    const b = m.kind === "tool" ? m.sys : m.to;
    row.className = `msg msg-${m.kind}${m.failed ? " is-bad" : ""}${T.filter && !row.dataset.who.split(" ").includes(T.filter) ? " is-dim" : ""}`;
    row.innerHTML = `<button type="button" data-team="seek" ${replay ? "" : "tabindex=-1"}>
      <span class="msg-route">${chip(m.from)}${b ? `${arrow}${chip(b)}` : ""}</span><span class="msg-text">${html}</span>${extra}</button>`;
    for (const li of list.children) li.classList.toggle("is-now", li === row);
    list.scrollTop = list.scrollHeight;
  };
  const typing = (who) => {
    const list = $("#team-talk");
    if (!list || $("#team-typing")) return;
    const li = document.createElement("li");
    li.id = "team-typing";
    li.className = "msg msg-typing";
    li.innerHTML = `<span class="msg-route">${chip(who)}</span><span class="msg-text">is deciding the next step<span class="dots"></span></span>`;
    list.append(li);
    list.scrollTop = list.scrollHeight;
  };
  const scrub = () => {
    const el = $("#team-scrub");
    if (!el) return;
    if (el.children.length !== T.msgs.length) {
      el.innerHTML = T.msgs.map((m, i) => `<li><button type="button" class="seg seg-${AGENTS[m.from] || m.from === "you" ? m.from : "sys"}" data-team="seek" data-i="${i}" ${replay ? "" : "disabled"}
        aria-label="Message ${i + 1}" data-tip="${WHO[m.from]}${m.kind === "tool" ? ` → ${WHO[m.sys]}` : m.to ? ` → ${WHO[m.to]}` : ""}|${esc(m.kind === "tool" ? m.name : m.text.slice(0, 90))}"></button></li>`).join("");
    }
    [...el.children].forEach((li, i) => { li.className = T.finished || i < T.shown ? "is-done" : i === T.shown ? "is-now" : ""; });
    const c = $("#team-count");
    if (c) c.textContent = T.msgs.length ? `${Math.max(1, T.shown + 1)} of ${T.msgs.length}${replay || T.ended ? "" : "…"}` : "";
  };

  // ---- a message travelling along its wire
  const lengthOf = (pts) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  // How much of each wire the members' boxes cover, so an arrow starts and ends at the edge of a box, not under it.
  const measure = () => {
    const now = performance.now();
    if (T.half && now - T.measured < 600) return;
    const stage = canvas.getBoundingClientRect();
    if (!stage.width) return;
    T.half = {};
    for (const id of Object.keys(AT)) {
      const el = nodeEl(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      T.half[id] = [r.width / 2 * W / stage.width, r.height / 2 * H / stage.height];
    }
    T.measured = now;
    T.trim = {};
  };
  const trimmed = (key, back) => {
    const id = `${key}${back ? "<" : ""}`;
    if (T.trim && T.trim[id]) return T.trim[id];
    const pts = ROUTE[key].map((q) => q.slice());
    const [a, b] = key.split(">");
    const cut = (i, j, who) => {
      const half = T.half && T.half[who];
      if (!half) return;                                       // a zone: the wire ends where it enters
      const q = pts[i], next = pts[j];
      if (q[0] === next[0]) q[1] += Math.sign(next[1] - q[1]) * (half[1] + 2);
      else q[0] += Math.sign(next[0] - q[0]) * (half[0] + 2);
    };
    cut(0, 1, a);
    cut(pts.length - 1, pts.length - 2, b);
    const out = back ? pts.reverse() : pts;
    if (!T.trim) T.trim = {};
    T.trim[id] = out;
    return out;
  };
  // The label of the message that is on its way, next to its wire.
  const tag = (key, text, color) => {
    const el = $("#team-tag");
    if (!el) return;
    if (!text || !TAG[key]) { el.hidden = true; return; }
    const [x, y, align] = TAG[key];
    el.hidden = false;
    el.textContent = text;
    el.className = `wire-tag is-${align}`;
    el.style.cssText = `left:${pc(x)};top:${pv(y)};color:${css(color)}`;
  };
  // A message leaves: an arrow grows along the wire from the sender to the receiver, and stays until the next one leaves.
  const pulse = (key, { back = false, color = COLOR.ink, to = null, label = "" } = {}) => {
    if (fast()) return Promise.resolve();
    measure();
    const pts = trimmed(key, back);
    const time = Math.min(900, Math.max(520, lengthOf(pts) * 3.2));
    T.fading = T.arrow ? { ...T.arrow, fade: 1 } : null;
    T.arrow = { pts, t: calm ? 1 : 0, time, color };
    tag(key, label, color);
    return wait(calm ? 320 : time).then(() => { if (to) ping(to); });      // timed by the clock, so a hidden tab does not stall the conversation
  };

  // ---- the supply department's lines: where each requested part comes from, and when
  const lines = (list) => {
    const el = $("#z-lines");
    if (!el) return [];
    let y = DEPOT.y - 4;
    const placed = list.map((l) => {
      const rowsNeeded = Math.max(1, Math.ceil((l.boxes || 0) / DEPOT.per));
      const at = { y: y + 26, label: y };
      y += 26 + (l.boxes ? rowsNeeded * 19 + 8 : 0);
      return { ...l, ...at };
    });
    el.innerHTML = placed.map((l) => `<div class="zone zone-line ${l.bad ? "is-bad" : ""}" style="left:${pc(DEPOT.x)};top:${pv(l.label)};width:${pc(DEPOT.w)}">${l.text}</div>`).join("");
    return placed;
  };

  // ---- what each answer does to the fleet picture
  const STAGE = {
    async check_records(o) {
      if (T.known) for (const d of T.dots) { if (!d.rec.scorable) Object.assign(d, { hollow: true, level: "none" }); }
      else { const u = Math.min(scaled(o.cannot_be_scored), count); for (let k = 0; k < u; k++) Object.assign(T.dots[byOrder[k]], { hollow: true, level: "none" }); }
      say("fleet", "risk", `${plural(o.records, "record")} checked. ${fmtInt(o.with_missing_or_unusable_readings)} ${o.with_missing_or_unusable_readings === 1 ? "has" : "have"} a missing reading, and ${fmtInt(o.cannot_be_scored)} cannot be scored.`);
      await wait(1100);
    },
    async run_failure_model(o) {
      T.scan = null;
      if (!replay) { learning = learn(); }                       // the file has its risks now
      await learning;
      const L = o.by_level || {};
      if (scoredRows()) {
        for (const d of T.dots) { d.level = LEVEL[d.rec.level]; d.hollow = d.level === "none"; }
      } else {
        const pool = byOrder.filter((i) => !T.dots[i].hollow);
        const high = Math.min(scaled(L.High), pool.length), medium = Math.min(scaled(L.Medium), pool.length - high);
        pool.forEach((i, k) => { T.dots[i].level = k < high ? "high" : k < high + medium ? "medium" : "low"; });
      }
      for (const d of T.dots) {
        if (d.hollow) continue;
        d.tc = COLOR[d.level];
        d.ta = d.level === "low" ? 0.85 : 1;
        d.wait = rand() * 420;
      }
      T.revealed = true;
      setNode("model", "done", n === 1 ? "Answered" : `${fmtInt(L.High)} High risk`);
      say("model", "risk", n === 1
        ? (L.High ? '<b class="t-high">Likely to fail within 30 days.</b> High risk.' : L.Medium ? "Not expected to fail within 30 days, but the risk is rising. Medium risk." : L.Low ? "No failure expected within 30 days. Low risk." : "No prediction: both key readings are missing.")
        : `Scored. <b class="t-high">${fmtInt(L.High)}</b> ${L.High === 1 ? "is" : "are"} likely to fail within 30 days, and ${fmtInt(L.Medium)} more ${L.Medium === 1 ? "needs" : "need"} watching.`);
      await wait(1100);
      // then the fleet lines up by urgency: High first, then Medium, Low, and the ones that could not be scored
      const rank = { high: 0, medium: 1, low: 2, none: 3, idle: 2 };
      const risk = (i) => T.dots[i].rec?.risk ?? -1;
      const sorted = T.dots.map((_, i) => i).sort((a, b) => rank[T.dots[a].level] - rank[T.dots[b].level] || risk(b) - risk(a) || T.dots[a].order - T.dots[b].order);
      sorted.forEach((i, pos) => { const [x, y] = cell(pos); Object.assign(T.dots[i], { tx: x, ty: y, wait: rand() * 260 }); });
      T.sorted = sorted;
      $("#z-legend").innerHTML = `<i class="k-high"></i>${fmtInt(L.High)} High<i class="k-medium"></i>${fmtInt(L.Medium)} Medium<i class="k-low"></i>${fmtInt(L.Low)} Low<i class="k-none"></i>${fmtInt(L["Not scored"])} not scored`;
      await wait(n === 1 ? 500 : 1200);
    },
    async propose_actions(o, step) {
      const inverse = Object.fromEntries(Object.entries(state.meta.actions).map(([k, v]) => [v, k]));
      const by = {};
      for (const [label, k] of Object.entries(o.by_action || {})) by[inverse[label] || label] = k;
      const sorted = T.sorted || T.dots.map((_, i) => i);
      const order = ["repair", "inspect", "retest"];
      let picks = [];
      const refused = new Set((o.not_filed || []).map((x) => x.record_id));
      const asked = (step.input?.actions || []).filter((a) => a && !refused.has(a.record_id) && T.byId.has(a.record_id));
      if (T.known && asked.length === (o.filed_for_review ?? -1)) {
        picks = asked.map((a) => ({ dot: T.dots[T.byId.get(a.record_id)], action: a.action }));
        picks.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || (b.dot.rec.risk ?? -1) - (a.dot.rec.risk ?? -1));
      } else {
        const pool = { high: sorted.filter((i) => T.dots[i].level === "high"), medium: sorted.filter((i) => T.dots[i].level === "medium"), none: sorted.filter((i) => T.dots[i].level === "none") };
        for (const [action, level] of [["repair", "high"], ["inspect", "medium"], ["retest", "none"]]) {
          for (let k = 0; k < (by[action] || 0); k++) picks.push({ dot: T.dots[pool[level][Math.min(k, pool[level].length - 1)] ?? sorted[k]], action, level });
        }
      }
      picks.forEach((p, k) => {
        const d = p.dot, [sx, sy] = slotAt(T.chips.length);
        const level = p.level || (d && ["high", "medium", "none"].includes(d.level) ? d.level : { repair: "high", inspect: "medium", retest: "none" }[p.action]);
        if (T.unit <= 1.01 && d) d.ta = 0.14;                   // the aircraft itself moves onto the list
        T.chips.push({ x: d ? d.tx : FLEET.x, y: d ? d.ty : FLEET.y, tx: sx, ty: sy, r: d ? d.r : radius, tr: slotR, level, action: p.action, a: 1, ta: 1,
          wait: k * 30, part: null, rec: T.known && d ? d.rec : null });
      });
      $("#z-list").textContent = `${fmtInt(T.chips.length)} proposed`;
      const parts = [by.repair && plural(by.repair, "repair"), by.inspect && plural(by.inspect, "inspection"), by.retest && plural(by.retest, "repeat test")].filter(Boolean);
      say("risk", "list", picks.length
        ? `${picks.length === 1 ? "The aircraft goes" : `The ${fmtInt(picks.length)} most urgent go`} on this week's list: ${parts.join(", ") || plural(picks.length, "action")}. ${picks.length === 1 ? "It waits" : "They wait"} for your decision.`
        : "Nothing needs to go on this week's list.");
      await wait(1300 + picks.length * 30);
    },
    async check_stock(o) {
      const shown = Math.min(o.free_now, STORE.per * 4);
      for (let k = T.shelf.length; k < shown; k++) {
        const x = STORE.x + 7 + (k % STORE.per) * 19.5, y = STORE.y + 7 + Math.floor(k / STORE.per) * 19.5;
        T.shelf.push({ x, y, tx: x, ty: y, s: 11, a: 0, ta: 1, wait: k * 22, used: false });
      }
      $("#z-store").textContent = `${fmtInt(o.free_now)} free${o.free_now > shown ? ` (${shown} shown)` : ""} · simulated`;
      say("store", "stock", `<b>${plural(o.free_now, "spare actuator")}</b> ${o.free_now === 1 ? "is" : "are"} free. ${plural(o.repairs_waiting_for_a_part, "repair")} ${o.repairs_waiting_for_a_part === 1 ? "needs" : "need"} one.`);
      await wait(1100);
    },
    async reserve_parts(o) {
      const covered = o.set_aside_from_hangar_store, without = o.repairs_still_without_a_part;
      const repairs = T.chips.filter((c) => c.action === "repair").sort((a, b) => (b.rec?.risk ?? 0) - (a.rec?.risk ?? 0));     // the most urgent get the store's parts
      repairs.forEach((c, k) => {
        if (k < covered) {
          const box = T.shelf.find((b) => !b.used) || T.shelf[T.shelf.push({ x: STORE.x + 7, y: STORE.y + 7, s: 11, a: 1, ta: 1, wait: 0, used: false }) - 1];
          const [px, py] = partAt(c);
          c.part = "store";
          Object.assign(box, { used: true, tx: px, ty: py, s: 9, wait: k * 45 });
        } else c.part = "none";
      });
      say("store", "stock", without
        ? `${plural(covered, "repair")} ${covered === 1 ? "gets" : "get"} a part from the store. <b class="t-high">${plural(without, "repair")} ${without === 1 ? "has" : "have"} no part.</b>`
        : covered === 1 ? "The repair gets its part from the store." : `Every one of the ${plural(covered, "repair")} gets a part from the store.`);
      await wait(1300 + Math.min(covered, 28) * 45);
    },
    async get_supply_options(o) {
      const real = (o.sources || []).filter((s) => s.source !== "backorder");
      const text = real.map((s) => (s.units_available === 0 ? `${esc(s.name)}: none` : `${esc(s.name)}: ${s.units_available === "no limit" ? "available" : fmtInt(s.units_available)}${s.delivery_days ? `, ${s.delivery_days} days` : ""}`));
      lines(real.map((s) => ({ bad: s.units_available === 0, text: `${SOURCE(s.name)} · ${s.units_available === 0 ? "none" : s.units_available === "no limit" ? "available" : `${fmtInt(s.units_available)} units`}${s.delivery_days && s.units_available !== 0 ? ` · ${s.delivery_days} days` : ""}` })));
      say("depot", "supply", `${text.join(". ")}. ${plural(o.units_needed, "part")} ${o.units_needed === 1 ? "is" : "are"} needed.`);
      await wait(1200);
    },
    async request_parts(o) {
      const asked = o.lines || [];
      const waiting = T.chips.filter((c) => c.action === "repair" && c.part === "none").sort((a, b) => (b.rec?.risk ?? 0) - (a.rec?.risk ?? 0));
      // A part with no delivery date is late by definition. The dated ones that arrive late come from the slowest source.
      const dated = (line) => Number.isInteger(line.arrives_in_days);
      let lateLeft = Math.max(0, (o.arrive_after_the_repair_is_due_for || 0) - asked.filter((l) => !dated(l)).reduce((sum, l) => sum + l.quantity, 0));
      const lateBy = asked.map(() => 0);
      for (let i = asked.length - 1; i >= 0 && lateLeft > 0; i--) {
        if (!dated(asked[i])) continue;
        lateBy[i] = Math.min(asked[i].quantity, lateLeft);
        lateLeft -= lateBy[i];
      }
      const placed = lines(asked.map((l) => ({ text: `${fmtInt(l.quantity)} · ${SOURCE(l.from)} · ${dated(l) ? `${l.arrives_in_days} days` : "no date"}`, boxes: l.quantity, bad: !dated(l) })));
      let k = 0;
      asked.forEach((line, row) => {
        for (let q = 0; q < line.quantity; q++, k++) {
          const c = waiting[k];
          const late = !dated(line) || q >= line.quantity - lateBy[row];
          const x0 = DEPOT.x + 7 + (q % DEPOT.per) * 19.5, y0 = (placed[row]?.y ?? DEPOT.y) + 7 + Math.floor(q / DEPOT.per) * 19;
          const [px, py] = c ? partAt(c) : [x0, y0];
          T.sent.push({ x: x0, y: y0, tx: px, ty: py, s: 9, a: 0, ta: 1, wait: 450 + k * 55, late, dated: dated(line) });
          if (c) c.part = late ? "late" : "sent";
        }
      });
      $("#z-supply").textContent = `${o.request_id || "request"} · simulated`;
      const late = o.arrive_after_the_repair_is_due_for || 0;
      say("supply", "depot", `Request ${esc(o.request_id)}: ${asked.map((l) => esc(partLine(l))).join(" and ")}.${late ? ` <b class="t-high">${plural(late, "part")} would not be here before the repair is due.</b>` : " All of them arrive in time."} Nothing is ordered until you approve.`);
      await wait(1900 + k * 55);
    },
  };

  // ---- playing one message
  async function play(m) {
    await gate();
    T.shown = T.at;
    scrub();
    sync();
    if (m.kind === "start") {
      setNode("you", "done", "Asked for a review");
      say("you", m.to, esc(m.text));
      talk(m, esc(m.text));
      await pulse("lead>you", { back: true, color: HUE.you, to: m.to, label: "request" });
      setNode(m.to, "working", "Planning the work");
      await wait(700);
    } else if (m.kind === "note") {
      say("sys", null, esc(m.text), m.failed);
      talk(m, esc(m.text));
      await wait(1200);
    } else if (m.kind === "ask") {
      setNode("lead", "working", `Asking the ${WHO[m.to]}`);
      say("lead", m.to, esc(m.text));
      talk(m, esc(m.text));
      await pulse(`lead>${m.to}`, { color: HUE.lead, to: m.to, label: "task" });
      setNode("lead", "waiting", "Waiting for the report");
      setNode(m.to, "working", "Starting");
      await wait(600);
    } else if (m.kind === "tool") {
      const isModel = m.sys === "model";
      setNode(m.from, "working", DOING[m.name] || esc(m.name));
      say(m.from, m.sys, `<code>${esc(m.name)}</code> ${m.name === "run_failure_model" ? "Score every aircraft: will its actuator fail within 30 days?" : ""}`);
      talk(m, `<code>${esc(m.name)}</code>`);
      await pulse(m.route, { color: HUE[m.from], to: isModel ? "model" : null, label: m.name });
      if (isModel) setNode("model", "working", m.name === "run_failure_model" ? "Scoring" : "Answering");
      if (m.name === "run_failure_model") T.scan = { x: FLEET.x, bad: false };
      await until(() => T.msgs.find((x) => x.key === m.key)?.done, m.name === "run_failure_model" ? 1300 : 250);
      const now = T.msgs.find((x) => x.key === m.key) || m;
      const o = now.step.output || {}, d = describe(now.step);
      if (now.failed && T.scan) T.scan.bad = true;
      await pulse(m.route, { back: true, color: now.failed ? COLOR.high : HUE.sys, to: m.from, label: now.failed ? "error" : "result" });
      talk(now, `<code>${esc(m.name)}</code>`, `<span class="msg-back ${now.failed ? "is-bad" : ""}">${d.result || esc(d.title)}</span>`);
      if (now.failed) {
        const model = o.error === "MODEL_UNAVAILABLE", store = o.error === "STOCK_UNAVAILABLE";
        if (isModel) setNode("model", "failed", "Did not answer");
        setNode(m.from, model || store ? "failed" : "working", model ? "No predictions" : store ? "Stock unknown" : "Trying another way");
        say(m.sys, m.from, model ? `<b>The failure model did not answer.</b> There are no predictions, and none are invented. ${esc(o.message || "")}`
          : store ? "<b>The stock system did not answer.</b> Nothing is assumed about spare parts. The repairs stay on the list without a part status." : esc(d.title), true);
        await wait(1900);
        T.scan = null;
      } else if (STAGE[m.name]) await STAGE[m.name](o, now.step);
      else {
        if (isModel) setNode("model", "done", "Answered");
        say(m.sys, m.from, d.result || esc(d.title));
        await wait(800);
      }
    } else if (m.kind === "report") {
      say(m.from, "lead", esc(m.text), m.failed);
      talk(m, esc(m.text));
      await pulse(`lead>${m.from}`, { back: true, color: m.failed ? COLOR.high : HUE[m.from], to: "lead", label: "report" });
      setNode(m.from, m.failed ? "failed" : "done", m.failed ? "Could not finish" : "Reported back");
      setNode("lead", "working", "Reading the report");
      await wait(1000);
    } else if (m.kind === "final") {
      T.scan = null;
      say(m.from, "you", esc(m.text), m.failed);
      talk(m, esc(m.text));
      await pulse("lead>you", { color: m.failed ? COLOR.high : HUE.lead, to: "you", label: "summary" });
      for (const id of ["lead", "risk", "stock", "supply", "model"]) {
        const el = nodeEl(id);
        if (el?.classList.contains("is-idle")) setNode(id, "skipped", id === "lead" ? "" : "Not called");
        else if (el && !el.classList.contains("is-failed")) setNode(id, "done", id === m.from ? "Summary written" : undefined);
      }
      setNode("you", "working", T.chips.length ? "Your decision now" : "Nothing to decide");
      await wait(1400);
    }
    if (fast()) settle();
  }

  // ---- playing the conversation in order, however fast or slowly the run produces it
  async function pump() {
    while (!T.dead) {
      const m = T.msgs[T.at];
      if (!m) {
        if (T.ended) break;
        const last = (T.run.steps || [])[T.run.steps.length - 1];          // between two moves an agent is thinking
        if (last?.type === "model" && last.status === "running" && AGENTS[last.agent]) {
          setNode(last.agent, "working", 'Deciding<span class="dots"></span>');
          typing(last.agent);
        }
        await sleep(120);
        continue;
      }
      try { await play(m); } catch (err) { console.error(err); /* a step of the picture must never stop the review from showing */ }
      T.at++;
      if (m.kind === "final") break;
    }
    if (T.dead) return;
    T.finished = true;
    scrub();
    sync();
    if (replay) {
      // Played to the end, a replay moves on to the result by itself. Someone stepping through it keeps the last frame.
      if (T.paused) return;
      await sleep(1700);
      if (T.paused) return;
    }
    T.dead = true;
    onDone?.();
  }
  function update(next) {
    T.run = next;
    T.msgs = messagesOf(next, batch);
    T.ended = next.status !== "running";
    const el = $("#team-elapsed");
    if (el) el.textContent = replay ? "" : `${seconds(next) ?? 0} s`;
    scrub();
  }

  // ---- drawing
  function trace(pts) {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  }
  const box = (x, y, s) => { g.fillStyle = "#fafaf7"; g.fillRect(x - s / 2 - 1, y - s / 2 - 1, s + 2, s + 2); };
  // An arrowhead at the end of a path, pointing the way the path was going.
  function head(pts, s) {
    const [x, y] = pts[pts.length - 1];
    let k = pts.length - 2;
    while (k > 0 && pts[k][0] === x && pts[k][1] === y) k--;
    const dx = x - pts[k][0], dy = y - pts[k][1], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - ux * s - uy * s * 0.55, y - uy * s + ux * s * 0.55);
    g.lineTo(x - ux * s + uy * s * 0.55, y - uy * s - ux * s * 0.55);
    g.closePath();
    g.fill();
  }
  // The first part of a path, up to `share` of its length, with a head at its tip: an arrow on its way.
  function shaft(pts, share, color, alpha) {
    let left = share * lengthOf(pts);
    const out = [pts[0]];
    for (let i = 1; i < pts.length && left > 0; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], seg = Math.hypot(dx, dy);
      if (!seg) continue;
      const take = Math.min(seg, left);
      out.push([pts[i - 1][0] + dx / seg * take, pts[i - 1][1] + dy / seg * take]);
      left -= take;
    }
    if (out.length < 2) return;
    g.lineWidth = 2.4; g.strokeStyle = css(color, alpha); g.fillStyle = css(color, alpha);
    trace(out);
    head(out, 10);
  }
  function frame() {
    const now = performance.now();                                     // one clock, whoever asked for this frame
    if (!document.body.contains(canvas)) { T.dead = true; T.gone = true; return; }     // the screen was left: stop drawing
    const dt = Math.max(0, Math.min(1000, now - (T.last || now)));                   // time-based, so a slow or hidden tab catches up instead of lagging
    T.last = now;
    const ease = calm ? 1 : 1 - Math.exp(-dt * T.rate / 150);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const wide = canvas.clientWidth || W;
    if (canvas.width !== Math.round(wide * dpr)) { canvas.width = Math.round(wide * dpr); canvas.height = Math.round(wide * H / W * dpr); }
    const k = canvas.width / W;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, W, H);
    g.lineJoin = "round"; g.lineCap = "round";

    // the wiring: who can talk to whom. A small grey head marks where each wire arrives.
    measure();
    g.lineWidth = 1.2;
    g.strokeStyle = css(COLOR.line);
    g.fillStyle = css(COLOR.line);
    for (const key of Object.keys(ROUTE)) {
      const pts = trimmed(key, false);
      trace(pts);
      if (key !== "lead>you") head(pts, 6.5);
    }
    if (T.scan) {                                                    // the model's answers flowing down into the fleet
      T.dash = (T.dash + dt * 0.03 * T.rate) % 12;
      g.lineWidth = 1.8; g.strokeStyle = css(T.scan.bad ? COLOR.high : COLOR.accent);
      g.setLineDash([5, 7]); g.lineDashOffset = -T.dash;
      trace(trimmed("model>fleet", false));
      g.setLineDash([]); g.lineDashOffset = 0;
    }

    // the rule under each zone's name
    g.lineWidth = 1; g.strokeStyle = css(COLOR.ink, 0.85);
    for (const z of [FLEET, LIST, STORE, DEPOT]) { g.beginPath(); g.moveTo(z.x, RULE + 0.5); g.lineTo(z.x + z.w, RULE + 0.5); g.stroke(); }

    // the places on this week's list
    g.setLineDash([3, 3]);
    g.strokeStyle = "rgba(22,23,27,0.22)";
    for (let j = 0; j < T.listSize; j++) { const [x, y] = slotAt(j); g.beginPath(); g.arc(x, y, slotR, 0, 6.2832); g.stroke(); }
    g.setLineDash([]);

    const move = (p) => {
      if (p.wait > 0) { p.wait -= dt * T.rate; if (p.wait > 0) return; }      // a late frame still moves the piece
      p.x += (p.tx - p.x) * ease; p.y += (p.ty - p.y) * ease;
      if (p.tr !== undefined) p.r += (p.tr - p.r) * ease;
      p.a += (p.ta - p.a) * ease;
      if (p.tc && p.c) for (let i = 0; i < 3; i++) p.c[i] += (p.tc[i] - p.c[i]) * ease;
    };
    for (const d of T.dots) {
      move(d);
      if (d.a < 0.01) continue;
      g.beginPath(); g.arc(d.x, d.y, d.r, 0, 6.2832);
      if (d.hollow) { g.lineWidth = Math.max(0.8, Math.min(2.4, d.r * 0.4)); g.strokeStyle = css(COLOR.idle, d.a); g.stroke(); }
      else { g.fillStyle = `rgba(${d.c[0] | 0},${d.c[1] | 0},${d.c[2] | 0},${d.a})`; g.fill(); }
    }
    if (T.known && count <= 12) {                                    // a handful of aircraft are named in the picture itself
      g.font = '600 13px "Cascadia Mono", ui-monospace, Consolas, monospace'; g.textAlign = "center"; g.fillStyle = css(COLOR.ink, 0.78);
      for (const d of T.dots) g.fillText(String(d.rec.aircraft_id).slice(0, 18), d.x, d.y + radius + 18);
    }
    if (T.scan) {                                                    // the model sweeping across the fleet
      T.scan.x += dt * 0.42 * T.rate;
      if (T.scan.x > FLEET.x + FLEET.w + 30) T.scan.x = FLEET.x - 30;
      const c = T.scan.bad ? COLOR.high : COLOR.accent;
      const x = Math.max(FLEET.x, Math.min(FLEET.x + FLEET.w, T.scan.x));
      const fade = g.createLinearGradient(x - 70, 0, x, 0);
      fade.addColorStop(0, css(c, 0)); fade.addColorStop(1, css(c, 0.16));
      g.fillStyle = fade; g.fillRect(Math.max(FLEET.x, x - 70), FLEET.y - 4, Math.min(70, x - FLEET.x), FLEET.h + 8);
      g.fillStyle = css(c, 0.9); g.fillRect(x, FLEET.y - 4, 2, FLEET.h + 8);
    }
    for (const c of T.chips) {
      move(c);
      g.beginPath(); g.arc(c.x, c.y, c.r, 0, 6.2832);
      if (c.level === "none") { g.fillStyle = "#fafaf7"; g.fill(); g.lineWidth = 2; g.strokeStyle = css(COLOR.idle); g.stroke(); }
      else { g.fillStyle = css(COLOR[c.level] || COLOR.low, c.a); g.fill(); }
      if (c.part === "none" && Math.abs(c.x - c.tx) < 1) {          // a repair still waiting for a part
        const s = 9, [bx, by] = partAt(c);
        box(bx, by, s);
        g.setLineDash([2, 2]); g.lineWidth = 1.3; g.strokeStyle = css(COLOR.high);
        g.strokeRect(bx - s / 2 + 0.6, by - s / 2 + 0.6, s - 1.2, s - 1.2); g.setLineDash([]);
      }
    }
    for (const b of T.shelf) {
      move(b);
      if (b.a < 0.01) continue;
      box(b.x, b.y, b.s);
      g.fillStyle = css(COLOR.ink, b.a); g.fillRect(b.x - b.s / 2, b.y - b.s / 2, b.s, b.s);
    }
    for (const b of T.sent) {
      move(b);
      if (b.a < 0.01) continue;
      box(b.x, b.y, b.s);
      g.lineWidth = 1.8; g.strokeStyle = css(b.late ? COLOR.high : COLOR.accent, b.a);
      if (!b.dated) g.setLineDash([2, 2]);
      g.strokeRect(b.x - b.s / 2 + 0.9, b.y - b.s / 2 + 0.9, b.s - 1.8, b.s - 1.8);
      g.setLineDash([]);
    }
    if (T.hover) {                                                   // the aircraft under the pointer
      const h = T.hover;
      g.lineWidth = 1.6; g.strokeStyle = css(COLOR.ink);
      g.beginPath(); g.arc(h.x, h.y, Math.max(h.r + 3, 5.5), 0, 6.2832); g.stroke();
    }
    // the message on its way: an arrow from the sender to the receiver, drawn last so nothing hides it
    for (const a of [T.fading, T.arrow]) {
      if (!a) continue;
      if (a.fade !== undefined) { a.fade -= dt / 260; if (a.fade <= 0) { T.fading = null; continue; } }
      else a.t = a.time ? Math.min(1, a.t + dt * T.rate / a.time) : 1;
      shaft(a.pts, a.t, a.color, a.fade === undefined ? 1 : a.fade);
    }
  }
  // Drawn on every animation frame. A tab in the background gets no frames, so a slow heartbeat keeps the picture current there.
  function tick(now) {
    if (T.gone) return;
    frame();
    requestAnimationFrame(tick);
  }
  const heartbeat = setInterval(() => {
    if (T.gone || !document.body.contains(canvas)) { clearInterval(heartbeat); return; }
    if (performance.now() - T.last > 400) frame();
  }, 300);

  // ---- pointing at an aircraft: which one it is, and what the team said about it
  const tip = $("#team-tip");
  const PART = { store: "part in the store", sent: "part requested, arrives in time", late: "part late or not available", none: "no part yet" };
  function pointAtDot(ev) {
    if (!T.known) return;
    const box = canvas.getBoundingClientRect();
    const x = (ev.clientX - box.left) / box.width * W, y = (ev.clientY - box.top) / box.height * H;
    let best = null, reach = 0;
    for (const c of T.chips) { const d = Math.hypot(c.x - x, c.y - y); if (c.rec && d < c.r + 4 && (!best || d < reach)) { best = c; reach = d; } }
    if (!best) for (const d of T.dots) { const far = Math.hypot(d.x - x, d.y - y); if (d.a > 0.3 && far < Math.max(d.r + 2.5, 4.5) && (!best || far < reach)) { best = d; reach = far; } }
    T.hover = best;
    canvas.style.cursor = best && replay ? "pointer" : "";
    if (!best || !tip) { if (tip) tip.hidden = true; return; }
    const r = best.rec, onList = best.action || T.chips.find((c) => c.rec === r)?.action;
    const chipOf = best.action ? best : T.chips.find((c) => c.rec === r);
    const risk = !T.revealed ? "Not scored yet" : r.level === "Not scored" || r.risk == null ? "No prediction: key readings missing" : `${fmtRisk(r.risk)} chance of failing within 30 days · ${esc(r.level)}`;
    tip.innerHTML = `<b class="mono">${esc(r.aircraft_id)}</b><span>${risk}</span>
      ${onList ? `<span>${esc(state.meta.actions[onList] || onList)} proposed${chipOf?.part ? ` · ${PART[chipOf.part]}` : ""}</span>` : ""}${replay ? "<small>Click to open the record</small>" : ""}`;
    tip.hidden = false;
    const left = best.x / W * 100, top = best.y / H * 100;
    tip.style.left = `${Math.min(left, 78)}%`;
    tip.style.top = `${top}%`;
    tip.classList.toggle("is-above", top > 62);
  }
  canvas.addEventListener("mousemove", pointAtDot);
  canvas.addEventListener("mouseleave", () => { T.hover = null; if (tip) tip.hidden = true; });
  canvas.addEventListener("click", () => { if (replay && T.hover?.rec) onPick?.(T.hover.rec.record_id); });

  // ---- the controls on the screen itself
  function sync() {
    const pause = $('[data-team="pause"]', root), step = $('[data-team="step"]', root), speed = $('[data-team="rate"]', root), back = $('[data-team="back"]', root);
    if (pause) pause.innerHTML = T.finished ? `${icon("refresh")}<span>Play again</span>` : `${icon(T.paused ? "play" : "pause")}<span>${T.paused ? "Play" : "Pause"}</span>`;
    if (step) step.disabled = !T.paused || T.finished;
    if (back) back.disabled = T.shown <= 0;
    if (speed) speed.textContent = `${T.rate}×`;
    const skip = $('[data-team="skip"]', root);
    if (skip && T.finished) { skip.classList.add("btn-primary"); skip.innerHTML = `See the result${icon("arrow")}`; }
  }
  root.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-team], [data-node]");
    if (!el || !document.body.contains(canvas) || (T.dead && !T.finished)) return;
    if (el.dataset.node) {                                           // pick a member: its messages stand out in the conversation
      T.filter = T.filter === el.dataset.node ? null : el.dataset.node;
      for (const node of $$("[data-node]", root)) node.classList.toggle("is-picked", node.dataset.node === T.filter);
      for (const li of $$("#team-talk li", root)) li.classList.toggle("is-dim", !!T.filter && !(li.dataset.who || "").split(" ").includes(T.filter));
      return;
    }
    const act = el.dataset.team;
    if (act === "pause") {
      if (T.finished) { onSeek?.(0, { paused: false, rate: T.rate }); return; }
      T.paused = !T.paused;
      sync();
    } else if (act === "step") { T.stepping = true; }
    else if (act === "rate") { T.rate = T.rate === 1 ? 2 : T.rate === 2 ? 0.5 : 1; sync(); }
    else if (act === "back" && replay) onSeek?.(Math.max(0, T.shown - 1), { paused: true, rate: T.rate });
    else if (act === "seek" && replay) onSeek?.(Number((el.closest("li") || el).dataset.i ?? el.dataset.i), { paused: T.paused && !T.finished, rate: T.rate });
  });

  requestAnimationFrame(tick);
  if (!replay) setNode("lead", "idle", "Hands out the work");
  update(run);
  if (catchUp) T.fastTo = Math.max(0, T.msgs.filter((m) => m.done).length - 1);      // opened part-way through a run: catch up at once
  sync();
  (replay ? learning : Promise.resolve()).then(pump);                // a replay knows its aircraft before the first message
  return { update, destroy() { T.dead = true; T.gone = true; T.finished = false; clearInterval(heartbeat); } };
}
