// "Check a single record": type the readings of one diagnostic test. The record becomes a file of its own, and the
// same team of agents reviews it in the same way as a fleet file, so one aircraft and two thousand look alike.
import { api } from "./api.js";
import { state } from "./main.js";
import { $, esc, icon } from "./ui.js";

const BASE = { Flight_Hours_Last_7_Days: 95, Flight_Cycles_Last_7_Days: 16, Actuator_Age_Hours: 3400, Days_Since_Last_Service: 180, Ambient_Temperature_C: 31,
  Hydraulic_Pressure_PSI: 4950, Hydraulic_Fluid_Temperature_C: 62, Reference_Leakage_Flow_mL_Min: 50, Reference_Actuation_Time_Seconds: 6, Diagnostic_Load_Ratio: 1 };
const EXAMPLES = {
  worn: { label: "Worn actuator", values: { ...BASE, Aircraft_ID: "B787-102", Hydraulic_Fluid_Grade: "FG-A", Pressure_Variation_PSI: 78, Internal_Leakage_Rate_mL_Min: 24, Actuation_Time_Seconds: 5.4 } },
  healthy: { label: "Healthy actuator", values: { ...BASE, Aircraft_ID: "B787-101", Hydraulic_Fluid_Grade: "FG-B", Flight_Hours_Last_7_Days: 80, Flight_Cycles_Last_7_Days: 12, Actuator_Age_Hours: 1500,
    Days_Since_Last_Service: 60, Ambient_Temperature_C: 25, Hydraulic_Pressure_PSI: 5000, Pressure_Variation_PSI: 55, Hydraulic_Fluid_Temperature_C: 55, Internal_Leakage_Rate_mL_Min: 4, Actuation_Time_Seconds: 3.9 } },
  missing: { label: "Leakage reading missing", values: { ...BASE, Aircraft_ID: "B787-103", Hydraulic_Fluid_Grade: "FG-A", Pressure_Variation_PSI: 70, Internal_Leakage_Rate_mL_Min: "", Actuation_Time_Seconds: 4.9 } },
  none: { label: "Both key readings missing", values: { ...BASE, Aircraft_ID: "B787-104", Hydraulic_Fluid_Grade: "FG-C", Flight_Hours_Last_7_Days: 70, Flight_Cycles_Last_7_Days: 10, Actuator_Age_Hours: 2100,
    Days_Since_Last_Service: 120, Ambient_Temperature_C: 28, Hydraulic_Pressure_PSI: 5010, Pressure_Variation_PSI: 66, Hydraulic_Fluid_Temperature_C: 58, Internal_Leakage_Rate_mL_Min: "", Actuation_Time_Seconds: "" } },
};
const m = { busy: false, example: "worn", values: { ...EXAMPLES.worn.values }, error: null, done: null };

// `onMade` receives the new one-record file once the server has checked and stored it.
export function openCheck(onMade) {
  Object.assign(m, { busy: false, example: "worn", error: null, values: { ...EXAMPLES.worn.values }, done: onMade });
  render();
}
function close() {
  $("#modal-root").innerHTML = "";
}

function render() {
  const field = (f) => {
    const value = m.values[f.name] ?? "";
    if (f.kind === "choice") {
      return `<label class="field"><span>${esc(f.label)}</span><select data-c-field="${f.name}" ${api.isPublic ? "disabled" : ""}>
        <option value="">(missing)</option>${f.choices.map((c) => `<option ${c === value ? "selected" : ""}>${c}</option>`).join("")}</select></label>`;
    }
    return `<label class="field"><span>${esc(f.label)}${f.unit ? ` <i>${esc(f.unit)}</i>` : ""}</span>
      <input type="text" inputmode="decimal" data-c-field="${f.name}" value="${esc(value)}" placeholder="empty = missing" data-tip="${esc(f.label)}|Allowed: ${f.min} to ${f.max}" ${api.isPublic ? "disabled" : ""}></label>`;
  };
  $("#modal-root").innerHTML = `
    <div class="scrim scrim-modal" data-c="close"></div>
    <div class="modal modal-check" role="dialog" aria-modal="true" aria-label="Check a single record">
      <header><div><h2>Check a single record</h2>
        <p>${api.isPublic ? "Pick one of the four examples. The real team reviewed each of them, and the review was recorded. Typing your own readings works in the Docker package."
          : "Type in the readings of one diagnostic test. The team reviews it the same way as a fleet file."}</p></div>
        <button type="button" class="icon-btn" data-c="close" aria-label="Close">${icon("x")}</button></header>
      <form class="modal-body" data-c-form="check">
        <div class="examples"><span>Start from</span>${Object.entries(EXAMPLES).map(([key, e]) => `
          <button type="button" data-c="example" data-key="${key}" aria-pressed="${m.example === key}">${e.label}</button>`).join("")}</div>
        <div class="fields fields-3">
          <label class="field"><span>Aircraft</span><input type="text" data-c-field="Aircraft_ID" maxlength="40" value="${esc(m.values.Aircraft_ID ?? "")}" placeholder="for example B787-102" ${api.isPublic ? "disabled" : ""}></label>
          ${state.meta.fields.map(field).join("")}
        </div>
        ${m.error ? `<div class="callout callout-error"><p><b>This record cannot be reviewed.</b> ${esc(m.error)}</p></div>` : ""}
        <div class="check-foot">
          <button type="submit" class="btn btn-primary btn-lg" ${m.busy ? "disabled" : ""}>${m.busy ? "Handing it to the team" : api.isPublic ? "Watch this review" : "Review this record"}${m.busy ? "" : icon("arrow")}</button>
          <span>${api.isPublic ? "The last two examples show how a missing reading is handled." : "Leave a reading empty to see how a missing value is handled."}</span>
        </div>
      </form>
    </div>`;
}

function readFields() {
  for (const el of document.querySelectorAll("[data-c-field]")) m.values[el.dataset.cField] = el.value.trim();
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-c]");
  if (!el) return;
  if (el.dataset.c === "close") close();
  else if (el.dataset.c === "example") {
    Object.assign(m, { example: el.dataset.key, values: { ...EXAMPLES[el.dataset.key].values }, error: null });
    render();
  }
});

document.addEventListener("submit", async (ev) => {
  if (ev.target.dataset.cForm !== "check") return;
  ev.preventDefault();
  if (m.busy) return;
  readFields();
  m.busy = true;
  m.error = null;
  render();
  try {
    const made = await api.addRecord(m.values);
    m.busy = false;
    close();
    m.done?.(made);
  } catch (err) {
    m.busy = false;
    m.error = err.message;
    if ($("#modal-root").innerHTML) render();
  }
});

// Escape closes whatever window is open in the middle of the screen, and only that: a record panel behind it stays.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || !$("#modal-root").innerHTML) return;
  close();
  ev.stopImmediatePropagation();
});
