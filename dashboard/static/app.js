"use strict";

const LEVEL_NAMES = ["Normal", "Slightly High", "High", "Very High"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Written for the people who decide, not the people who repair.
const ACTION = { High: "Schedule repair now", Medium: "Plan an inspection", Low: "No action needed" };
const COMPARE_WEEKS = 4;   // "what changed" looks this many weeks back, because one week is mostly sensor noise
const OUTCOME_WEEKS = 5;   // a record's 30-day outcome is inside the data only if this many later weeks exist

const state = { data: null, records: [], byWeek: [], periods: [], week: null, selected: null, filter: "All", sort: { key: "risk", dir: -1 } };

const $ = (sel) => document.querySelector(sel);
// Every value that comes from the data file goes through esc() before it reaches innerHTML.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cls = (level) => `is-${level.toLowerCase()}`;
const fmtRisk = (v) => (v < 1 ? "<1%" : `${Math.round(v)}%`);
const fmtThreshold = (v) => `${+v.toFixed(1)}%`;
const fmtInt = (v) => Math.round(v).toLocaleString("en-US");
const lastWeek = () => state.data.weeks.length - 1;
const fmtDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTH_NAMES[m - 1]} ${y}`; };
const fmtMonth = (iso) => { const [y, m] = iso.split("-").map(Number); return `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`; };
const dateOf = (week) => fmtDate(state.data.weeks[week]);
// The 30-day outcome of a record is only shown when the following weeks are in the data (a replay of the past).
const outcomeKnown = (week) => week <= lastWeek() - OUTCOME_WEEKS;

function icon(level) {
  if (level === "High") {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" style="fill:var(--critical)"/>
      <path d="M8 6v4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="12" r=".9" fill="#fff"/></svg>`;
  }
  if (level === "Medium") {
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 15 8 8 15 1 8z" style="fill:var(--warning)"/>
      <path d="M8 4.8v3.6" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11" r=".9" fill="#0b0b0b"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" style="fill:var(--good)"/>
    <path d="m4.8 8.2 2.2 2.2 4.2-4.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
const badge = (level) => `<span class="badge ${cls(level)}">${icon(level)}${level}</span>`;
const swatch = (level) => `<span class="swatch ${level == null ? "step-none" : `step-${level}`}"></span>`;
const condition = (level) => `<span class="cond">${swatch(level)}${level == null ? "No reading" : LEVEL_NAMES[level]}</span>`;

// ---------------------------------------------------------------- reasons in plain words
const OP_PHRASE = [null, "operation starting to slow", "slow operation", "very slow operation"];
const LEAK_PHRASE = [null, "leakage starting to rise", "high leakage", "very high leakage"];
const OP_MEANING = [
  "The actuator moves the landing gear in normal time.",
  "The actuator has started to take longer than normal to move the landing gear.",
  "The actuator is taking much longer than normal to move the landing gear.",
  "The actuator is as slow as actuators usually are just before they fail. In the data, this is the strongest warning sign.",
];
const LEAK_MEANING = [
  "Internal hydraulic leakage is normal.",
  "Internal hydraulic leakage has started to rise above normal.",
  "Hydraulic fluid is leaking inside the actuator well above normal.",
  "Internal leakage is at the level usually seen just before a failure.",
];
const DECISION_WHY = {
  High: "The risk is above the alert line. Aircraft at this level usually failed within a few weeks, so schedule the repair now to avoid an unplanned grounding.",
  Medium: "Not expected to fail this month, but the readings are moving towards failure. Plan an inspection before they get worse.",
  Low: "No warning sign is strong enough to act on yet.",
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Readings are compared with a new actuator, after correcting for the test settings of that day.
const slowerText = (t) => {
  const pct = Math.round((t / state.data.baseline.t - 1) * 100);
  return pct <= 2 ? "same as a new actuator" : `${pct}% slower than a new actuator`;
};
// Leakage starts near zero, so it reads more clearly as how far it has moved from a new actuator's level
// towards the level usually seen just before a failure. The level names use the same scale.
const leakText = (l) => {
  const { baseline, failing } = state.data;
  const pct = Math.round(Math.max(0, (l - baseline.l) / (failing.l - baseline.l)) * 100);
  return pct >= 100 ? "at or above the level seen at failure" : `${pct}% of the way to the level seen at failure`;
};

// The short reason shown in the table. Operation time comes first because it carries most of the risk.
function reasonShort(r) {
  const parts = [OP_PHRASE[r.op ?? 0], LEAK_PHRASE[r.leak ?? 0]].filter(Boolean);
  // One sign clearly high while the other is normal is worth saying: failures usually show both.
  if (oneSignOnly(r)) return cap(`${parts[0]}, ${r.op >= 2 ? "leakage" : "operation"} normal`);
  if (parts.length) return cap(parts.join(" and "));
  return r.op == null && r.leak == null ? "No readings this week" : "Readings normal";
}
const oneSignOnly = (r) => (r.op >= 2 && r.leak === 0) || (r.leak >= 2 && r.op === 0);

// How often records like this one were followed by a failure. The data has the answer for every record.
function pastOutcomes(match) {
  const known = state.records.filter(match);
  return { n: known.length, failed: known.filter((x) => x.actual).length };
}
function evidence(stat, what) {
  if (!stat.n) return `No record in the data had ${what}, so this part is the model's estimate.`;
  return `In the data, ${fmtInt(stat.failed)} of ${fmtInt(stat.n)} records with ${what} were followed by a failure within 30 days (${Math.round((stat.failed / stat.n) * 100)}%).`;
}

// What records at this risk have meant in time.
const bandOf = (risk) => state.data.timeframe.find((b) => risk >= b.from && risk < b.to) ?? state.data.timeframe.at(-1);
function timeLeft(risk) {
  const b = bandOf(risk);
  // A failure comes up to a week after an actuator's last record, so the upper end is one week later.
  if (b.weeks_low == null || b.weeks_high == null || b.weeks_high > 26) return `more than ${b.weeks_low ?? 26} weeks`;
  return b.weeks_low === 0 ? `under ${b.weeks_high + 1} weeks` : `${b.weeks_low} to ${b.weeks_high + 1} weeks`;
}

const recordAt = (id, week) => state.byWeek[week]?.find((x) => x.id === id);
function changeSince(r) {
  const fitted = state.records.find((x) => x.id === r.id && x.actIndex === r.actIndex);
  const age = r.order - fitted.order;
  const install = r.actIndex === 0 ? "" : `Actuator ${esc(r.actuator)} was fitted ${age === 0 ? "this week" : `${age} week${age === 1 ? "" : "s"} ago`}, after the previous one failed. `;
  const prev = recordAt(r.id, r.order - COMPARE_WEEKS);
  if (!prev || prev.actIndex !== r.actIndex) return install || "This is the first record for this aircraft.";
  const move = (name, from, to) => (from == null || to == null || from === to ? null
    : `${name} ${to > from ? "rose" : "fell"} from ${LEVEL_NAMES[from]} to ${LEVEL_NAMES[to]}`);
  const moves = [move("operation time", prev.op, r.op), move("leakage", prev.leak, r.leak)].filter(Boolean);
  const what = moves.length ? `${moves.join(", and ")}.` : "no change in the reading levels.";
  const risk = fmtRisk(prev.risk) === fmtRisk(r.risk)
    ? `Risk stayed at ${fmtRisk(r.risk)}.` : `Risk went from ${fmtRisk(prev.risk)} to ${fmtRisk(r.risk)}.`;
  return `${install}Compared with ${COMPARE_WEEKS} weeks ago (${esc(prev.month)}): ${what} ${risk}`;
}

// The reason a group of aircraft shares: how many of them show each warning sign.
function sharedReason(rows) {
  const n = rows.length;
  const count = (key, from) => rows.filter((r) => (r[key] ?? 0) >= from).length;
  const part = (k, sign) => (k === 0 ? null : n === 1 ? sign : k === n ? `all ${n} show ${sign}` : `${k} of ${n} show ${sign}`);
  let parts = [part(count("op", 2), "slow operation"), part(count("leak", 2), "high leakage")].filter(Boolean);
  if (!parts.length) parts = [part(count("op", 1), "operation starting to slow"), part(count("leak", 1), "leakage starting to rise")].filter(Boolean);
  if (!parts.length) return "the readings taken together are close to the alert line";
  return n === 1 ? `it shows ${parts.join(" and ")}` : parts.join(" and ");
}

// ---------------------------------------------------------------- data
// The data file holds one compact row per aircraft per week. Turn it into records the page can read.
function expand(d) {
  const at = Object.fromEntries(d.fields.map((name, i) => [name, i]));
  const level = (risk) => (risk >= d.thresholds.high ? "High" : risk >= d.thresholds.medium ? "Medium" : "Low");
  const records = [];
  for (const aircraft of d.fleet) {
    aircraft.rows.forEach((v, order) => {
      const notes = [];
      if (v[at.t] == null) notes.push("No actuation time reading this week. The risk uses the other readings.");
      if (v[at.l] == null) notes.push("No leakage reading this week. The risk uses the other readings.");
      if (v[at.pv] == null) notes.push("No pressure variation reading this week.");
      const factors = [["operation time", v[at.f_op]], ["leakage", v[at.f_leak]], ["pressure variation", v[at.f_pv]]]
        .filter(([, share]) => share > 0).map(([factor, share]) => ({ factor, share: share / 100 })).sort((a, b) => b.share - a.share);
      records.push({
        row: records.length, id: aircraft.id, grade: aircraft.grade, order, month: fmtDate(d.weeks[order]),
        risk: v[at.risk], level: level(v[at.risk]), t: v[at.t], l: v[at.l], pv: v[at.pv],
        op: v[at.op] < 0 ? null : v[at.op], leak: v[at.leak] < 0 ? null : v[at.leak],
        age: v[at.age], hours: v[at.fh], cycles: v[at.fc], dss: v[at.dss],
        actIndex: v[at.act], actuator: aircraft.acts[v[at.act]],
        replaced: order > 0 && aircraft.rows[order - 1][at.act] !== v[at.act],
        actual: v[at.y] === 1, factors, notes,
      });
    });
  }
  return records;
}

// The fleet as of the chosen week, ranked by risk.
function fleetAt(week) {
  const list = (state.byWeek[week] ?? []).map((r) => ({ ...r }));
  list.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id, undefined, { numeric: true }));
  list.forEach((r, i) => { r.rank = i + 1; });
  return list;
}
const countAt = (week, level) => (state.byWeek[week] ?? []).filter((r) => r.level === level).length;

function sorted(list) {
  const { key, dir } = state.sort;
  const value = { risk: (r) => r.risk, id: (r) => r.id }[key];
  return [...list].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const diff = typeof x === "string" ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
    return diff * dir || a.rank - b.rank;
  });
}

// ---------------------------------------------------------------- top
function renderMeta() {
  const d = state.data;
  $("#meta").innerHTML = `
    <div><span class="k">Data</span>
      <span class="v">${esc(d.source)} · ${fmtInt(d.model.aircraft)} aircraft · ${fmtInt(d.model.rows)} weekly records</span></div>
    <div><span class="k">Model check on unseen aircraft</span>
      <span class="v">${d.model.caught} of ${d.model.failures} failures flagged before they happened · typical warning ${d.model.lead_weeks} weeks</span></div>`;
}

// Built once, then updated in place, so dragging the slider is not interrupted by a redraw.
function buildDateControl() {
  const last = lastWeek();
  $("#months").innerHTML = `<span class="eyebrow">Fleet as of</span>
    <div class="date-row">
      <button type="button" class="step" data-step="-1" aria-label="One week earlier">◀</button>
      <strong id="date-now"></strong>
      <button type="button" class="step" data-step="1" aria-label="One week later">▶</button>
    </div>
    <input type="range" id="week-slider" min="0" max="${last}" step="1" aria-label="Week shown">
    <span class="date-sub" id="date-sub"></span>`;
  $("#week-slider").addEventListener("input", (ev) => {
    state.week = Number(ev.target.value);
    render();
  });
}
function renderDate() {
  const last = lastWeek();
  $("#date-now").textContent = dateOf(state.week);
  $("#week-slider").value = state.week;
  $("#date-sub").textContent = state.week === last
    ? `Week ${state.week + 1} of ${last + 1} · latest records`
    : `Week ${state.week + 1} of ${last + 1} · replay of a past week`;
  document.querySelector('[data-step="-1"]').disabled = state.week === 0;
  document.querySelector('[data-step="1"]').disabled = state.week === last;
}

function renderTiles(list) {
  const t = state.data.thresholds;
  const count = (level) => list.filter((r) => r.level === level).length;
  const tile = (key, label, value, sub, glyph) => `
    <button type="button" class="tile" data-filter="${key}" aria-pressed="${state.filter === key}">
      <span class="label">${label}</span><span class="glyph">${glyph}</span>
      <span class="value">${value}</span><span class="sub">${sub}</span>
    </button>`;
  $("#tiles").innerHTML =
    tile("All", "Aircraft monitored", list.length, "Show the whole fleet", "") +
    tile("High", "High risk", count("High"), `Risk ${fmtThreshold(t.high)} or more`, icon("High")) +
    tile("Medium", "Medium risk", count("Medium"), `Risk ${fmtThreshold(t.medium)} to ${fmtThreshold(t.high)}`, icon("Medium")) +
    tile("Low", "Low risk", count("Low"), `Risk under ${fmtThreshold(t.medium)}`, icon("Low"));
}

function renderAlert(list) {
  const high = list.filter((r) => r.level === "High");
  const medium = list.filter((r) => r.level === "Medium");
  const names = (rows) => {
    const shown = rows.slice(0, 8).map((r) => esc(r.id)).join(", ");
    return rows.length > 8 ? `${shown} and ${rows.length - 8} more` : shown;
  };
  const verb = (n) => (n === 1 ? "is" : "are");
  let kind = "is-good";
  let glyph = icon("Low");
  let body = "<p><strong>No aircraft is above the Medium threshold.</strong></p>";
  if (high.length) {
    const expected = high.reduce((sum, r) => sum + r.risk / 100, 0);
    kind = "is-critical";
    glyph = icon("High");
    body = `<p><strong>${high.length} aircraft ${verb(high.length)} High risk. Without action, about ${Math.max(1, Math.round(expected))} of them will fail within 30 days.</strong> ${names(high)}</p>
      <p>Why: ${sharedReason(high)}, the pattern seen before failures in the data.</p>`;
    if (medium.length) {
      body += `<p>${medium.length} aircraft ${verb(medium.length)} Medium risk and should have an inspection planned: ${names(medium)}</p>`;
    }
  } else if (medium.length) {
    kind = "is-warning";
    glyph = icon("Medium");
    body = `<p><strong>${medium.length} aircraft ${verb(medium.length)} Medium risk.</strong> Plan an inspection: ${names(medium)}</p>
      <p>Why: ${sharedReason(medium)}. Not expected to fail this month, but moving towards failure.</p>`;
  }
  $("#alert").innerHTML = `<div class="alert ${kind}" role="status">${glyph}<div>${body}</div></div>`;
}

// ---------------------------------------------------------------- fleet outlook (management view)
// One bar per calendar month: the aircraft at High and at Medium risk in that month's last week.
function trendChart() {
  const periods = state.periods;
  const levels = ["High", "Medium"]; // High sits on the baseline so its growth is easy to read
  const counts = periods.map((p) => Object.fromEntries(levels.map((l) => [l, countAt(p.week, l)])));
  const total = Math.max(...counts.map((c) => c.High + c.Medium), 1);
  const W = 420, left = 30, right = 8, top = 10, plotH = 112;
  const bottom = top + plotH;
  const band = (W - left - right) / periods.length;
  const barW = Math.min(24, band - 4);
  const step = total <= 5 ? 1 : total <= 12 ? 2 : Math.ceil(total / 5 / 5) * 5;
  const axisMax = Math.ceil(total / step) * step;
  const yOf = (n) => top + plotH * (1 - n / axisMax);
  const ticks = [];
  for (let n = 0; n <= axisMax; n += step) ticks.push(n);
  const fill = { High: "var(--critical)", Medium: "var(--warning)" };
  const labelEvery = Math.ceil(periods.length / 8);
  const currentMonth = state.data.weeks[state.week].slice(0, 7);

  const grid = ticks.map((n) => `
    <line class="${n === 0 ? "baseline" : "gridline"}" x1="${left}" x2="${W - right}" y1="${yOf(n)}" y2="${yOf(n)}"/>
    <text x="${left - 7}" y="${yOf(n) + 4}" text-anchor="end">${n}</text>`).join("");
  const columns = periods.map((p, i) => {
    const c = counts[i];
    const x = left + band * (i + 0.5) - barW / 2;
    const current = p.key === currentMonth;
    let below = 0;
    const present = levels.filter((l) => c[l] > 0);
    const segments = present.map((level, k) => {
      const y1 = yOf(below);
      below += c[level];
      const y0 = yOf(below);
      const isTop = k === present.length - 1;
      const gap = isTop ? 0 : 2; // surface gap between stacked segments
      const h = Math.max(y1 - y0 - gap, 1);
      const yTop = y0 + gap;
      const r = Math.min(3, barW / 2);
      return isTop && h > r
        ? `<path d="M${x},${yTop + h}V${yTop + r}a${r},${r} 0 0 1 ${r},-${r}h${barW - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${yTop + h}z" style="fill:${fill[level]}"/>`
        : `<rect x="${x}" y="${yTop}" width="${barW}" height="${h}" style="fill:${fill[level]}"/>`;
    }).join("");
    const tip = `${p.label} (week of ${dateOf(p.week)})|High risk: ${c.High}|Medium risk: ${c.Medium}`;
    return `${segments}
      ${i % labelEvery ? "" : `<text class="month-label ${current ? "is-current" : ""}" x="${left + band * (i + 0.5)}" y="${bottom + 16}" text-anchor="middle">${esc(p.label)}</text>`}
      <rect class="hit" x="${left + band * i}" y="${top - 6}" width="${band}" height="${plotH + 28}" data-week="${p.week}" data-tip="${esc(tip)}"/>`;
  }).join("");
  // The chosen month's highlight goes underneath everything, so it never covers a neighbouring label.
  const at = periods.findIndex((p) => p.key === currentMonth);
  const highlight = at < 0 ? "" : `<rect class="current-band" x="${left + band * at + 1}" y="${top - 6}" width="${band - 2}" height="${plotH + 12}" rx="5"/>`;
  return `<svg viewBox="0 0 ${W} ${bottom + 24}" role="img" aria-label="Aircraft at High and Medium risk by month">${highlight}${grid}${columns}</svg>`;
}

function renderOutlook(list) {
  const expected = list.reduce((sum, r) => sum + r.risk / 100, 0);
  const high = list.filter((r) => r.level === "High").length;
  const share = list.length ? Math.round((high / list.length) * 100) : 0;
  const stat = (label, value, sub) => `
    <div class="stat"><span class="label">${label}</span><span class="value">${value}</span><span class="sub">${sub}</span></div>`;
  let change = "";
  const earlier = state.week - COMPARE_WEEKS;
  if (earlier >= 0) {
    const before = countAt(earlier, "High");
    const diff = high - before;
    const mark = diff > 0 ? '<span class="delta up">▲</span>' : diff < 0 ? '<span class="delta down">▼</span>' : "";
    change = stat(`High-risk aircraft, change in ${COMPARE_WEEKS} weeks`,
      diff === 0 ? "No change" : `${mark}${diff > 0 ? "+" : "−"}${Math.abs(diff)}`,
      `${before} on ${esc(dateOf(earlier))}, ${high} on ${esc(dateOf(state.week))}`);
  }
  $("#outlook").innerHTML = `
    <div class="card-head"><h2>Fleet outlook</h2><span class="hint">What to expect in the next 30 days if nothing is done.</span></div>
    <div class="outlook-body">
      ${stat("Expected failures in the next 30 days", expected.toFixed(1), `of ${list.length} aircraft, if no action is taken`)}
      ${stat("Fleet at High risk", `${share}%`, `${high} of ${list.length} aircraft`)}
      ${change}
      <div class="trend">
        <div class="trend-head"><span class="label">Aircraft at High and Medium risk, by month</span>
          <span class="legend">${["High", "Medium"].map((l) => `<span>${icon(l)}${l}</span>`).join("")}</span></div>
        <div class="chart">${trendChart()}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- fleet table
function renderFleet(list, visible) {
  const showOutcome = outcomeKnown(state.week);
  const head = (key, label) => {
    const active = state.sort.key === key;
    const up = active && state.sort.dir > 0;
    return `<th ${active ? `aria-sort="${up ? "ascending" : "descending"}"` : ""}>
      <button type="button" data-sort="${key}">${label}<span class="arrow">${up ? "▲" : "▼"}</span></button></th>`;
  };
  const row = (r) => {
    const flag = r.notes.length
      ? `<span class="note-flag" data-tip="Data notes|${esc(r.notes.join("|"))}">${icon("Medium")}</span>` : "";
    const outcome = r.actual ? '<span class="outcome failed">Failed</span>' : '<span class="outcome">No failure</span>';
    const reading = (level, name, text) => `<span class="cond">${swatch(level)}${name} ${level == null ? "not recorded" : `${LEVEL_NAMES[level]} · ${text}`}</span>`;
    const when = r.level === "Low" ? "" : `<span class="ac-sub action">Typically fails in ${timeLeft(r.risk)}</span>`;
    return `<tr tabindex="0" data-select="${esc(r.id)}" aria-selected="${r.id === state.selected}">
      <td class="rank">${r.rank}</td>
      <td><span class="ac-id">${esc(r.id)}</span>${flag}<span class="ac-sub">Actuator ${esc(r.actuator)} · ${fmtInt(r.age)} h</span></td>
      <td class="why"><span class="why-text">${esc(reasonShort(r))}</span>
        <span class="why-readings">${reading(r.op, "Operation", r.t == null ? "" : slowerText(r.t).replace(" than a new actuator", ""))}
          ${reading(r.leak, "Leakage", r.l == null ? "" : leakText(r.l).replace("the level seen at failure", "failure level"))}</span></td>
      <td><div class="risk-cell" data-tip="${esc(r.id)}|Risk ${fmtRisk(r.risk)}|${r.level} risk">
        <span class="risk-num">${fmtRisk(r.risk)}</span>
        <div class="meter ${cls(r.level)}"><div class="meter-fill" style="width:${r.risk}%"></div></div></div></td>
      <td class="decision">${badge(r.level)}<span class="ac-sub action">${ACTION[r.level]}</span>${when}</td>
      ${showOutcome ? `<td>${outcome}</td>` : ""}
    </tr>`;
  };
  const hint = state.filter === "All"
    ? "Ranked by risk. Select an aircraft for details."
    : `Showing ${visible.length} of ${list.length} aircraft: ${state.filter} risk.`;
  $("#fleet").innerHTML = `
    <div class="card-head"><h2>Fleet priorities</h2><span class="hint">${hint}</span></div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>#</th>${head("id", "Aircraft")}<th>Why</th>
        ${head("risk", "Risk, next 30 days")}<th>Level and decision</th>${showOutcome ? "<th>Next 30 days, as recorded</th>" : ""}
      </tr></thead>
      <tbody>${sorted(visible).map(row).join("")}</tbody>
    </table></div>
    ${visible.length ? "" : `<p class="empty">No aircraft at ${esc(state.filter)} risk in this week.</p>`}`;
}

// ---------------------------------------------------------------- aircraft detail
// The aircraft's whole history, week by week. Weeks after the chosen date are faded.
function historyChart(current) {
  const d = state.data;
  const t = d.thresholds;
  const history = state.records.filter((r) => r.id === current.id);
  const n = d.weeks.length;
  const W = 480, left = 92, right = 16, top = 14, plotH = 132;
  const band = (W - left - right) / n;
  const xOf = (order) => left + band * (order + 0.5);
  const yOf = (v) => top + plotH * (1 - v / 100);
  const bottom = top + plotH;
  const rowY = [bottom + 30, bottom + 50];

  const grid = [0, 25, 50, 75, 100].map((v) => `
    <line class="${v === 0 ? "baseline" : "gridline"}" x1="${left}" x2="${W - right}" y1="${yOf(v)}" y2="${yOf(v)}"/>
    <text x="${left - 8}" y="${yOf(v) + 4}" text-anchor="end">${v}${v === 100 ? "%" : ""}</text>`).join("");
  const thresholds = [["High", t.high], ["Medium", t.medium]].map(([name, v]) => `
    <line class="threshold" x1="${left}" x2="${W - right}" y1="${yOf(v)}" y2="${yOf(v)}"/>
    <text class="threshold-label" x="${left + 4}" y="${yOf(v) - 4}">${name} from ${fmtThreshold(v)}</text>`).join("");
  // A date label every six months, on the first week of that month.
  const monthText = d.weeks.map((iso, i) => {
    const month = Number(iso.slice(5, 7));
    const first = i === 0 || d.weeks[i - 1].slice(0, 7) !== iso.slice(0, 7);
    return first && (month === 1 || month === 7) ? `<text class="month-label" x="${xOf(i)}" y="${bottom + 17}" text-anchor="middle">${esc(fmtMonth(iso))}</text>` : "";
  }).join("");

  const path = (rows) => (rows.length > 1 ? `M${rows.map((r) => `${xOf(r.order).toFixed(1)},${yOf(r.risk).toFixed(1)}`).join("L")}` : "");
  const past = history.filter((r) => r.order <= current.order);
  const future = history.filter((r) => r.order >= current.order);
  const replaced = history.filter((r) => r.replaced).map((r) => `
    <line class="replaced ${r.order > current.order ? "is-future" : ""}" x1="${xOf(r.order) - band / 2}" x2="${xOf(r.order) - band / 2}" y1="${top}" y2="${bottom}"/>`).join("");
  const cx = xOf(current.order);
  const cy = yOf(current.risk);
  // The value sits beside the marker, on whichever side has room, so it does not cover the line leading up to it.
  const onRight = cx < left + 60;
  const marker = `<circle class="dot ${cls(current.level)}" cx="${cx}" cy="${cy}" r="5"/><circle class="current" cx="${cx}" cy="${cy}" r="8.5"/>
    <text class="value-label" x="${onRight ? cx + 14 : cx - 14}" y="${cy < top + 8 ? cy + 4 : cy - 6}" text-anchor="${onRight ? "start" : "end"}">${fmtRisk(current.risk)}</text>`;
  const hits = history.map((r) => {
    const tip = [`${r.id} · ${r.month}`, `Risk ${fmtRisk(r.risk)} · ${r.level}`,
      `Operation time ${r.op == null ? "not recorded" : LEVEL_NAMES[r.op]}`, `Leakage ${r.leak == null ? "not recorded" : LEVEL_NAMES[r.leak]}`];
    if (r.replaced) tip.push(`New actuator ${r.actuator} fitted this week`);
    if (r.actual && outcomeKnown(r.order)) tip.push("Recorded outcome: failed within 30 days");
    return `<rect class="hit" x="${xOf(r.order) - band / 2}" y="${top}" width="${band}" height="${rowY[1] + 14 - top}" data-week="${r.order}" data-tip="${esc(tip.join("|"))}"/>`;
  }).join("");
  const strip = (key, y, name) => `
    <text class="row-label" x="${left - 8}" y="${y + 11}" text-anchor="end">${name}</text>
    ${history.map((r) => `<rect x="${(xOf(r.order) - band / 2).toFixed(1)}" y="${y}" width="${(band + 0.4).toFixed(1)}" height="14"
      style="fill:${r[key] == null ? "var(--grid)" : `var(--step-${r[key]})`}" opacity="${r.order > current.order ? 0.3 : 1}"/>`).join("")}`;

  return `<svg viewBox="0 0 ${W} ${rowY[1] + 24}" role="img" aria-label="Risk by week for ${esc(current.id)}">
    ${grid}${thresholds}${monthText}${replaced}
    <path class="line is-future" d="${path(future)}"/><path class="line" d="${path(past)}"/>${marker}
    ${strip("op", rowY[0], "Operation time")}${strip("leak", rowY[1], "Leakage")}${hits}
  </svg>`;
}

function renderDetail(list) {
  const r = list.find((x) => x.id === state.selected);
  if (!r) {
    $("#detail").innerHTML = '<p class="empty">Select an aircraft to see its details.</p>';
    return;
  }
  const t = state.data.thresholds;
  const b = bandOf(r.risk);
  const both = r.op == null || r.leak == null ? null : pastOutcomes((x) => x.leak === r.leak && x.op === r.op);
  const elevated = (r.op ?? 0) > 0 || (r.leak ?? 0) > 0;
  const watch = r.level !== "Low" ? ""
    : oneSignOnly(r) ? " One reading is high on its own. Failures in the data usually showed slow operation and rising leakage together, so keep watching this aircraft."
      : elevated ? " The readings have started to rise, so keep watching this aircraft." : " Keep monitoring.";
  const item = (name, level, meaning, numbers, stat, what) => (level == null
    ? `<li><b>${name} not recorded this week.</b> The risk uses the other readings.</li>`
    : `<li><b>${name} ${LEVEL_NAMES[level]}.</b> ${meaning} ${cap(numbers)}.
        <span class="evidence">${evidence(stat, what)}</span></li>`);
  const why = `
    <p class="why-head"><b>${esc(reasonShort(r))}.</b> ${DECISION_WHY[r.level]}${watch}
      <span class="evidence">${both ? evidence(both, "this same operation time and leakage") : ""}</span></p>
    <ul class="why-list">
      ${item("Operation time", r.op, OP_MEANING[r.op ?? 0], r.t == null ? "" : slowerText(r.t), pastOutcomes((x) => x.op === r.op), `operation time ${LEVEL_NAMES[r.op ?? 0]}`)}
      ${item("Leakage", r.leak, LEAK_MEANING[r.leak ?? 0], r.l == null ? "" : `leakage is ${leakText(r.l)}`, pastOutcomes((x) => x.leak === r.leak), `leakage ${LEVEL_NAMES[r.leak ?? 0]}`)}
    </ul>
    <p class="change">${changeSince(r)}</p>`;
  const factors = r.factors.length
    ? `<h4 class="sub-head">How much each reading adds to the risk</h4><div class="factors">${r.factors.map((f) => `
        <div class="factor" data-tip="${esc(f.factor)}|${Math.round(f.share * 100)}% of the added risk">
          <span class="name">${esc(f.factor)}</span>
          <span class="barwrap"><span class="bar" style="display:block;width:${f.share * 100}%"></span></span>
          <span class="share">${Math.round(f.share * 100)}%</span>
        </div>`).join("")}</div>
       <p class="quiet" style="margin-top:10px">Share of the risk added on top of a new actuator.</p>`
    : '<p class="quiet">No reading is adding a noticeable amount of risk.</p>';
  const reading = (label, value) => (value == null ? "" : `<div><dt>${label}</dt><dd>${value}</dd></div>`);
  const outcome = !outcomeKnown(r.order) ? "" : `
    <div class="section"><h3>What happened next</h3>
      <p>${r.actual ? "The data records a failure within 30 days of this record." : "No failure was recorded within 30 days of this record."}</p></div>`;
  const notes = r.notes.length ? `
    <div class="section"><h3>Data notes</h3><ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "";

  $("#detail").innerHTML = `
    <div class="detail-head"><div><h2>${esc(r.id)}</h2><p>Record: ${esc(r.month)} · actuator ${esc(r.actuator)}</p></div>${badge(r.level)}</div>
    <div class="section">
      <h3>Risk of failure in the next 30 days</h3>
      <div class="hero"><span class="figure">${fmtRisk(r.risk)}</span>
        <span class="range">Typical time to failure at this risk: <b>${timeLeft(r.risk)}</b></span></div>
      <div class="scale" data-tip="${esc(r.id)}|Risk ${fmtRisk(r.risk)}|${r.level} risk">
        <div class="track meter ${cls(r.level)}"><div class="fill meter-fill" style="width:${r.risk}%"></div></div>
        <span class="tick" style="left:${t.medium}%"></span><span class="tick" style="left:${t.high}%"></span>
        <div class="ticks"><span style="left:${t.medium}%">Medium from ${fmtThreshold(t.medium)}</span>
          <span style="left:${t.high}%">High from ${fmtThreshold(t.high)}</span></div>
      </div>
      <p class="evidence">Of ${fmtInt(b.n)} past records at this risk (${fmtThreshold(b.from)} to ${fmtThreshold(b.to)}), ${b.in_30_days}% failed within 30 days and ${b.in_12_weeks}% within 12 weeks.</p>
    </div>
    <div class="section"><h3>Why this risk</h3>${why}${factors}</div>
    <div class="section"><h3>Readings on ${esc(r.month)}</h3>
      <dl class="readings">
        ${reading("Operation time", condition(r.op))}
        ${reading("Leakage", condition(r.leak))}
        ${reading("Pressure variation", r.pv == null ? "No reading" : `${fmtInt(r.pv)} PSI`)}
        ${reading("Actuator age", `${fmtInt(r.age)} flight hours`)}
        ${reading("Flight hours, last 7 days", fmtInt(r.hours))}
        ${reading("Flight cycles, last 7 days", fmtInt(r.cycles))}
        ${reading("Days since last service", fmtInt(r.dss))}
        ${reading("Hydraulic fluid grade", esc(r.grade))}
      </dl>
    </div>
    <div class="section"><h3>Risk by week</h3>
      <div class="chart">${historyChart(r)}</div>
      <div class="key">${LEVEL_NAMES.map((name, i) => `<span><i class="swatch step-${i}"></i>${name}</span>`).join("")}
        <span><i class="key-line"></i>New actuator fitted</span></div>
    </div>
    ${outcome}${notes}`;
}

// ---------------------------------------------------------------- wiring
function render() {
  const active = document.activeElement;
  let refocus = null;
  if (active && active.dataset) {
    for (const key of ["filter", "sort"]) {
      if (active.dataset[key] !== undefined && active.tagName === "BUTTON") refocus = `button[data-${key}="${CSS.escape(active.dataset[key])}"]`;
    }
    if (active.matches("tr[data-select]")) refocus = 'tr[aria-selected="true"]';
  }
  const list = fleetAt(state.week);
  const visible = state.filter === "All" ? list : list.filter((r) => r.level === state.filter);
  if (!visible.some((r) => r.id === state.selected)) state.selected = (visible[0] ?? list[0])?.id ?? null;
  renderDate();
  renderTiles(list);
  renderAlert(list);
  renderOutlook(list);
  renderFleet(list, visible);
  renderDetail(list);
  if (refocus) document.querySelector(refocus)?.focus();
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-week],[data-step],[data-filter],[data-sort],[data-select]");
  if (!el) return;
  if (el.dataset.week !== undefined) {
    state.week = Number(el.dataset.week);
  } else if (el.dataset.step !== undefined) {
    state.week = Math.min(Math.max(state.week + Number(el.dataset.step), 0), lastWeek());
  } else if (el.dataset.filter !== undefined) {
    state.filter = state.filter === el.dataset.filter ? "All" : el.dataset.filter;
  } else if (el.dataset.sort !== undefined) {
    const key = el.dataset.sort;
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === "id" ? 1 : -1 };
  } else {
    state.selected = el.dataset.select;
  }
  render();
});

document.addEventListener("keydown", (ev) => {
  const row = ev.target.closest && ev.target.closest("tr[data-select]");
  if (!row) return;
  let target = null;
  if (ev.key === "Enter" || ev.key === " ") target = row;
  if (ev.key === "ArrowDown") target = row.nextElementSibling;
  if (ev.key === "ArrowUp") target = row.previousElementSibling;
  if (!target) return;
  ev.preventDefault();
  state.selected = target.dataset.select;
  render();
});

const tooltip = $("#tooltip");
let tipOwner = null;
function fillTip(el) {
  tooltip.replaceChildren(...el.dataset.tip.split("|").map((text, i) => {
    const node = document.createElement(i === 0 ? "b" : "div");
    node.textContent = text;
    return node;
  }));
  tooltip.hidden = false;
}
function placeTip(x, y) {
  const pad = 14;
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  tooltip.style.left = `${x + pad + w > innerWidth - 8 ? x - w - pad : x + pad}px`;
  tooltip.style.top = `${y + pad + h > innerHeight - 8 ? y - h - pad : y + pad}px`;
}
function hideTip() {
  tipOwner = null;
  tooltip.hidden = true;
}
document.addEventListener("mousemove", (ev) => {
  const el = ev.target.closest && ev.target.closest("[data-tip]");
  if (!el) {
    if (tipOwner) hideTip();
    return;
  }
  if (el !== tipOwner || tooltip.hidden) {
    tipOwner = el;
    fillTip(el);
  }
  placeTip(ev.clientX, ev.clientY);
});
document.addEventListener("focusin", (ev) => {
  const el = ev.target.closest && ev.target.closest("[data-tip]");
  if (!el) return;
  tipOwner = el;
  fillTip(el);
  const box = el.getBoundingClientRect();
  placeTip(box.right, box.top);
});
document.addEventListener("focusout", hideTip);
document.addEventListener("scroll", hideTip, true);

async function init() {
  try {
    // The local server answers /api/state. The hosted copy has no server, so it reads the exported file.
    let res = await fetch("/api/state").catch(() => null);
    if (!res || !res.ok) res = await fetch("state.json");
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $("#fleet").innerHTML = `<p class="empty">Could not load the data (${esc(err.message)}).
      Start the dashboard with dashboard/server.py, then reload this page.</p>`;
    return;
  }
  const d = state.data;
  state.records = expand(d);
  state.byWeek = d.weeks.map(() => []);
  for (const r of state.records) state.byWeek[r.order].push(r);
  const lastOfMonth = new Map();   // calendar month -> its last week
  d.weeks.forEach((iso, week) => lastOfMonth.set(iso.slice(0, 7), week));
  state.periods = [...lastOfMonth].map(([key, week]) => ({ key, week, label: fmtMonth(d.weeks[week]) }));
  state.week = lastWeek();
  buildDateControl();
  renderMeta();
  render();
}
init();
