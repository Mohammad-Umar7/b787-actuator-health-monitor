// Model track record: how the failure model did on aircraft it never saw, and a week-by-week replay against what happened.
import { api } from "./api.js";
import { state } from "./main.js";
import { $, LEVEL_CLASS, esc, fmtDate, fmtInt, fmtRisk, icon, levelMark, riskBar, subnav } from "./ui.js";

const OUTCOME_WEEKS = 5;      // a record's 30-day outcome is inside the data only if this many later weeks exist
const OP = [null, "operation starting to slow", "slow operation", "very slow operation"];
const LEAK = [null, "leakage starting to rise", "high leakage", "very high leakage"];
const t = { data: null, records: [], byWeek: [], week: 0, selected: null, show: "flagged" };

function expand(d) {
  const at = Object.fromEntries(d.fields.map((name, i) => [name, i]));
  const level = (risk) => (risk >= d.thresholds.high ? "High" : risk >= d.thresholds.medium ? "Medium" : "Low");
  const records = [];
  for (const aircraft of d.fleet) {
    aircraft.rows.forEach((v, order) => records.push({
      id: aircraft.id, order, risk: v[at.risk], level: level(v[at.risk]),
      op: v[at.op] < 0 ? null : v[at.op], leak: v[at.leak] < 0 ? null : v[at.leak],
      actuator: aircraft.acts[v[at.act]], replaced: order > 0 && aircraft.rows[order - 1][at.act] !== v[at.act], actual: v[at.y] === 1,
    }));
  }
  return records;
}
function reason(r) {
  const parts = [OP[r.op ?? 0], LEAK[r.leak ?? 0]].filter(Boolean);
  const text = parts.length ? parts.join(" and ") : "readings normal";
  return text[0].toUpperCase() + text.slice(1);
}
const lastWeek = () => t.data.weeks.length - 1;
const known = (week) => week <= lastWeek() - OUTCOME_WEEKS;

export async function show() {
  if (!t.data) {
    t.data = await api.history();
    t.records = expand(t.data);
    t.byWeek = t.data.weeks.map(() => []);
    for (const r of t.records) t.byWeek[r.order].push(r);
    t.week = lastWeek() - 8;       // a recent week whose outcome is known, so the replay shows what happened next
  }
  const v = state.meta.validation;
  const tr = state.meta.training;
  const fig = (value, label, note, tone = "") => `<div class="fig ${tone}"><b>${value}</b><span>${label}</span><small>${note}</small></div>`;
  $("#page").innerHTML = `
    <div class="wrap wrap-wide">
      ${subnav("model")}
      <h1 class="display display-sm">How far the failure model can be trusted</h1>
      <p class="lede">Checked on ${fmtInt(tr.aircraft)} aircraft it never saw in training, then replayed week by week against what the data recorded next.</p>
      <div class="figures figures-5">
        ${fig(`${v.caught} of ${v.failures}`, "Failures flagged in time", "At least once in their final 30 days", "fig-ok")}
        ${fig(`${v.lead_weeks} weeks`, "Typical first warning", "Before the actuator's last record")}
        ${fig(v.f1, "F1 score", `Precision ${v.precision}%, recall ${v.recall}%`)}
        ${fig(`${v.accuracy}%`, "Accuracy", `AUC ${v.auc}`)}
        ${fig(`${v.false_alarms_early}%`, "False alarms that were early", "Failed within 12 weeks anyway")}
      </div>
      <div class="two">
        <section class="sec">
          <header class="sec-head"><div><h2>What a risk level has meant</h2><p>From past records whose next three months are known.</p></div></header>
          <div class="table-wrap"><table><thead><tr><th>Risk</th><th>Level</th><th>Failed within 30 days</th><th>Failed within 12 weeks</th><th>Records</th></tr></thead>
            <tbody>${state.meta.timeframe.map((b) => { const level = b.from >= state.meta.thresholds.high ? "High" : b.from >= state.meta.thresholds.medium ? "Medium" : "Low"; return `<tr>
              <td><b>${b.from}% to ${Math.min(b.to, 100)}%</b></td><td>${levelMark(level)}</td>
              <td><span class="share share-${LEVEL_CLASS[level]}"><i style="width:${b.in_30_days}%"></i></span>${b.in_30_days}%</td>
              <td><span class="share share-${LEVEL_CLASS[level]}"><i style="width:${b.in_12_weeks}%"></i></span>${b.in_12_weeks}%</td><td>${fmtInt(b.n)}</td></tr>`; }).join("")}</tbody></table></div>
        </section>
        <section class="sec">
          <header class="sec-head"><div><h2>How it was checked</h2><p>The numbers on this page are not training scores.</p></div></header>
          <ul class="method">
            <li><b>Data.</b> ${fmtInt(tr.rows)} weekly records from ${fmtInt(tr.aircraft)} aircraft and ${fmtInt(tr.actuators)} actuators, ${esc(fmtDate(tr.from))} to ${esc(fmtDate(tr.to))}. ${fmtInt(tr.yes_rows)} are a Yes.</li>
            <li><b>Unseen aircraft.</b> ${esc(v.method)}. Every risk in the replay below comes from a model that never saw that aircraft.</li>
            <li><b>Decision line.</b> A record is a Yes from ${state.meta.thresholds.high}% risk, chosen on replacement actuators, the kind the test set contains.</li>
            <li><b>Limits.</b> One record at a time, no history: four and six weeks before a failure look alike, so about one Yes in three is early. The data is synthetic and for this hackathon only.</li>
          </ul>
        </section>
      </div>
      <section class="sec" id="replay"></section>
    </div>`;
  renderReplay();
}

// The frame is built once. Only its contents are refreshed afterwards, so the slider can be dragged smoothly.
function renderReplay() {
  $("#replay").innerHTML = `
    <header class="sec-head"><div><h2>Replay a week</h2><p>Pick any week of the two years. See what the model flagged, then what the data recorded next.</p></div>
      <div class="tabs" id="replay-seg"></div></header>
    <div class="replay-bar">
      <button type="button" class="icon-btn" id="wk-prev" data-t="step" data-step="-1" aria-label="One week earlier">${icon("chevron", "flip")}</button>
      <strong id="replay-date"></strong>
      <button type="button" class="icon-btn" id="wk-next" data-t="step" data-step="1" aria-label="One week later">${icon("chevron")}</button>
      <input type="range" id="week" min="0" max="${lastWeek()}" value="${t.week}" aria-label="Week shown">
      <span class="replay-counts" id="replay-counts"></span>
    </div>
    <p class="replay-line" id="replay-line"></p>
    <div class="replay-grid" id="replay-grid"></div>`;
  updateReplay();
}

function updateReplay() {
  const week = t.week;
  const fleet = [...t.byWeek[week]].sort((a, b) => b.risk - a.risk);
  const count = (lvl) => fleet.filter((r) => r.level === lvl).length;
  const flagged = fleet.filter((r) => r.level !== "Low");
  const rows = t.show === "flagged" ? flagged : fleet;
  if (!rows.some((r) => r.id === t.selected)) t.selected = rows[0]?.id ?? fleet[0].id;
  const showOutcome = known(week);
  const high = fleet.filter((r) => r.level === "High");
  const hits = high.filter((r) => r.actual).length;
  const line = !showOutcome ? "These are the latest weeks: the next 30 days are not in the data yet."
    : high.length ? `${hits} of the ${high.length} High-risk aircraft failed within 30 days. ${fleet.filter((r) => r.level !== "High" && r.actual).length} failure(s) were not flagged High this week.`
      : "No aircraft was High risk this week.";
  $("#replay-seg").innerHTML = `<button type="button" data-t="show" data-show="flagged" aria-pressed="${t.show === "flagged"}">Flagged<span>${flagged.length}</span></button>
    <button type="button" data-t="show" data-show="all" aria-pressed="${t.show === "all"}">All<span>${fleet.length}</span></button>`;
  $("#replay-date").textContent = fmtDate(t.data.weeks[week]);
  $("#wk-prev").disabled = week === 0;
  $("#wk-next").disabled = week === lastWeek();
  if (Number($("#week").value) !== week) $("#week").value = week;
  $("#replay-counts").innerHTML = `<span>${levelMark("High")}<b>${count("High")}</b></span><span>${levelMark("Medium")}<b>${count("Medium")}</b></span><span>${levelMark("Low")}<b>${count("Low")}</b></span>`;
  $("#replay-line").textContent = line;
  $("#replay-grid").innerHTML = `
      <div class="table-wrap replay-table"><table><thead><tr><th>Aircraft</th><th>Risk, next 30 days</th><th>Level</th><th>Why</th>${showOutcome ? "<th>Next 30 days, as recorded</th>" : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr data-t="pick" data-id="${esc(r.id)}" class="${r.id === t.selected ? "is-open" : ""}" tabindex="0">
          <td><span class="mono ac">${esc(r.id)}</span><small>Actuator ${esc(r.actuator)}</small></td><td class="c-risk">${riskBar(r.risk, r.level)}</td><td>${levelMark(r.level)}</td>
          <td class="c-why">${esc(reason(r))}</td>${showOutcome ? `<td>${r.actual ? '<span class="st st-bad">Failed</span>' : '<span class="muted">No failure</span>'}</td>` : ""}</tr>`).join("")
          || `<tr><td colspan="5" class="muted pad">No aircraft was flagged this week.</td></tr>`}</tbody></table></div>
      <div class="replay-chart"><h3><span class="mono">${esc(t.selected)}</span> · risk week by week</h3>${chart(t.selected)}
        <p class="fine">Dashed vertical lines mark a new actuator fitted after a failure. The red strip marks weeks whose record was a real Yes. Weeks after the chosen date are faded.</p></div>`;
}

function chart(id) {
  const d = t.data;
  const history = t.records.filter((r) => r.id === id);
  const n = d.weeks.length, W = 520, left = 34, right = 10, top = 12, plotH = 150, bottom = top + plotH;
  const band = (W - left - right) / n;
  const x = (order) => left + band * (order + 0.5);
  const y = (v) => top + plotH * (1 - v / 100);
  const grid = [0, 25, 50, 75, 100].map((v) => `<line class="${v ? "gridline" : "baseline"}" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
  const lines = [["High", d.thresholds.high], ["Medium", d.thresholds.medium]].map(([name, v]) => `<line class="threshold" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/><text class="threshold-label" x="${left + 4}" y="${y(v) - 4}">${name} from ${v}%</text>`).join("");
  const labels = d.weeks.map((iso, i) => ((i === 0 || d.weeks[i - 1].slice(0, 7) !== iso.slice(0, 7)) && ["01", "07"].includes(iso.slice(5, 7)) ? `<text x="${x(i)}" y="${bottom + 16}" text-anchor="middle">${esc(fmtDate(iso).slice(-8))}</text>` : "")).join("");
  const path = (rows) => (rows.length > 1 ? `M${rows.map((r) => `${x(r.order).toFixed(1)},${y(r.risk).toFixed(1)}`).join("L")}` : "");
  const now = history[t.week];
  const swaps = history.filter((r) => r.replaced).map((r) => `<line class="swap ${r.order > t.week ? "is-future" : ""}" x1="${x(r.order) - band / 2}" x2="${x(r.order) - band / 2}" y1="${top}" y2="${bottom}"/>`).join("");
  const failed = history.filter((r) => r.actual && known(r.order)).map((r) => `<rect class="fail-band ${r.order > t.week ? "is-future" : ""}" x="${x(r.order) - band / 2}" y="${bottom + 22}" width="${band + 0.4}" height="6"/>`).join("");
  const hits = history.map((r) => `<rect class="hit" x="${x(r.order) - band / 2}" y="${top}" width="${band}" height="${plotH + 30}" data-t="week" data-week="${r.order}"
    data-tip="${esc(fmtDate(d.weeks[r.order]))}|Risk ${fmtRisk(r.risk)} · ${r.level}|${esc(reason(r))}${r.replaced ? "|New actuator fitted this week" : ""}${r.actual && known(r.order) ? "|Recorded: failed within 30 days" : ""}"/>`).join("");
  const side = x(now.order) < left + 60;
  return `<svg class="chart" viewBox="0 0 ${W} ${bottom + 36}" role="img" aria-label="Risk by week for ${esc(id)}">
    ${grid}${lines}${labels}${swaps}<text class="row-label" x="${left - 6}" y="${bottom + 29}" text-anchor="end">Yes</text>${failed}
    <path class="line is-future" d="${path(history.slice(t.week))}"/><path class="line" d="${path(history.slice(0, t.week + 1))}"/>
    <circle class="dot dot-${LEVEL_CLASS[now.level]}" cx="${x(now.order)}" cy="${y(now.risk)}" r="5"/><circle class="ring" cx="${x(now.order)}" cy="${y(now.risk)}" r="8.5"/>
    <text class="value-label" x="${side ? x(now.order) + 14 : x(now.order) - 14}" y="${y(now.risk) < top + 8 ? y(now.risk) + 4 : y(now.risk) - 6}" text-anchor="${side ? "start" : "end"}">${fmtRisk(now.risk)}</text>
    ${hits}</svg>`;
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-t]");
  if (!el || state.page !== "model" || !t.data) return;
  const act = el.dataset.t;
  if (act === "step") t.week = Math.min(Math.max(t.week + Number(el.dataset.step), 0), lastWeek());
  else if (act === "week") t.week = Number(el.dataset.week);
  else if (act === "pick") t.selected = el.dataset.id;
  else if (act === "show") t.show = el.dataset.show;
  updateReplay();
});

document.addEventListener("input", (ev) => {
  if (ev.target.id !== "week" || state.page !== "model") return;
  t.week = Number(ev.target.value);
  updateReplay();
});
