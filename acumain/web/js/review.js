// The Review page, in three moments: bring in a file, watch the team of agents work on it, then decide on the list they drafted.
import { api } from "./api.js";
import { addressOf, navigate, refreshBatches, refreshStatus, renderTop, setAddress, state } from "./main.js";
import { $, ACTION_SHORT, LEVEL_CLASS, cap, empty, esc, fmtDate, fmtInt, fmtRisk, fmtTime, icon, levelMark, markdown, plural, repaint, riskBar, toast } from "./ui.js";
import { modelFailed, partLine, planned, runMeta, timeline } from "./steps.js";
import { mount as mountTeam, teamView } from "./team.js";
import { openCheck } from "./check.js";
import { holoHtml, mountHolo } from "./holo.js";

const PAGE_SIZE = 50;
const SAMPLE = "sample";
const freshRecords = () => ({ open: false, level: "Any", issues: false, search: "", offset: 0, data: { total: 0, rows: [] }, selected: new Set() });
const v = {
  seq: 0,               // a page load that finishes after a newer one has started is thrown away
  batch: null,          // the file on screen
  run: null,            // the run in progress, if any
  review: null,         // the latest finished review of this file
  qa: null,             // the latest question and its answer
  proposals: [],
  requests: [],         // parts requests drafted by the Supply agent (simulated)
  playing: false,       // the team screen is on: a review is running, or its picture is still catching up, or it is replayed
  replay: false,
  plain: false,         // the planner chose to skip the picture while the review is still running
  team: null,           // the controller of the team screen
  teamAt: {},           // where a replay stands after a jump: the message, paused or not, the speed
  catchUp: false,       // the page was opened on a review that was already running
  single: null,         // the record itself, when the file holds exactly one
  deciding: null,       // the decision window that is open, if any
  listSize: 25,
  rec: freshRecords(),
  drawer: null,
  timer: null,
  busy: false,
  upload: { busy: false, error: null, name: null },
  searchTimer: null,
  removing: null,       // the file whose "Remove" was clicked once and waits for a second click
  outage: null,
};
// The file that was just chosen on the start page. Its page opens on the team at work: a new review for a file that
// has none, a replay of the last one for a file that was reviewed before.
let chosen = null;
function choose(batchId) {
  chosen = batchId;
  navigate("review", batchId);
}
const here = () => state.page === "review";
const actionName = (a) => state.meta.actions[a] || a;
const one = () => v.batch?.records === 1;
const count = (status) => v.proposals.filter((p) => p.status === status).length;

// ---------------------------------------------------------------- loading
export async function show(arg) {
  const my = ++v.seq;
  stopPolling();
  const [batchId, ...rest] = (arg || "").split("/");
  const recordId = rest.join("/") || null;
  await refreshBatches();
  if (my !== v.seq) return;
  if (!batchId) {
    state.batchId = null;
    Object.assign(v, { batch: null, run: null, review: null, qa: null, drawer: null, single: null, busy: false, removing: null, playing: false, replay: false, plain: false });
    chosen = null;
    endTeam();
    renderTop();
    renderStart();
    return;
  }
  const found = state.batches.find((b) => b.id === batchId);
  if (!found) {
    state.batchId = null;
    renderTop();
    $("#page").innerHTML = `<div class="wrap">${empty("That file is no longer here", "It may have been removed. Start again with another file.", '<a class="btn" href="#review">Back to the start</a>')}</div>`;
    return;
  }
  state.batchId = batchId;
  renderTop();
  const auto = chosen === batchId;
  chosen = null;
  Object.assign(v, { batch: found, run: null, review: null, qa: null, drawer: null, single: null, busy: false, proposals: [], requests: [], rec: freshRecords(),
    outage: !!state.health?.model?.simulated_outage, playing: false, replay: false, plain: false, deciding: null, teamAt: {}, catchUp: false });
  endTeam();
  const [runs, proposals, requests] = await Promise.all([api.runs(80), api.proposals(batchId), api.partsRequests(batchId), loadSingle()]);
  if (my !== v.seq) return;
  v.proposals = proposals;
  v.requests = requests;
  const mine = runs.filter((r) => r.batch_id === batchId && !r.archived);
  const active = mine.find((r) => r.status === "running");
  const lastReview = mine.find((r) => r.kind === "review" && r.status !== "running");
  const lastQuestion = mine.find((r) => r.kind === "question" && r.status !== "running");
  const answer = lastQuestion && (!lastReview || lastQuestion.started_at >= lastReview.started_at) ? lastQuestion : null;   // only an answer about the current results
  const full = (r) => (r ? api.run(r.id) : null);
  [v.run, v.review, v.qa] = await Promise.all([full(active), full(lastReview), full(answer)]);
  if (my !== v.seq) return;
  v.playing = v.run?.kind === "review";
  v.catchUp = v.playing;
  const reviewed = v.review && found.scored;
  if (!v.playing && reviewed && (auto || new URLSearchParams(location.search).has("replay"))) Object.assign(v, { playing: true, replay: true });
  if (auto && !v.run && !reviewed) { start({ kind: "review" }); return; }      // a file that was just brought in goes straight to the team
  render();
  if (v.run) { v.busy = true; poll(); }
  if (recordId) openDrawer(recordId);
}

async function reload() {
  await refreshBatches();
  v.batch = state.batches.find((b) => b.id === state.batchId) || v.batch;
  [v.proposals, v.requests] = await Promise.all([api.proposals(v.batch.id), api.partsRequests(v.batch.id), loadSingle()]);
  if (v.rec.open) await loadRecords();
}
// A file with exactly one record shows that record itself on its page, not a table of one row.
async function loadSingle() {
  const b = v.batch;
  v.single = null;
  if (!b || b.records !== 1) return;
  try {
    const page = await api.records(b.id, { limit: 1 });
    const found = page.rows[0] && await api.record(b.id, page.rows[0].record_id);
    if (v.batch === b || v.batch?.id === b.id) v.single = found || null;
  } catch { /* the page still works without it: it falls back to the table of one */ }
}
// Every record of the file, for the team screen: each dot there is one of these.
async function loadRows() {
  const id = v.batch.id, out = [];
  for (let offset = 0; offset < 2500; offset += 500) {
    const page = await api.records(id, { limit: 500, offset });
    out.push(...page.rows);
    if (!page.rows.length || out.length >= page.total) break;
  }
  return out;
}
function endTeam() {
  v.team?.destroy();
  v.team = null;
  v.preview?.destroy();          // the landing page's looping picture, if it was playing
  v.preview = null;
}
async function loadRecords() {
  const r = v.rec;
  r.data = await api.records(v.batch.id, { level: r.level === "Any" ? null : r.level, issues: r.issues, q: r.search, offset: r.offset, limit: PAGE_SIZE });
}

// Which moment the page is in.
function view() {
  if (v.playing || v.run?.kind === "review") return "working";
  if (v.batch.scored) return "result";
  return v.review ? "failed" : "ready";
}

function render() {
  if (!here() || !v.batch) return;
  const kind = view();
  endTeam();
  const body = { ready: readyView, working: workingView, result: resultView, failed: failedView }[kind]();
  $("#page").innerHTML = `<div class="wrap wrap-${kind}" data-view="${kind}">
    <a class="crumb" href="#review">${icon("back")}All files</a>${body}</div>`;
  if (kind === "working" && !v.plain) {
    const run = v.run || v.review;
    v.team = mountTeam(run, v.batch, { onDone: teamDone, onSeek: seek, onPick: openDrawer, loadRows, replay: v.replay, catchUp: v.catchUp, ...v.teamAt });
    v.catchUp = false;
  }
  if (kind === "result") { paintHead(); paintActions(); }
  if (kind === "result" || kind === "failed") paintRail();
  if (kind !== "working") paintRecords();
}

// A jump inside a replay: the picture is drawn again up to that message, and plays on from there.
function seek(index, opts = {}) {
  if (!here() || !v.batch || !v.replay) return;
  v.teamAt = { from: Math.max(0, index), ...opts };
  render();
}

// The team screen has shown everything it had: move on to the result (or back to it, after a replay).
function teamDone() {
  const finished = v.replay ? null : v.review;
  Object.assign(v, { playing: false, replay: false, plain: false, teamAt: {} });
  if (!here() || !v.batch) return;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (!finished) return;
  if (finished.status === "failed") toast("The team stopped before finishing. Nothing was approved or carried out.", "error");
  else if (modelFailed(finished)) toast("The failure model did not answer. No predictions were made.", "error");
  else toast(finished.proposals.length ? `${plural(finished.proposals.length, "action")} proposed. They wait for your decision.` : "The review finished with no new actions to propose.", finished.proposals.length ? "ok" : "info");
}

// ---------------------------------------------------------------- 1. start: bring in a file
function fileState(b) {
  const p = b.proposals;
  if (b.active_run) return "the team is working on it";
  if (p.pending) return `${plural(p.pending, "action")} waiting for your approval`;
  if (b.scored) return p.approved ? `reviewed, ${plural(p.approved, "work order")}` : "reviewed";
  return "not reviewed yet";
}

function renderStart() {
  if (!here() || state.batchId) return;
  const sample = state.batches.find((b) => b.id === SAMPLE);
  const touched = (b) => b.scored || b.active_run || b.proposals.pending + b.proposals.approved + b.proposals.rejected > 0;
  const listed = state.batches.filter((b) => b.id !== SAMPLE || touched(b));
  const u = v.upload;
  const val = state.meta.validation;
  const fileRow = (b) => `<li class="file-row">
      <a class="file-main" href="${addressOf("review", b.id)}">${icon("file")}<span><b>${esc(b.name)}</b><small>${plural(b.records, "record")} · ${esc(fileState(b))}</small></span></a>
      ${b.id === SAMPLE || api.isPublic ? "" : v.removing === b.id
        ? `<span class="file-confirm">Remove this file and its results? <button type="button" class="link link-danger" data-r="remove-yes" data-id="${esc(b.id)}">Remove</button><button type="button" class="link" data-r="remove-no">Keep</button></span>`
        : `<button type="button" class="link link-quiet" data-r="remove" data-id="${esc(b.id)}">Remove</button>`}
      <a class="file-go" href="${addressOf("review", b.id)}">Open${icon("arrow")}</a></li>`;
  const upload = api.isPublic ? `<div class="source is-off">${icon("upload")}<b>Upload your records</b>
      <span>Works in the Docker package. This public copy replays recorded reviews.</span></div>` : `
    <label class="source source-drop ${u.busy ? "is-busy" : ""}" id="drop">
      <input type="file" id="file" accept=".csv,text/csv" hidden ${u.busy ? "disabled" : ""}>
      ${u.busy ? '<span class="spinner"></span>' : icon("upload")}
      <b>${u.busy ? `Checking ${esc(u.name)}` : "Upload your records"}</b>
      <span>${u.busy ? "Reading the columns and every reading." : `Drop a CSV file here, or click to choose one. Up to ${fmtInt(state.meta.limits.max_rows)} records.`}</span>
    </label>`;
  $("#page").innerHTML = `
    <div class="wrap wrap-start" data-view="start">
      <div class="landing">
        <div class="landing-text">
          <p class="kicker">AcuMain · Boeing 787 nose landing gear actuators</p>
          <h1 class="display">Which aircraft get this week's hangar slots?</h1>
          <p class="lede">A team of AI agents reads the diagnostic records, runs our trained failure model, checks the spare parts and drafts the week's action list. You watch it happen, and nothing is carried out until you approve it.</p>
          ${sample ? `<button type="button" class="source source-main" data-r="use" data-id="${SAMPLE}">
            <em class="source-tag">Start here</em><b>Use the sample fleet file</b>
            <span>${plural(sample.records, "diagnostic record")}, January to May 2026. ${cap(fileState(sample))}.</span>
            <strong class="source-cta">${touched(sample) ? "Watch the team review it" : "Start the review"}${icon("arrow")}</strong></button>` : ""}
          <div class="source-pair">
            ${upload}
            <button type="button" class="source" data-r="check-one">${icon("gauge")}<b>Check a single record</b>
              <span>${api.isPublic ? "Four recorded examples, reviewed by the same team." : "Type in one test. The same team reviews that aircraft."}</span></button>
          </div>
          ${u.error ? `<div class="callout callout-error"><p><b>${esc(u.name || "This file")} cannot be used.</b> ${esc(u.error)}</p></div>` : ""}
          ${api.isPublic ? "" : '<p class="start-links">No file at hand? Download a <a href="/api/files/sample_upload.csv" download>sample with 30 records</a> or the <a href="/api/files/template.csv" download>empty template</a>.</p>'}
        </div>
        <div class="landing-show" aria-label="How a review runs">
          <header><h2>How a review runs</h2><span>An example on the sample fleet file, playing in a loop</span></header>
          <div id="preview"></div>
          <ul class="landing-facts">
            <li><b>${val.caught} of ${val.failures}</b><span>failures flagged in their final 30 days, on aircraft the model never saw</span></li>
            <li><b>${val.lead_weeks} weeks</b><span>typical warning before a failure</span></li>
            <li><b>You decide</b><span>every action waits for your approval; work orders are simulated</span></li>
          </ul>
        </div>
      </div>
      ${listed.length ? `<section class="files"><h2>Files in this workspace</h2><ul>${listed.map(fileRow).join("")}</ul></section>` : ""}
      <p class="start-foot">Predictions come from the Stage 2 failure model, validated on ${fmtInt(state.meta.training.aircraft)} aircraft it never saw in training. Spare-parts stock and the supply department are simulated. <a href="#model">See the track record</a></p>
    </div>`;
  startPreview();
}

// ---------------------------------------------------------------- the landing page's picture of the team at work
// An example review, written out step by step with the numbers of the sample fleet file, so the landing page can
// show how the agents talk to each other before anything has been run. It is labelled as an example on the page.
const PREVIEW_BATCH = { id: "example", name: "Example", records: 2000 };
function previewRun() {
  const step = (seq, agent, name, output, input = {}) => ({ seq, type: "tool", agent, name, status: "completed", is_error: false, input, output });
  return { id: "example", kind: "review", status: "completed", context: { team: true, list_size: 25 }, started_at: null, finished_at: null,
    final_text: "Approve 25 repairs on the highest-risk aircraft. 12 have a spare part in the store, and parts are requested for the other 13.",
    steps: [
      step(1, "lead", "assign_risk_agent", { agent: "Risk agent", report: "203 of 2,000 aircraft are likely to fail within 30 days. I proposed repairs for the 25 most urgent.", facts: { repairs_proposed: 25 } }),
      step(2, "risk", "check_records", { records: 2000, with_missing_or_unusable_readings: 448, cannot_be_scored: 8 }),
      step(3, "risk", "run_failure_model", { scored: 1992, not_scored: 8, by_level: { High: 203, Medium: 144, Low: 1645, "Not scored": 8 }, expected_failures_in_30_days: 174, model_version: state.health?.model?.version || "" }),
      step(4, "risk", "propose_actions", { filed_for_review: 25, by_action: { [state.meta.actions.repair]: 25 }, not_filed: [] }, { actions: [] }),
      step(5, "lead", "assign_stock_agent", { agent: "Stock agent", report: "12 of the 25 repairs have a spare actuator in the hangar store. 13 have none.", facts: { stock_checked: true, repairs_without_a_part: 13 } }),
      step(6, "stock", "check_stock", { free_now: 12, repairs_waiting_for_a_part: 25, shortage: 13 }),
      step(7, "stock", "reserve_parts", { set_aside_from_hangar_store: 12, repairs_still_without_a_part: 13 }),
      step(8, "lead", "assign_supply_agent", { agent: "Supply agent", report: "I drafted a request for 13 parts: 8 from the central warehouse in 2 days and 5 from the supplier in 14 days.", facts: {} }),
      step(9, "supply", "get_supply_options", { units_needed: 13, sources: [{ source: "warehouse", name: "Central warehouse", units_available: 8, delivery_days: 2 }, { source: "supplier", name: "Supplier order", units_available: "no limit", delivery_days: 14 }] }),
      step(10, "supply", "request_parts", { request_id: "PR-SIM-0001", units_requested: 13, lines: [{ from: "Central warehouse", quantity: 8, arrives_in_days: 2 }, { from: "Supplier order", quantity: 5, arrives_in_days: 14 }],
        arrive_after_the_repair_is_due_for: 5, repairs_still_without_any_source: 0 }),
    ] };
}
function startPreview() {
  const el = $("#preview");
  v.preview?.destroy();
  v.preview = null;
  if (!el || !here() || state.batchId) return;
  const run = previewRun();
  el.innerHTML = teamView(run, PREVIEW_BATCH, true, true);
  v.preview = mountTeam(run, PREVIEW_BATCH, { replay: true, rate: 1.4, onDone: () => setTimeout(startPreview, 900) });
}

async function upload(file) {
  if (!file || v.upload.busy) return;
  v.upload = { busy: true, error: null, name: file.name };
  renderStart();
  try {
    const made = await api.upload(file);
    v.upload = { busy: false, error: null, name: null };
    toast(`${plural(made.records, "record")} loaded${made.with_issues ? `, ${fmtInt(made.with_issues)} with a missing or unusable reading` : ""}. The team starts now.`, "ok");
    choose(made.id);
  } catch (err) {
    v.upload = { busy: false, error: err.message, name: file.name };
    renderStart();
  }
}

// ---------------------------------------------------------------- shared pieces of a file's page
function dataLine(b) {
  return `<div class="checkline">
    <span><b>${fmtInt(b.records)}</b> ${b.records === 1 ? "record" : "records"}</span>
    <span data-tip="Missing readings|A blank or unusable reading is reported, never hidden.|The model still predicts unless both key readings are missing."><b>${fmtInt(b.with_issues)}</b> with a missing reading</span>
    <span data-tip="Cannot be scored|Both key readings, actuation time and leakage, are missing.|No prediction is made. The honest next step is a repeat test."><b>${fmtInt(b.not_scorable)}</b> cannot be scored</span>
  </div>${b.file_notes?.length ? `<ul class="file-notes">${b.file_notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
}

function goRow(label, primary = true) {
  if (api.isPublic) return "";                 // a new review needs the model and the agents, which the public copy does not run
  const selected = v.rec.selected.size;
  return `<div class="go-row">
    <button type="button" class="btn ${primary ? "btn-primary btn-lg" : ""}" data-r="review" ${v.busy ? "disabled" : ""}>${selected ? `Review ${plural(selected, "selected record")}` : label}</button>
    ${one() ? "" : `<label class="size" data-tip="List size|The most urgent actions come first.|Ask again afterwards for the next ones.">Propose up to
      <input type="number" id="list-size" min="1" max="${state.meta.limits.max_list_size}" value="${v.listSize}" aria-label="Largest number of actions to propose"> actions</label>`}
  </div>`;
}

// ---------------------------------------------------------------- 2a. a file that has not been reviewed
function readyView() {
  const b = v.batch;
  return `
    <p class="kicker">${esc(b.name)}</p>
    <h1 class="display">${plural(b.records, "record")} ${b.records === 1 ? "is" : "are"} ready for review</h1>
    ${dataLine(b)}
    ${goRow("Review records")}
    <section class="sec">
      <h2>What the agent will do</h2>
      ${planned()}
    </section>
    <section class="records" id="records"></section>`;
}

// ---------------------------------------------------------------- 2b. the team at work
// The picture of the team comes first. Every tool call behind it is one click away, underneath.
function workingView() {
  const run = v.run || v.review;
  const trail = `<details class="trail trail-live" data-k="live" ${v.plain ? "open" : ""}>
      <summary><span>Every step and tool call</span><small>Which agent did what, with the exact input and output</small></summary>
      <div id="live">${timeline(run)}</div></details>
    <p class="fine">Every step is also saved in the <a href="#log">activity log</a>.</p>`;
  if (v.plain) {
    return `<p class="kicker">${esc(v.batch.name)}</p>
      <h1 class="display">The team is still working<span class="dots"></span></h1>
      <p class="lede">The result opens as soon as the review is finished.</p>${trail}`;
  }
  return `${teamView(run, v.batch, v.replay)}${trail}`;
}
// While a run is followed, the trail is redrawn only when it changed, and only the steps that are new animate in.
const live = { key: "", seen: 0 };
function paintLive() {
  if (!here()) return;
  const steps = v.run.steps || [];
  const key = `${v.run.id}:${steps.map((s) => `${s.seq}${s.status}`).join(",")}`;
  const changed = key !== live.key;
  const seen = live.key.startsWith(`${v.run.id}:`) ? live.seen : 0;
  live.key = key;
  live.seen = steps.length ? steps[steps.length - 1].seq : 0;
  if (v.run.kind === "review") {
    v.team?.update(v.run);
    if (changed) repaint($("#live"), timeline(v.run, { after: seen }));
  } else if (changed) paintAsk();
}

// ---------------------------------------------------------------- 2c. a review that ended without predictions
function failedView() {
  const r = v.review;
  const outage = state.health?.model?.simulated_outage;
  const why = modelFailed(r)
    ? "The failure model did not answer, so there are no predictions and no action list. The team proposed nothing and did not estimate any risk in its place."
    : r.status === "failed" ? `${esc(r.error || "An unexpected error ended the run.")} Nothing was approved or carried out.`
      : "The review ended before the failure model produced any predictions, so there is no action list.";
  return `
    <p class="kicker">${esc(v.batch.name)}</p>
    <h1 class="display">The review could not be completed.</h1>
    <p class="lede">${why}</p>
    <div class="go-row">
      <button type="button" class="btn btn-primary btn-lg" data-r="review" ${v.busy ? "disabled" : ""}>Try again</button>
      ${outage ? '<button type="button" class="btn btn-lg" data-action="outage-off">Switch the failure model back on</button>' : ""}
      <button type="button" class="btn btn-lg" data-r="replay" ${v.busy ? "disabled" : ""}>${icon("play")}Watch what happened</button>
    </div>
    <div class="result-grid">
      <section class="sec sec-flat"><h2>What happened</h2>${timeline(r)}<p class="fine">${runMeta(r)}</p></section>
      <aside class="rail" id="rail"></aside>
    </div>
    <section class="records" id="records"></section>`;
}

// ---------------------------------------------------------------- 3. the result: decisions first
function resultView() {
  return `
    <header class="result-head" id="head"></header>
    <div class="result-grid">
      <section class="actions" id="actions" aria-label="Action list"></section>
      <aside class="rail" id="rail" aria-label="The agent's account"></aside>
    </div>
    <section class="whole" id="whole" aria-label="The whole file"></section>
    <section class="records" id="records"></section>`;
}

// What each recommended action asks the planner to do, in plain words.
const KINDS = ["repair", "inspect", "retest"];
const ACTION_MEANING = {
  repair: "Bring the aircraft in and repair or replace the actuator before it fails.",
  inspect: "Inspect the actuator at the next planned stop. The risk is rising but still below the failure line.",
  retest: "Run the diagnostic test again. A key reading was missing, so there is no reliable prediction yet.",
};
const ACTION_NOUN = { repair: ["repair", "repairs"], inspect: ["inspection", "inspections"], retest: ["repeat test", "repeat tests"] };

// The recommendation in one sentence, right under the headline. The aircraft themselves follow directly below.
function recommendation() {
  if (!v.proposals.length) return v.review ? (one() ? "The team proposes no action for it." : "The team proposed no actions.") : "No actions have been proposed for this file yet.";
  const parts = KINDS.map((action) => {
    const n = v.proposals.filter((p) => p.action === action).length;
    return n ? `<b>${fmtInt(n)} ${ACTION_NOUN[action][n === 1 ? 0 : 1]}</b>` : "";
  }).filter(Boolean);
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const pending = count("pending"), approved = count("approved"), rejected = count("rejected");
  const where = pending === v.proposals.length ? `${pending === 1 ? "It is" : "Each one is"} listed below with its reason. Nothing is carried out until you approve it.`
    : pending ? `${pending} still ${pending === 1 ? "waits" : "wait"} for your approval. So far ${approved} approved, ${rejected} rejected.`
      : v.proposals.length === 1 ? `You ${approved ? "approved" : "rejected"} it.` : `Every one has a decision: ${approved} approved, ${rejected} rejected.`;
  return `The team recommends ${what}. ${where}`;
}

// The evidence behind one kind of action: how high the risk is across its aircraft, and how soon they typically fail.
function evidenceOf(mine) {
  const risks = mine.map((p) => p.risk).filter((r) => r != null);
  if (!risks.length) return "No prediction was possible for these.";
  const times = mine.map((p) => p.time_left).filter(Boolean);
  const usual = [...new Set(times)].sort((a, b) => times.filter((x) => x === b).length - times.filter((x) => x === a).length)[0];
  const lo = fmtRisk(Math.min(...risks)), hi = fmtRisk(Math.max(...risks));
  return [`Chance of failing within 30 days: ${lo === hi ? hi : `${lo} to ${hi}`}.`, usual ? `Typically ${mine.length === 1 ? "fails" : "fail"} in ${usual}.` : ""].filter(Boolean).join(" ");
}

// The headline and first sentence for a file with one record: what the model said about that aircraft.
function singleHead(d) {
  const who = esc(d.aircraft_id);
  if (!d.scorable) return [`No prediction could be made for ${who}.`, "Both key readings, actuation time and leakage, are missing or unusable, so the model was not asked to guess."];
  const headline = d.level === "High" ? `${who} is likely to fail within 30 days.`
    : d.level === "Medium" ? `${who} needs watching: its risk is rising.` : `${who} is not likely to fail within 30 days.`;
  const soon = d.time_left && d.level !== "Low" ? ` Actuators at this risk have typically failed in ${esc(d.time_left)}.` : "";
  return [headline, `The failure model puts the chance at <b>${fmtRisk(d.risk)}</b> (${esc(d.level)} risk). ${esc(d.reason)}.${soon}`];
}

function paintHead() {
  const el = $("#head");
  if (!el) return;
  const b = v.batch, L = b.levels, t = state.meta.thresholds;
  const d = one() && v.single?.scored ? v.single : null;
  const [headline, lede] = d ? singleHead(d)
    : [L.High === 0 ? `None of the ${plural(b.records, "actuator")} is likely to fail within 30 days.`
      : `${fmtInt(L.High)} of ${plural(b.records, "actuator")} ${L.High === 1 ? "is" : "are"} likely to fail within 30 days.`, ""];
  const stale = v.review && modelFailed(v.review)
    ? `<div class="callout callout-warn"><p><b>The latest review failed at the model call.</b> What you see below comes from the earlier review. Run it again once the failure model is back.</p></div>` : "";
  const fig = (key, value, label, note, tone = "") => `<${key ? `button type="button" data-r="filter" data-level="${key}"` : "div"} class="fig ${tone}">
    <b>${value}</b><span>${label}</span><small>${note}</small></${key ? "button" : "div"}>`;
  const check = b.answer_check ? `<p class="answer-check">This file included the real answers. On its ${fmtInt(b.answer_check.records)} records the model caught
    ${fmtInt(b.answer_check.caught)} of ${fmtInt(b.answer_check.caught + b.answer_check.missed)} failures with ${plural(b.answer_check.false_alarms, "false alarm")}
    (F1 ${b.answer_check.f1}, accuracy ${b.answer_check.accuracy}%).</p>` : "";
  el.innerHTML = `
    <div class="result-top">
      <div><p class="kicker">${esc(b.name)}${v.review ? ` · reviewed ${esc(fmtTime(v.review.started_at))}` : ""}</p>
        <h1 class="display">${headline}</h1></div>
      ${v.review ? `<button type="button" class="btn" data-r="replay" ${v.busy ? "disabled" : ""}>${icon("play")}Watch the team at work</button>` : ""}
    </div>
    <p class="lede">${lede} ${recommendation()}</p>
    ${stale}`;
  if (d && $("#whole")) {
    // One aircraft: its readings and the model's reasons take the place of the file's totals and table.
    repaint($("#whole"), `
      <header class="sec-head"><div><h2>What the model saw</h2><p>Record <span class="mono">${esc(d.record_id)}</span>${d.date ? ` · ${esc(fmtDate(d.date))}` : ""}</p></div></header>
      <div class="single">${recordResult(d)}${recordNotes(d)}</div>`);
    startHolos($("#whole"), d);
    return;
  }
  // The numbers for the whole file sit lower down, next to the records they filter. The recommendation comes first.
  if ($("#whole")) $("#whole").innerHTML = `
    <header class="sec-head"><div><h2>The whole file</h2><p>Pick a number to see those records.</p></div></header>
    <div class="figures">
      ${fig("High", fmtInt(L.High), "High risk", "Predicted to fail within 30 days", "fig-high")}
      ${fig("Medium", fmtInt(L.Medium), "Watch", `Risk ${t.medium}% to ${t.high}%`, "fig-medium")}
      ${fig("Issues", fmtInt(b.with_issues), "Missing readings", `${fmtInt(L["Not scored"])} could not be scored`)}
      ${fig(null, fmtInt(b.expected_failures), "Expected failures", "Within 30 days, if nothing is done")}
    </div>${check}`;
}

function paintActions() {
  const el = $("#actions");
  if (!el) return;
  const pending = count("pending"), approved = count("approved"), rejected = count("rejected");
  const again = pending ? "Prepare the list again" : "Propose the next actions";
  if (!v.proposals.length) {
    const d = one() && v.single?.scored && v.single.scorable ? v.single : null;
    const calm = d && v.review ? `<p class="no-action"><b>No action is needed for this aircraft now.</b> Keep monitoring it at the normal interval.
      ${d.plans?.monitor ? `<button type="button" class="link" data-r="steps" data-kind="monitor">See what that means${icon("arrow")}</button>` : ""}</p>` : "";
    el.innerHTML = `<header class="sec-head"><div><h2>What the team recommends</h2><p>${v.review ? "No action proposed" : "Nothing has been proposed for this file yet."}</p></div></header>
      ${calm}${goRow(one() ? "Review this record again" : "Prepare the action list", false)}`;
    return;
  }
  // A row states the action and its part. The decision itself is taken in a window, not by a stray click on the row.
  const item = (p) => {
    const decided = p.status !== "pending";
    const outcome = p.status === "approved" ? `<span class="done done-ok">${icon("check")}<span class="mono">${esc(p.work_order_id)}</span></span>`
      : `<span class="done" ${p.decision_note ? `data-tip="Rejected|${esc(p.decision_note)}"` : ""}>Rejected</span>`;
    return `<li class="arow ${decided ? `is-${p.status}` : ""}">
      <button type="button" class="arow-main" data-r="open" data-id="${esc(p.record_id)}" ${p.note ? `data-tip="The team's note|${esc(p.note)}"` : ""}>
        <span class="arow-id mono">${esc(p.aircraft_id)}</span>
        <span class="arow-risk">${p.risk != null ? riskBar(p.risk, p.level) : '<span class="muted">No prediction</span>'}</span>
        <span class="arow-why"><b>${esc(actionName(p.action))}</b><small>${esc(p.reason || "")}</small></span>
        <span class="arow-part">${partText(p)}</span>
      </button>
      <span class="arow-act">${decided
        ? `${outcome}<button type="button" class="link link-change" data-r="decision" data-id="${esc(p.id)}" aria-label="Change your decision for ${esc(p.aircraft_id)}">Change</button>`
        : `<button type="button" class="btn btn-sm" data-r="decision" data-id="${esc(p.id)}" aria-label="Decide on ${esc(actionName(p.action))} for ${esc(p.aircraft_id)}">Decide</button>`}</span>
    </li>`;
  };
  const groups = KINDS.map((action) => {
    const mine = v.proposals.filter((p) => p.action === action);
    if (!mine.length) return "";
    const open = mine.filter((p) => p.status === "pending").length;
    return `<section class="group">
      <header><div><h3>${esc(actionName(action))}<span>${fmtInt(mine.length)} aircraft</span></h3>
          <p>${ACTION_MEANING[action] || ""} <span>${esc(evidenceOf(mine))}</span></p></div>
        ${open && open !== pending ? `<button type="button" class="link" data-r="bulk" data-kind="${action}">Approve ${open === mine.length ? "these" : "the remaining"} ${open}</button>` : ""}</header>
      <div class="alist-head" aria-hidden="true"><span>Aircraft</span>
        <span data-tip="Chance of failing in 30 days|The failure model's estimate for this aircraft.|The higher it is, the more urgent. The list starts with the highest.">Chance of failing in 30 days</span>
        <span>Recommended action, and why</span><span>${action === "repair" ? "Spare part" : ""}</span><span>Your decision</span></div>
      <ul class="alist">${mine.map(item).join("")}</ul></section>`;
  }).join("");
  // The Supply agent's request sits above the list: it is a decision of its own.
  const requests = v.requests.map((r) => {
    const total = r.lines.reduce((sum, l) => sum + l.quantity, 0);
    const state = r.status === "pending" ? `<button type="button" class="btn btn-sm" data-r="request" data-id="${esc(r.id)}">Decide</button>`
      : `<span class="request-state">${r.status === "approved" ? `<span class="done done-ok">${icon("check")}Approved</span>` : '<span class="done">Rejected</span>'}
          <button type="button" class="link link-change" data-r="request" data-id="${esc(r.id)}" aria-label="Change your decision on parts request ${esc(r.id)}">Change</button></span>`;
    return `<div class="request ${r.status === "pending" ? "" : `is-${r.status}`}">
      <div><b>Parts request <span class="mono">${esc(r.id)}</span></b><span>${plural(total, "spare actuator")}: ${r.lines.map((l) => esc(partLine(l))).join(", ")}.
        ${lateText(r) ? `<em>${lateText(r)}</em>` : "All arrive in time."} Drafted by the Supply agent, simulated.</span></div>${state}</div>`;
  }).join("");
  // What the list buys: the failures the model expects among the repairs on it, against the whole file.
  const repairs = v.proposals.filter((p) => p.action === "repair" && p.status !== "rejected" && p.risk != null);
  const covered = repairs.reduce((sum, p) => sum + p.risk / 100, 0);
  const total = v.batch.expected_failures;
  const coverage = repairs.length && total && !one() ? `<p class="coverage" data-tip="How this is worked out|Each risk is the chance that aircraft fails within 30 days.|Added up, they give the number of failures to expect.">
    These ${plural(repairs.length, "repair")} cover about <b>${fmtInt(covered)}</b> of the <b>${fmtInt(total)}</b> failures expected in 30 days (${Math.round((covered / total) * 100)}%).</p>` : "";
  el.innerHTML = `
    <header class="sec-head">
      <div><h2>What the team recommends</h2><p>${pending} waiting · ${approved} approved · ${rejected} rejected</p></div>
      ${pending > 1 ? `<button type="button" class="btn btn-primary" data-r="bulk">Approve all ${pending}…</button>` : ""}
    </header>
    ${coverage}${requests}${groups}
    <footer class="actions-foot">
      <p class="sim">Simulated. Approving creates a work order inside AcuMain only. No aircraft or maintenance system is contacted.</p>
      ${goRow(one() ? "Review this record again" : again, false)}
    </footer>`;
}

// ---------------------------------------------------------------- the rail: the agent's note, its trail, and questions
// The page keeps the opening of a long text. The rest opens in a window of its own.
function short(text, what, link) {
  const parts = String(text || "").trim().split(/\n\s*\n/);
  if (parts.length < 2) return `<div class="md">${markdown(text)}</div>`;
  return `<div class="md">${markdown(parts[0])}</div><button type="button" class="link link-more" data-r="read" data-what="${what}">${link}${icon("arrow")}</button>`;
}

function paintRail() {
  const el = $("#rail");
  if (!el) return;
  const r = v.review;
  const failed = view() === "failed";
  const account = !r ? "" : `
    <section class="rail-sec">
      <h2>The team's note</h2>
      ${r.status === "failed" ? `<p class="muted">The run stopped before the note could be written.</p>` : r.final_text ? short(r.final_text, "note", "Read the full note") : '<p class="muted">No note was written.</p>'}
    </section>
    ${failed ? "" : `<section class="rail-sec">
      <details class="trail" data-k="trail"><summary><span>How the team got here</span><small>${runMeta(r)}</small></summary>${timeline(r)}</details>
    </section>`}`;
  repaint(el, `${account}<section class="rail-sec" id="ask"></section>`);
  paintAsk();
}

const SUGGESTED = ["How far can I trust these predictions?", "Which aircraft should I look at first, and why?"];
function paintAsk() {
  const el = $("#ask");
  if (!el) return;
  const asking = v.run?.kind === "question" ? v.run : null;
  const keep = $("#question")?.value ?? "";
  const focused = document.activeElement?.id === "question";
  let thread = "";
  if (asking) {
    thread = `<div class="qa is-live"><p class="qa-q">${esc(asking.task)}</p>${timeline(asking)}</div>`;
  } else if (v.qa) {
    thread = `<div class="qa ${v.qa.status === "failed" ? "is-failed" : ""}">
      <p class="qa-q">${esc(v.qa.task)}<button type="button" class="icon-btn icon-btn-sm" data-r="dismiss-qa" aria-label="Dismiss this answer">${icon("x")}</button></p>
      ${v.qa.status === "failed" ? `<div class="md"><p>The agent could not answer: ${esc(v.qa.error || "unknown error")}</p></div>` : short(v.qa.final_text, "answer", "Read the full answer")}
      <details class="trail trail-sm" data-k="qa-trail"><summary><span>How it found out</span><small>${runMeta(v.qa)}</small></summary>${timeline(v.qa)}</details>
    </div>`;
  }
  repaint(el, `
    <h2>Ask the agent</h2>
    <form class="ask" data-r-form="ask">
      <input type="text" id="question" maxlength="600" autocomplete="off" placeholder="${api.isPublic ? "Questions work in the Docker package" : "Ask about this file or one aircraft"}" aria-label="Question for the agent" ${asking || api.isPublic ? "disabled" : ""}>
      <button type="submit" class="btn btn-sm" ${v.busy || api.isPublic ? "disabled" : ""}>Ask</button>
    </form>
    ${asking || v.qa || api.isPublic ? "" : `<p class="suggest">${SUGGESTED.map((s) => `<button type="button" class="link" data-r="suggest">${s}</button>`).join("")}</p>`}
    ${thread}`);
  if ($("#question")) { $("#question").value = asking ? "" : keep; if (focused && !asking) $("#question").focus(); }
}

// ---------------------------------------------------------------- every record, on request
function filters() {
  const b = v.batch, L = b.levels;
  return b.scored
    ? [["Any", "All", b.records], ["High", "High", L.High], ["Medium", "Medium", L.Medium], ["Low", "Low", L.Low], ["Not scored", "Not scored", L["Not scored"]], ["Issues", "Missing readings", b.with_issues]]
    : [["Any", "All", b.records], ["Issues", "Missing readings", b.with_issues], ["Not scored", "Cannot be scored", b.not_scorable]];
}

function paintRecords() {
  const el = $("#records");
  if (!el) return;
  const b = v.batch, r = v.rec, L = b.levels;
  el.hidden = one() && !!v.single?.scored && view() === "result";
  if (el.hidden) return;
  const head = `<button type="button" class="rec-toggle" data-r="toggle-records" aria-expanded="${r.open}">
    ${icon(r.open ? "down" : "chevron")}<span>${r.open ? "Hide the records" : `See all ${plural(b.records, "record")}`}</span>
    ${b.scored ? `<small>${fmtInt(L.High)} High · ${fmtInt(L.Medium)} Medium · ${fmtInt(L.Low)} Low · ${fmtInt(L["Not scored"])} not scored</small>` : "<small>As they came in, before the model has run</small>"}</button>`;
  if (!r.open) { el.innerHTML = head; return; }
  const active = r.issues ? "Issues" : r.level;
  el.innerHTML = `${head}
    <div class="rec-body">
      <div class="toolbar">
        <div class="tabs" role="group" aria-label="Filter the records">${filters().map(([key, label, n]) => `
          <button type="button" data-r="filter" data-level="${key}" aria-pressed="${active === key}">${label}<span>${fmtInt(n)}</span></button>`).join("")}</div>
        <label class="search">${icon("search")}<input type="search" id="search" placeholder="Find an aircraft or record ID" aria-label="Find an aircraft or record ID" value="${esc(r.search)}"></label>
      </div>
      <div id="table"></div>
      <div class="pager" id="pager"></div>
    </div>`;
  paintTable();
}

function proposalText(p) {
  if (!p) return "";
  const what = ACTION_SHORT[p.action] || actionName(p.action);
  if (p.status === "approved") return `<span class="done done-ok" data-tip="${esc(actionName(p.action))}|Approved. Work order ${esc(p.work_order_id)} (simulated).">${icon("check")}${esc(what)}</span>`;
  if (p.status === "rejected") return `<span class="done" data-tip="${esc(actionName(p.action))}|Rejected. No work order.">${esc(what)} rejected</span>`;
  return `<span class="done done-wait" data-tip="${esc(actionName(p.action))}|Waiting for your approval">${esc(what)} proposed</span>`;
}

function paintTable() {
  const el = $("#table");
  if (!el) return;
  const b = v.batch, r = v.rec, rows = r.data.rows;
  if (!rows.length) {
    el.innerHTML = empty("No records match", r.search ? `Nothing matches “${r.search}”.` : "Try another filter.");
    $("#pager").innerHTML = "";
    return;
  }
  const allOnPage = rows.every((x) => r.selected.has(x.record_id));
  const flag = (x) => (x.issues ? `<span class="flag" data-tip="Data note|${plural(x.issues, "reading")} missing or unusable">${icon("alert")}</span>` : "");
  const lead = (x) => `
    <td class="c-check"><input type="checkbox" data-r-check="${esc(x.record_id)}" ${r.selected.has(x.record_id) ? "checked" : ""} aria-label="Select ${esc(x.aircraft_id)}"></td>
    <td><span class="mono ac">${esc(x.aircraft_id)}</span><small>${esc(fmtDate(x.date))}</small></td>`;
  const open = (x) => `<tr data-r="open" data-id="${esc(x.record_id)}" tabindex="0" class="${v.drawer?.record_id === x.record_id ? "is-open" : ""}">`;
  const row = b.scored
    ? (x) => `${open(x)}${lead(x)}
        <td class="c-risk">${riskBar(x.risk, x.level)}</td>
        <td>${levelMark(x.level)}</td>
        <td class="c-why">${esc(x.reason || "")}${flag(x)}</td>
        <td class="c-time">${x.time_left ? esc(x.time_left) : '<span class="muted">–</span>'}</td>
        <td class="c-prop">${proposalText(x.proposal)}</td></tr>`
    : (x) => `${open(x)}${lead(x)}
        <td class="c-why">${!x.scorable ? `Both key readings missing: cannot be scored${flag(x)}` : x.issues ? `${plural(x.issues, "reading")} missing or unusable${flag(x)}` : '<span class="muted">All readings present</span>'}</td></tr>`;
  const cols = b.scored
    ? '<th>Aircraft</th><th>Risk, 30 days</th><th>Level</th><th>Why</th><th class="c-time">Typically fails in</th><th>Action</th>'
    : "<th>Aircraft</th><th>Data</th>";
  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th class="c-check"><input type="checkbox" data-r-check="page" ${allOnPage ? "checked" : ""} aria-label="Select every record on this page"></th>${cols}</tr></thead>
    <tbody>${rows.map(row).join("")}</tbody></table></div>`;
  const from = r.offset + 1, to = r.offset + rows.length;
  $("#pager").innerHTML = `
    <span>${r.selected.size
      ? `<b>${plural(r.selected.size, "record")} selected</b> <button type="button" class="btn btn-sm" data-r="review" ${v.busy ? "disabled" : ""}>Review only these</button> <button type="button" class="link" data-r="clear-selection">Clear</button>`
      : `${fmtInt(from)} to ${fmtInt(to)} of ${fmtInt(r.data.total)}`}</span>
    <span class="pager-buttons">
      <button type="button" class="btn btn-sm" data-r="page" data-dir="-1" ${r.offset === 0 ? "disabled" : ""}>Previous</button>
      <button type="button" class="btn btn-sm" data-r="page" data-dir="1" ${to >= r.data.total ? "disabled" : ""}>Next</button></span>`;
}

async function openRecords(level) {
  const r = v.rec;
  r.open = true;
  if ($("#search")) { clearTimeout(v.searchTimer); r.search = $("#search").value.trim(); }      // keep what is typed in the search box
  if (level) { r.issues = level === "Issues"; r.level = r.issues ? "Any" : level; r.offset = 0; }
  try { await loadRecords(); } catch (err) { toast(err.message, "error"); return; }
  paintRecords();
}

// ---------------------------------------------------------------- one record, in a side panel
async function openDrawer(recordId) {
  try {
    v.drawer = await api.record(v.batch.id, recordId);
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  setAddress("review", `${v.batch.id}/${recordId}`);       // a link to this record can be shared
  renderDrawer();
  paintTable();
}
function closeDrawer() {
  if (!v.drawer) return;
  v.drawer = null;
  $("#drawer-root").innerHTML = "";
  if (here() && v.batch) { setAddress("review", v.batch.id); paintTable(); }
}

// What the failure model said about one record, and why. Shown in the side panel, and on the page of a file with one record.
function recordResult(d) {
  const meter = (r, label) => {
    if (!r || r.level == null) return `<div class="reading"><div class="reading-top"><b>${label}</b><span class="muted">Not recorded</span></div><div class="meter meter-none"><i style="width:0"></i></div></div>`;
    return `<div class="reading"><div class="reading-top"><b>${label}</b><span class="lvl lvl-${r.level}">${esc(r.level_name)}</span></div>
      <div class="meter meter-${r.level}" data-tip="${label}|${esc(r.text)}"><i style="width:${[14, 45, 72, 100][r.level]}%"></i></div><p>${esc(cap(r.text))}.</p></div>`;
  };
  const evidence = (e, what) => (e && e.n ? `<li>${fmtInt(e.failed)} of ${fmtInt(e.n)} past records with ${what} failed within 30 days (${Math.round((e.failed / e.n) * 100)}%).</li>` : "");
  let result;
  if (!d.scored) {
    result = `<div class="callout"><p>The failure model has not been run on this file yet. Start the review to get a prediction.</p></div>`;
  } else if (!d.scorable) {
    result = `<div class="callout callout-warn"><p><b>No prediction was made.</b> Both key readings, actuation time and leakage, are missing or unusable.
      The honest next step is to repeat the diagnostic test.</p>
      ${d.plans?.retest ? `<p><button type="button" class="link" data-r="steps" data-kind="retest">See the steps${icon("arrow")}</button></p>` : ""}</div>`;
  } else {
    const reduced = d.confidence.startsWith("Reduced");
    result = `
      <div class="hero"><span class="hero-num t-${LEVEL_CLASS[d.level]}">${fmtRisk(d.risk)}</span>
        <div>${levelMark(d.level)}<span>risk of failure within 30 days</span></div></div>
      <div class="scale"><i class="scale-fill s-${LEVEL_CLASS[d.level]}" style="width:${Math.max(2, d.risk)}%"></i>
        <span class="scale-tick" style="left:${state.meta.thresholds.medium}%"></span><span class="scale-tick" style="left:${state.meta.thresholds.high}%"></span></div>
      <dl class="facts">
        <div><dt>The model says</dt><dd>${d.prediction === "Yes" ? "Yes, likely to fail" : "No failure expected"}</dd></div>
        <div><dt>Typically fails in</dt><dd>${esc(d.time_left || "–")}</dd></div>
        <div><dt>Suggested next step</dt><dd>${d.plans?.[d.suggested_action]
          ? `<button type="button" class="link link-step" data-r="steps" data-kind="${esc(d.suggested_action)}" data-tip="See the steps|What to do, by when, and why">${esc(actionName(d.suggested_action))}${icon("arrow")}</button>`
          : esc(actionName(d.suggested_action))}</dd></div>
      </dl>
      <p class="fine">A Yes is a reason to review, not a confirmed failure.</p>
      <h3>Why</h3>
      <p class="why">${esc(d.reason)}.</p>
      ${meter(d.readings.operation, "Operation time")}${meter(d.readings.leakage, "Leakage")}
      <p class="confidence ${reduced ? "is-reduced" : ""}">${icon(reduced ? "alert" : "check")}<span>Confidence: ${esc(d.confidence)}</span></p>
      <details class="inputs proof" data-k="evidence"><summary>Show the evidence behind this risk</summary>
        <h4>How records at this risk ended</h4>
        <p>Of ${fmtInt(d.band.n)} past records at this risk, ${d.band.in_30_days}% failed within 30 days and ${d.band.in_12_weeks}% within 12 weeks.</p>
        ${d.factors.length ? `<h4>Where the risk comes from</h4><div class="factors">${d.factors.map((f) => `
          <div class="factor"><span>${esc(f.name)}</span><span class="factor-bar"><i style="width:${f.share}%"></i></span><b>${f.share}%</b></div>`).join("")}</div>` : ""}
        ${d.evidence.pair || d.evidence.op || d.evidence.leak ? `<h4>Similar actuators in the training data</h4><ul class="evidence">
          ${evidence(d.evidence.pair, "these same operation and leakage levels")}${evidence(d.evidence.op, "this operation time level")}${evidence(d.evidence.leak, "this leakage level")}</ul>` : ""}
      </details>`;
  }
  return `${d.scored ? holoHtml(d) : ""}${result}`;
}
// Start the hologram of every record shown inside an element. A picture whose canvas has left the page stops by itself.
function startHolos(container, d) {
  for (const el of container ? container.querySelectorAll("[data-holo]") : []) mountHolo(el, d, { tour: el.classList.contains("holo-big") || !el.dataset.seen });
}
// The same hologram, large, in a window of its own.
function openHolo() {
  const d = v.drawer || v.single;
  if (!d || !d.scored) return;
  v.deciding = { kind: "holo" };
  $("#modal-root").innerHTML = `<div class="scrim scrim-modal scrim-dark" data-r="close-window"></div>
    <div class="modal modal-holo" role="dialog" aria-modal="true" aria-label="Hologram of ${esc(d.aircraft_id)}">
      <header><div><span class="kicker"><span class="mono">${esc(d.aircraft_id)}</span> · nose landing gear actuator</span><h2>${d.scorable ? `${fmtRisk(d.risk)} chance of failing within 30 days` : "No prediction for this record"}</h2></div>
        <button type="button" class="icon-btn" data-r="close-window" aria-label="Close">${icon("x")}</button></header>
      <div class="modal-body">${holoHtml(d, true)}</div>
    </div>`;
  startHolos($("#modal-root"), d);
}
// The data notes and every reading of one record.
function recordNotes(d) {
  const issues = d.issues.length ? `<h3>Data notes</h3><ul class="notes">${d.issues.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  if (api.isPublic) return `${issues}<p class="fine">The raw readings of this record are left out of the public copy.</p>`;
  return `${issues}
    <details class="inputs" data-k="readings"><summary>All readings in this record</summary>
      <dl>${[["Hydraulic fluid grade", d.grade ?? null, ""], ...d.inputs.map((i) => [i.label, i.value, i.unit])].map(([label, value, unit]) => `
        <div><dt>${esc(label)}</dt><dd>${value == null ? '<span class="missing">missing</span>' : `${esc(value)}${unit ? ` <i>${esc(unit)}</i>` : ""}`}</dd></div>`).join("")}</dl></details>`;
}

function renderDrawer() {
  const d = v.drawer;
  if (!d) return;
  const p = d.proposal;
  const proposal = !p ? "" : `
    <div class="drawer-prop is-${p.status}">
      <div><span class="kicker">${p.status === "pending" ? "Proposed by the team" : p.status === "approved" ? "Approved by you" : "Rejected by you"}</span>
        <b>${esc(actionName(p.action))}</b>${p.note ? `<p>${esc(p.note)}</p>` : ""}
        ${p.status === "approved" ? `<p>Work order <span class="mono">${esc(p.work_order_id)}</span> created (simulated).</p>` : ""}
        ${p.status === "rejected" && p.decision_note ? `<p>Your note: ${esc(p.decision_note)}</p>` : ""}
        ${p.action === "repair" ? `<p>${partText(p)}</p>` : ""}
        ${d.plans?.[p.action] ? `<p><button type="button" class="link" data-r="steps" data-kind="${esc(p.action)}">See the steps in detail${icon("arrow")}</button></p>` : ""}</div>
      <div class="drawer-buttons">${p.status === "pending"
        ? `<button type="button" class="btn btn-primary btn-sm" data-r="decision" data-id="${esc(p.id)}">Decide</button>`
        : `<button type="button" class="btn btn-sm" data-r="decision" data-id="${esc(p.id)}">Change</button>`}</div>
    </div>`;
  // repaint keeps a fold the planner opened ("Show the evidence", "All readings") open when the panel is redrawn.
  repaint($("#drawer-root"), `
    <div class="scrim" data-r="close-drawer"></div>
    <aside class="drawer" role="dialog" aria-label="Record ${esc(d.aircraft_id)}">
      <header><div><span class="kicker">Record <span class="mono">${esc(d.record_id)}</span>${d.date ? ` · ${esc(fmtDate(d.date))}` : ""}</span><h2 class="mono">${esc(d.aircraft_id)}</h2></div>
        <button type="button" class="icon-btn" data-r="close-drawer" aria-label="Close">${icon("x")}</button></header>
      <div class="drawer-body">${proposal}${recordResult(d)}${recordNotes(d)}
        ${d.actual ? `<p class="fine">Recorded answer in the file: <b>${d.actual === "Yes" ? "failed within 30 days" : "no failure within 30 days"}</b>.</p>` : ""}</div>
      ${d.scored && !v.playing && !api.isPublic ? `<footer><button type="button" class="btn" data-r="ask-record" ${v.busy ? "disabled" : ""}>Ask the agent about this aircraft</button></footer>` : ""}
    </aside>`);
  startHolos($("#drawer-root"), d);
}

// ---------------------------------------------------------------- the steps for one action, in a window of their own
// Opened from the record panel. It sits in the middle of the screen so the planner's eye goes to what to do next.
function openSteps(kind, record) {
  const d = record || v.drawer || v.single;
  const plan = d?.plans?.[kind];
  if (!plan) return;
  const mine = d.proposal || v.proposals.find((x) => x.record_id === d.record_id && x.status !== "superseded");
  const p = mine && mine.action === kind ? mine : null;
  const who = p ? "Proposed by the team" : kind === d.suggested_action ? "Suggested by the failure model" : "";
  const decide = p?.status === "pending"
    ? `<button type="button" class="btn btn-primary" data-r="decision" data-id="${esc(p.id)}">Decide on this action</button>`
    : p?.status === "approved" ? `<span class="done done-ok">${icon("check")}Approved · work order <span class="mono">${esc(p.work_order_id)}</span> (simulated)</span>`
      : p?.status === "rejected" ? '<span class="done">You rejected this action</span>' : "";
  $("#modal-root").innerHTML = `
    <div class="scrim scrim-modal" data-r="close-steps"></div>
    <div class="modal modal-plan" role="dialog" aria-modal="true" aria-label="${esc(plan.title)}: the steps">
      <header><div>
          <span class="kicker"><span class="mono">${esc(d.aircraft_id)}</span> · ${d.risk != null ? `${fmtRisk(d.risk)} chance of failing within 30 days` : "no prediction"}${who ? ` · ${who}` : ""}</span>
          <h2>${esc(plan.title)}</h2>
          <p>${esc(plan.goal)}</p></div>
        <button type="button" class="icon-btn" data-r="close-steps" aria-label="Close">${icon("x")}</button></header>
      <div class="modal-body">
        <p class="plan-when"><span>Do it by</span><b>${esc(plan.when)}</b></p>
        <ol class="plan-steps">${plan.steps.map((s) => `<li><b>${esc(s.do)}</b>${s.why ? `<span>${esc(s.why)}</span>` : ""}</li>`).join("")}</ol>
        <p class="fine">${esc(plan.scope)}</p>
      </div>
      <footer>${decide}<button type="button" class="btn btn-quiet" data-r="close-steps">Close</button></footer>
    </div>`;
}
function closeSteps() {
  $("#modal-root").innerHTML = "";
}

// ---------------------------------------------------------------- running the agent
function stopPolling() {
  clearTimeout(v.timer);
  v.timer = null;
}
function poll() {
  stopPolling();
  v.timer = setTimeout(async () => {
    if (!v.run) return;
    let run;
    try {
      run = await api.run(v.run.id);
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    if (!v.run || run.id !== v.run.id) return;
    v.run = run;
    if (run.status === "running") {
      paintLive();
      poll();
      return;
    }
    v.busy = false;
    v.run = null;
    if (run.kind === "review") { v.review = run; v.qa = null; v.rec.selected.clear(); } else v.qa = run;
    try { await Promise.all([refreshStatus(), reload()]); } catch (err) { toast(err.message, "error"); }
    if (!here() || state.batchId !== run.batch_id) return;
    if (run.kind === "review") {
      // The picture may still be catching up with the run. It shows the last steps, then calls teamDone.
      if (v.team) { v.team.update(run); repaint($("#live"), timeline(run)); } else teamDone();
    } else if ($("#ask") && $(".wrap")?.dataset.view === view()) {
      paintHead();            // a question can make the agent run the model, which changes the numbers
      paintActions();
      paintAsk();
    } else render();
  }, 450);
}

async function start(body) {
  if (v.busy || !v.batch) return;
  v.busy = true;
  try {
    const { run_id } = await api.startRun({ batch_id: v.batch.id, list_size: v.listSize, selected: v.drawer?.record_id || null,
      screen: { page: "Review", filter: v.rec.issues ? "records with missing readings" : v.rec.level, search: v.rec.search }, ...body });
    v.run = await api.run(run_id);
    if (body.kind === "review") {
      closeDrawer();
      Object.assign(v, { playing: true, replay: false, plain: false, teamAt: {}, catchUp: false });
      render();
      window.scrollTo(0, 0);
    } else {
      closeDrawer();
      paintAsk();
      paintActions();
      $("#ask")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    poll();
  } catch (err) {
    v.busy = false;
    toast(err.message, "error");
    if (body.kind === "review") render();
  }
}

function afterDecision() {
  paintHead();
  paintActions();
  paintTable();
  if (v.drawer) openDrawer(v.drawer.record_id);
}
// `override` changes a decision that was already taken: the server cancels or creates the work order accordingly.
async function decide(id, decision, note, override = false) {
  const before = v.proposals.find((x) => x.id === id);
  try {
    const p = await api.decide(id, decision, note || null, override);
    const text = decision === "approved"
      ? `${override ? "Changed to approved" : "Approved"}. Work order ${p.work_order_id} created (simulated).`
      : override ? `Changed to rejected. Work order ${before?.work_order_id || ""} was cancelled (simulated).` : "Rejected. No work order was created.";
    toast(text, decision === "approved" ? "ok" : "info");
    await reload();
    afterDecision();
  } catch (err) {
    toast(err.message, "error");
    if (err.status === 409) { await reload().catch(() => {}); afterDecision(); }
  }
}
async function decideMany(decision, action) {
  try {
    const done = await api.decideMany(v.batch.id, { decision, action: action || null });
    toast(`${plural(done.length, "action")} ${decision}. ${decision === "approved" ? "Simulated work orders were created." : ""}`, "ok");
    await reload();
    afterDecision();
  } catch (err) {
    toast(err.message, "error");
  }
}
async function decideRequest(id, decision, note, override = false) {
  try {
    await api.decidePartsRequest(id, decision, note || null, override);
    const text = decision === "approved"
      ? `${override ? "Changed to approved." : ""} Parts request ${id} ${override ? "is" : "approved. It is"} marked as sent to the supply department (simulated).`
      : override ? `Changed to rejected. Parts request ${id} is withdrawn (simulated).` : `Parts request ${id} rejected. Nothing was requested.`;
    toast(text.trim(), decision === "approved" ? "ok" : "info");
  } catch (err) {
    toast(err.message, "error");
  }
  await reload().catch(() => {});
  afterDecision();
}

// ---------------------------------------------------------------- deciding: a small window with the facts and two buttons
// Where a repair's spare part comes from, as a short phrase. `long` adds the due date for the decision window.
function partText(p, long = false) {
  if (p.action !== "repair") return "";
  const part = p.part;
  if (!part) return '<span class="part part-unknown">Part not checked</span>';
  const due = part.due_days ? ` The repair is due within ${part.due_days} days.` : "";
  if (part.status === "in_store") return `<span class="part part-store"><i></i>Part in the store</span>${long ? " A spare actuator is set aside in the hangar store (simulated)." : ""}`;
  if (part.status === "requested") {
    const when = part.eta_days == null ? "No delivery date" : `Part in ${part.eta_days} days`;
    const cls = part.late ? "part-late" : "part-sent";
    const more = part.eta_days == null ? ` No source can give a delivery date (request ${esc(part.request_id || "")}).${due}`
      : ` Requested from the ${esc(String(part.source_name || "").toLowerCase())} (request ${esc(part.request_id || "")}).${part.late ? ` That is after the repair is due.${due}` : " That is in time."}`;
    return `<span class="part ${cls}"><i></i>${when}${part.late && part.eta_days != null ? ", late" : ""}</span>${long ? more : ""}`;
  }
  return `<span class="part part-late"><i></i>No part</span>${long ? ` There is no spare actuator for this repair yet.${due}` : ""}`;
}

// What is wrong with a request's timing, in a sentence: parts that arrive after the repair is due, and parts with no date at all.
function lateText(r) {
  const undated = r.lines.filter((l) => l.delivery_days == null).reduce((sum, l) => sum + l.quantity, 0);
  const dated = r.lines.filter((l) => l.delivery_days != null).reduce((sum, l) => sum + (l.late || 0), 0);
  return [dated ? `${plural(dated, "part")} would arrive after the repair is due.` : "",
    undated ? `${plural(undated, "part")} ${undated === 1 ? "has" : "have"} no delivery date.` : ""].filter(Boolean).join(" ");
}

function closeWindow() {
  v.deciding = null;
  $("#modal-root").innerHTML = "";
}
function windowHtml(title, kicker, body, footer, wide = false) {
  return `<div class="scrim scrim-modal" data-r="close-window"></div>
    <div class="modal ${wide ? "" : "modal-plan"}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><div>${kicker ? `<span class="kicker">${kicker}</span>` : ""}<h2>${esc(title)}</h2></div>
        <button type="button" class="icon-btn" data-r="close-window" aria-label="Close">${icon("x")}</button></header>
      <div class="modal-body">${body}</div>
      ${footer ? `<footer>${footer}</footer>` : ""}
    </div>`;
}

// The second line under a repair's part status: where the part is, or when it comes.
function partMore(p) {
  const part = p.part;
  if (!part) return "The store was not checked.";
  if (part.status === "in_store") return "Set aside in the hangar store (simulated).";
  if (part.status === "requested") {
    if (part.eta_days == null) return "No source can give a delivery date yet.";
    const from = `From the ${esc(String(part.source_name || "supply department").toLowerCase())}.`;
    return part.late ? `${from} The repair is due within ${part.due_days} days.` : `${from} In time for the repair.`;
  }
  return "There is no spare actuator for this repair yet.";
}

// The small window every decision is taken in.
function decideShell(kicker, title, body, buttons, foot) {
  return `<div class="scrim scrim-modal" data-r="close-window"></div>
    <div class="modal modal-decide" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><div><span class="kicker">${kicker}</span><h2>${esc(title)}</h2></div>
        <button type="button" class="icon-btn" data-r="close-window" aria-label="Close">${icon("x")}</button></header>
      <div class="modal-body">${body}</div>
      <div class="decide-buttons">${buttons}</div>
      <div class="decide-foot">${foot}</div>
    </div>`;
}
const SURE_BUTTONS = `<button type="button" class="btn btn-danger" data-r="confirm-reject">Yes, reject it</button>
  <button type="button" class="btn" data-r="decision-back">No, go back</button>`;

// One proposed action: the three facts behind it, then the decision. A pending action is approved or rejected;
// a decision already taken can be changed. A rejection always asks "Are you sure?" first.
function openDecision(proposalId) {
  const p = v.proposals.find((x) => x.id === proposalId);
  if (!p || !["pending", "approved", "rejected"].includes(p.status)) return;
  v.deciding = { kind: "proposal", id: p.id, sure: false };
  paintDecision();
}
function paintDecision() {
  const d = v.deciding;
  const p = d && d.kind === "proposal" ? v.proposals.find((x) => x.id === d.id) : null;
  if (!p) { closeWindow(); return; }
  const action = actionName(p.action), who = `<span class="mono">${esc(p.aircraft_id)}</span>`;
  if (d.sure) {
    const lose = p.status === "approved" ? `Work order <b class="mono">${esc(p.work_order_id)}</b> will be cancelled.` : "No work order will be created.";
    const stays = p.risk != null ? ` The aircraft stays at <b>${fmtRisk(p.risk)}</b> risk of failing within 30 days.` : "";
    $("#modal-root").innerHTML = decideShell(`${who} · ${esc(action)}`, "Are you sure?",
      `<p class="sure">You are rejecting <b>${esc(action.toLowerCase())}</b> for ${who}. ${lose}${stays}</p>`, SURE_BUTTONS, "<span>You can change this decision later.</span>");
    return;
  }
  const risk = p.risk != null
    ? `<b class="t-${LEVEL_CLASS[p.level] || "low"}">${fmtRisk(p.risk)}</b> chance of failing within 30 days${p.time_left ? `<small>Typically fails in ${esc(p.time_left)}</small>` : ""}`
    : "No prediction<small>A key reading is missing</small>";
  const facts = `<dl class="decide-facts">
      <div><dt>Risk</dt><dd>${risk}</dd></div>
      <div><dt>Why</dt><dd>${esc(p.reason || "No reason was recorded")}</dd></div>
      ${p.action === "repair" ? `<div><dt>Spare part</dt><dd>${partText(p)}<small>${partMore(p)}</small></dd></div>` : ""}
    </dl>`;
  const steps = `<button type="button" class="link" data-r="steps-for" data-id="${esc(p.record_id)}" data-kind="${esc(p.action)}">See the steps${icon("arrow")}</button>`;
  if (p.status === "pending") {
    $("#modal-root").innerHTML = decideShell(`${who} · proposed by the team`, `${action}?`, facts,
      `<button type="button" class="btn btn-primary" data-r="confirm-approve">Approve</button>
       <button type="button" class="btn btn-reject" data-r="ask-reject">Reject</button>`,
      `<span>Approving creates a simulated work order.</span>${steps}`);
  } else if (p.status === "approved") {
    $("#modal-root").innerHTML = decideShell(`${who} · your decision`, action,
      `<p class="decided decided-ok">${icon("check")}<span>You approved this. Work order <b class="mono">${esc(p.work_order_id)}</b> (simulated).</span></p>${facts}`,
      `<button type="button" class="btn" data-r="close-window">Keep it approved</button>
       <button type="button" class="btn btn-reject" data-r="ask-reject">Change to rejected</button>`,
      `<span>Rejecting cancels the work order.</span>${steps}`);
  } else {
    $("#modal-root").innerHTML = decideShell(`${who} · your decision`, action,
      `<p class="decided"><span>You rejected this. There is no work order for it.</span></p>${facts}`,
      `<button type="button" class="btn btn-primary" data-r="confirm-approve">Change to approved</button>
       <button type="button" class="btn" data-r="close-window">Keep it rejected</button>`,
      `<span>Approving creates a simulated work order.</span>${steps}`);
  }
}

// The Supply agent's request to the supply department. Decided and changed the same way as an action.
function openRequest(id) {
  if (!v.requests.some((x) => x.id === id)) return;
  v.deciding = { kind: "request", id, sure: false };
  paintRequest();
}
function paintRequest() {
  const d = v.deciding;
  const r = d && d.kind === "request" ? v.requests.find((x) => x.id === d.id) : null;
  if (!r) { closeWindow(); return; }
  const total = r.lines.reduce((sum, l) => sum + l.quantity, 0);
  if (d.sure) {
    const lose = r.status === "approved" ? "It is marked as sent now, and will be withdrawn." : "Nothing will be requested.";
    $("#modal-root").innerHTML = decideShell(`Parts request <span class="mono">${esc(r.id)}</span>`, "Are you sure?",
      `<p class="sure">You are rejecting the request for <b>${plural(total, "spare actuator")}</b>. ${lose} ${plural(total, "repair")} ${total === 1 ? "stays" : "stay"} without a part.</p>`,
      SURE_BUTTONS, "<span>You can change this decision later.</span>");
    return;
  }
  const body = `
    <p class="decision-why"><b>${plural(total, "spare actuator")}</b> for the repairs the hangar store cannot cover.${r.note ? ` <span class="muted">${esc(r.note)}</span>` : ""}</p>
    <div class="table-wrap"><table><thead><tr><th>From</th><th>Units</th><th>Arrives in</th><th>For aircraft</th></tr></thead><tbody>
      ${r.lines.map((l) => `<tr><td><b>${esc(l.source_name)}</b></td><td>${fmtInt(l.quantity)}</td>
        <td>${l.delivery_days == null ? '<span class="st st-bad">No delivery date</span>' : `${l.delivery_days} days`}${l.late && l.delivery_days != null ? ` <span class="st st-bad">· ${fmtInt(l.late)} after the repair is due</span>` : ""}</td>
        <td class="c-why"><span class="mono">${l.aircraft.slice(0, 4).map(esc).join(", ")}${l.aircraft.length > 4 ? ` and ${l.aircraft.length - 4} more` : ""}</span></td></tr>`).join("")}
    </tbody></table></div>
    ${lateText(r) ? `<div class="callout callout-warn"><p><b>${lateText(r)}</b> Those aircraft stay at risk until the part is in.</p></div>` : ""}
    <p class="fine">The supply department and its delivery times are simulated. Approving marks the request as sent; nothing is ordered anywhere.</p>`;
  const footer = r.status === "pending"
    ? `<button type="button" class="btn btn-primary" data-r="request-approve">Approve the request</button>
       <button type="button" class="btn btn-reject" data-r="ask-reject">Reject</button>
       <button type="button" class="btn btn-quiet" data-r="close-window">Not now</button>`
    : r.status === "approved"
      ? `<span class="done done-ok">${icon("check")}You approved this · marked as sent (simulated)</span>
         <button type="button" class="btn btn-reject" data-r="ask-reject">Change to rejected</button>
         <button type="button" class="btn btn-quiet" data-r="close-window">Close</button>`
      : `<span class="done">You rejected this request</span>
         <button type="button" class="btn btn-primary" data-r="request-approve">Change to approved</button>
         <button type="button" class="btn btn-quiet" data-r="close-window">Close</button>`;
  $("#modal-root").innerHTML = windowHtml(`Parts request ${r.id}`, r.status === "pending" ? "Drafted by the Supply agent · waits for your approval" : "Drafted by the Supply agent · your decision", body, footer, true);
}

// Approving many at once still asks first, and says what it means for parts.
function openBulk(kind) {
  const mine = v.proposals.filter((p) => p.status === "pending" && (!kind || p.action === kind));
  if (!mine.length) return;
  v.deciding = { kind: "bulk", action: kind || null };
  const repairs = mine.filter((p) => p.action === "repair");
  const noPart = repairs.filter((p) => p.part && p.part.status !== "in_store").length;
  const lines = ["repair", "inspect", "retest"].map((a) => { const n = mine.filter((p) => p.action === a).length; return n ? `<li><b>${fmtInt(n)}</b> × ${esc(actionName(a))}</li>` : ""; }).join("");
  const body = `<ul class="bulk">${lines}</ul>
    ${noPart ? `<div class="callout callout-warn"><p><b>${plural(noPart, "repair")} ${noPart === 1 ? "does" : "do"} not have a part in the store.</b> The work order is created, but the repair cannot start until the part arrives.</p></div>` : ""}
    <p class="fine">This creates ${plural(mine.length, "simulated work order")} inside AcuMain. No aircraft or maintenance system is contacted.</p>`;
  $("#modal-root").innerHTML = windowHtml(`Approve ${plural(mine.length, "action")}?`, "One decision for all of them", body,
    `<button type="button" class="btn btn-primary" data-r="confirm-bulk">Approve all ${fmtInt(mine.length)}</button><button type="button" class="btn btn-quiet" data-r="close-window">Cancel</button>`);
}

// A long text from an agent, in a window of its own, so the page keeps only the short version.
function openText(title, kicker, text) {
  v.deciding = { kind: "text" };
  $("#modal-root").innerHTML = windowHtml(title, kicker, `<div class="md md-full">${markdown(text)}</div>`,
    '<button type="button" class="btn btn-quiet" data-r="close-window">Close</button>', true);
}

// ---------------------------------------------------------------- events
document.addEventListener("click", async (ev) => {
  if (ev.target.closest("[data-r-check]")) { ev.stopPropagation(); return; }      // handled by the change event
  const el = ev.target.closest("[data-r]");
  if (!el || !here()) return;
  const act = el.dataset.r;
  if (act === "check-one") { openCheck((made) => choose(made.id)); return; }
  if (act === "use") { choose(el.dataset.id); return; }
  if (act === "remove") { v.removing = el.dataset.id; renderStart(); return; }
  if (act === "remove-no") { v.removing = null; renderStart(); return; }
  if (act === "remove-yes") {
    try { await api.removeBatch(el.dataset.id); toast("The file and its results were removed.", "ok"); } catch (err) { toast(err.message, "error"); }
    v.removing = null;
    await refreshBatches();
    renderStart();
    return;
  }
  if (!v.batch) return;
  if (act === "review") {
    start({ kind: "review", record_ids: v.rec.selected.size ? [...v.rec.selected] : null });
  } else if (act === "toggle-records") {
    if (v.rec.open) { v.rec.open = false; paintRecords(); } else await openRecords();
  } else if (act === "filter") {
    await openRecords(el.dataset.level);
    if (el.classList.contains("fig")) $("#records").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (act === "page") {
    v.rec.offset = Math.max(0, v.rec.offset + Number(el.dataset.dir) * PAGE_SIZE);
    try { await loadRecords(); } catch (err) { toast(err.message, "error"); return; }
    paintTable();
    $("#records").scrollIntoView({ block: "start" });
  } else if (act === "clear-selection") {
    v.rec.selected.clear();
    syncSelection();
  } else if (act === "open") {
    openDrawer(el.dataset.id);
  } else if (act === "close-drawer") {
    closeDrawer();
  } else if (act === "steps") {
    openSteps(el.dataset.kind);
  } else if (act === "close-steps") {
    closeSteps();
  } else if (act === "decision") {
    openDecision(el.dataset.id);
  } else if (act === "ask-reject" || act === "decision-back") {
    if (!v.deciding) return;
    v.deciding.sure = act === "ask-reject";
    if (v.deciding.kind === "request") paintRequest(); else paintDecision();
  } else if (act === "confirm-approve") {
    const p = v.deciding && v.proposals.find((x) => x.id === v.deciding.id);
    closeWindow();
    if (p) decide(p.id, "approved", null, p.status === "rejected");
  } else if (act === "confirm-reject") {
    const d = v.deciding;
    closeWindow();
    if (d?.kind === "request") {
      const r = v.requests.find((x) => x.id === d.id);
      if (r) decideRequest(r.id, "rejected", null, r.status === "approved");
    } else if (d) {
      const p = v.proposals.find((x) => x.id === d.id);
      if (p) decide(p.id, "rejected", null, p.status === "approved");
    }
  } else if (act === "steps-for") {
    try { openSteps(el.dataset.kind, await api.record(v.batch.id, el.dataset.id)); } catch (err) { toast(err.message, "error"); }
  } else if (act === "request") {
    openRequest(el.dataset.id);
  } else if (act === "request-approve") {
    const r = v.deciding && v.requests.find((x) => x.id === v.deciding.id);
    closeWindow();
    if (r) decideRequest(r.id, "approved", null, r.status === "rejected");
  } else if (act === "bulk") {
    openBulk(el.dataset.kind);
  } else if (act === "confirm-bulk") {
    const kind = v.deciding.action;
    closeWindow();
    decideMany("approved", kind);
  } else if (act === "holo-big") {
    openHolo();
  } else if (act === "close-window") {
    closeWindow();
  } else if (act === "read") {
    if (el.dataset.what === "note" && v.review) openText("The team's note", `Written by the orchestrator · ${runMeta(v.review)}`, v.review.final_text);
    else if (v.qa) openText(v.qa.task, `The agent's answer · ${runMeta(v.qa)}`, v.qa.final_text);
  } else if (act === "replay") {
    if (!v.review || v.busy) return;
    Object.assign(v, { playing: true, replay: true, plain: false, teamAt: {} });
    closeDrawer();
    render();
    window.scrollTo(0, 0);
  } else if (act === "dismiss-qa") {
    v.qa = null;
    paintAsk();
  } else if (act === "suggest") {
    start({ kind: "question", question: el.textContent.trim() });
  } else if (act === "ask-record") {
    const who = v.drawer.aircraft_id;
    start({ kind: "question", question: `Explain the result for ${who} in plain words. What would you do with it, and how sure can I be?` });
  }
});

// The team screen's own button: leave the picture. While the review is still running that shows the plain trail.
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("[data-team='skip']") || !here() || !v.batch) return;
  if (v.run?.kind === "review") {
    Object.assign(v, { plain: true });
    render();
  } else teamDone();
});

document.addEventListener("change", (ev) => {
  if (!here()) return;
  if (ev.target.id === "file") { upload(ev.target.files[0]); return; }
  const check = ev.target.closest("[data-r-check]");
  if (!check || !v.batch) return;
  const key = check.dataset.rCheck;
  const ids = key === "page" ? v.rec.data.rows.map((x) => x.record_id) : [key];
  for (const id of ids) {
    if (check.checked) {
      if (v.rec.selected.size >= state.meta.limits.max_selected) { toast(`You can select up to ${state.meta.limits.max_selected} records.`, "info"); break; }
      v.rec.selected.add(id);
    } else v.rec.selected.delete(id);
  }
  syncSelection();
});

// The main button follows the selection: with records ticked it reviews only those.
function syncSelection() {
  paintTable();
  if (view() === "result") { paintActions(); return; }
  const button = $(".go-row [data-r='review']");
  const n = v.rec.selected.size;
  if (button) button.textContent = n ? `Review ${plural(n, "selected record")}` : view() === "failed" ? "Try again" : "Review records";
}

document.addEventListener("input", (ev) => {
  if (!here() || !v.batch) return;
  if (ev.target.id === "list-size") {
    const n = Number(ev.target.value);
    if (Number.isFinite(n) && n >= 1) v.listSize = Math.min(state.meta.limits.max_list_size, Math.round(n));
  } else if (ev.target.id === "search") {
    clearTimeout(v.searchTimer);
    v.searchTimer = setTimeout(async () => {
      v.rec.search = ev.target.value.trim();
      v.rec.offset = 0;
      try { await loadRecords(); paintTable(); } catch (err) { toast(err.message, "error"); }
    }, 220);
  }
});

document.addEventListener("submit", (ev) => {
  if (ev.target.dataset.rForm !== "ask") return;
  ev.preventDefault();
  const text = $("#question").value.trim();
  if (!text) { toast("Type a question first.", "info"); return; }
  $("#question").value = "";
  start({ kind: "question", question: text });
});

document.addEventListener("keydown", (ev) => {
  if (!here()) return;
  if (ev.key === "Escape" && v.drawer && !$("#modal-root").innerHTML) closeDrawer();
  const row = ev.target.closest && ev.target.closest("tr[data-r='open']");
  if (row && (ev.key === "Enter" || ev.key === " ") && ev.target === row) { ev.preventDefault(); openDrawer(row.dataset.id); }
});

for (const type of ["dragover", "dragleave", "drop"]) {
  document.addEventListener(type, (ev) => {
    const drop = ev.target.closest && ev.target.closest("#drop");
    if (!drop) return;
    ev.preventDefault();
    drop.classList.toggle("is-over", type === "dragover");
    if (type === "drop" && ev.dataTransfer.files.length) upload(ev.dataTransfer.files[0]);
  });
}

// The page for a failed review offers to switch the model back on; it follows the switch when it changes.
document.addEventListener("acumain:status", () => {
  const outage = !!state.health?.model?.simulated_outage;
  if (outage === v.outage) return;
  v.outage = outage;
  if (here() && v.batch && !v.run && view() === "failed") render();
});
