// Two plainer pages: the work orders that approvals created, and the log of everything the agent did.
import { api } from "./api.js";
import { refreshBatches, state } from "./main.js";
import { $, cap, downloadCsv, empty, esc, fmtInt, fmtRisk, fmtTime, fmtUsd, icon, markdown, modelName, plural, repaint, subnav, toast } from "./ui.js";
import { partLine, runMeta, timeline } from "./steps.js";

// ---------------------------------------------------------------- work orders
const d = { proposals: [], orders: [], requests: [] };

export const orders = {
  async show() {
    await refreshBatches();
    const lists = await Promise.all([api.workOrders(), api.partsRequests(), ...state.batches.map((b) => api.proposals(b.id))]);
    d.orders = lists[0];
    d.requests = lists[1];
    d.proposals = lists.slice(2).flat();
    // Where the spare part for a repair comes from, in a few words.
    const part = (p) => {
      if (p.action !== "repair") return '<span class="muted">Not needed</span>';
      const x = p.part;
      if (!x) return '<span class="muted">Not checked</span>';
      if (x.status === "in_store") return "In the hangar store";
      if (x.status === "requested") return x.eta_days == null ? '<span class="st st-bad">No delivery date</span>'
        : `${esc(x.source_name || "Requested")}, ${x.eta_days} days${x.late ? ' <span class="st st-bad">(late)</span>' : ""}`;
      return '<span class="st st-bad">No part</span>';
    };
    const by = Object.fromEntries(d.proposals.map((p) => [p.id, p]));
    const names = Object.fromEntries(state.batches.map((b) => [b.id, b.name]));
    const several = new Set(d.proposals.map((p) => p.batch_id)).size > 1;
    const count = (s) => d.proposals.filter((p) => p.status === s).length;
    const action = (a) => esc(state.meta.actions[a] || a);
    const live = d.orders.filter((o) => !o.cancelled_at), cancelled = d.orders.length - live.length;
    const table = d.orders.length ? `
      <div class="table-wrap"><table><thead><tr><th>Work order</th><th>Aircraft</th><th>Action</th><th>Risk when approved</th><th>Why</th><th>Spare part</th>${several ? "<th>File</th>" : ""}<th>Status</th></tr></thead>
      <tbody>${d.orders.map((o) => { const p = by[o.proposal_id] || {}; return `<tr class="${o.cancelled_at ? "is-cancelled" : ""}">
        <td><span class="mono ac">${esc(o.id)}</span></td><td><span class="mono">${esc(o.aircraft_id)}</span></td><td>${action(o.action)}</td>
        <td>${p.risk != null ? fmtRisk(p.risk) : '<span class="muted">No prediction</span>'}</td><td class="c-why">${esc(p.reason || "")}${p.decision_note ? `<small>Your note: ${esc(p.decision_note)}</small>` : ""}</td><td>${p.action ? part(p) : ""}</td>
        ${several ? `<td class="c-why">${esc(names[o.batch_id] || "")}</td>` : ""}
        <td>${o.cancelled_at ? `<span class="st st-bad">Cancelled</span><small>${esc(fmtTime(o.cancelled_at))}, you changed the decision</small>` : `Approved ${esc(fmtTime(o.created_at))}`}</td></tr>`; }).join("")}</tbody></table></div>`
      : empty("No work orders yet", "A work order appears here when you approve a proposed action on the Review page.", '<a class="btn" href="#review">Go to Review</a>');
    const rejected = d.proposals.filter((p) => p.status === "rejected");
    $("#page").innerHTML = `
      <div class="wrap wrap-wide">
        <h1 class="display display-sm">Work orders</h1>
        <p class="lede">What you approved and what you turned down. The agent never approves anything. Work orders are simulated: they exist only inside AcuMain.</p>
        <div class="figures figures-3">
          <div class="fig"><b>${fmtInt(live.length)}</b><span>Work orders</span><small>Created by your approvals${cancelled ? `, plus ${fmtInt(cancelled)} cancelled` : ""}</small></div>
          <div class="fig"><b>${fmtInt(count("pending"))}</b><span>Waiting for you</span><small>Proposed, not yet decided</small></div>
          <div class="fig"><b>${fmtInt(count("rejected"))}</b><span>Rejected</span><small>No work order was created</small></div>
        </div>
        <section class="sec">
          <header class="sec-head"><div><h2>Created work orders</h2><p>Simulated. No maintenance system is contacted.</p></div>
            ${d.orders.length ? `<button type="button" class="btn btn-sm" data-p="export">${icon("download")}Download CSV</button>` : ""}</header>
          ${table}
        </section>
        ${d.requests.length ? `<section class="sec">
          <header class="sec-head"><div><h2>Parts requests</h2><p>Drafted by the Supply agent. The supply department and its delivery times are simulated.</p></div></header>
          <div class="table-wrap"><table><thead><tr><th>Request</th><th>What was asked for</th><th>Arriving late</th><th>Drafted</th><th>Your decision</th></tr></thead>
          <tbody>${d.requests.map((r) => { const late = r.lines.reduce((sum, l) => sum + (l.late || 0), 0); return `<tr>
            <td><span class="mono ac">${esc(r.id)}</span></td><td class="c-why">${r.lines.map((l) => esc(partLine(l))).join(", ")}</td>
            <td>${late ? `<span class="st st-bad">${plural(late, "part")}</span>` : '<span class="muted">None</span>'}</td><td>${esc(cap(fmtTime(r.created_at)))}</td>
            <td>${r.status === "approved" ? '<span class="done done-ok">Approved, marked as sent</span>' : r.status === "rejected" ? "Rejected" : '<span class="st st-run">Waiting for you</span>'}</td></tr>`; }).join("")}</tbody></table></div></section>` : ""}
        ${rejected.length ? `<section class="sec">
          <header class="sec-head"><div><h2>Rejected proposals</h2><p>Kept for the record. Nothing was created for these.</p></div></header>
          <div class="table-wrap"><table><thead><tr><th>Aircraft</th><th>Proposed action</th><th>Risk</th><th>Why it was proposed</th><th>Rejected</th></tr></thead>
          <tbody>${rejected.map((p) => `<tr><td><span class="mono ac">${esc(p.aircraft_id)}</span></td><td>${action(p.action)}</td><td>${p.risk != null ? fmtRisk(p.risk) : '<span class="muted">No prediction</span>'}</td>
            <td class="c-why">${esc(p.reason || "")}${p.decision_note ? `<small>Your note: ${esc(p.decision_note)}</small>` : ""}</td><td>${esc(cap(fmtTime(p.decided_at)))}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
      </div>`;
  },
};

// ---------------------------------------------------------------- activity log
const a = { runs: [], open: null, detail: null };

export const log = {
  async show() {
    await refreshBatches();
    a.runs = await api.runs(100);
    a.open = null;
    a.detail = null;
    $("#page").innerHTML = '<div class="wrap wrap-wide" id="log"></div>';
    render();
  },
};

function render() {
  const agent = state.health.agent;
  const names = Object.fromEntries(state.batches.map((b) => [b.id, b.name]));
  const total = a.runs.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const status = (r) => (r.status === "completed" ? '<span class="st">Completed</span>' : r.status === "running" ? '<span class="st st-run">Running</span>' : '<span class="st st-bad">Failed</span>');
  const row = (r) => {
    const open = a.open === r.id;
    const tokens = (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
    return `<tr class="run-row ${open ? "is-open" : ""}" data-p="run" data-id="${esc(r.id)}" tabindex="0">
        <td>${esc(cap(fmtTime(r.started_at)))}</td>
        <td class="c-why"><b>${esc(r.kind === "review" ? "Prepare the action list" : r.task)}</b>${r.archived ? ' <span class="label" data-tip="Before a reset|The results and proposals of this run were cleared when the file was reset.">Before reset</span>' : ""}
          <small>${esc(names[r.batch_id] || "A file that was removed")}</small></td>
        <td>${esc(r.mode === "claude" ? modelName(r.model) : cap(r.mode))}</td><td>${fmtInt(r.model_calls)} / ${fmtInt(r.tool_calls)}</td><td>${fmtInt(r.proposals)}</td>
        <td>${tokens ? fmtInt(tokens) : "–"}</td><td>${fmtUsd(r.cost_usd || 0)}</td><td>${status(r)}</td><td class="c-go">${icon(open ? "down" : "chevron")}</td></tr>
      ${open ? `<tr class="run-detail"><td colspan="9">${a.detail ? `
        ${a.detail.error ? `<div class="callout callout-error"><p>${esc(a.detail.error)}</p></div>` : ""}
        <div class="run-grid"><div><h3>Steps</h3>${timeline(a.detail, { engine: true })}<p class="fine">${runMeta(a.detail, { engine: true })}</p></div>
          <div><h3>What it told the planner</h3><div class="md run-final">${a.detail.final_text ? markdown(a.detail.final_text) : '<p class="muted">No answer was written.</p>'}</div>
            <h3>What it was asked</h3><pre class="context">${esc(JSON.stringify(a.detail.context, null, 2))}</pre></div></div>` : '<p class="muted pad">Loading…</p>'}</td></tr>` : ""}`;
  };
  repaint($("#log"), `
    ${subnav("log")}
    <h1 class="display display-sm">Everything the agent did</h1>
    <p class="lede">Each run, step by step: what the agent decided, which tools it called with what input, and what came back.</p>
    <div class="figures">
      <div class="fig"><b>${fmtInt(a.runs.length)}</b><span>Runs recorded</span><small>Most recent first</small></div>
      <div class="fig"><b class="fig-text">${agent.mode === "claude" ? esc(modelName(agent.model)) : "Built-in planner"}</b><span>Decides the steps</span><small>${agent.mode === "claude" ? `Effort: ${esc(agent.effort)}` : "No language model, no cost"}</small></div>
      <div class="fig"><b>${fmtUsd(agent.spent_today_usd)}</b><span>Spent today</span><small>Limit ${fmtUsd(agent.daily_limit_usd)} a day, ${fmtUsd(agent.run_limit_usd)} a run</small></div>
      <div class="fig"><b>${fmtUsd(total)}</b><span>Spent in this log</span><small>Worked out from token counts</small></div>
    </div>
    <section class="sec">
      <header class="sec-head"><div><h2>Runs</h2><p>Open a run to see every step with its exact input and output.</p></div></header>
      ${a.runs.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Task</th><th>Decided by</th><th>Decisions / tool calls</th><th>Proposals</th><th>Tokens</th><th>Cost</th><th>Status</th><th></th></tr></thead>
        <tbody>${a.runs.map(row).join("")}</tbody></table></div>` : empty("Nothing has run yet", "Start a review and its steps are recorded here.", '<a class="btn" href="#review">Go to Review</a>')}
    </section>`);
}

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-p]");
  if (!el) return;
  if (el.dataset.p === "export") {
    const by = Object.fromEntries(d.proposals.map((p) => [p.id, p]));
    downloadCsv("acumain_work_orders_simulated.csv", d.orders.map((o) => ({ work_order: o.id, aircraft: o.aircraft_id, record: o.record_id,
      action: state.meta.actions[o.action] || o.action, risk_percent: by[o.proposal_id]?.risk ?? "", reason: by[o.proposal_id]?.reason ?? "", approved_at: o.created_at, cancelled_at: o.cancelled_at || "", status: o.status })));
    toast(`${plural(d.orders.length, "work order")} exported.`, "ok");
  } else if (el.dataset.p === "run" && !ev.target.closest(".run-detail")) {
    a.open = a.open === el.dataset.id ? null : el.dataset.id;
    a.detail = null;
    render();
    if (a.open) {
      try { a.detail = await api.run(a.open); } catch (err) { toast(err.message, "error"); a.open = null; }
      if (state.page === "log") render();
    }
  }
});

document.addEventListener("keydown", (ev) => {
  const row = ev.target.closest && ev.target.closest("tr[data-p='run']");
  if (row && (ev.key === "Enter" || ev.key === " ") && ev.target === row) { ev.preventDefault(); row.click(); }
});
