// Two simpler pages: the decisions that were taken, and the log of everything the assistant did.
import { api } from "./api.js";
import { currentBatch, state } from "./main.js";
import { $, ACTION_ICON, downloadCsv, empty, esc, fmtInt, fmtRisk, fmtTime, fmtUsd, icon, markdown, modelName, plural, toast } from "./ui.js";
import { runMeta, timeline } from "./steps.js";

// ---------------------------------------------------------------- decisions
const d = { proposals: [], orders: [] };

export const decisions = {
  async show() {
    const batch = currentBatch();
    if (!batch) { $("#page").innerHTML = empty("No batch selected", "Add records first.", "upload"); return; }
    [d.proposals, d.orders] = await Promise.all([api.proposals(batch.id), api.workOrders(batch.id)]);
    const by = Object.fromEntries(d.proposals.map((p) => [p.id, p]));
    const count = (s) => d.proposals.filter((p) => p.status === s).length;
    const action = (a) => `${icon(ACTION_ICON[a] || "dot")}${esc(state.meta.actions[a] || a)}`;
    const orders = d.orders.length ? `
      <div class="table-wrap"><table><thead><tr><th>Work order</th><th>Aircraft</th><th>Action</th><th>Risk when approved</th><th>Why</th><th>Approved</th><th>Status</th></tr></thead>
      <tbody>${d.orders.map((o) => { const p = by[o.proposal_id] || {}; return `<tr>
        <td><b>${esc(o.id)}</b></td><td>${esc(o.aircraft_id)}</td><td class="c-act">${action(o.action)}</td>
        <td>${p.risk != null ? fmtRisk(p.risk) : "No prediction"}</td><td class="c-why">${esc(p.reason || "")}</td>
        <td>${esc(fmtTime(o.created_at))}</td><td><span class="tag tag-ok">${esc(o.status)}</span></td></tr>`; }).join("")}</tbody></table></div>`
      : empty("No work orders yet", "A work order appears here when you approve a proposed action in the review queue.", "decisions");
    const rejected = d.proposals.filter((p) => p.status === "rejected");
    $("#page").innerHTML = `
      <section class="kpis kpis-4">
        <div class="kpi kpi-plain"><span class="kpi-label">Awaiting your approval</span><span class="kpi-value">${count("pending")}</span><span class="kpi-sub">In the review queue</span></div>
        <div class="kpi kpi-low"><span class="kpi-label">Approved</span><span class="kpi-value">${count("approved")}</span><span class="kpi-sub">Work orders created (simulated)</span></div>
        <div class="kpi kpi-plain"><span class="kpi-label">Rejected</span><span class="kpi-value">${count("rejected")}</span><span class="kpi-sub">No work order</span></div>
        <div class="kpi kpi-plain"><span class="kpi-label">Decided by</span><span class="kpi-value">You</span><span class="kpi-sub">The assistant never approves</span></div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Work orders</h2><p>Simulated. They exist only inside AcuMain; no maintenance system is contacted.</p></div>
          ${d.orders.length ? `<button type="button" class="btn btn-secondary btn-sm" data-p="export">${icon("download")}Download CSV</button>` : ""}</div>
        ${orders}
      </section>
      ${rejected.length ? `<section class="card"><div class="card-head"><div><h2>Rejected proposals</h2><p>Kept for the record. Nothing was created for these.</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Aircraft</th><th>Proposed action</th><th>Risk</th><th>Why it was proposed</th><th>Rejected</th></tr></thead>
        <tbody>${rejected.map((p) => `<tr><td><b>${esc(p.aircraft_id)}</b></td><td class="c-act">${action(p.action)}</td><td>${p.risk != null ? fmtRisk(p.risk) : "No prediction"}</td>
          <td class="c-why">${esc(p.reason || "")}</td><td>${esc(fmtTime(p.decided_at))}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
  },
};

// ---------------------------------------------------------------- activity log
const a = { runs: [], open: null, detail: null };

export const activity = {
  async show() {
    a.runs = await api.runs(100);
    a.open = null;
    a.detail = null;
    render();
  },
};

function render() {
  const agent = state.health.agent;
  const names = Object.fromEntries(state.batches.map((b) => [b.id, b.name]));
  const total = a.runs.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const status = (r) => (r.status === "completed" ? '<span class="tag tag-ok">Completed</span>' : r.status === "running" ? '<span class="tag tag-pending">Running</span>' : '<span class="tag tag-bad">Failed</span>');
  const row = (r) => {
    const open = a.open === r.id;
    const tokens = (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
    return `<tr class="run-row ${open ? "is-open" : ""}" data-p="run" data-id="${esc(r.id)}" tabindex="0">
        <td>${esc(fmtTime(r.started_at))}</td><td class="c-why"><b>${esc(r.kind === "review" ? "Prepare the action list" : r.task)}</b><span class="sub">${esc(names[r.batch_id] || "A batch that was removed")}</span></td>
        <td>${esc(r.mode === "claude" ? modelName(r.model) : r.mode[0].toUpperCase() + r.mode.slice(1))}</td><td>${fmtInt(r.model_calls)} / ${fmtInt(r.tool_calls)}</td><td>${fmtInt(r.proposals)}</td>
        <td>${tokens ? fmtInt(tokens) : "–"}</td><td>${fmtUsd(r.cost_usd || 0)}</td><td>${status(r)}</td><td class="c-go">${icon(open ? "down" : "chevron")}</td></tr>
      ${open ? `<tr class="run-detail"><td colspan="9">${a.detail ? `
        ${a.detail.error ? `<div class="callout callout-error">${icon("alert")}<p>${esc(a.detail.error)}</p></div>` : ""}
        <div class="run-grid"><div><h3>Steps</h3>${timeline(a.detail)}</div>
          <div><h3>What it told the planner</h3><div class="md run-final">${a.detail.final_text ? markdown(a.detail.final_text) : '<p class="muted">No answer was written.</p>'}</div>
            <h3>What it was asked</h3><pre class="context">${esc(JSON.stringify(a.detail.context, null, 2))}</pre></div></div>` : '<p class="muted pad">Loading…</p>'}</td></tr>` : ""}`;
  };
  $("#page").innerHTML = `
    <section class="kpis kpis-4">
      <div class="kpi kpi-plain"><span class="kpi-label">Runs recorded</span><span class="kpi-value">${fmtInt(a.runs.length)}</span><span class="kpi-sub">Most recent first</span></div>
      <div class="kpi kpi-plain"><span class="kpi-label">Assistant</span><span class="kpi-value kpi-text">${agent.mode === "claude" ? esc(modelName(agent.model)) : "Built-in planner"}</span><span class="kpi-sub">${agent.mode === "claude" ? `Effort: ${esc(agent.effort)}` : "No language model, no cost"}</span></div>
      <div class="kpi kpi-plain"><span class="kpi-label">Claude spend today</span><span class="kpi-value">${fmtUsd(agent.spent_today_usd)}</span><span class="kpi-sub">Limit ${fmtUsd(agent.daily_limit_usd)} a day, ${fmtUsd(agent.run_limit_usd)} a run</span></div>
      <div class="kpi kpi-plain"><span class="kpi-label">Spend in this log</span><span class="kpi-value">${fmtUsd(total)}</span><span class="kpi-sub">Estimated from token counts</span></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Assistant runs</h2><p>Open a run to see each decision, each tool call with its exact input and output, and the answer it gave.</p></div></div>
      ${a.runs.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Task</th><th>Decided by</th><th>Decisions / tool calls</th><th>Proposals</th><th>Tokens</th><th>Cost</th><th>Status</th><th></th></tr></thead>
        <tbody>${a.runs.map(row).join("")}</tbody></table></div>` : empty("Nothing has run yet", "Run the assistant from the review queue and its steps are recorded here.", "activity")}
    </section>`;
}

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-p]");
  if (!el) return;
  if (el.dataset.p === "export") {
    const by = Object.fromEntries(d.proposals.map((p) => [p.id, p]));
    downloadCsv("acumain_work_orders_simulated.csv", d.orders.map((o) => ({ work_order: o.id, aircraft: o.aircraft_id, record: o.record_id,
      action: state.meta.actions[o.action] || o.action, risk_percent: by[o.proposal_id]?.risk ?? "", reason: by[o.proposal_id]?.reason ?? "", approved_at: o.created_at, status: o.status })));
    toast(`${plural(d.orders.length, "work order")} exported.`, "ok");
  } else if (el.dataset.p === "run" && !ev.target.closest(".run-detail")) {
    a.open = a.open === el.dataset.id ? null : el.dataset.id;
    a.detail = null;
    render();
    if (a.open) {
      try { a.detail = await api.run(a.open); } catch (err) { toast(err.message, "error"); a.open = null; }
      render();
    }
  }
});
