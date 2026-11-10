// The review queue: the records, the assistant that drafts the action list, and the planner's approvals.
import { api } from "./api.js";
import { currentBatch, refreshBatches, refreshStatus, state } from "./main.js";
import { $, ACTION_ICON, LEVEL_CLASS, empty, esc, fmtDate, fmtInt, fmtRisk, icon, levelPill, markdown, modelName, plural, riskBar, toast } from "./ui.js";
import { STAGES, runMeta, stages, timeline } from "./steps.js";
import { openAddRecords } from "./records.js";

const PAGE_SIZE = 50;
const q = {
  level: "Any", issues: false, search: "", offset: 0, records: { total: 0, rows: [] }, selected: new Set(),
  proposals: [], tab: "actions", timer: null, listSize: 25, drawer: null, busy: false, searchTimer: null,
  run: null,        // the run being followed, or the most recent one: its steps fill the "Assistant steps" tab
  review: null,     // the latest finished review: its summary stays at the top
  qa: null,         // the latest answered question, shown under the summary until dismissed
};
const batch = () => currentBatch();
const actionName = (a) => state.meta.actions[a] || a;
const onQueue = () => state.page === "queue";

// ---------------------------------------------------------------- loading
export async function show(arg) {
  Object.assign(q, { level: "Any", issues: false, search: "", offset: 0, selected: new Set(), drawer: null, run: null, review: null, qa: null });
  $("#drawer-root").innerHTML = "";
  stopPolling();
  if (!batch()) {
    $("#page").innerHTML = empty("No records yet", "Add a file of diagnostic records to start a review.", "upload",
      `<button type="button" class="btn btn-primary" data-q="add">${icon("plus")}Add records</button>`);
    return;
  }
  $("#page").innerHTML = `
    <section class="assist card" id="assist"></section>
    <section class="kpis" id="kpis"></section>
    <div class="split">
      <section class="card records" aria-label="Records">
        <div class="toolbar" id="toolbar"></div>
        <div id="table"></div>
        <div class="pager" id="pager"></div>
      </section>
      <aside class="card side" id="side" aria-label="Action list and assistant"></aside>
    </div>`;
  renderToolbar();
  const [runs] = await Promise.all([api.runs(60), loadRecords(), loadProposals()]);
  const mine = runs.filter((r) => r.batch_id === state.batchId && !r.archived);
  const lastReview = mine.find((r) => r.kind === "review" && r.status !== "running");
  const lastQuestion = mine.find((r) => r.kind === "question" && r.status !== "running");
  const full = new Map();
  const load = async (r) => { if (r && !full.has(r.id)) full.set(r.id, await api.run(r.id)); return r ? full.get(r.id) : null; };
  q.run = await load(mine[0]);
  q.review = await load(lastReview);
  // An answer is shown only if it came after the review it talks about.
  q.qa = lastQuestion && (!lastReview || lastQuestion.started_at >= lastReview.started_at) ? await load(lastQuestion) : null;
  renderAll();
  if (q.run?.status === "running") poll();
  if (arg === "add") openAddRecords(added);
  else if (arg) openDrawer(arg);
}

async function added(made) {
  state.batchId = made.id;
  await refreshBatches();
  show();
}

async function loadRecords() {
  q.records = await api.records(state.batchId, {
    level: q.level === "Any" ? null : q.level, issues: q.issues, q: q.search, offset: q.offset, limit: PAGE_SIZE,
  });
}
async function loadProposals() {
  q.proposals = await api.proposals(state.batchId);
}
async function reload() {
  await Promise.all([refreshBatches(), loadRecords(), loadProposals()]);
  renderAll();
}
function renderAll() {
  if (!onQueue() || !$("#assist")) return;
  renderAssist();
  renderKpis();
  renderFilters();
  renderTable();
  renderSide();
}

// ---------------------------------------------------------------- the assistant bar
function modeChip() {
  const a = state.health.agent;
  return a.mode === "claude"
    ? `<span class="chip chip-accent" data-tip="Assistant|Claude decides which tool to call next and writes the summary.">${icon("spark")}${esc(modelName(a.model))}</span>`
    : `<span class="chip" data-tip="Assistant|${esc(a.reason || "The built-in planner calls the same tools in a fixed order. It costs nothing.")}">${icon("cpu")}Built-in planner</span>`;
}

function renderAssist() {
  const b = batch();
  const run = q.run;
  const selected = q.selected.size;
  const label = selected ? `Review ${plural(selected, "selected record")}` : b.scored ? "Prepare the list again" : "Prepare action list";
  const controls = `
    <div class="assist-controls">
      <label class="stepper" data-tip="List size|How many actions the assistant may propose in one go. The most urgent come first.">
        <span>List size</span>
        <button type="button" data-q="size" data-step="-5" aria-label="Fewer">−</button>
        <input type="number" id="list-size" min="1" max="${state.meta.limits.max_list_size}" value="${q.listSize}" aria-label="List size">
        <button type="button" data-q="size" data-step="5" aria-label="More">+</button>
      </label>
      <button type="button" class="btn btn-primary btn-lg" data-q="review" ${q.busy ? "disabled" : ""}>${icon("spark")}${label}</button>
    </div>`;

  let body;
  if (run?.status === "running") {
    const st = stages(run);
    const review = run.kind === "review";
    const latest = [...run.steps].reverse().find((s) => s.type !== "notice");
    body = `
      <div class="assist-main">
        <div class="assist-head"><span class="spinner"></span><h2>${review ? "The assistant is preparing your action list" : "The assistant is looking into your question"}</h2>${modeChip()}</div>
        ${review ? `<ol class="stages">${STAGES.map((s, i) => `<li class="stage stage-${st[i]}"><span class="stage-dot">${st[i] === "done" ? icon("check") : st[i] === "failed" ? icon("x") : ""}</span>${s.label}</li>`).join("")}</ol>` : ""}
        <p class="assist-sub">${latest ? esc(latest.type === "tool" ? `Tool: ${latest.name}` : "Deciding the next step") : "Starting"} · every step is saved in the activity log.</p>
      </div>`;
  } else if (q.review?.status === "failed") {
    body = `
      <div class="assist-main">
        <div class="assist-head">${icon("alert", "bad")}<h2>The assistant stopped before finishing</h2>${modeChip()}</div>
        <p class="assist-sub">${esc(q.review.error || "An unexpected error ended the run.")} Nothing was approved or executed. You can run it again.</p>
      </div>${controls}`;
  } else if (q.review) {
    body = `
      <div class="assist-main">
        <div class="assist-head">${icon("spark", "accent")}<h2>The assistant's summary</h2>${modeChip()}</div>
        ${summary(q.review.final_text, false)}
        <p class="assist-meta">${runMeta(q.review)} · <button type="button" class="link" data-q="tab" data-tab="assistant">See every step</button></p>
      </div>${controls}`;
  } else {
    body = `
      <div class="assist-main">
        <div class="assist-head">${icon("spark", "accent")}<h2>${b.scored ? "This batch has results" : `${plural(b.records, "record")} waiting for review`}</h2>${modeChip()}</div>
        <p class="assist-sub">The assistant checks the data, runs the failure model, and drafts an action list with reasons.
          Nothing is carried out until you approve it${b.with_issues ? `, and ${fmtInt(b.with_issues)} records with a missing reading are reported, not hidden` : ""}.</p>
      </div>${controls}`;
  }
  const ask = run?.status === "running" ? "" : `
    <form class="ask" data-q-form="ask">
      ${icon("send")}<input type="text" id="question" maxlength="600" autocomplete="off"
        placeholder="${q.drawer ? `Ask about ${esc(q.drawer.aircraft_id)} or this batch…` : "Ask the assistant about this batch, for example: how far can I trust these predictions?"}" aria-label="Question for the assistant">
      <button type="submit" class="btn btn-secondary btn-sm" ${q.busy ? "disabled" : ""}>Ask</button>
    </form>`;
  const answer = q.qa && run?.status !== "running" ? `
    <div class="qa ${q.qa.status === "failed" ? "is-failed" : ""}">
      <div class="qa-q">${icon("send")}<span>${esc(q.qa.task)}</span>
        <button type="button" class="icon-btn" data-q="dismiss-qa" aria-label="Dismiss this answer">${icon("x")}</button></div>
      <div class="md">${q.qa.status === "failed" ? `<p>The assistant could not answer: ${esc(q.qa.error || "unknown error")}</p>` : markdown(q.qa.final_text)}</div>
      <p class="assist-meta">${runMeta(q.qa)}</p>
    </div>` : "";
  const keep = $("#question")?.value ?? "";
  const focused = document.activeElement?.id === "question";
  const more = $("#assist details.more");
  if (more) q.summaryOpen = more.open;
  $("#assist").innerHTML = `<div class="assist-top">${body}</div>${answer}${ask}`;
  if ($("#question")) { $("#question").value = keep; if (focused) $("#question").focus(); }
}

// A review summary shows its headline; the rest opens on request, so the records stay in view.
function summary(text, whole) {
  const parts = String(text || "").trim().split(/\n\s*\n/);
  if (whole || parts.length < 2 || String(text).length < 520) return `<div class="md">${markdown(text)}</div>`;
  return `<div class="md">${markdown(parts[0])}</div>
    <details class="more" ${q.summaryOpen ? "open" : ""}><summary>Read the full summary</summary><div class="md">${markdown(parts.slice(1).join("\n\n"))}</div></details>`;
}

// ---------------------------------------------------------------- numbers
function renderKpis() {
  const b = batch();
  const kpi = (key, label, value, sub, tone, active) => `
    <button type="button" class="kpi kpi-${tone} ${active ? "is-active" : ""}" ${key ? `data-q="filter" data-level="${key}"` : "disabled"}>
      <span class="kpi-label">${label}</span><span class="kpi-value">${value}</span><span class="kpi-sub">${sub}</span></button>`;
  const t = state.meta.thresholds;
  if (!b.scored) {
    $("#kpis").innerHTML =
      kpi("Any", "Records", fmtInt(b.records), "Not scored yet", "plain", q.level === "Any" && !q.issues) +
      kpi(null, "Predicted to fail", "–", "Run the assistant to see", "muted") + kpi(null, "Watch", "–", "", "muted") +
      kpi("Issues", "Missing readings", fmtInt(b.with_issues), `${fmtInt(b.not_scorable)} cannot be scored`, "plain", q.issues) +
      kpi(null, "Expected failures, 30 days", "–", "", "muted");
    return;
  }
  const L = b.levels;
  $("#kpis").innerHTML =
    kpi("High", "Predicted to fail", fmtInt(L.High), `Risk ${t.high}% or more`, "high", q.level === "High") +
    kpi("Medium", "Watch", fmtInt(L.Medium), `Risk ${t.medium}% to ${t.high}%`, "medium", q.level === "Medium") +
    kpi("Low", "Low risk", fmtInt(L.Low), "No action needed", "low", q.level === "Low") +
    kpi("Issues", "Missing readings", fmtInt(b.with_issues), `${fmtInt(L["Not scored"])} could not be scored`, "plain", q.issues) +
    kpi(null, "Expected failures, 30 days", fmtInt(b.expected_failures), "If nothing is done", "plain") +
    (b.answer_check ? `<p class="answer-check">${icon("shield")}This file included the real answers. On its ${fmtInt(b.answer_check.records)} records the model caught
      ${fmtInt(b.answer_check.caught)} of ${fmtInt(b.answer_check.caught + b.answer_check.missed)} failures with ${fmtInt(b.answer_check.false_alarms)} false alarms
      (F1 ${b.answer_check.f1}, accuracy ${b.answer_check.accuracy}%).</p>` : "");
}

// ---------------------------------------------------------------- records table
const FILTERS = [["Any", "All"], ["High", "High"], ["Medium", "Medium"], ["Low", "Low"], ["Not scored", "Not scored"]];

function renderToolbar() {
  $("#toolbar").innerHTML = `
    <div class="seg" id="filters" role="group" aria-label="Filter by risk level"></div>
    <label class="search">${icon("search")}<input type="search" id="search" placeholder="Find an aircraft or record ID" aria-label="Find an aircraft or record ID"></label>`;
  renderFilters();
}
function renderFilters() {
  const scored = batch().scored;
  $("#filters").innerHTML = FILTERS.filter(([k]) => scored || k === "Any" || k === "Not scored").map(([key, label]) => `
    <button type="button" data-q="filter" data-level="${key}" aria-pressed="${!q.issues && q.level === key}">${label}</button>`).join("") +
    `<button type="button" data-q="filter" data-level="Issues" aria-pressed="${q.issues}">Missing readings</button>`;
}

function proposalChip(p) {
  if (!p) return "";
  const cls = p.status === "approved" ? "ok" : p.status === "rejected" ? "off" : "pending";
  const text = p.status === "approved" ? `Approved · ${esc(p.work_order_id)}` : p.status === "rejected" ? "Rejected" : "Awaiting your approval";
  const short = { repair: "Repair", inspect: "Inspect", retest: "Retest" }[p.action] || actionName(p.action);
  return `<span class="tag tag-${cls}" data-tip="${esc(actionName(p.action))}|${text}">${icon(p.status === "approved" ? "check" : ACTION_ICON[p.action] || "dot")}${esc(short)}</span>`;
}

function renderTable() {
  const b = batch();
  const rows = q.records.rows;
  if (!rows.length) {
    $("#table").innerHTML = empty("No records match", q.search ? `Nothing matches “${q.search}”.` : "Try another filter.", "search");
    $("#pager").innerHTML = "";
    return;
  }
  const allOnPage = rows.every((r) => q.selected.has(r.record_id));
  const note = (r) => (r.issues ? `<span class="warn-ic" data-tip="Data note|${plural(r.issues, "reading")} missing or unusable">${icon("alert")}</span>` : "");
  const lead = (r) => `
      <td class="c-check"><input type="checkbox" data-q-check="${esc(r.record_id)}" ${q.selected.has(r.record_id) ? "checked" : ""} aria-label="Select ${esc(r.aircraft_id)}"></td>
      <td><span class="ac">${esc(r.aircraft_id)}</span><span class="sub">${esc(fmtDate(r.date))}</span></td>`;
  const open = (r) => `<tr data-q="open" data-id="${esc(r.record_id)}" tabindex="0" class="${q.drawer?.record_id === r.record_id ? "is-open" : ""}">`;
  // Before the model has run there is nothing to rank, so the table shows only what is known: the record and its data.
  const row = b.scored ? (r) => `${open(r)}${lead(r)}
      <td class="c-risk">${riskBar(r.risk, r.level)}</td>
      <td>${levelPill(r.level)}</td>
      <td class="c-why">${esc(r.reason || "")}${note(r)}</td>
      <td class="c-time">${r.time_left ? esc(r.time_left) : '<span class="muted">–</span>'}</td>
      <td class="c-action">${proposalChip(r.proposal)}</td></tr>`
    : (r) => `${open(r)}${lead(r)}
      <td>${levelPill(r.level)}</td>
      <td class="c-why">${r.issues ? `${plural(r.issues, "reading")} missing or unusable${note(r)}` : '<span class="muted">All readings present</span>'}</td>
      <td class="c-go">${icon("chevron")}</td></tr>`;
  const head = b.scored
    ? '<th>Aircraft</th><th>Risk, 30 days</th><th>Level</th><th>Why</th><th class="c-time">Typically fails in</th><th>Proposed</th>'
    : "<th>Aircraft</th><th>Status</th><th>Data</th><th></th>";
  $("#table").innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="c-check"><input type="checkbox" data-q-check="page" ${allOnPage ? "checked" : ""} aria-label="Select every record on this page"></th>${head}
      </tr></thead>
      <tbody>${rows.map(row).join("")}</tbody></table></div>`;
  const from = q.offset + 1, to = q.offset + rows.length;
  $("#pager").innerHTML = `
    <span>${q.selected.size ? `<b>${plural(q.selected.size, "record")} selected</b> · <button type="button" class="link" data-q="clear-selection">Clear</button>` : `${fmtInt(from)} to ${fmtInt(to)} of ${fmtInt(q.records.total)}`}</span>
    <span class="pager-buttons">
      <button type="button" class="btn btn-ghost btn-sm" data-q="page" data-dir="-1" ${q.offset === 0 ? "disabled" : ""}>Previous</button>
      <button type="button" class="btn btn-ghost btn-sm" data-q="page" data-dir="1" ${to >= q.records.total ? "disabled" : ""}>Next</button></span>`;
}

// ---------------------------------------------------------------- side panel: action list and assistant steps
function renderSide() {
  const pending = q.proposals.filter((p) => p.status === "pending").length;
  $("#side").innerHTML = `
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-q="tab" data-tab="actions" aria-selected="${q.tab === "actions"}">Action list${q.proposals.length ? `<span class="count ${pending ? "is-hot" : ""}">${pending || q.proposals.length}</span>` : ""}</button>
      <button type="button" role="tab" data-q="tab" data-tab="assistant" aria-selected="${q.tab === "assistant"}">Assistant steps${q.run?.steps ? `<span class="count">${q.run.steps.filter((s) => s.type !== "notice").length}</span>` : ""}</button>
    </div>
    <div class="side-body">${q.tab === "actions" ? actionList() : assistantSteps()}</div>`;
}

function actionList() {
  if (!q.proposals.length) {
    return empty("No actions proposed yet", "Run the assistant. It files its proposals here, and nothing is carried out until you approve them.", "decisions");
  }
  const count = (s) => q.proposals.filter((p) => p.status === s).length;
  const pending = count("pending");
  const item = (p) => {
    const decided = p.status !== "pending";
    return `<li class="prop ${decided ? `is-${p.status}` : ""}">
      <button type="button" class="prop-main" data-q="open" data-id="${esc(p.record_id)}">
        <span class="prop-top"><b>${esc(p.aircraft_id)}</b>${p.risk != null ? `<span class="prop-risk risk-${LEVEL_CLASS[p.level]}">${fmtRisk(p.risk)}</span>` : '<span class="prop-risk">No prediction</span>'}</span>
        <span class="prop-why">${esc(p.reason || "")}${p.time_left ? ` · fails in ${esc(p.time_left)}` : ""}</span>
        ${p.note ? `<span class="prop-note">${esc(p.note)}</span>` : ""}
      </button>
      ${decided
        ? `<span class="tag tag-${p.status === "approved" ? "ok" : "off"}">${p.status === "approved" ? `${icon("check")}${esc(p.work_order_id)}` : "Rejected"}</span>`
        : `<span class="prop-buttons">
            <button type="button" class="icon-btn approve" data-q="decide" data-id="${esc(p.id)}" data-decision="approved" aria-label="Approve ${esc(actionName(p.action))} for ${esc(p.aircraft_id)}" data-tip="Approve|Creates a simulated work order">${icon("check")}</button>
            <button type="button" class="icon-btn reject" data-q="decide" data-id="${esc(p.id)}" data-decision="rejected" aria-label="Reject ${esc(actionName(p.action))} for ${esc(p.aircraft_id)}" data-tip="Reject|No work order is created">${icon("x")}</button></span>`}
    </li>`;
  };
  const groups = ["repair", "retest", "inspect"].map((action) => {
    const mine = q.proposals.filter((p) => p.action === action);
    if (!mine.length) return "";
    const open = mine.filter((p) => p.status === "pending").length;
    return `<section class="group">
      <header><h3>${icon(ACTION_ICON[action])}${esc(actionName(action))}<span class="count">${mine.length}</span></h3>
        ${open ? `<button type="button" class="btn btn-ghost btn-sm" data-q="decide-many" data-action-kind="${action}" data-decision="approved">Approve ${open === mine.length ? "all" : "remaining"} ${open}</button>` : ""}</header>
      <ul>${mine.map(item).join("")}</ul></section>`;
  }).join("");
  // What the list buys: the failures the model expects among the repairs on it, against the whole batch.
  const repairs = q.proposals.filter((p) => p.action === "repair" && p.status !== "rejected" && p.risk != null);
  const covered = repairs.reduce((sum, p) => sum + p.risk / 100, 0);
  const total = batch().expected_failures;
  const coverage = repairs.length && total ? `
    <p class="coverage" data-tip="How this is worked out|Each risk is the chance that aircraft fails within 30 days.|Added up, they give the number of failures to expect.">
      ${icon("track")}<span>These <b>${plural(repairs.length, "repair")}</b> cover about <b>${fmtInt(covered)}</b> of the <b>${fmtInt(total)}</b> failures expected in 30 days
      (${Math.round((covered / total) * 100)}%).</span></p>` : "";
  return `
    <div class="side-summary">
      <span><b>${pending}</b> awaiting approval</span><span><b>${count("approved")}</b> approved</span><span><b>${count("rejected")}</b> rejected</span>
      ${pending ? `<button type="button" class="btn btn-primary btn-sm" data-q="decide-many" data-decision="approved">Approve all ${pending}</button>` : ""}
    </div>
    ${coverage}
    ${groups}
    <p class="sim-note">${icon("shield")}Simulated environment. Approving creates a work order inside AcuMain only. No aircraft system is contacted.</p>`;
}

function assistantSteps() {
  if (!q.run) return empty("No run yet", "When the assistant works, every decision and tool call appears here with its exact input and output.", "activity");
  return `<div class="run-head"><b>${esc(q.run.kind === "review" ? "Prepare the action list" : q.run.task)}</b><span>${runMeta(q.run)}</span></div>${timeline(q.run)}`;
}

// ---------------------------------------------------------------- record drawer
async function openDrawer(recordId) {
  try {
    q.drawer = await api.record(state.batchId, recordId);
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  history.replaceState(null, "", `#queue/${encodeURIComponent(recordId)}`);     // a link to this record can be shared
  renderDrawer();
  renderTable();
  renderAssist();
}
function closeDrawer() {
  q.drawer = null;
  $("#drawer-root").innerHTML = "";
  history.replaceState(null, "", "#queue");
  if (onQueue() && $("#table")) { renderTable(); renderAssist(); }
}

function renderDrawer() {
  const d = q.drawer;
  if (!d) return;
  const p = d.proposal;
  const bar = (r, label) => {
    if (!r || r.level == null) return `<div class="reading"><div class="reading-top"><b>${label}</b><span class="muted">Not recorded</span></div><div class="meter meter-none"><i style="width:0"></i></div></div>`;
    return `<div class="reading"><div class="reading-top"><b>${label}</b><span class="lvl lvl-${r.level}">${esc(r.level_name)}</span></div>
      <div class="meter meter-${r.level}" data-tip="${label}|${esc(r.text)}"><i style="width:${[14, 45, 72, 100][r.level]}%"></i></div><p>${esc(r.text[0].toUpperCase() + r.text.slice(1))}.</p></div>`;
  };
  const evidence = (e, what) => (e && e.n ? `<li>${fmtInt(e.failed)} of ${fmtInt(e.n)} past records with ${what} failed within 30 days (${Math.round((e.failed / e.n) * 100)}%).</li>` : "");
  let result;
  if (!d.scored) {
    result = `<div class="callout">${icon("info")}<p>The model has not been run on this batch yet. Run the assistant to get a prediction.</p></div>`;
  } else if (!d.scorable) {
    result = `<div class="callout callout-warn">${icon("alert")}<p><b>No prediction was made.</b> Both key readings, actuation time and leakage, are missing or unusable.
      The honest next step is to repeat the diagnostic test.</p></div>`;
  } else {
    result = `
      <div class="hero"><div><span class="hero-num risk-${LEVEL_CLASS[d.level]}">${fmtRisk(d.risk)}</span><span class="hero-label">risk of failure within 30 days</span></div>${levelPill(d.level)}</div>
      <div class="scale"><i class="scale-fill bar-${LEVEL_CLASS[d.level]}" style="width:${Math.max(2, d.risk)}%"></i>
        <span class="scale-tick" style="left:${state.meta.thresholds.medium}%"></span><span class="scale-tick" style="left:${state.meta.thresholds.high}%"></span></div>
      <dl class="facts">
        <div><dt>Model says</dt><dd>${d.prediction === "Yes" ? "Yes, likely to fail" : "No failure expected"}</dd></div>
        <div><dt>Typically fails in</dt><dd>${esc(d.time_left || "–")}</dd></div>
        <div><dt>Suggested next step</dt><dd>${esc(actionName(d.suggested_action))}</dd></div>
      </dl>
      <p class="fine">Of ${fmtInt(d.band.n)} past records at this risk, ${d.band.in_30_days}% failed within 30 days and ${d.band.in_12_weeks}% within 12 weeks.
        A Yes is a reason to review, not a confirmed failure.</p>
      <h3>Why</h3>
      <p class="why">${esc(d.reason)}.</p>
      ${bar(d.readings.operation, "Operation time")}${bar(d.readings.leakage, "Leakage")}
      ${d.factors.length ? `<h3>What adds to the risk</h3><div class="factors">${d.factors.map((f) => `
        <div class="factor"><span>${esc(f.name)}</span><span class="factor-bar"><i style="width:${f.share}%"></i></span><b>${f.share}%</b></div>`).join("")}</div>` : ""}
      ${d.evidence.pair || d.evidence.op || d.evidence.leak ? `<h3>In the training data</h3><ul class="evidence">
        ${evidence(d.evidence.pair, "these same operation and leakage levels")}${evidence(d.evidence.op, "this operation time level")}${evidence(d.evidence.leak, "this leakage level")}</ul>` : ""}
      <p class="confidence ${d.confidence.startsWith("Reduced") ? "is-reduced" : ""}">${icon(d.confidence.startsWith("Reduced") ? "alert" : "shield")}Confidence: ${esc(d.confidence)}</p>`;
  }
  const proposal = !p ? "" : `
    <div class="drawer-prop prop-${p.status}">
      <div><span class="eyebrow">${p.status === "pending" ? "Proposed by the assistant" : p.status === "approved" ? "Approved" : "Rejected"}</span>
        <b>${icon(ACTION_ICON[p.action])}${esc(actionName(p.action))}</b>${p.note ? `<p>${esc(p.note)}</p>` : ""}
        ${p.status === "approved" ? `<p>Work order ${esc(p.work_order_id)} created (simulated).</p>` : ""}</div>
      ${p.status === "pending" ? `<div class="drawer-buttons">
        <button type="button" class="btn btn-primary btn-sm" data-q="decide" data-id="${esc(p.id)}" data-decision="approved">${icon("check")}Approve</button>
        <button type="button" class="btn btn-secondary btn-sm" data-q="decide" data-id="${esc(p.id)}" data-decision="rejected">Reject</button></div>` : ""}
    </div>`;
  const issues = d.issues.length ? `<h3>Data notes</h3><ul class="notes">${d.issues.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  const inputs = `
    <details class="inputs"><summary>All readings in this record</summary>
      <dl>${[["Hydraulic fluid grade", d.grade ?? null, ""], ...d.inputs.map((i) => [i.label, i.value, i.unit])].map(([label, value, unit]) => `
        <div><dt>${esc(label)}</dt><dd>${value == null ? '<span class="missing">missing</span>' : `${esc(value)}${unit ? ` <i>${esc(unit)}</i>` : ""}`}</dd></div>`).join("")}</dl></details>`;
  $("#drawer-root").innerHTML = `
    <div class="scrim" data-q="close-drawer"></div>
    <aside class="drawer" role="dialog" aria-label="Record ${esc(d.aircraft_id)}">
      <header><div><span class="eyebrow">Record ${esc(d.record_id)}${d.date ? ` · ${esc(fmtDate(d.date))}` : ""}</span><h2>${esc(d.aircraft_id)}</h2></div>
        <button type="button" class="icon-btn" data-q="close-drawer" aria-label="Close">${icon("x")}</button></header>
      <div class="drawer-body">${proposal}${result}${issues}${inputs}
        ${d.actual ? `<p class="fine">Recorded answer in the file: <b>${d.actual === "Yes" ? "failed within 30 days" : "no failure within 30 days"}</b>.</p>` : ""}</div>
      <footer><button type="button" class="btn btn-secondary" data-q="ask-record">${icon("spark")}Ask the assistant about this aircraft</button></footer>
    </aside>`;
}

// ---------------------------------------------------------------- running the assistant
function stopPolling() {
  clearTimeout(q.timer);
  q.timer = null;
}
function poll() {
  stopPolling();
  q.timer = setTimeout(async () => {
    if (!q.run) return;
    try {
      q.run = await api.run(q.run.id);
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    if (q.run.status === "running") {
      if (onQueue()) { renderAssist(); if (q.tab === "assistant") renderSide(); }
      poll();
      return;
    }
    q.busy = false;
    if (q.run.kind === "review") { q.review = q.run; q.qa = null; } else q.qa = q.run;
    await refreshStatus();
    if (!onQueue()) return;
    await reload();
    if (q.drawer) openDrawer(q.drawer.record_id);
    if (q.run.status === "failed") toast("The assistant stopped before finishing. See the steps for the reason.", "error");
    else if (q.run.kind === "review") toast(q.run.proposals.length ? `${plural(q.run.proposals.length, "action")} proposed. Review them in the action list.` : "The review finished with no actions proposed.", q.run.proposals.length ? "ok" : "info");
  }, 450);
}

async function start(body) {
  if (q.busy) return;
  q.busy = true;
  try {
    const { run_id } = await api.startRun({ batch_id: state.batchId, list_size: q.listSize, selected: q.drawer?.record_id || null,
      screen: { page: "Review queue", filter: q.issues ? "records with missing readings" : q.level, search: q.search }, ...body });
    q.run = await api.run(run_id);
    if (body.kind === "review") q.tab = "actions";
    renderAssist();
    renderSide();
    poll();
  } catch (err) {
    q.busy = false;
    toast(err.message, "error");
    renderAssist();
  }
}

async function decide(id, decision) {
  try {
    const p = await api.decide(id, decision);
    toast(decision === "approved" ? `Approved. Work order ${p.work_order_id} created (simulated).` : "Rejected. No work order was created.", decision === "approved" ? "ok" : "info");
    await reload();
    if (q.drawer) openDrawer(q.drawer.record_id);
  } catch (err) {
    toast(err.message, "error");
    if (err.status === 409) { await reload().catch(() => {}); if (q.drawer) openDrawer(q.drawer.record_id); }
  }
}

async function decideMany(decision, action) {
  try {
    const done = await api.decideMany(state.batchId, { decision, action: action || null });
    toast(`${plural(done.length, "action")} ${decision}. ${decision === "approved" ? "Simulated work orders were created." : ""}`, "ok");
    await reload();
    if (q.drawer) openDrawer(q.drawer.record_id);
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------------------------------------------------------------- events
document.addEventListener("click", async (ev) => {
  const check = ev.target.closest("[data-q-check]");
  if (check) { ev.stopPropagation(); return; }                 // handled by the change event
  const el = ev.target.closest("[data-q]");
  if (!el) return;
  const act = el.dataset.q;
  if (act === "add") { openAddRecords(added); return; }
  if (!onQueue()) return;
  if (act === "dismiss-qa") { q.qa = null; renderAssist(); return; }
  if (act === "review") {
    start({ kind: "review", record_ids: q.selected.size ? [...q.selected] : null });
  } else if (act === "size") {
    q.listSize = Math.max(1, Math.min(state.meta.limits.max_list_size, q.listSize + Number(el.dataset.step)));
    $("#list-size").value = q.listSize;
  } else if (act === "filter") {
    q.issues = el.dataset.level === "Issues";
    q.level = q.issues ? "Any" : el.dataset.level;
    q.offset = 0;
    await loadRecords();
    renderKpis(); renderFilters(); renderTable();
  } else if (act === "page") {
    q.offset = Math.max(0, q.offset + Number(el.dataset.dir) * PAGE_SIZE);
    await loadRecords();
    renderTable();
    $("#table").scrollIntoView({ block: "nearest" });
  } else if (act === "clear-selection") {
    q.selected.clear();
    renderTable(); renderAssist();
  } else if (act === "tab") {
    q.tab = el.dataset.tab;
    renderSide();
    if (el.classList.contains("link")) $("#side").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (act === "open") {
    openDrawer(el.dataset.id);
  } else if (act === "close-drawer") {
    closeDrawer();
  } else if (act === "decide") {
    decide(el.dataset.id, el.dataset.decision);
  } else if (act === "decide-many") {
    decideMany(el.dataset.decision, el.dataset.actionKind);
  } else if (act === "ask-record") {
    const who = q.drawer.aircraft_id;
    start({ kind: "question", question: `Explain the result for ${who} in plain words. What would you do with it, and how sure can I be?` });
    toast(`Asked the assistant about ${who}.`, "info");
  }
});

document.addEventListener("change", (ev) => {
  const check = ev.target.closest("[data-q-check]");
  if (!check || !onQueue()) return;
  const key = check.dataset.qCheck;
  const ids = key === "page" ? q.records.rows.map((r) => r.record_id) : [key];
  for (const id of ids) {
    if (check.checked) {
      if (q.selected.size >= state.meta.limits.max_selected) { toast(`You can select up to ${state.meta.limits.max_selected} records.`, "info"); break; }
      q.selected.add(id);
    } else q.selected.delete(id);
  }
  renderTable(); renderAssist();
});

document.addEventListener("input", (ev) => {
  if (!onQueue()) return;
  if (ev.target.id === "list-size") {
    const v = Number(ev.target.value);
    if (Number.isFinite(v) && v >= 1) q.listSize = Math.min(state.meta.limits.max_list_size, Math.round(v));
  } else if (ev.target.id === "search") {
    clearTimeout(q.searchTimer);
    q.searchTimer = setTimeout(async () => {
      q.search = ev.target.value.trim();
      q.offset = 0;
      try { await loadRecords(); renderTable(); } catch (err) { toast(err.message, "error"); }
    }, 220);
  }
});

document.addEventListener("submit", (ev) => {
  if (ev.target.dataset.qForm !== "ask") return;
  ev.preventDefault();
  const text = $("#question").value.trim();
  if (!text) { toast("Type a question first.", "info"); return; }
  $("#question").value = "";
  start({ kind: "question", question: text });
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && q.drawer && !$("#modal-root").innerHTML) closeDrawer();
  const row = ev.target.closest && ev.target.closest("tr[data-q='open']");
  if (row && (ev.key === "Enter" || ev.key === " ") && ev.target === row) { ev.preventDefault(); openDrawer(row.dataset.id); }
});
