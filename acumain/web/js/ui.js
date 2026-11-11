// Small building blocks shared by every page: escaping, formatting, icons, risk marks, toasts.

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
  return today ? `today ${time}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

const PATHS = {
  upload: '<path d="M12 16V5M8 9l4-4 4 4M5 19h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 19h14"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-6"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
};
export const icon = (name, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ""}</svg>`;

const MODEL_NAMES = { "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-sonnet-5": "Claude Sonnet 5", "claude-opus-5-5": "Claude Opus 5.5", "claude-haiku-5-5": "Claude Haiku 5.5", "built-in planner": "Built-in planner" };
export const modelName = (id) => MODEL_NAMES[id] || id || "";
export const LEVEL_CLASS = { High: "high", Medium: "medium", Low: "low", "Not scored": "none", "Awaiting model": "none" };
// A risk level is plain text with a small square. Only High and Medium carry colour.
export const levelMark = (level) => `<span class="lv lv-${LEVEL_CLASS[level] || "none"}"><i></i>${esc(level === "Awaiting model" ? "Not scored yet" : level)}</span>`;
export const ACTION_SHORT = { repair: "Repair", inspect: "Inspect", retest: "Retest", monitor: "Monitor" };

export function riskBar(risk, level) {
  if (risk == null) return '<span class="muted">–</span>';
  return `<span class="risk risk-${LEVEL_CLASS[level] || "none"}"><b>${fmtRisk(risk)}</b><span class="bar"><i style="width:${Math.max(3, Math.min(100, risk))}%"></i></span></span>`;
}

// A deliberately small Markdown subset for the agent's summaries: bold, italics, bullets, paragraphs.
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

// The two views that share one place in the navigation.
export const subnav = (current) => `<nav class="subnav" aria-label="Model and log">
  <a href="#model" aria-current="${current === "model" ? "page" : "false"}">Model track record</a>
  <a href="#log" aria-current="${current === "log" ? "page" : "false"}">Agent activity log</a></nav>`;

export const empty = (title, text, extra = "") => `
  <div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;

// Replace an element's HTML without closing the <details data-k="…"> the reader had opened, or moving their scroll.
export function repaint(el, html) {
  if (!el) return;
  const open = new Set($$("details[data-k]", el).filter((d) => d.open).map((d) => d.dataset.k));
  el.innerHTML = html;
  for (const d of $$("details[data-k]", el)) if (open.has(d.dataset.k)) d.open = true;
}

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
