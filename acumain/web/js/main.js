// Start-up, shared state, the sidebar and top bar, and switching between pages.
import { api } from "./api.js";
import { $, esc, fmtUsd, icon, modelName, toast } from "./ui.js";
import * as queue from "./queue.js";
import * as pages from "./pages.js";
import * as track from "./track.js";

export const state = {
  page: "queue",
  health: null,
  meta: null,
  batches: [],
  batchId: null,
};

const PAGES = {
  queue: { label: "Review queue", icon: "queue", module: queue, title: "Review queue", sub: "Records waiting for a decision. The assistant drafts the action list; you approve it." },
  decisions: { label: "Decisions", icon: "decisions", module: pages.decisions, title: "Decisions", sub: "What was approved and rejected. Work orders are simulated: nothing leaves AcuMain." },
  track: { label: "Track record", icon: "track", module: track, title: "Track record", sub: "How the model did on 100 aircraft it never saw in training, replayed week by week." },
  activity: { label: "Activity log", icon: "activity", module: pages.activity, title: "Activity log", sub: "Every assistant run, step by step: what it decided, which tools it called, and what came back." },
};

export const currentBatch = () => state.batches.find((b) => b.id === state.batchId) || null;

export async function refreshStatus() {
  try {
    state.health = await api.health();
  } catch (err) {
    if (!state.health) throw err;
  }
  renderSidebar();
  renderBanner();
}

export async function refreshBatches() {
  state.batches = await api.batches();
  if (!state.batches.some((b) => b.id === state.batchId)) state.batchId = state.batches[0]?.id ?? null;
  renderTopbar();
}

// ---------------------------------------------------------------- chrome
function renderSidebar() {
  const h = state.health;
  const model = h?.model;
  const agent = h?.agent;
  const item = ([key, p]) => `
    <button type="button" class="nav-item" data-page="${key}" aria-current="${state.page === key ? "page" : "false"}">
      ${icon(p.icon)}<span>${p.label}</span></button>`;
  $("#sidebar").innerHTML = `
    <div class="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2563eb"/>
        <path d="M16 7v12M16 12l6 5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="16" cy="23" r="3.6" fill="none" stroke="#fff" stroke-width="2.6"/></svg>
      <div><strong>AcuMain</strong><span>B787 nose gear actuators</span></div>
    </div>
    <nav class="nav">${Object.entries(PAGES).map(item).join("")}</nav>
    <div class="side-status">
      <div class="status-row" data-tip="Prediction model|${model?.available ? `Stage 2 model, version ${esc(model.version)}` : esc(model?.error || "Not loaded")}">
        <span class="dot ${model?.available ? "ok" : "bad"}"></span>
        <div><b>Failure model</b><span>${model?.available ? "Ready" : model?.simulated_outage ? "Outage (simulated)" : "Unavailable"}</span></div>
      </div>
      <div class="status-row" data-tip="Assistant|${agent?.mode === "claude" ? `Claude decides the next step. Spend today ${fmtUsd(agent.spent_today_usd)} of ${fmtUsd(agent.daily_limit_usd)}.` : esc(agent?.reason || "")}">
        <span class="dot ${agent?.mode === "claude" ? "ok" : "idle"}"></span>
        <div><b>Assistant</b><span>${agent?.mode === "claude" ? esc(modelName(agent.model)) : "Built-in planner"}</span></div>
      </div>
      ${agent?.mode === "claude" || agent?.spent_today_usd ? `<div class="spend"><span>Claude spend today</span><b>${fmtUsd(agent.spent_today_usd)} <i>/ ${fmtUsd(agent.daily_limit_usd)}</i></b></div>` : ""}
      <details class="demo">
        <summary>Demo controls</summary>
        <label class="switch"><input type="checkbox" data-action="toggle-outage" ${model?.simulated_outage ? "checked" : ""}>
          <span class="track"></span><span>Simulate a model outage</span></label>
        <button type="button" class="btn btn-ghost btn-sm" data-action="reset-batch">${icon("refresh")}Reset this batch</button>
        <p>For showing how a failed model call and a fresh review are handled.</p>
      </details>
    </div>`;
}

function renderTopbar() {
  const p = PAGES[state.page];
  const needsBatch = state.page === "queue" || state.page === "decisions";
  const picker = needsBatch && state.batches.length ? `
    <label class="batch-picker"><span>Batch</span>
      <select data-action="pick-batch" aria-label="Batch of records">
        ${state.batches.map((b) => `<option value="${esc(b.id)}" ${b.id === state.batchId ? "selected" : ""}>${esc(b.name)} · ${b.records.toLocaleString("en-US")} records</option>`).join("")}
      </select></label>` : "";
  $("#topbar").innerHTML = `
    <div class="titles"><h1>${p.title}</h1><p>${p.sub}</p></div>
    <div class="top-actions">${picker}
      ${state.page === "queue" ? `<button type="button" class="btn btn-secondary" data-q="add">${icon("plus")}Add records</button>` : ""}</div>`;
}

function renderBanner() {
  const model = state.health?.model;
  let html = "";
  if (model?.simulated_outage) {
    html = `<div class="banner banner-warn">${icon("alert")}<span><b>Simulated model outage is on.</b> Every prediction call will fail until you switch it off.</span>
      <button type="button" class="btn btn-sm btn-secondary" data-action="outage-off">Switch it off</button></div>`;
  } else if (model && !model.available) {
    html = `<div class="banner banner-error">${icon("alert")}<span><b>The prediction model is unavailable.</b> ${esc(model.error || "")} No predictions can be made until it loads.</span></div>`;
  }
  $("#banner").innerHTML = html;
}

// ---------------------------------------------------------------- navigation
// The address is "#page" or "#page/detail", for example "#queue/Q-18857260" to open one record.
function parseHash() {
  const [page, ...rest] = location.hash.slice(1).split("/");
  return [page, rest.length ? decodeURIComponent(rest.join("/")) : undefined];
}

export async function go(page, arg) {
  if (!PAGES[page]) { page = "queue"; arg = undefined; }
  state.page = page;
  const address = `#${page}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
  if (location.hash !== address) history.replaceState(null, "", address);
  $("#drawer-root").innerHTML = "";
  $("#modal-root").innerHTML = "";
  renderSidebar();
  renderTopbar();
  $("#page").innerHTML = '<div class="boot">Loading…</div>';
  try {
    await PAGES[page].module.show(arg);
  } catch (err) {
    $("#page").innerHTML = `<div class="empty">${icon("alert")}<h3>This page could not be loaded</h3><p>${esc(err.message)}</p>
      <button type="button" class="btn btn-secondary" data-page="${page}">Try again</button></div>`;
  }
}

document.addEventListener("click", async (ev) => {
  const nav = ev.target.closest("[data-page]");
  if (nav) { go(nav.dataset.page); return; }
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  try {
    if (action === "outage-off") {
      await api.outage(false);
      await refreshStatus();
      toast("The model is back on.", "ok");
    } else if (action === "reset-batch") {
      if (!state.batchId) return;
      await api.resetBatch(state.batchId);
      await refreshBatches();
      toast("The batch was reset: results, proposals and work orders were cleared.", "ok");
      go(state.page);
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

document.addEventListener("change", async (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  try {
    if (el.dataset.action === "toggle-outage") {
      await api.outage(el.checked);
      await refreshStatus();
      toast(el.checked ? "Model outage simulated. Prediction calls will now fail." : "The model is back on.", el.checked ? "info" : "ok");
    } else if (el.dataset.action === "pick-batch") {
      state.batchId = el.value;
      go(state.page);
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

window.addEventListener("hashchange", () => {
  const [page, arg] = parseHash();
  if (page !== state.page || arg) go(page, arg);
});

async function init() {
  try {
    [state.health, state.meta] = await Promise.all([api.health(), api.meta()]);
    await refreshBatches();
  } catch (err) {
    $("#page").innerHTML = `<div class="empty">${icon("alert")}<h3>AcuMain could not start</h3><p>${esc(err.message)}</p></div>`;
    return;
  }
  renderBanner();
  const [page, arg] = parseHash();
  await go(page || "queue", arg);
  setInterval(() => refreshStatus().catch(() => {}), 15000);
}
init();
