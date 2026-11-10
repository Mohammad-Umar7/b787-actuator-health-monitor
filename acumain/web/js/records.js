// "Add records": upload a file of diagnostic records, or type one record in and see the model's answer live.
import { api } from "./api.js";
import { state } from "./main.js";
import { $, LEVEL_CLASS, esc, fmtInt, fmtRisk, icon, levelPill, toast } from "./ui.js";

const EXAMPLES = {
  healthy: { label: "Healthy actuator", values: { Hydraulic_Fluid_Grade: "FG-B", Flight_Hours_Last_7_Days: 80, Flight_Cycles_Last_7_Days: 12, Actuator_Age_Hours: 1500, Days_Since_Last_Service: 60, Ambient_Temperature_C: 25, Hydraulic_Pressure_PSI: 5000, Pressure_Variation_PSI: 55, Hydraulic_Fluid_Temperature_C: 55, Internal_Leakage_Rate_mL_Min: 4, Actuation_Time_Seconds: 3.9, Reference_Leakage_Flow_mL_Min: 50, Reference_Actuation_Time_Seconds: 6, Diagnostic_Load_Ratio: 1 } },
  worn: { label: "Worn actuator", values: { Hydraulic_Fluid_Grade: "FG-A", Flight_Hours_Last_7_Days: 95, Flight_Cycles_Last_7_Days: 16, Actuator_Age_Hours: 3400, Days_Since_Last_Service: 180, Ambient_Temperature_C: 31, Hydraulic_Pressure_PSI: 4950, Pressure_Variation_PSI: 78, Hydraulic_Fluid_Temperature_C: 62, Internal_Leakage_Rate_mL_Min: 24, Actuation_Time_Seconds: 5.4, Reference_Leakage_Flow_mL_Min: 50, Reference_Actuation_Time_Seconds: 6, Diagnostic_Load_Ratio: 1 } },
  missing: { label: "Leakage reading missing", values: { Hydraulic_Fluid_Grade: "FG-A", Flight_Hours_Last_7_Days: 95, Flight_Cycles_Last_7_Days: 16, Actuator_Age_Hours: 3400, Days_Since_Last_Service: 180, Ambient_Temperature_C: 31, Hydraulic_Pressure_PSI: 4950, Pressure_Variation_PSI: 70, Hydraulic_Fluid_Temperature_C: 62, Internal_Leakage_Rate_mL_Min: "", Actuation_Time_Seconds: 4.9, Reference_Leakage_Flow_mL_Min: 50, Reference_Actuation_Time_Seconds: 6, Diagnostic_Load_Ratio: 1 } },
  none: { label: "Both key readings missing", values: { Hydraulic_Fluid_Grade: "FG-C", Flight_Hours_Last_7_Days: 70, Flight_Cycles_Last_7_Days: 10, Actuator_Age_Hours: 2100, Days_Since_Last_Service: 120, Ambient_Temperature_C: 28, Hydraulic_Pressure_PSI: 5010, Pressure_Variation_PSI: 66, Hydraulic_Fluid_Temperature_C: 58, Internal_Leakage_Rate_mL_Min: "", Actuation_Time_Seconds: "", Reference_Leakage_Flow_mL_Min: 50, Reference_Actuation_Time_Seconds: 6, Diagnostic_Load_Ratio: 1 } },
};
const m = { tab: "upload", onMade: null, busy: false, values: { ...EXAMPLES.worn.values }, result: null, error: null, uploadError: null, file: null };

export function openAddRecords(onMade) {
  Object.assign(m, { tab: "upload", onMade, busy: false, result: null, error: null, uploadError: null, file: null, values: { ...EXAMPLES.worn.values } });
  render();
}
function close() {
  $("#modal-root").innerHTML = "";
}

function render() {
  $("#modal-root").innerHTML = `
    <div class="scrim scrim-modal" data-m="close"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Add records">
      <header><h2>Add records</h2><button type="button" class="icon-btn" data-m="close" aria-label="Close">${icon("x")}</button></header>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-m="tab" data-tab="upload" aria-selected="${m.tab === "upload"}">${icon("upload")}Upload a file</button>
        <button type="button" role="tab" data-m="tab" data-tab="manual" aria-selected="${m.tab === "manual"}">${icon("cpu")}Check one record</button>
      </div>
      <div class="modal-body">${m.tab === "upload" ? uploadTab() : manualTab()}</div>
    </div>`;
}

function uploadTab() {
  return `
    <label class="drop ${m.file ? "has-file" : ""}" id="drop">
      <input type="file" id="file" accept=".csv,text/csv" hidden>
      ${icon(m.file ? "file" : "upload")}
      <b>${m.file ? esc(m.file.name) : "Drop a CSV file here, or click to choose one"}</b>
      <span>${m.file ? `${fmtInt(m.file.size / 1024)} KB · click to choose another` : `Same columns as the Stage 2 test file. Up to ${fmtInt(state.meta.limits.max_rows)} records.`}</span>
    </label>
    ${m.uploadError ? `<div class="callout callout-error">${icon("alert")}<p><b>This file cannot be used.</b> ${esc(m.uploadError)}</p></div>` : ""}
    <label class="field"><span>Name for this batch (optional)</span><input type="text" id="batch-name" maxlength="80" placeholder="For example: Week 47 diagnostics"></label>
    <div class="modal-actions">
      <span class="links"><a href="/api/files/sample_upload.csv" download>${icon("download")}Sample file (30 records)</a>
        <a href="/api/files/template.csv" download>${icon("download")}Empty template</a></span>
      <button type="button" class="btn btn-primary" data-m="upload" ${m.file && !m.busy ? "" : "disabled"}>${m.busy ? "Checking the file…" : "Add to the review queue"}</button>
    </div>
    <ul class="hints">
      <li>Blank readings are fine. They are reported, and the model still predicts unless both key readings are missing.</li>
      <li>Values that are not numbers or are outside the allowed range are treated as missing and listed for you.</li>
      <li>If the file has a <code>Failure_Next_30_Days</code> column, AcuMain also shows how the model did against it.</li>
    </ul>`;
}

function manualTab() {
  const field = (f) => {
    const v = m.values[f.name] ?? "";
    if (f.kind === "choice") {
      return `<label class="field"><span>${esc(f.label)}</span><select data-m-field="${f.name}">
        <option value="">(missing)</option>${f.choices.map((c) => `<option ${c === v ? "selected" : ""}>${c}</option>`).join("")}</select></label>`;
    }
    return `<label class="field"><span>${esc(f.label)}${f.unit ? ` <i>${esc(f.unit)}</i>` : ""}</span>
      <input type="text" inputmode="decimal" data-m-field="${f.name}" value="${esc(v)}" placeholder="leave empty if missing" data-tip="${esc(f.label)}|Allowed: ${f.min} to ${f.max}"></label>`;
  };
  return `
    <p class="modal-intro">Type the readings of one diagnostic test and the model answers at once. Nothing is saved. Leave a reading empty to see how a missing value is handled.</p>
    <div class="examples"><span>Start from an example:</span>${Object.entries(EXAMPLES).map(([k, e]) => `<button type="button" class="btn btn-ghost btn-sm" data-m="example" data-key="${k}">${e.label}</button>`).join("")}</div>
    <div class="manual">
      <form class="fields" data-m-form="check">${state.meta.fields.map(field).join("")}
        <div class="fields-foot"><button type="submit" class="btn btn-primary" ${m.busy ? "disabled" : ""}>${icon("play")}${m.busy ? "Asking the model…" : "Check this record"}</button></div>
      </form>
      <div class="manual-result">${resultCard()}</div>
    </div>`;
}

function resultCard() {
  if (m.error) return `<div class="callout callout-error">${icon("alert")}<p><b>No prediction.</b> ${esc(m.error)}</p></div>`;
  const d = m.result;
  if (!d) return `<div class="result-empty">${icon("cpu")}<p>The model's answer appears here.</p></div>`;
  const notes = d.issues.length ? `<ul class="notes">${d.issues.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  if (!d.scorable) {
    return `<div class="result"><div class="result-top">${levelPill("Not scored")}</div>
      <p><b>No prediction was made.</b> Both key readings are missing or unusable, so the model was not asked to guess.</p>
      <p class="fine">Suggested next step: ${esc(state.meta.actions[d.suggested_action])}.</p>${notes}</div>`;
  }
  return `<div class="result">
    <div class="result-top"><span class="hero-num risk-${LEVEL_CLASS[d.level]}">${fmtRisk(d.risk)}</span>${levelPill(d.level)}</div>
    <p><b>${d.prediction === "Yes" ? "Yes, likely to fail within 30 days." : "No failure expected within 30 days."}</b> ${esc(d.reason)}.</p>
    <dl class="facts">
      <div><dt>Typically fails in</dt><dd>${esc(d.time_left || "–")}</dd></div>
      <div><dt>Suggested next step</dt><dd>${esc(state.meta.actions[d.suggested_action])}</dd></div>
      <div><dt>Operation time</dt><dd>${esc(d.readings.operation.text || "not recorded")}</dd></div>
      <div><dt>Leakage</dt><dd>${esc(d.readings.leakage.text || "not recorded")}</dd></div>
    </dl>
    <p class="confidence ${d.confidence.startsWith("Reduced") ? "is-reduced" : ""}">${icon(d.confidence.startsWith("Reduced") ? "alert" : "shield")}Confidence: ${esc(d.confidence)}</p>
    ${notes}</div>`;
}

function readFields() {
  for (const el of document.querySelectorAll("[data-m-field]")) m.values[el.dataset.mField] = el.value.trim();
}

async function upload() {
  if (!m.file || m.busy) return;
  m.busy = true;
  m.uploadError = null;
  const name = $("#batch-name")?.value.trim();
  render();
  try {
    const made = await api.upload(m.file, name);
    close();
    toast(`${fmtInt(made.records)} records added${made.with_issues ? `, ${fmtInt(made.with_issues)} with a missing or unusable reading` : ""}.`, "ok");
    m.onMade?.(made);
  } catch (err) {
    m.busy = false;
    m.uploadError = err.message;
    render();
  }
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-m]");
  if (!el) return;
  const act = el.dataset.m;
  if (act === "close") close();
  else if (act === "tab") { if (m.tab === "manual") readFields(); m.tab = el.dataset.tab; render(); }
  else if (act === "upload") upload();
  else if (act === "example") { m.values = { ...EXAMPLES[el.dataset.key].values }; m.result = null; m.error = null; render(); }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id !== "file") return;
  m.file = ev.target.files[0] || null;
  m.uploadError = null;
  render();
});

for (const type of ["dragover", "dragleave", "drop"]) {
  document.addEventListener(type, (ev) => {
    const drop = ev.target.closest && ev.target.closest("#drop");
    if (!drop) return;
    ev.preventDefault();
    drop.classList.toggle("is-over", type === "dragover");
    if (type === "drop" && ev.dataTransfer.files.length) { m.file = ev.dataTransfer.files[0]; m.uploadError = null; render(); }
  });
}

document.addEventListener("submit", async (ev) => {
  if (ev.target.dataset.mForm !== "check") return;
  ev.preventDefault();
  if (m.busy) return;
  readFields();
  m.busy = true;
  m.error = null;
  render();
  try {
    m.result = await api.predict(m.values);
  } catch (err) {
    m.result = null;
    m.error = err.message;
  }
  m.busy = false;
  render();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && $("#modal-root").innerHTML) close();
});
