// Small building blocks shared by every page: escaping, formatting, icons, pills, toasts.

// Every value that comes from the server goes through esc() before it reaches innerHTML.
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const fmtInt = (v) => (v == null ? "–" : Math.round(v).toLocaleString("en-US"));
export const fmtRisk = (v) => (v == null ? "–" : v < 1 ? "<1%" : `${Math.floor(v)}%`);
export const fmtUsd = (v) => (v == null ? "–" : v === 0 ? "$0.00" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
export const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : (iso || "");
}
export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return today ? `Today ${time}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

const PATHS = {
  queue: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  decisions: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 13l2 2 4-4"/>',
  track: '<path d="M3 12h4l2.5-7 4 14 2.5-7h5"/>',
  activity: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  upload: '<path d="M12 16V5M8 9l4-4 4 4M5 19h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  wrench: '<path d="M14.5 6.5a4.5 4.5 0 0 0-5.8 5.8L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 5.8-5.8L14.5 12.5 11.5 9.5z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  flask: '<path d="M9.5 3h5M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3"/><path d="M7.5 15h9"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 19h14"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  tool: '<path d="M4 20 10 14M13 5l6 6-3 3-6-6zM15 3l6 6"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.7 7.5 9 4.3-1.3 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
  send: '<path d="M4 12 20 4l-5 16-3.5-6.5z"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
};
export const icon = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ""}</svg>`;

const MODEL_NAMES = { "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-sonnet-5": "Claude Sonnet 5", "claude-opus-5-5": "Claude Opus 5.5", "claude-haiku-5-5": "Claude Haiku 5.5", "built-in planner": "Built-in planner" };
export const modelName = (id) => MODEL_NAMES[id] || id || "";
export const LEVEL_CLASS = { High: "high", Medium: "medium", Low: "low", "Not scored": "none", "Awaiting model": "wait" };
export const levelPill = (level) => `<span class="pill pill-${LEVEL_CLASS[level] || "none"}"><i></i>${esc(level)}</span>`;
export const ACTION_ICON = { repair: "wrench", inspect: "eye", retest: "flask", monitor: "clock" };

export function riskBar(risk, level) {
  if (risk == null) return '<span class="muted">–</span>';
  return `<span class="risk"><span class="risk-num">${fmtRisk(risk)}</span>
    <span class="bar bar-${LEVEL_CLASS[level] || "none"}"><i style="width:${Math.max(2, Math.min(100, risk))}%"></i></span></span>`;
}

// A deliberately small Markdown subset for the assistant's summaries: bold, italics, bullets, paragraphs.
export function markdown(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|\s)_(.+?)_(?=\s|$|[.,])/g, "$1<em>$2</em>");
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`); list = []; } };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) { list.push(inline(bullet[1])); continue; }
    flush();
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    out.push(heading ? `<p class="md-head">${inline(heading[1])}</p>` : `<p>${inline(line)}</p>`);
  }
  flush();
  return out.join("");
}

export function toast(message, kind = "info", ms = 4500) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `${icon(kind === "error" ? "alert" : kind === "ok" ? "check" : "info")}<span>${esc(message)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 250); }, ms);
}

export const empty = (title, text, iconName = "info", extra = "") => `
  <div class="empty">${icon(iconName)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;

export function downloadCsv(filename, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([[cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Tooltips for anything with data-tip="Title|line|line".
const tip = $("#tooltip");
let tipOwner = null;
function showTip(el, x, y) {
  if (el !== tipOwner) {
    tipOwner = el;
    tip.replaceChildren(...el.dataset.tip.split("|").map((t, i) => Object.assign(document.createElement(i ? "div" : "b"), { textContent: t })));
    tip.hidden = false;
  }
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${x + pad + w > innerWidth - 8 ? x - w - pad : x + pad}px`;
  tip.style.top = `${y + pad + h > innerHeight - 8 ? y - h - pad : y + pad}px`;
}
function hideTip() { tipOwner = null; tip.hidden = true; }
document.addEventListener("mousemove", (ev) => {
  const el = ev.target.closest && ev.target.closest("[data-tip]");
  if (el) showTip(el, ev.clientX, ev.clientY); else if (tipOwner) hideTip();
});
document.addEventListener("scroll", hideTip, true);
document.addEventListener("click", hideTip, true);
