"use strict";

const LEVEL_NAMES = ["Normal", "Slightly High", "High", "Very High"];
const LEVEL_SHORT = ["N", "SH", "H", "VH"];
// Written for the people who decide, not the people who repair.
const ACTION = { High: "Schedule repair now", Medium: "Plan an inspection", Low: "No action needed" };

const state = { data: null, month: null, selected: null, filter: "All", sort: { key: "risk", dir: -1 } };

const $ = (sel) => document.querySelector(sel);
// Every value that comes from the data file goes through esc() before it reaches innerHTML.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cls = (level) => `is-${level.toLowerCase()}`;
const fmtRisk = (v) => (v < 1 ? "<1%" : `${Math.round(v)}%`);
const fmtRange = (r) => (r.high < 1 ? "below 1%" : `${fmtRisk(r.low)} to ${fmtRisk(r.high)}`);
const fmtThreshold = (v) => `${+v.toFixed(1)}%`;
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const monthLabel = (order) => state.data.months.find((m) => m.order === order)?.label ?? "";

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
const condition = (level) => `<span class="cond"><span class="swatch step-${level}"></span>${LEVEL_NAMES[level]}</span>`;

// ---------------------------------------------------------------- reasons in plain words
const OP_PHRASE = [null, "operation starting to slow", "slow operation"];
const LEAK_PHRASE = [null, "leakage starting to rise", "high leakage", "very high leakage"];
const OP_MEANING = [
  "The actuator moves the landing gear in normal time.",
  "The actuator has started to take longer than normal to move the landing gear.",
  "The actuator is taking much longer than normal to move the landing gear. In the data, this is the strongest warning sign of a failure.",
];
const LEAK_MEANING = [
  "Hydraulic leakage is normal.",
  "Hydraulic leakage has started to rise above normal.",
  "Hydraulic fluid is leaking well above normal.",
  "Hydraulic leakage is at the worst level recorded.",
];
const DECISION_WHY = {
  High: "More likely than not to fail within 30 days. Schedule the repair now to avoid an unplanned grounding.",
  Medium: "Not expected to fail this month, but the readings are moving towards failure. Plan an inspection before they get worse.",
  Low: "No warning sign is strong enough to act on yet.",
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The short reason shown in the table. Operation time comes first because it carries most of the risk.
function reasonShort(r) {
  const parts = [OP_PHRASE[r.op], LEAK_PHRASE[r.leak]].filter(Boolean);
  return parts.length ? cap(parts.join(" and ")) : "All readings normal";
}

// How often records like this one were followed by a failure, when the data has the answers.
function pastOutcomes(match) {
  const known = state.data.records.filter((x) => x.actual != null && match(x));
  return { n: known.length, failed: known.filter((x) => x.actual).length };
}
function evidence(stat, what) {
  if (!state.data.has_answers) return "";
  if (!stat.n) return `No record in the data had ${what}, so this part is the model's estimate.`;
  if (stat.n === 1) return `In the data, the only record with ${what} ${stat.failed ? "was" : "was not"} followed by a failure within 30 days.`;
  return `In the data, ${stat.failed} of ${stat.n} records with ${what} were followed by a failure within 30 days.`;
}

function changeSince(r) {
  const prev = state.data.records
    .filter((x) => x.id === r.id && x.order < r.order)
    .sort((a, b) => b.order - a.order)[0];
  if (!prev) return "This is the first record for this aircraft.";
  const move = (name, from, to) => (from === to ? null
    : `${name} ${to > from ? "rose" : "fell"} from ${LEVEL_NAMES[from]} to ${LEVEL_NAMES[to]}`);
  const moves = [move("leakage", prev.leak, r.leak), move("operation time", prev.op, r.op)].filter(Boolean);
  const when = prev.month ? `Since ${esc(prev.month)}` : "Since the previous record";
  const what = moves.length ? `${moves.join(", and ")}.` : "no change in the readings.";
  const risk = fmtRisk(prev.risk) === fmtRisk(r.risk)
    ? `Risk stayed at ${fmtRisk(r.risk)}.` : `Risk went from ${fmtRisk(prev.risk)} to ${fmtRisk(r.risk)}.`;
  return `${when}: ${what} ${risk}`;
}

// The reason a group of aircraft shares: their mildest readings, with "or worse" when some go further.
function sharedReason(rows) {
  const floor = { op: Math.min(...rows.map((r) => r.op)), leak: Math.min(...rows.map((r) => r.leak)) };
  const worse = rows.some((r) => r.op > floor.op || r.leak > floor.leak) ? " or worse" : "";
  const who = rows.length === 1 ? "it shows" : `all ${rows.length} show`;
  return `${who} ${esc(reasonShort(floor).toLowerCase())}${worse}`;
}

// ---------------------------------------------------------------- data
// The fleet as of the chosen month: each aircraft's latest record up to that month, ranked by risk.
function fleetAt(asOf) {
  const latest = new Map();
  for (const r of state.data.records) {
    if (asOf != null && r.order > asOf) continue;
    const seen = latest.get(r.id);
    if (!seen || r.order > seen.order || (r.order === seen.order && r.row > seen.row)) latest.set(r.id, r);
  }
  const list = [...latest.values()].map((r) => ({ ...r, stale: asOf != null && r.order < asOf }));
  list.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id, undefined, { numeric: true }));
  list.forEach((r, i) => { r.rank = i + 1; });
  return list;
}

function sorted(list) {
  const { key, dir } = state.sort;
  const value = { risk: (r) => r.risk, id: (r) => r.id, leak: (r) => r.leak, op: (r) => r.op }[key];
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
  const aircraft = new Set(d.records.map((r) => r.id)).size;
  $("#meta").innerHTML = `
    <div><span class="k">Data</span>
      <span class="v">${esc(d.source)} · ${d.records.length} records · ${aircraft} aircraft</span></div>
    <div><span class="k">Model check on unseen aircraft</span>
      <span class="v">${d.model.caught} of ${d.model.failures} failures caught · ${d.model.false_alarms} false alarm${d.model.false_alarms === 1 ? "" : "s"}</span></div>`;
}

function renderMonths() {
  const months = state.data.months;
  if (months.length < 2) {
    $("#months").innerHTML = "";
    return;
  }
  $("#months").innerHTML = `<span class="eyebrow">Fleet as of</span>
    <div class="segmented" role="group" aria-label="Month">${months.map((m) => `
      <button type="button" data-month="${m.order}" aria-pressed="${m.order === state.month}">${esc(m.label)}</button>`).join("")}
    </div>`;
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
function trendChart() {
  const months = state.data.months;
  const levels = ["High", "Medium", "Low"]; // High sits on the baseline so its growth is easy to read
  const counts = months.map((m) => {
    const list = fleetAt(m.order);
    return Object.fromEntries(levels.map((l) => [l, list.filter((r) => r.level === l).length]));
  });
  const total = Math.max(...counts.map((c) => c.High + c.Medium + c.Low), 1);
  const W = 420, left = 30, right = 8, top = 10, plotH = 112;
  const bottom = top + plotH;
  const band = (W - left - right) / months.length;
  const barW = Math.min(24, band - 8);
  const yOf = (n) => top + plotH * (1 - n / total);
  const step = total <= 5 ? 1 : total <= 12 ? 2 : Math.ceil(total / 5 / 5) * 5;
  const ticks = [];
  for (let n = 0; n <= total; n += step) ticks.push(n);
  const fill = { High: "var(--critical)", Medium: "var(--warning)", Low: "var(--good)" };
  const labelEvery = Math.ceil(months.length / 12);

  const grid = ticks.map((n) => `
    <line class="${n === 0 ? "baseline" : "gridline"}" x1="${left}" x2="${W - right}" y1="${yOf(n)}" y2="${yOf(n)}"/>
    <text x="${left - 7}" y="${yOf(n) + 4}" text-anchor="end">${n}</text>`).join("");
  const columns = months.map((m, i) => {
    const c = counts[i];
    const x = left + band * (i + 0.5) - barW / 2;
    const current = m.order === state.month;
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
      const shape = isTop && h > 4
        ? `<path d="M${x},${yTop + h}V${yTop + 4}a4,4 0 0 1 4,-4h${barW - 8}a4,4 0 0 1 4,4V${yTop + h}z" style="fill:${fill[level]}"/>`
        : `<rect x="${x}" y="${yTop}" width="${barW}" height="${h}" style="fill:${fill[level]}"/>`;
      const label = level === "High" && h >= 16
        ? `<text class="seg-label" x="${x + barW / 2}" y="${yTop + h / 2 + 4}" text-anchor="middle">${c.High}</text>` : "";
      return shape + label;
    }).join("");
    const tip = `${m.label}|High risk: ${c.High}|Medium risk: ${c.Medium}|Low risk: ${c.Low}`;
    return `${current ? `<rect class="current-band" x="${left + band * i + 2}" y="${top - 6}" width="${band - 4}" height="${plotH + 28}" rx="6"/>` : ""}
      ${segments}
      ${i % labelEvery ? "" : `<text class="month-label ${current ? "is-current" : ""}" x="${left + band * (i + 0.5)}" y="${bottom + 16}" text-anchor="middle">${esc(m.label)}</text>`}
      <rect class="hit" x="${left + band * i}" y="${top - 6}" width="${band}" height="${plotH + 28}" tabindex="0" data-month="${m.order}" data-tip="${esc(tip)}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${bottom + 24}" role="img" aria-label="Aircraft at each risk level by month">${grid}${columns}</svg>`;
}

function renderOutlook(list) {
  const months = state.data.months;
  const expected = list.reduce((sum, r) => sum + r.risk / 100, 0);
  const high = list.filter((r) => r.level === "High").length;
  const share = list.length ? Math.round((high / list.length) * 100) : 0;
  const stat = (label, value, sub) => `
    <div class="stat"><span class="label">${label}</span><span class="value">${value}</span><span class="sub">${sub}</span></div>`;
  let change = "";
  const index = months.findIndex((m) => m.order === state.month);
  if (index > 0) {
    const before = fleetAt(months[index - 1].order).filter((r) => r.level === "High").length;
    const diff = high - before;
    const mark = diff > 0 ? '<span class="delta up">▲</span>' : diff < 0 ? '<span class="delta down">▼</span>' : "";
    change = stat(`High-risk aircraft since ${esc(months[index - 1].label)}`,
      diff === 0 ? "No change" : `${mark}${diff > 0 ? "+" : "−"}${Math.abs(diff)}`,
      `${before} in ${esc(months[index - 1].label)}, ${high} in ${esc(months[index].label)}`);
  }
  const trend = months.length > 1 ? `
    <div class="trend">
      <div class="trend-head"><span class="label">Aircraft at each risk level, by month</span>
        <span class="legend">${["High", "Medium", "Low"].map((l) => `<span>${icon(l)}${l}</span>`).join("")}</span></div>
      <div class="chart">${trendChart()}</div>
    </div>` : "";
  $("#outlook").innerHTML = `
    <div class="card-head"><h2>Fleet outlook</h2><span class="hint">What to expect in the next 30 days if nothing is done.</span></div>
    <div class="outlook-body ${trend ? "" : "no-trend"}">
      ${stat("Expected failures in the next 30 days", expected.toFixed(1), `of ${list.length} aircraft, if no action is taken`)}
      ${stat("Fleet at High risk", `${share}%`, `${high} of ${list.length} aircraft`)}
      ${change}
      ${trend}
    </div>`;
}

// ---------------------------------------------------------------- fleet table
function renderFleet(list, visible) {
  const hasAnswers = state.data.has_answers;
  const head = (key, label) => {
    const active = state.sort.key === key;
    const up = active && state.sort.dir > 0;
    return `<th ${active ? `aria-sort="${up ? "ascending" : "descending"}"` : ""}>
      <button type="button" data-sort="${key}">${label}<span class="arrow">${up ? "▲" : "▼"}</span></button></th>`;
  };
  const row = (r) => {
    const record = r.month == null ? "" : r.stale ? `Last record: ${esc(r.month)}` : `Record: ${esc(r.month)}`;
    const flag = r.notes.length
      ? `<span class="note-flag" data-tip="Data notes|${esc(r.notes.join("|"))}">${icon("Medium")}</span>` : "";
    const outcome = r.actual == null ? ""
      : r.actual ? '<span class="outcome failed">Failed</span>' : '<span class="outcome">No failure</span>';
    return `<tr tabindex="0" data-select="${esc(r.id)}" aria-selected="${r.id === state.selected}">
      <td class="rank">${r.rank}</td>
      <td><span class="ac-id">${esc(r.id)}</span>${flag}<span class="ac-sub ${r.stale ? "stale" : ""}">${record}</span></td>
      <td class="why"><span class="why-text">${esc(reasonShort(r))}</span>
        <span class="why-readings"><span class="cond"><span class="swatch step-${r.leak}"></span>Leakage ${LEVEL_NAMES[r.leak]}</span>
          <span class="cond"><span class="swatch step-${r.op}"></span>Operation ${LEVEL_NAMES[r.op]}</span></span></td>
      <td><div class="risk-cell" data-tip="${esc(r.id)}|Risk ${fmtRisk(r.risk)}|Likely range ${fmtRange(r)}">
        <span class="risk-num">${fmtRisk(r.risk)}</span>
        <div class="meter ${cls(r.level)}"><div class="meter-fill" style="width:${r.risk}%"></div></div>
        <span class="risk-range">Range ${fmtRange(r)}</span></div></td>
      <td>${badge(r.level)}<span class="ac-sub action">${ACTION[r.level]}</span></td>
      ${hasAnswers ? `<td>${outcome}</td>` : ""}
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
        ${head("risk", "Risk, next 30 days")}<th>Level and decision</th>${hasAnswers ? "<th>Recorded outcome</th>" : ""}
      </tr></thead>
      <tbody>${sorted(visible).map(row).join("")}</tbody>
    </table></div>
    ${visible.length ? "" : `<p class="empty">No aircraft at ${esc(state.filter)} risk in this month.</p>`}`;
}

// ---------------------------------------------------------------- aircraft detail
function historyChart(current) {
  const d = state.data;
  const t = d.thresholds;
  const history = d.records.filter((r) => r.id === current.id).sort((a, b) => a.order - b.order || a.row - b.row);
  const months = d.months.length ? d.months : [{ order: current.order, label: "Record" }];
  const W = 480, left = 92, right = 16, top = 14, plotH = 132;
  const band = (W - left - right) / months.length;
  const xOf = (order) => left + band * (months.findIndex((m) => m.order === order) + 0.5);
  const yOf = (v) => top + plotH * (1 - v / 100);
  const bottom = top + plotH;
  const cellW = Math.min(band - 6, 64);
  const rowY = [bottom + 30, bottom + 56];
  const labelEvery = Math.ceil(months.length / 12);

  const grid = [0, 25, 50, 75, 100].map((v) => `
    <line class="${v === 0 ? "baseline" : "gridline"}" x1="${left}" x2="${W - right}" y1="${yOf(v)}" y2="${yOf(v)}"/>
    <text x="${left - 8}" y="${yOf(v) + 4}" text-anchor="end">${v}${v === 100 ? "%" : ""}</text>`).join("");
  const thresholds = [["High", t.high], ["Medium", t.medium]].map(([name, v]) => `
    <line class="threshold" x1="${left}" x2="${W - right}" y1="${yOf(v)}" y2="${yOf(v)}"/>
    <text class="threshold-label" x="${W - right}" y="${yOf(v) - 4}" text-anchor="end">${name} from ${fmtThreshold(v)}</text>`).join("");
  const monthText = months.map((m, i) => (i % labelEvery ? "" : `
    <text class="month-label ${m.order === current.order ? "is-current" : ""}" x="${xOf(m.order)}" y="${bottom + 17}" text-anchor="middle">${esc(m.label)}</text>`)).join("");

  const pts = history.map((r) => ({ r, x: xOf(r.order), y: yOf(r.risk) }));
  const spread = pts.length > 1
    ? `<polygon class="band" points="${pts.map((p) => `${p.x},${yOf(p.r.high)}`).join(" ")} ${[...pts].reverse().map((p) => `${p.x},${yOf(p.r.low)}`).join(" ")}"/>`
    : pts.map((p) => `<line class="line" x1="${p.x}" x2="${p.x}" y1="${yOf(p.r.high)}" y2="${yOf(p.r.low)}" opacity="0.3"/>`).join("");
  const line = pts.length > 1 ? `<path class="line" d="M${pts.map((p) => `${p.x},${p.y}`).join("L")}"/>` : "";
  const dots = pts.map((p) => {
    const isCurrent = p.r.row === current.row;
    const labelY = p.y < top + 18 ? p.y + 20 : p.y - 12;
    const tip = [`${p.r.id}${p.r.month ? ` · ${p.r.month}` : ""}`, `Risk ${fmtRisk(p.r.risk)} (range ${fmtRange(p.r)})`,
      `${p.r.level} risk`, `Leakage ${LEVEL_NAMES[p.r.leak]}`, `Operation time ${LEVEL_NAMES[p.r.op]}`];
    if (p.r.actual) tip.push("Recorded outcome: failed within 30 days");
    return `<circle class="dot ${cls(p.r.level)}" cx="${p.x}" cy="${p.y}" r="5"/>
      ${isCurrent ? `<circle class="current" cx="${p.x}" cy="${p.y}" r="8.5"/>
        <text class="value-label" x="${p.x}" y="${labelY}" text-anchor="middle">${fmtRisk(p.r.risk)}</text>` : ""}
      <circle class="hit" cx="${p.x}" cy="${p.y}" r="14" tabindex="0" data-month="${p.r.order}" data-tip="${esc(tip.join("|"))}"/>`;
  }).join("");

  const strip = (key, y, name) => `
    <text class="row-label" x="${left - 8}" y="${y + 14}" text-anchor="end">${name}</text>
    ${history.map((r) => `
      <rect x="${xOf(r.order) - cellW / 2}" y="${y}" width="${cellW}" height="20" rx="4" style="fill:var(--step-${r[key]})"/>
      <text class="cell-text" x="${xOf(r.order)}" y="${y + 14}" text-anchor="middle" style="fill:${r[key] === 0 ? "#0b0b0b" : "#fff"}">${LEVEL_SHORT[r[key]]}</text>`).join("")}`;

  return `<svg viewBox="0 0 ${W} ${rowY[1] + 26}" role="img" aria-label="Risk by month for ${esc(current.id)}">
    ${grid}${thresholds}${monthText}${spread}${line}${dots}
    ${strip("leak", rowY[0], "Leakage")}${strip("op", rowY[1], "Operation time")}
  </svg>`;
}

function renderDetail(list) {
  const r = list.find((x) => x.id === state.selected);
  if (!r) {
    $("#detail").innerHTML = '<p class="empty">Select an aircraft to see its details.</p>';
    return;
  }
  const t = state.data.thresholds;
  const record = r.month == null ? ""
    : r.stale ? `Last record: ${esc(r.month)}. No record for ${esc(monthLabel(state.month))}.` : `Record: ${esc(r.month)}`;
  const both = pastOutcomes((x) => x.leak === r.leak && x.op === r.op);
  const watch = r.level !== "Low" ? ""
    : r.leak > 0 || r.op > 0 ? " The readings have started to rise, so keep watching this aircraft." : " Keep monitoring.";
  const why = `
    <p class="why-head"><b>${esc(reasonShort(r))}.</b> ${DECISION_WHY[r.level]}${watch}
      <span class="evidence">${evidence(both, "this same leakage and operation time")}</span></p>
    <ul class="why-list">
      <li><b>Operation time ${LEVEL_NAMES[r.op]}.</b> ${OP_MEANING[r.op]}
        <span class="evidence">${evidence(pastOutcomes((x) => x.op === r.op), `operation time ${LEVEL_NAMES[r.op]}`)}</span></li>
      <li><b>Leakage ${LEVEL_NAMES[r.leak]}.</b> ${LEAK_MEANING[r.leak]}
        <span class="evidence">${evidence(pastOutcomes((x) => x.leak === r.leak), `leakage ${LEVEL_NAMES[r.leak]}`)}</span></li>
    </ul>
    <p class="change">${changeSince(r)}</p>`;
  const factors = r.factors.length
    ? `<h4 class="sub-head">How much each reading adds to the risk</h4><div class="factors">${r.factors.map((f) => `
        <div class="factor" data-tip="${esc(f.factor)}|${Math.round(f.share * 100)}% of the added risk">
          <span class="name">${esc(f.factor)}</span>
          <span class="barwrap"><span class="bar" style="display:block;width:${f.share * 100}%"></span></span>
          <span class="share">${Math.round(f.share * 100)}%</span>
        </div>`).join("")}</div>
       <p class="quiet" style="margin-top:10px">Share of the risk added on top of a healthy actuator.</p>`
    : '<p class="quiet">All readings are at or below normal, so nothing is adding risk.</p>';
  const reading = (label, value) => (value == null ? "" : `<div><dt>${label}</dt><dd>${value}</dd></div>`);
  const number = (v, unit = "") => (v == null ? null : `${fmtNum(v)}${unit}`);
  const outcome = r.actual == null ? "" : `
    <div class="section"><h3>Recorded outcome</h3>
      <p>${r.actual ? "The data records a failure within 30 days of this record." : "No failure was recorded within 30 days of this record."}</p></div>`;
  const notes = r.notes.length ? `
    <div class="section"><h3>Data notes</h3><ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "";

  $("#detail").innerHTML = `
    <div class="detail-head"><div><h2>${esc(r.id)}</h2><p>${record}</p></div>${badge(r.level)}</div>
    <div class="section">
      <h3>Risk of failure in the next 30 days</h3>
      <div class="hero"><span class="figure">${fmtRisk(r.risk)}</span><span class="range">Likely range ${fmtRange(r)}</span></div>
      <div class="scale" data-tip="${esc(r.id)}|Risk ${fmtRisk(r.risk)}|Likely range ${fmtRange(r)}">
        <div class="track meter ${cls(r.level)}"><div class="fill meter-fill" style="width:${r.risk}%"></div></div>
        <span class="whisker" style="left:${r.low}%;width:${Math.max(r.high - r.low, 0.5)}%"></span>
        <span class="tick" style="left:${t.medium}%"></span><span class="tick" style="left:${t.high}%"></span>
        <div class="ticks"><span style="left:${t.medium}%">Medium from ${fmtThreshold(t.medium)}</span>
          <span style="left:${t.high}%">High from ${fmtThreshold(t.high)}</span></div>
      </div>
    </div>
    <div class="section"><h3>Why this risk</h3>${why}${factors}</div>
    <div class="section"><h3>Readings${r.month ? ` in ${esc(r.month)}` : ""}</h3>
      <dl class="readings">
        ${reading("Leakage", condition(r.leak))}
        ${reading("Operation time", condition(r.op))}
        ${reading("Actuator age", number(r.age, " months"))}
        ${reading("Flight hours", number(r.hours))}
        ${reading("Flight cycles", number(r.cycles))}
        ${reading("Previous failures", number(r.previous_failures))}
        ${reading("Maintenance events", number(r.maintenance_events))}
      </dl>
    </div>
    <div class="section"><h3>Risk by month</h3>
      <div class="chart">${historyChart(r)}</div>
      <div class="key">${LEVEL_NAMES.map((name, i) => `<span><i class="swatch step-${i}"></i>${LEVEL_SHORT[i]} ${name}</span>`).join("")}</div>
    </div>
    ${outcome}${notes}`;
}

// ---------------------------------------------------------------- wiring
function render() {
  const active = document.activeElement;
  let refocus = null;
  if (active && active.dataset) {
    for (const key of ["month", "filter", "sort"]) {
      if (active.dataset[key] !== undefined && active.tagName === "BUTTON") refocus = `button[data-${key}="${CSS.escape(active.dataset[key])}"]`;
    }
    if (active.matches("tr[data-select]")) refocus = 'tr[aria-selected="true"]';
  }
  const list = fleetAt(state.month);
  const visible = state.filter === "All" ? list : list.filter((r) => r.level === state.filter);
  if (!visible.some((r) => r.id === state.selected)) state.selected = (visible[0] ?? list[0])?.id ?? null;
  renderMonths();
  renderTiles(list);
  renderAlert(list);
  renderOutlook(list);
  renderFleet(list, visible);
  renderDetail(list);
  if (refocus) document.querySelector(refocus)?.focus();
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-month],[data-filter],[data-sort],[data-select]");
  if (!el) return;
  if (el.dataset.month !== undefined) {
    state.month = Number(el.dataset.month);
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
  if (el !== tipOwner) {
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
  const months = state.data.months;
  state.month = months.length ? months[months.length - 1].order : null;
  $(".controls").classList.toggle("single", months.length < 2);
  renderMeta();
  render();
}
init();
