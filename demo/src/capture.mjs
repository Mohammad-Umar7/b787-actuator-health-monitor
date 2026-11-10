// Captures the REAL dashboard for the demo video.
//
//   node demo/src/capture.mjs [--url http://127.0.0.1:8791/] [--out demo/work/hf/assets/shots]
//
// It opens the live page in headless Chrome at 1920x1080 (2x pixel density so push-ins stay sharp),
// performs real clicks (month selector, aircraft rows) and saves one full-page PNG per state, plus
// shots.json with the position of every element the video points at. Nothing is drawn or mocked.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = resolve(HERE, "..", "work");
const require = createRequire(join(WORK, "package.json"));
const puppeteer = require("puppeteer-core");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const URL_ = arg("url", "http://127.0.0.1:8791/");
const OUT = resolve(arg("out", join(WORK, "hf", "assets", "shots")));
const BROWSERS = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const executablePath = BROWSERS.find((p) => existsSync(p));
if (!executablePath) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");

// Runs in the page: where everything is, in CSS pixels from the top-left of the page.
function measure() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +(r.left + scrollX).toFixed(1), y: +(r.top + scrollY).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const q = (sel, root = document) => root.querySelector(sel);
  const rects = {
    topbar: box(q(".topbar")), brand: box(q(".brand")), meta: box(q("#meta")),
    controls: box(q(".controls")), months: box(q("#months")), tiles: box(q("#tiles")),
    alert: box(q("#alert .alert")), outlook: box(q("#outlook")), trend: box(q("#outlook .trend")),
    fleet: box(q("#fleet")), thead: box(q("#fleet thead")), tbody: box(q("#fleet tbody")),
    detail: box(q("#detail")), detailHead: box(q("#detail .detail-head")),
    figure: box(q("#detail .hero .figure")), hero: box(q("#detail .hero")), scale: box(q("#detail .scale")),
    factors: box(q("#detail .factors")), history: box(q("#detail .chart")),
  };
  document.querySelectorAll("#months button").forEach((b) => { rects[`month_${b.textContent.trim()}`] = box(b); });
  document.querySelectorAll("#tiles .tile").forEach((b) => { rects[`tile_${b.dataset.filter}`] = box(b); });
  document.querySelectorAll("#outlook .stat").forEach((el, i) => { rects[`stat_${i + 1}`] = box(el); });
  document.querySelectorAll("#fleet thead th").forEach((el, i) => { rects[`th_${i + 1}`] = box(el); });
  document.querySelectorAll("#detail .section").forEach((el) => {
    const name = (el.querySelector("h3")?.textContent || "").trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
    rects[`section_${name}`] = box(el);
  });
  document.querySelectorAll("#detail .factor").forEach((el, i) => { rects[`factor_${i + 1}`] = box(el); });
  const rows = [...document.querySelectorAll("#fleet tbody tr")].map((tr) => {
    const cells = [...tr.children];
    return {
      id: tr.dataset.select, selected: tr.getAttribute("aria-selected") === "true", row: box(tr),
      aircraft: box(cells[1]), risk: box(cells[4]), riskCell: box(cells[4].querySelector(".risk-cell")),
      decision: box(cells[5]), badge: box(cells[5].querySelector(".badge")), action: box(cells[5].querySelector(".action")),
      outcome: box(cells[6]), outcomeText: cells[6]?.textContent.trim() ?? "",
      level: cells[5].querySelector(".badge")?.textContent.trim(), actionText: cells[5].querySelector(".action")?.textContent.trim(),
      riskText: cells[4].querySelector(".risk-num")?.textContent.trim(),
    };
  });
  const text = (sel) => (q(sel)?.textContent || "").replace(/\s+/g, " ").trim();
  const facts = {
    title: document.title, heading: text(".brand h1"), meta: text("#meta"), alert: text("#alert"),
    tiles: [...document.querySelectorAll("#tiles .tile")].map((t) => `${t.querySelector(".label").textContent.trim()}: ${t.querySelector(".value").textContent.trim()}`),
    month: text('#months button[aria-pressed="true"]'), stats: [...document.querySelectorAll("#outlook .stat")].map((s) => s.textContent.replace(/\s+/g, " ").trim()),
    detailTitle: text("#detail h2"), figure: text("#detail .hero .figure"),
    factors: [...document.querySelectorAll("#detail .factor")].map((f) => f.textContent.replace(/\s+/g, " ").trim()),
    tooltipHidden: q("#tooltip")?.hidden ?? true,
  };
  return { page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }, rects, rows, facts };
}

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
try {
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await page.waitForSelector("#fleet tbody tr");
  await page.evaluate(() => document.fonts.ready);

  const shots = { url: URL_, capturedAt: new Date().toISOString(), viewport: { w: 1920, h: 1080, dpr: 2 }, states: {} };
  const park = async () => { await page.mouse.move(960, 6); await new Promise((r) => setTimeout(r, 150)); };
  const snap = async (name) => {
    await park(); // move the pointer onto the top bar so no hover style or tooltip is in the picture
    const info = await page.evaluate(measure);
    if (!info.facts.tooltipHidden) throw new Error(`tooltip visible in state ${name}`);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    shots.states[name] = { file: `${name}.png`, ...info };
    console.log(`${name}: page ${info.page.w}x${info.page.h} · month ${info.facts.month} · ${info.facts.tiles.join(" · ")} · selected ${info.facts.detailTitle} ${info.facts.figure}`);
  };
  const clickMonth = async (label) => {
    const btn = await page.evaluateHandle((l) => [...document.querySelectorAll("#months button")].find((b) => b.textContent.trim() === l), label);
    await btn.asElement().click();
  };
  const clickRow = async (id) => {
    // click on the aircraft name cell (the risk cell would pop a tooltip)
    const cell = await page.$(`tr[data-select="${id}"] td:nth-child(2)`);
    if (!cell) throw new Error(`row ${id} not found`);
    await cell.click();
  };

  await snap("apr");                       // the page as it opens: latest month, top-ranked aircraft selected
  for (const m of ["Jan", "Feb", "Mar"]) { await clickMonth(m); await snap(m.toLowerCase()); }
  await clickMonth("Apr");
  await clickRow("B787-007"); await snap("apr_007");
  await clickRow("B787-008"); await snap("apr_008");

  writeFileSync(join(OUT, "shots.json"), JSON.stringify(shots, null, 1));
  console.log(`wrote ${Object.keys(shots.states).length} states to ${OUT}`);
} finally {
  await browser.close();
}
