// Turns the raw steps of an assistant run into something a person can read: one plain sentence per step,
// with the exact inputs and outputs one click away.
import { esc, fmtInt, fmtMs, fmtTime, fmtUsd, icon, modelName, plural } from "./ui.js";

const VERB = {
  check_records: "check the records",
  run_failure_model: "run the failure model",
  list_records: "read the results",
  get_record: "look closer at a record",
  get_model_track_record: "check the model's track record",
  propose_actions: "file the proposed actions",
};
export const STAGES = [
  { key: "check_records", label: "Check the data" },
  { key: "run_failure_model", label: "Run the failure model" },
  { key: "read", label: "Read the results" },
  { key: "propose_actions", label: "Draft the action list" },
];

export function describe(step) {
  const o = step.output || {};
  const running = step.status === "running";
  if (step.type === "notice") return { icon: step.is_error ? "alert" : "info", tone: step.is_error ? "warn" : "note", title: o.text || "" };
  if (step.type === "model") {
    if (running) return { icon: "spark", tone: "run", title: "Deciding the next step…" };
    if (step.is_error) return { icon: "alert", tone: "bad", title: `The assistant could not answer: ${o.error || "unknown error"}` };
    const calls = o.requested_tools || [];
    const title = calls.length ? `Decided to ${[...new Set(calls.map((c) => VERB[c.name] || c.name))].join(" and ")}` : "Wrote the answer";
    return { icon: "spark", tone: "think", title };
  }
  const name = step.name;
  if (running) {
    const doing = { check_records: "Checking the records…", run_failure_model: "Running the failure model…", list_records: "Reading the results…",
      get_record: "Looking closer at a record…", get_model_track_record: "Checking the model's track record…", propose_actions: "Filing the proposed actions…" };
    return { icon: "tool", tone: "run", title: doing[name] || `Running ${name}…` };
  }
  if (step.is_error) {
    const title = o.error === "MODEL_UNAVAILABLE" ? `The model call failed. ${o.message || ""} No predictions were made.` : `${VERB[name] ? `Could not ${VERB[name]}` : name}: ${o.error || "error"}`;
    return { icon: "alert", tone: "bad", title };
  }
  switch (name) {
    case "check_records":
      return { icon: "database", tone: "ok", title: `Checked ${plural(o.records, "record")}: ${fmtInt(o.with_missing_or_unusable_readings)} with a missing or unusable reading, ${fmtInt(o.cannot_be_scored)} cannot be scored` };
    case "run_failure_model":
      return { icon: "cpu", tone: "ok", title: `Ran the model on ${plural(o.scored, "record")}: ${fmtInt(o.by_level?.High)} predicted to fail, ${fmtInt(o.by_level?.Medium)} to watch` };
    case "list_records":
      return { icon: "queue", tone: "ok", title: `Read ${fmtInt(o.returned)} of ${fmtInt(o.matching)} ${step.input?.level && step.input.level !== "Any" ? `${step.input.level} ` : ""}records` };
    case "get_record":
      return { icon: "eye", tone: "ok", title: `Looked closer at ${o.aircraft || step.input?.record_id}` };
    case "get_model_track_record":
      return { icon: "shield", tone: "ok", title: "Checked the model's track record" };
    case "propose_actions": {
      const skipped = o.not_filed?.length ? `, ${fmtInt(o.not_filed.length)} not filed` : "";
      return { icon: "decisions", tone: "ok", title: `Filed ${plural(o.filed_for_review, "proposal")} for your approval${skipped}` };
    }
    default:
      return { icon: "tool", tone: "ok", title: name };
  }
}

const pretty = (v) => esc(JSON.stringify(v ?? null, null, 2));

export function timeline(run, { open = false } = {}) {
  if (!run?.steps?.length) return '<p class="muted pad">No steps recorded yet.</p>';
  const items = run.steps.map((step) => {
    const d = describe(step);
    const meta = [];
    if (step.type === "model" && step.status !== "running") {
      meta.push(esc(modelName(step.output?.served_by || step.name)));
      if (step.tokens_in || step.tokens_out) meta.push(`${fmtInt(step.tokens_in)} in, ${fmtInt(step.tokens_out)} out`);
      if (step.cost_usd) meta.push(fmtUsd(step.cost_usd));
    }
    if (step.duration_ms != null && step.type !== "notice") meta.push(fmtMs(step.duration_ms));
    const kind = step.type === "model" ? "Assistant" : step.type === "tool" ? `Tool · ${esc(step.name)}` : "Notice";
    const detail = step.type === "notice" ? "" : `
      <details class="step-detail" ${open ? "open" : ""}><summary>Show the exact ${step.type === "model" ? "reply" : "input and output"}</summary>
        ${step.type === "tool" ? `<div class="code-label">Input</div><pre>${pretty(step.input)}</pre>` : ""}
        <div class="code-label">${step.type === "tool" ? "Output" : "Reply"}</div><pre>${pretty(step.output)}</pre></details>`;
    return `<li class="step step-${d.tone}">
      <span class="step-ic">${step.status === "running" ? '<span class="spinner"></span>' : icon(d.icon)}</span>
      <div class="step-body"><div class="step-kind">${kind}${meta.length ? ` <span>· ${meta.join(" · ")}</span>` : ""}</div>
        <div class="step-title">${esc(d.title)}</div>${detail}</div></li>`;
  }).join("");
  return `<ol class="steps">${items}</ol>`;
}

export function runMeta(run) {
  const bits = [fmtTime(run.started_at), esc(run.mode === "claude" ? modelName(run.model) : run.mode[0].toUpperCase() + run.mode.slice(1))];
  const toolCalls = run.steps ? run.steps.filter((s) => s.type === "tool").length : run.tool_calls;
  if (toolCalls != null) bits.push(plural(toolCalls, "tool call"));
  if (run.cost_usd) bits.push(`${fmtInt(run.input_tokens + run.cache_read_tokens + run.cache_write_tokens + run.output_tokens)} tokens`, fmtUsd(run.cost_usd));
  else bits.push("no cost");
  return bits.join(" · ");
}

// Where a review run stands, for the progress strip shown while it works.
export function stages(run) {
  const tools = (run?.steps || []).filter((s) => s.type === "tool");
  const state = (names) => {
    const mine = tools.filter((s) => names.includes(s.name));
    if (!mine.length) return "todo";
    if (mine.some((s) => s.status === "running")) return "doing";
    return mine.some((s) => s.is_error) && !mine.some((s) => !s.is_error) ? "failed" : "done";
  };
  const out = [state(["check_records"]), state(["run_failure_model"]), state(["list_records", "get_record", "get_model_track_record"]), state(["propose_actions"])];
  // The step after the last finished one is the one being worked on, even between tool calls.
  if (run?.status === "running" && !out.includes("doing") && !out.includes("failed")) {
    const next = out.indexOf("todo");
    if (next >= 0) out[next] = "doing";
  }
  if (out[3] !== "todo" && out[2] === "todo") out[2] = "done";    // nothing extra needed reading
  return out;
}
