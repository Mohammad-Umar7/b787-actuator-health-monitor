// Turns the raw steps of an agent run into a readable trail: one plain line per step and what came back,
// with the exact tool name, input and output one click away.
import { cap, esc, fmtInt, fmtMs, fmtTime, fmtUsd, icon, modelName, plural } from "./ui.js";

// The members of the team. A step is tagged with the member that took it.
export const AGENTS = {
  lead: { name: "Orchestrator", job: "Decides who works next and writes your summary" },
  risk: { name: "Risk agent", job: "Checks the records and calls the failure model" },
  stock: { name: "Stock agent", job: "Checks the spare-parts store" },
  supply: { name: "Supply agent", job: "Requests missing parts from the supply department" },
};
const VERB = {
  check_records: "check the data",
  run_failure_model: "call the failure model",
  list_records: "read the results",
  get_record: "look closer at a record",
  get_model_track_record: "check the model's track record",
  propose_actions: "file the proposed actions",
  check_stock: "check the spare-parts store",
  reserve_parts: "set the free parts aside",
  get_supply_options: "look for a source for the missing parts",
  request_parts: "file a parts request",
  assign_risk_agent: "hand the records to the Risk agent",
  assign_stock_agent: "ask the Stock agent to check for parts",
  assign_supply_agent: "ask the Supply agent to find the missing parts",
};
const DOING = {
  check_records: "Checking the data",
  run_failure_model: "Calling the failure model",
  list_records: "Reading the results",
  get_record: "Looking closer at a record",
  get_model_track_record: "Checking the model's track record",
  propose_actions: "Filing the proposed actions",
  check_stock: "Checking the spare-parts store",
  reserve_parts: "Setting the free parts aside",
  get_supply_options: "Looking for a source for the missing parts",
  request_parts: "Filing a parts request",
  assign_risk_agent: "Waiting for the Risk agent",
  assign_stock_agent: "Waiting for the Stock agent",
  assign_supply_agent: "Waiting for the Supply agent",
};
const HANDED = { assign_risk_agent: "Handed the records to the Risk agent", assign_stock_agent: "Asked the Stock agent which repairs have a part",
  assign_supply_agent: "Asked the Supply agent to find the missing parts" };
const days = (d) => (Number.isInteger(d) ? `${d} day${d === 1 ? "" : "s"}` : "no delivery date");
// "8 from the central warehouse (2 days)", for one line of a parts request as a tool or the server reports it.
export const partLine = (line) => {
  const name = String(line.from || line.source_name || "").toLowerCase();
  const when = line.arrives_in_days ?? line.delivery_days;
  return Number.isInteger(when) ? `${fmtInt(line.quantity)} from the ${name} (${days(when)})` : `${fmtInt(line.quantity)} on ${name}`;
};
// What a review normally does, in order. Shown before a run starts and as the steps still to come while it works.
export const PLAN = [
  { key: "check_records", title: "Check the data", sub: "Count the records and find missing or unusable readings." },
  { key: "run_failure_model", title: "Call the failure model", sub: "The Stage 2 model we trained scores every record it can." },
  { key: "read", title: "Read the highest-risk records", sub: "Rank by risk and read the reasons behind each one." },
  { key: "propose_actions", title: "Draft the action list", sub: "File repairs, inspections and re-tests for you to decide on." },
];

const facts = (...parts) => parts.filter(Boolean).join('<span class="sep">·</span>');

function distribution(levels) {
  const L = levels || {};
  const part = (key, cls) => (L[key] ? `<i class="d-${cls}" style="flex-grow:${L[key]}"></i>` : "");
  return `<span class="dist" aria-hidden="true">${part("High", "high")}${part("Medium", "medium")}${part("Low", "low")}${part("Not scored", "none")}</span>
    <span class="dist-key">${facts(`<b class="t-high">${fmtInt(L.High)} High</b>`, `<b class="t-medium">${fmtInt(L.Medium)} Medium</b>`, `${fmtInt(L.Low)} Low`, `${fmtInt(L["Not scored"])} not scored`)}</span>`;
}

// One step, described for a person. `result` is HTML that is already escaped.
export function describe(step) {
  const o = step.output || {};
  const running = step.status === "running";
  if (step.type === "notice") return { tone: step.is_error ? "bad" : "note", title: o.text || "" };
  if (step.type === "model") {
    const who = AGENTS[step.agent] ? `The ${AGENTS[step.agent].name}` : "The agent";
    if (running) return { tone: "run", title: `${who} is deciding the next step` };
    if (step.is_error) return { tone: "bad", title: `${who}'s language model did not answer: ${o.error || "unknown error"}` };
    const calls = o.requested_tools || [];
    const wrote = step.agent === "lead" || !step.agent ? "wrote the summary" : "wrote its report";
    return { tone: "agent", title: calls.length ? `${who} decided to ${[...new Set(calls.map((c) => VERB[c.name] || c.name))].join(" and ")}` : `${who} ${wrote}` };
  }
  const name = step.name;
  if (running) return { tone: "run", title: DOING[name] || `Running ${name}`, tag: name === "run_failure_model" ? "Our Stage 2 model" : "" };
  if (step.is_error) {
    if (o.error === "MODEL_UNAVAILABLE") {
      return { tone: "bad", title: "The failure model did not answer", tag: "Our Stage 2 model",
        result: `${esc(o.message || "")} No predictions were made, and none were estimated in their place.` };
    }
    if (o.error === "STOCK_UNAVAILABLE") {
      return { tone: "bad", title: "The stock system did not answer", tag: "Simulated stock",
        result: `${esc(o.message || "")} Nothing was assumed about spare parts.` };
    }
    return { tone: "bad", title: `Could not ${VERB[name] || name}`, result: esc(o.error || "The tool reported an error.") };
  }
  switch (name) {
    case "assign_risk_agent":
    case "assign_stock_agent":
    case "assign_supply_agent":
      return { tone: "ok", title: HANDED[name], result: `${esc(o.agent || "It")} reported: ${esc(firstSentences(o.report))}` };
    case "check_stock":
      return { tone: "ok", title: "Checked the spare-parts store", tag: "Simulated stock",
        result: facts(`${fmtInt(o.free_now)} free in the hangar store`, `${plural(o.repairs_waiting_for_a_part, "repair")} waiting for a part`,
          o.shortage ? `<b class="t-high">${fmtInt(o.shortage)} short</b>` : "enough for all") };
    case "reserve_parts":
      return { tone: "ok", title: `Set ${plural(o.set_aside_from_hangar_store, "part")} aside for the most urgent repairs`,
        result: o.repairs_still_without_a_part
          ? facts(`<b class="t-high">${plural(o.repairs_still_without_a_part, "repair")} without a part</b>`,
            o.their_earliest_due_date_in_days ? `the most urgent is due within ${days(o.their_earliest_due_date_in_days)}` : "")
          : "Every proposed repair has a part." };
    case "get_supply_options":
      return { tone: "ok", title: `Looked for a source for ${plural(o.units_needed, "part")}`, tag: "Simulated supply department",
        result: facts(...(o.sources || []).filter((s) => s.source !== "backorder").map((s) =>
          `${esc(s.name)}: ${s.units_available === "no limit" ? "available" : `${fmtInt(s.units_available)} units`}${s.delivery_days ? `, ${days(s.delivery_days)}` : ", no delivery date"}`)) };
    case "request_parts":
      return { tone: "ok", title: `Filed request ${esc(o.request_id)} for ${plural(o.units_requested, "part")}`, tag: "Waits for your approval",
        result: facts(...(o.lines || []).map((l) => esc(partLine(l))),
          o.arrive_after_the_repair_is_due_for ? `<b class="t-high">${fmtInt(o.arrive_after_the_repair_is_due_for)} arrive after the repair is due</b>` : "all arrive in time",
          o.repairs_still_without_any_source ? `<b class="t-high">${fmtInt(o.repairs_still_without_any_source)} with no source</b>` : "") };
    case "check_records":
      return { tone: "ok", title: "Checked the data",
        result: facts(plural(o.records, "record"), `${fmtInt(o.with_missing_or_unusable_readings)} with a missing or unusable reading`, `${fmtInt(o.cannot_be_scored)} cannot be scored`) };
    case "run_failure_model":
      return { tone: "ok", title: `Called the failure model on ${plural((o.scored || 0) + (o.not_scored || 0), "record")}`,
        tag: `Our Stage 2 model · version ${esc(o.model_version || "")}`,
        result: `${distribution(o.by_level)}<span class="tl-extra">About ${plural(Math.round(o.expected_failures_in_30_days || 0), "failure")} expected within 30 days if nothing is done.</span>` };
    case "list_records": {
      const level = step.input?.level && step.input.level !== "Any" ? `${step.input.level}-risk ` : "";
      const first = o.records?.[0];
      return { tone: "ok", title: `Read ${fmtInt(o.returned)} of ${fmtInt(o.matching)} ${level}records${step.input?.only_missing_readings ? " with a missing reading" : ""}`,
        result: first ? `Highest: <span class="mono">${esc(first.aircraft)}</span>${first.risk_percent != null ? ` at ${first.risk_percent}%` : ""}${first.reason ? `, ${esc(first.reason.toLowerCase())}` : ""}` : "No records matched." };
    }
    case "get_record":
      return { tone: "ok", title: `Looked closer at ${o.aircraft || step.input?.record_id || "a record"}`,
        result: o.risk_percent != null ? facts(`${o.risk_percent}% risk`, esc(o.reason || ""), o.confidence ? esc(o.confidence.split(":")[0] + " confidence") : "") : esc(cap(o.model_result || "")) };
    case "get_model_track_record":
      return { tone: "ok", title: "Checked the model's track record",
        result: facts(`F1 ${esc(o.f1_percent)}`, `${esc(o.failures_flagged_in_their_final_30_days)} failures flagged in their final 30 days`) };
    case "propose_actions": {
      const kinds = Object.entries(o.by_action || {}).map(([label, n]) => `${fmtInt(n)} × ${esc(label)}`);
      return { tone: "ok", title: `Filed ${plural(o.filed_for_review, "action")} for your approval`,
        result: facts(...kinds, o.not_filed?.length ? `${fmtInt(o.not_filed.length)} not filed` : "", "nothing has been carried out") };
    }
    default:
      return { tone: "ok", title: name };
  }
}

// The opening of a report: its first sentence or two, without Markdown marks.
export function firstSentences(text, limit = 190) {
  const plain = String(text || "").replace(/\*\*/g, "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, 60)).trim()}`;
}

const pretty = (v) => esc(JSON.stringify(v ?? null, null, 2));
const NODE = { ok: icon("check"), bad: icon("x"), run: '<span class="spinner"></span>', agent: "", note: "", todo: "" };

function row(step, engine, fresh) {
  const d = describe(step);
  if (step.type === "notice") return `<li class="tl-row tl-note ${d.tone === "bad" ? "is-bad" : ""} ${fresh ? "is-new" : ""}"><span class="tl-node"></span><div class="tl-body"><div class="tl-title">${esc(d.title)}</div></div></li>`;
  const meta = [];
  const who = AGENTS[step.agent];
  if (who) meta.push(`<span class="tl-who tl-who-${step.agent}">${who.name}</span>`);
  if (step.type === "tool") meta.push(`<code>${esc(step.name)}</code>`);
  if (step.type === "model" && step.status !== "running") {
    if (engine) meta.push(esc(modelName(step.output?.served_by || step.name)));
    if (step.tokens_in || step.tokens_out) meta.push(`${fmtInt(step.tokens_in)} in, ${fmtInt(step.tokens_out)} out`);
    if (engine && step.cost_usd) meta.push(fmtUsd(step.cost_usd));
  }
  if (step.duration_ms != null && step.status !== "running") meta.push(fmtMs(step.duration_ms));
  const more = step.status === "running" ? "" : `
    <details class="tl-more" data-k="s${step.seq}"><summary>${step.type === "tool" ? "Exact input and output" : "The agent's reply"}</summary>
      ${step.type === "tool" ? `<div class="code-label">Input</div><pre>${pretty(step.input)}</pre>` : ""}
      <div class="code-label">${step.type === "tool" ? "Output" : "Reply"}</div><pre>${pretty(step.output)}</pre></details>`;
  const kind = step.type === "model" ? "tl-agent" : "tl-tool";
  return `<li class="tl-row ${kind} is-${d.tone} ${fresh ? "is-new" : ""}">
    <span class="tl-node">${NODE[d.tone] ?? ""}</span>
    <div class="tl-body">
      <div class="tl-line"><span class="tl-title">${esc(d.title)}${d.tone === "run" ? '<span class="dots"></span>' : ""}</span><span class="tl-meta">${meta.join(" · ")}</span></div>
      ${d.tag ? `<div class="tl-tag">${d.tag}</div>` : ""}
      ${d.result ? `<div class="tl-result">${d.result}</div>` : ""}${more}
    </div></li>`;
}

const ghost = (p) => `<li class="tl-row tl-tool is-todo"><span class="tl-node"></span><div class="tl-body">
  <div class="tl-line"><span class="tl-title">${p.title}</span></div><div class="tl-result">${p.sub}</div></div></li>`;

// The trail of a run. `ahead` adds the planned steps a running review has not reached yet; `engine` names the language
// model; steps numbered above `after` are marked as new, so only they animate in while a run is being followed.
export function timeline(run, { ahead = false, engine = false, after = Infinity } = {}) {
  const steps = run?.steps || [];
  if (!steps.length && !ahead) return '<p class="muted">No steps recorded yet.</p>';
  let rest = "";
  if (ahead && run.status === "running" && run.kind === "review") {
    const st = stages(run);
    rest = PLAN.filter((_, i) => st[i] === "todo").map(ghost).join("");
  }
  return `<ol class="tl">${steps.map((s) => row(s, engine, s.seq > after)).join("")}${rest}</ol>`;
}

// The same trail before anything has run: what the agent will do, and where the planner comes in.
export function planned() {
  return `<ol class="tl tl-plan">${PLAN.map(ghost).join("")}
    <li class="tl-row tl-tool is-todo is-you"><span class="tl-node"></span><div class="tl-body">
      <div class="tl-line"><span class="tl-title">You decide</span></div>
      <div class="tl-result">Approve or reject each action. Only an approval creates a work order, and work orders are simulated.</div></div></li></ol>`;
}

export function seconds(run) {
  const from = new Date(run.started_at).getTime();
  const to = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 1000)) : null;
}

export function runMeta(run, { engine = false } = {}) {
  const bits = [cap(fmtTime(run.started_at))];
  if (engine) bits.push(esc(run.mode === "claude" ? modelName(run.model) : cap(run.mode)));
  const toolCalls = run.steps ? run.steps.filter((s) => s.type === "tool").length : run.tool_calls;
  if (toolCalls != null) bits.push(plural(toolCalls, "tool call"));
  const took = run.status === "running" ? null : seconds(run);
  if (took != null) bits.push(`${took} s`);
  if (engine) bits.push(run.cost_usd ? `${fmtInt(run.input_tokens + run.cache_read_tokens + run.cache_write_tokens + run.output_tokens)} tokens · ${fmtUsd(run.cost_usd)}` : "no cost");
  return bits.join(" · ");
}

// Where a review run stands against the plan: "todo", "doing", "done" or "failed" for each planned step.
export function stages(run) {
  const tools = (run?.steps || []).filter((s) => s.type === "tool");
  const state = (names) => {
    const mine = tools.filter((s) => names.includes(s.name));
    if (!mine.length) return "todo";
    if (mine.some((s) => s.status === "running")) return "doing";
    return mine.some((s) => s.is_error) && !mine.some((s) => !s.is_error) ? "failed" : "done";
  };
  const out = [state(["check_records"]), state(["run_failure_model"]), state(["list_records", "get_record", "get_model_track_record"]), state(["propose_actions"])];
  if (out[3] !== "todo" && out[2] === "todo") out[2] = "done";    // the model's own top list was enough; nothing extra was read
  if (out[1] === "failed") { out[2] = out[2] === "todo" ? "skipped" : out[2]; out[3] = out[3] === "todo" ? "skipped" : out[3]; }
  return out;
}

// True when the latest attempt to call the failure model failed and no later call succeeded.
export function modelFailed(run) {
  const calls = (run?.steps || []).filter((s) => s.type === "tool" && s.name === "run_failure_model" && s.status !== "running");
  return calls.length > 0 && calls[calls.length - 1].is_error;
}
