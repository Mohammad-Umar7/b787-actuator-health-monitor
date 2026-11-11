// Start-up, shared state, the top bar, and moving between pages.
import { api } from "./api.js";
import { $, esc, toast } from "./ui.js";
import * as review from "./review.js";
import * as pages from "./pages.js";
import * as track from "./track.js";

export const state = {
  page: "review",
  health: null,
  meta: null,
  batches: [],
  batchId: null,      // the file open on the Review page, or null on the start screen
};

// "model" and "log" are two views of one place in the navigation.
const PAGES = {
  review: { module: review, nav: "review" },
  orders: { module: pages.orders, nav: "orders" },
  model: { module: track, nav: "model" },
  log: { module: pages.log, nav: "model" },
};
const OLD_NAMES = { queue: "review", decisions: "orders", track: "model", activity: "log" };
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="currentColor"/>
  <path d="M16 7v12M16 12l6 5" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"/>
  <circle cx="16" cy="23" r="3.6" fill="none" stroke="#fff" stroke-width="2.6"/></svg>`;

export const currentBatch = () => state.batches.find((b) => b.id === state.batchId) || null;

export async function refreshStatus() {
  try {
    state.health = await api.health();
  } catch (err) {
    if (!state.health) throw err;
  }
  renderTop();
  renderBanner();
  document.dispatchEvent(new Event("acumain:status"));
}

export async function refreshBatches() {
  state.batches = await api.batches();
}

// ---------------------------------------------------------------- the top bar
export function renderTop() {
  const model = state.health?.model;
  const agent = state.health?.agent;
  const here = PAGES[state.page]?.nav;
  const link = (key, label, href) => `<a href="${href}" aria-current="${here === key ? "page" : "false"}">${label}</a>`;
  const modelText = model?.available ? "Failure model ready" : model?.simulated_outage ? "Failure model off" : "Failure model unavailable";
  const modelTip = model?.available ? `The Stage 2 model we trained, version ${model.version}.|It is loaded all the time and makes every prediction.`
    : (model?.error || "The model is not loaded.");
  const agentTip = agent?.mode === "claude" ? "The agent decides which tool to call next and writes the summary.|It never makes a prediction itself."
    : (agent?.reason || "The built-in planner calls the same tools in a fixed order.");
  const wasOpen = $("#demo-menu")?.open;
  const stock = state.health?.stock || {};
  const preset = stock.store >= 60 ? "plenty" : stock.store === 0 && stock.warehouse === 0 && !stock.supplier_available ? "none"
    : stock.store === 12 && stock.warehouse === 8 && stock.supplier_available ? "short" : "";
  const presetButton = (key, label) => `<button type="button" data-action="stock-preset" data-preset="${key}" aria-pressed="${preset === key}">${label}</button>`;
  $("#top").innerHTML = `
    <div class="top-in">
      <a class="brand" href="#review">${MARK}<span>AcuMain</span></a>
      <nav class="nav" aria-label="Main">
        ${link("review", "Review", state.batchId ? addressOf("review", state.batchId) : "#review")}
        ${link("orders", "Work orders", "#orders")}
        ${link("model", "Model and log", "#model")}
      </nav>
      <div class="top-right">
        ${api.isPublic ? `<span class="status is-ok" data-tip="Public copy|The failure model and the agents ran these reviews for real, and each step was recorded.|This copy replays them. It does not run the model or the agents."><i></i>Recorded reviews by the real agents</span>` : `
        <span class="status ${model?.available ? "is-ok" : "is-bad"}" data-tip="Failure model|${esc(modelTip)}"><i></i>${modelText}</span>
        <span class="status ${agent?.mode === "claude" ? "is-ok" : "is-idle"}" data-tip="Agent|${esc(agentTip)}"><i></i>${agent?.mode === "claude" ? "Agents ready" : "Built-in planner"}</span>
        <details class="menu" id="demo-menu" ${wasOpen ? "open" : ""}>
          <summary>Demo</summary>
          <div class="menu-pop">
            <b class="menu-title">Failure model</b>
            <label class="switch"><input type="checkbox" data-action="toggle-outage" ${model?.simulated_outage ? "checked" : ""}>
              <span class="track"></span><span>Simulate a model outage</span></label>
            <p>Every call to the failure model fails until you switch this off. The team reports the failure and invents nothing.</p>
            <b class="menu-title">Spare parts (simulated)</b>
            <div class="presets">${presetButton("plenty", "Plenty")}${presetButton("short", "Short")}${presetButton("none", "None anywhere")}</div>
            <p>Hangar store ${stock.store ?? "–"} (${stock.free ?? "–"} free) · central warehouse ${stock.warehouse ?? "–"} in ${stock.warehouse_days ?? "–"} days ·
              supplier ${stock.supplier_available ? `in ${stock.supplier_days} days` : "has none"}. Run the review again to see the Stock and Supply agents react.</p>
            <label class="switch"><input type="checkbox" data-action="toggle-stock-outage" ${stock.simulated_outage ? "checked" : ""}>
              <span class="track"></span><span>Simulate a stock system outage</span></label>
            <b class="menu-title">This file</b>
            <button type="button" class="btn btn-sm" data-action="reset-batch" ${state.batchId ? "" : "disabled"}>Reset this file</button>
            <p>Clears its results, proposals, parts requests and work orders, so the review can be shown again from the start.</p>
          </div>
        </details>`}
      </div>
    </div>`;
}

function renderBanner() {
  const model = state.health?.model;
  let html = "";
  if (api.isPublic) {
    html = `<div class="banner banner-public"><span><b>Public copy.</b> These reviews were run by the real agents and the trained model, then recorded. Your approvals stay in this browser.
      Aircraft are relabelled. New reviews, uploads and questions need the Docker package.</span>
      <button type="button" class="btn btn-sm" data-action="public-reset">Reset my decisions</button></div>`;
  } else if (model?.simulated_outage) {
    html = `<div class="banner banner-warn"><span><b>Simulated model outage is on.</b> Every call to the failure model will fail until you switch it off.</span>
      <button type="button" class="btn btn-sm" data-action="outage-off">Switch it off</button></div>`;
  } else if (model && !model.available) {
    html = `<div class="banner banner-error"><span><b>The failure model is unavailable.</b> ${esc(model.error || "")} No predictions can be made until it loads.</span></div>`;
  }
  $("#banner").innerHTML = html;
}

// ---------------------------------------------------------------- navigation
// The address is "#page" or "#page/detail": "#review/sample" opens a file, "#review/sample/Q-18857260" opens one record in it.
function parseHash() {
  const [page, ...rest] = location.hash.slice(1).split("/");
  return [page, rest.length ? decodeURIComponent(rest.join("/")) : undefined];
}
export const addressOf = (page, arg) => `#${page}${arg ? `/${String(arg).split("/").map(encodeURIComponent).join("/")}` : ""}`;

// Go somewhere new. This adds a step to the browser's history, so Back works.
export function navigate(page, arg) {
  const address = addressOf(page, arg);
  if (location.hash === address) route(); else location.hash = address;
}
// Change the address without leaving the page, for example when a record is opened or closed.
export function setAddress(page, arg) {
  history.replaceState(null, "", addressOf(page, arg));
}

async function route() {
  let [page, arg] = parseHash();
  if (OLD_NAMES[page]) {                       // links written for the earlier layout still land somewhere sensible
    if (page === "queue") arg = arg && arg !== "add" ? `sample/${arg}` : arg === "add" ? undefined : "sample";
    page = OLD_NAMES[page];
  }
  if (!PAGES[page]) { page = "review"; arg = undefined; }
  state.page = page;
  $("#drawer-root").innerHTML = "";
  $("#modal-root").innerHTML = "";
  renderTop();
  $("#page").innerHTML = '<div class="boot">Loading…</div>';
  window.scrollTo(0, 0);
  try {
    await PAGES[page].module.show(arg);
  } catch (err) {
    $("#page").innerHTML = `<div class="wrap"><div class="empty"><h3>This page could not be loaded</h3><p>${esc(err.message)}</p>
      <a class="btn" href="${addressOf(page, arg)}" data-action="retry">Try again</a></div></div>`;
  }
}

document.addEventListener("click", async (ev) => {
  const menu = $("#demo-menu");
  if (menu?.open && !ev.target.closest("#demo-menu")) menu.open = false;
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  try {
    if (action === "retry") {
      ev.preventDefault();
      route();
    } else if (action === "public-reset") {
      api.resetPublic();
      await refreshBatches();
      toast("Your decisions in this browser were cleared.", "ok");
      route();
    } else if (action === "outage-off") {
      await api.outage(false);
      await refreshStatus();
      toast("The failure model is back on.", "ok");
    } else if (action === "stock-preset") {
      await api.setStock({ preset: el.dataset.preset });
      await refreshStatus();
      toast({ plenty: "Simulated stock: plenty in the hangar store.", short: "Simulated stock: short in the store, some in the warehouse.", none: "Simulated stock: none anywhere, and the supplier has none." }[el.dataset.preset], "info");
    } else if (action === "reset-batch") {
      if (!state.batchId) return;
      await api.resetBatch(state.batchId);
      await refreshBatches();
      if (menu) menu.open = false;
      toast("The file was reset: results, proposals and work orders were cleared.", "ok");
      navigate("review", state.batchId);
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

document.addEventListener("change", async (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el || !["toggle-outage", "toggle-stock-outage"].includes(el.dataset.action)) return;
  try {
    if (el.dataset.action === "toggle-stock-outage") {
      await api.setStock({ outage: el.checked });
      await refreshStatus();
      toast(el.checked ? "Stock system outage simulated. The Stock agent's check will now fail." : "The stock system is back on.", el.checked ? "info" : "ok");
      return;
    }
    await api.outage(el.checked);
    await refreshStatus();
    toast(el.checked ? "Model outage simulated. Calls to the failure model will now fail." : "The failure model is back on.", el.checked ? "info" : "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

window.addEventListener("hashchange", route);

async function init() {
  try {
    [state.health, state.meta] = await Promise.all([api.health(), api.meta()]);
    await refreshBatches();
  } catch (err) {
    $("#page").innerHTML = `<div class="wrap"><div class="empty"><h3>AcuMain could not start</h3><p>${esc(err.message)}</p></div></div>`;
    return;
  }
  renderBanner();
  await route();
  setInterval(() => refreshStatus().catch(() => {}), 15000);
}
init();
