// Builds the HyperFrames project for the demo video from three inputs:
//   demo/src/narration.json                    the script, the subtitle lines and the spoken spelling
//   demo/work/hf/audio_meta.json               voice clips + word timings (media-use audio engine)
//   demo/work/hf/assets/shots/shots.json       real dashboard screenshots + element positions (capture.mjs)
// and writes:
//   demo/work/hf/index.html, compositions/*.html, assets/voice/narration.wav, timing.json
//   demo/demo.srt, demo/narration.txt
//
//   node demo/src/compose.mjs
//
// The voice is the clock: every camera move, highlight and click is placed on the word that says it.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, "..");
const HF = join(DEMO, "work", "hf");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const narr = readJson(join(HERE, "narration.json"));
const meta = readJson(join(HF, "audio_meta.json"));
const shots = readJson(join(HF, "assets", "shots", "shots.json"));
const r3 = (n) => Math.round(n * 1000) / 1000;

// ------------------------------------------------------------------ what is on the cards
const NAME = "AcuMain";
const LINE = "B787 nose gear actuator health";
const TAGLINE = "Predict the failure before it happens.";
const LINK = "acumain.vercel.app";
const EVENT = "AI for Smart Maintenance Hackathon";
const TEAM = "Team Maze";
const NAVY = "#0d366b", PAPER = "#fcfcfb", PAGE_BG = "#f9f9f7", INK = "#0b0b0b", INK2 = "#52514e", ACCENT = "#184f95", SERIES = "#2a78d6";

// ------------------------------------------------------------------ timing
const LEAD = 1.3;   // title card on its own before the voice starts
const TAIL = 2.7;   // end card held after the last word
const GAP = { b1: 0.4, b2: 0.35, b3: 0.4, b4: 0.55, b5: 0.4, b6: 0.5, b7: 0.5 }; // pause after each beat

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

// Match the scripted words to the words the transcriber heard in the clip, by position.
// Numbers and names are heard differently ("thirty" -> "30", "AcuMain" -> "Acumane"), so unmatched
// stretches between two matched words are paired up in order.
function alignWords(scriptWords, heard) {
  const a = scriptWords.map(norm), b = heard.map((w) => norm(w.text));
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const range = new Array(n).fill(null);
  const anchors = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { anchors.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  anchors.push([n, m]);
  let pi = -1, pj = -1;
  for (const [ai, aj] of anchors) {
    const ci = ai - pi - 1, cj = aj - pj - 1;
    for (let k = 0; k < ci; k++) {
      if (cj > 0) range[pi + 1 + k] = [pj + 1 + Math.floor((k * cj) / ci), pj + 1 + Math.max(Math.floor((k * cj) / ci), Math.floor(((k + 1) * cj) / ci) - 1)];
      else range[pi + 1 + k] = pj >= 0 ? [pj, pj] : [Math.min(aj, m - 1), Math.min(aj, m - 1)];
    }
    if (ai < n) range[ai] = [aj, aj];
    pi = ai; pj = aj;
  }
  return range.map(([j0, j1]) => ({ start: heard[j0].start, end: heard[j1].end }));
}

// The transcriber stamps words in 80 ms steps, and a word that follows a pause is often stamped
// inside the pause. Pull such edges to where the sound really starts and stops.
function quietParts(file, clipEnd) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-38dB:d=0.1", "-f", "null", "-"], { encoding: "utf8" });
  const out = [];
  let from = null;
  for (const line of r.stderr.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) from = Math.max(0, +s[1]);
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && from != null) { out.push([from, +e[1]]); from = null; }
  }
  if (from != null) out.push([from, clipEnd]);
  return out;
}
let snapped = 0, snapMax = 0;
function snapToSound(words, quiet) {
  return words.map((w) => {
    let { start, end } = w;
    for (const [s, e] of quiet) {
      if (start >= s - 0.02 && start < e - 0.04) start = e - 0.04;          // stamped inside a pause: it starts when the sound does
      else if (start < s && end > s + 0.06 && end <= e + 0.02) end = s + 0.06; // runs into a pause: it ends when the sound does
    }
    if (end < start + 0.1) end = start + 0.1;
    const moved = Math.max(Math.abs(start - w.start), Math.abs(end - w.end));
    if (moved > 0.001) { snapped++; snapMax = Math.max(snapMax, moved); }
    return { ...w, start: r3(start), end: r3(end) };
  });
}

const voiceById = Object.fromEntries(meta.voices.map((v) => [v.id, v]));
const beats = [];
let clock = LEAD;
for (const b of narr.beats) {
  const v = voiceById[b.id];
  if (!v || !v.words?.length) throw new Error(`no voice clip or word timings for ${b.id}: run the voice step first`);
  const words = b.cues.flatMap((cue, ci) => cue.split(/\s+/).map((text) => ({ text, cue: ci })));
  const heard = snapToSound(v.words, quietParts(join(HF, v.path), v.duration_s));
  const times = alignWords(words.map((w) => w.text), heard);
  words.forEach((w, i) => Object.assign(w, times[i]));
  beats.push({ id: b.id, voiceStart: clock, duration: v.duration_s, file: v.path, words, cues: b.cues });
  clock += v.duration_s + (GAP[b.id] ?? 0);
}
const B = Object.fromEntries(beats.map((b) => [b.id, b]));
const lastWordEnd = beats.at(-1).voiceStart + beats.at(-1).words.at(-1).end;
const TOTAL = Math.ceil((lastWordEnd + TAIL) * 10) / 10;

// Global time at which a scripted word starts: W("b3", "medium") or W("b6", "and", 2) for the second "and".
function W(beat, word, occurrence = 1) {
  const hits = B[beat].words.filter((w) => norm(w.text) === norm(word));
  if (hits.length < occurrence) throw new Error(`word "${word}" (#${occurrence}) not found in ${beat}`);
  return B[beat].voiceStart + hits[occurrence - 1].start;
}

// ------------------------------------------------------------------ subtitles
const cues = [];
for (const b of beats) {
  b.cues.forEach((text, ci) => {
    const ws = b.words.filter((w) => w.cue === ci);
    cues.push({ beat: b.id, text, start: b.voiceStart + ws[0].start - 0.06, end: b.voiceStart + ws.at(-1).end + 0.3 });
  });
}
cues.forEach((c, i) => {
  const next = cues[i + 1];
  if (next && next.start - c.end < 0.45) c.end = next.start - 0.04; // hold until the next line when it follows closely
  c.start = r3(Math.max(0.2, c.start));
  c.end = r3(Math.min(TOTAL - 0.2, c.end));
});
const stamp = (t) => {
  const ms = Math.round(t * 1000);
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
writeFileSync(join(DEMO, "demo.srt"), cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n"));
writeFileSync(join(DEMO, "narration.txt"), beats.map((b) => b.cues.join(" ")).join("\n\n") + "\n");

// ------------------------------------------------------------------ the page and where things are
const S = shots.states;
const PAGE = S.apr.page;
const R = S.apr.rects;
const ROW = Object.fromEntries(S.apr.rows.map((r) => [r.id, r]));
const pad = (r, px, py = px) => ({ x: r.x - px, y: r.y - py, w: r.w + 2 * px, h: r.h + 2 * py });
const union = (...rs) => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
// Camera = where the 1920-wide page sits in the frame. Zoomed in, it always covers the frame.
const cam = (s, x, y) => (s >= 1
  ? { s, x: r3(Math.min(0, Math.max(1920 - PAGE.w * s, x))), y: r3(Math.min(0, Math.max(1080 - PAGE.h * s, y))) }
  : { s, x: r3(x), y: r3(y) });
const centred = (s) => 960 - s * 960;
const CAM = {
  top: cam(1, 0, 0),                                   // the page exactly as the browser shows it
  topPush: cam(1.1, 0, 0),
  table: cam(1.05, -48, 20 - 1.05 * R.fleet.y),         // whole fleet table
  table2: cam(1.07, -67, 20 - 1.07 * R.fleet.y),
  over: cam(0.52, centred(0.52), 12),                   // the whole dashboard as one card, clear of the subtitles
  over2: cam(0.545, centred(0.545), 12),
  // the next two start just under the top bar, so its name is never cut off at the frame edge
  tiles: cam(1.22, centred(1.22), -1.22 * R.topbar.h),   // month picker, tiles and alert
  tiles2: cam(1.26, centred(1.26), -1.26 * R.topbar.h),
  outlook: cam(1.25, centred(1.25), -1.25 * R.topbar.h), // tiles down to the fleet outlook card
  outlook2: cam(1.27, centred(1.27), -1.27 * R.topbar.h),
  fleet: cam(1.25, 0, 24 - 1.25 * R.fleet.y),           // fleet priorities, rows 1 to 8 above the subtitles
  fleet2: cam(1.28, 0, 24 - 1.28 * R.fleet.y),
  pair: cam(1.08, centred(1.08), 20 - 1.08 * R.fleet.y), // table and aircraft detail side by side
  pair2: cam(1.1, centred(1.1), 20 - 1.1 * R.fleet.y),
  detail: cam(1.6, -9999, 30 - 1.6 * R.detail.y),       // aircraft detail: risk figure and reasons
  detail2: cam(1.64, -9999, 30 - 1.64 * R.detail.y),
  history: cam(1.75, -9999, 1080 - 1.75 * PAGE.h),       // risk by month chart (bottom-right corner of the page)
  history2: cam(1.78, -9999, 1080 - 1.78 * PAGE.h),
};

// ------------------------------------------------------------------ scene windows (global seconds)
const tLift = W("b1", "On") - 0.62;                    // navy title curtain lifts onto the dashboard
const win = {
  title: [0, tLift + 0.8],
  b1: [tLift, B.b2.voiceStart - 0.3],
  b2: [B.b2.voiceStart - 0.3, B.b3.voiceStart - 0.25],
  b3: [B.b3.voiceStart - 0.25, B.b4.voiceStart - 0.3],
  b4: [B.b4.voiceStart - 0.3, B.b5.voiceStart - 0.35],
  b5: [B.b5.voiceStart - 0.35, B.b6.voiceStart - 0.3],
  b6: [B.b6.voiceStart - 0.3, B.b7.voiceStart + 0.1],
  facts: [B.b7.voiceStart - 0.6, B.b8.voiceStart + 0.1],
  end: [B.b8.voiceStart - 0.6, TOTAL],
};
for (const k of Object.keys(win)) win[k] = win[k].map(r3);
const dur = (k) => r3(win[k][1] - win[k][0]);

// ------------------------------------------------------------------ html helpers
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The dashboard uses the system UI font; on Windows that is Segoe UI. Inter is the bundled fallback.
const FONT_FACE = `@font-face { font-family: "Dash Sans"; src: local("Segoe UI"); font-weight: 400; }
    @font-face { font-family: "Dash Sans"; src: local("Segoe UI Semibold"), local("Segoe UI"); font-weight: 600; }`;
const FONT = `"Dash Sans", Inter, sans-serif`;
const MARK = (id, size) => `<svg id="${id}" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="${PAPER}"/>
          <path d="M16 6v13" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"/>
          <path d="M16 12l6 5" stroke="${NAVY}" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="16" cy="23" r="4" fill="none" stroke="${NAVY}" stroke-width="3"/>
        </svg>`;
const CHECK = (cls) => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#0ca30c"/><path d="m4.8 8.2 2.2 2.2 4.2-4.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const WARN = (cls) => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 15 8 8 15 1 8z" fill="#fab219"/><path d="M8 4.8v3.6" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11" r=".9" fill="#0b0b0b"/></svg>`;
const scene = (id, body) => `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>${id}</title></head>
  <body>
    <template>
${body}
    </template>
  </body>
</html>
`;
const camVars = (c) => `{ x: ${c.x}, y: ${c.y}, scale: ${c.s} }`;
const boxVars = (r) => `{ x: ${r3(r.x)}, y: ${r3(r.y)}, width: ${r3(r.w)}, height: ${r3(r.h)} }`;

// A dashboard scene: the real screenshots on a camera layer, plus a moving highlight and (when the
// page was clicked for real during capture) a pointer that shows where.
function dashScene(id, { images, camera, highlight = [], outline = [], pointer = null, radius = 0 }) {
  const t0 = win[id][0];
  const L = (t) => r3(Math.max(0, t - t0));
  const js = [];
  camera.forEach((k, i) => {
    if (!i) return;
    const p = camera[i - 1];
    js.push(`tl.fromTo("#${id}-cam", ${camVars(p.c)}, { ...${camVars(k.c)}, duration: ${r3(L(k.t) - L(p.t))}, ease: "${k.ease ?? "none"}", immediateRender: ${i === 1} }, ${L(p.t)});`);
  });
  // The page changes at once when it is clicked, so the pictures are swapped with a cut, not a dissolve.
  images.forEach((im, i) => {
    if (im.at == null) return;
    js.push(`tl.set("#${id}-shot-${i}", { opacity: 1 }, ${L(im.at)});`);
    if (im.until != null) js.push(`tl.set("#${id}-shot-${i}", { opacity: 0 }, ${L(im.until)});`);
  });
  const boxes = (list, el) => list.forEach((ep) => {
    js.push(`tl.set("#${id}-${el}", ${boxVars(ep.steps[0].rect)}, ${L(ep.in - 0.02)});`);
    js.push(`tl.fromTo("#${id}-${el}", { opacity: 0 }, { opacity: 1, duration: 0.22, ease: "power2.out", immediateRender: false }, ${L(ep.in)});`);
    ep.steps.slice(1).forEach((st, i) => js.push(`tl.fromTo("#${id}-${el}", ${boxVars(ep.steps[i].rect)}, { ...${boxVars(st.rect)}, duration: 0.34, ease: "power3.inOut", immediateRender: false }, ${L(st.t)});`));
    js.push(`tl.fromTo("#${id}-${el}", { opacity: 1 }, { opacity: 0, duration: 0.18, ease: "power2.in", immediateRender: false }, ${L(ep.out)});`);
  });
  boxes(highlight, "hl");
  boxes(outline, "ol");
  if (pointer) {
    const tip = (p) => `{ x: ${r3(p.x - 5)}, y: ${r3(p.y - 3)} }`; // the arrow's tip is at (5,3) of its 34px box
    js.push(`tl.set("#${id}-ptr", ${tip(pointer.from)}, ${L(pointer.show - 0.02)});`);
    js.push(`tl.fromTo("#${id}-ptr", { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "power2.out", immediateRender: false }, ${L(pointer.show)});`);
    let prev = pointer.from;
    for (const c of pointer.clicks) {
      const travel = c.travel ?? 0.5;
      js.push(`tl.fromTo("#${id}-ptr", ${tip(prev)}, { ...${tip(c)}, duration: ${travel}, ease: "power3.inOut", immediateRender: false }, ${L(c.t - travel - 0.08)});`);
      js.push(`tl.fromTo("#${id}-ptr-arrow", { scale: 1 }, { scale: 0.78, duration: 0.07, ease: "power2.in", yoyo: true, repeat: 1, immediateRender: false }, ${L(c.t - 0.05)});`);
      prev = c;
    }
    js.push(`tl.fromTo("#${id}-ptr", { opacity: 1 }, { opacity: 0, duration: 0.2, ease: "power2.in", immediateRender: false }, ${L(pointer.hide)});`);
  }
  return scene(id, `      <style>
        #root { position: absolute; inset: 0; overflow: hidden; background: ${NAVY}; }
        #${id}-cam { position: absolute; left: 0; top: 0; width: ${PAGE.w}px; height: ${PAGE.h}px; transform-origin: 0 0; overflow: hidden; border-radius: ${radius}px; background: ${PAGE_BG}; box-shadow: 0 40px 120px rgba(4, 16, 36, 0.55); }
        .${id}-shot { position: absolute; left: 0; top: 0; width: ${PAGE.w}px; display: block; }
        #${id}-hl, #${id}-ol { position: absolute; left: 0; top: 0; width: 100px; height: 100px; opacity: 0; border: 3px solid ${ACCENT}; border-radius: 12px; }
        #${id}-hl { box-shadow: 0 0 0 4000px rgba(13, 54, 107, 0.2), 0 6px 22px rgba(13, 54, 107, 0.3); }
        #${id}-ol { box-shadow: 0 0 0 5px rgba(24, 79, 149, 0.18); }
        #${id}-ptr { position: absolute; left: 0; top: 0; width: 34px; height: 34px; opacity: 0; }
        #${id}-ptr-arrow { display: block; width: 34px; height: 34px; transform-origin: 15% 9%; }
      </style>
      <div id="root" data-composition-id="${id}" data-width="1920" data-height="1080">
        <div id="${id}-cam" data-layout-allow-overflow>
${images.map((im, i) => `          <img id="${id}-shot-${i}" class="${id}-shot" src="assets/shots/${im.file}" alt="${esc(im.alt)}" style="height: ${S[im.state].page.h}px;${im.at == null ? "" : " opacity: 0;"}" />`).join("\n")}
          <div id="${id}-hl" data-layout-ignore></div>
          <div id="${id}-ol" data-layout-ignore></div>${pointer ? `
          <div id="${id}-ptr" data-layout-ignore><svg id="${id}-ptr-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2v17.5l4.7-4.3 3.1 6.9 2.9-1.3-3-6.7H18z" fill="${INK}" stroke="${PAPER}" stroke-width="1.5" stroke-linejoin="round"/></svg></div>` : ""}
        </div>
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
          ${js.join("\n          ")}
          window.__timelines["${id}"] = tl;
        })();
      </script>`);
}
const shot = (state, at = null, until = null) => ({ state, file: S[state].file, at, until, alt: `AcuMain dashboard, ${S[state].facts.month}, ${S[state].facts.detailTitle} selected` });

// ------------------------------------------------------------------ dashboard scenes
const files = {};

// Beat 1 (after the title card): the fleet, then the recorded failures.
{
  const tIn = W("b1", "In");
  const failed = S.apr.rows.filter((r) => r.outcomeText === "Failed");
  const outcomeCol = pad(union(R.th_7, ...failed.map((r) => r.outcome)), -3, 2);
  files.b1 = dashScene("b1", {
    images: [shot("apr")],
    camera: [
      { t: win.b1[0], c: CAM.top },
      { t: tIn - 0.55, c: CAM.topPush },
      { t: tIn + 0.4, c: CAM.table, ease: "power2.inOut" },
      { t: win.b1[1], c: CAM.table2 },
    ],
    highlight: [{ in: W("b1", "six") - 0.25, out: win.b1[1] - 0.22, steps: [{ rect: outcomeCol }] }],
  });
}

// Beat 2: pull back to the whole dashboard.
files.b2 = dashScene("b2", {
  radius: 12, // the page is shown as a card here
  images: [shot("apr")],
  camera: [
    { t: win.b2[0], c: CAM.table2 },
    { t: win.b2[0] + 1.05, c: CAM.over, ease: "power2.inOut" },
    { t: win.b2[1], c: CAM.over2 },
  ],
});

// Beat 3: tiles and the alert.
{
  const tile = (k) => pad(R[`tile_${k}`], 6);
  files.b3 = dashScene("b3", {
    radius: 12,
    images: [shot("apr")],
    camera: [
      { t: win.b3[0], c: CAM.over2 },
      { t: win.b3[0] + 1.1, c: CAM.tiles, ease: "power2.inOut" },
      { t: win.b3[1], c: CAM.tiles2 },
    ],
    highlight: [{
      in: W("b3", "high,") - 0.2, out: win.b3[1] - 0.3,
      steps: [
        { rect: tile("High") },
        { t: W("b3", "medium") - 0.22, rect: tile("Medium") },
        { t: W("b3", "low") - 0.22, rect: tile("Low") },
        { t: W("b3", "one") - 0.3, rect: pad(R.alert, 6) },
      ],
    }],
  });
}

// Beat 4: the fleet outlook, then the month selector stepped Jan, Feb, Mar, Apr (real clicks in capture).
{
  const cJan = W("b4", "from") + 0.25;
  const cFeb = W("b4", "to") - 0.1;
  const cMar = cFeb + 0.42;
  const cApr = cMar + 0.42;
  const btn = (m) => centre(R[`month_${m}`]);
  files.b4 = dashScene("b4", {
    // Apr is the picture underneath; clicking Apr again takes the three month layers away
    images: [shot("apr"), shot("jan", cJan + 0.03, cApr + 0.03), shot("feb", cFeb + 0.03, cApr + 0.03), shot("mar", cMar + 0.03, cApr + 0.03)],
    camera: [
      { t: win.b4[0], c: CAM.tiles2 },
      { t: win.b4[0] + 0.9, c: CAM.outlook, ease: "power2.inOut" },
      { t: win.b4[1], c: CAM.outlook2 },
    ],
    highlight: [{ in: W("b4", "fleet") - 0.1, out: W("b4", "from") - 0.3, steps: [{ rect: pad(R.outlook, 6) }] }],
    outline: [{ in: cJan + 0.1, out: win.b4[1] - 0.25, steps: [{ rect: pad(R.tile_High, 5) }] }],
    pointer: {
      from: { x: 520, y: 330 }, show: cJan - 0.85, hide: win.b4[1] - 0.25,
      clicks: [
        { ...btn("Jan"), t: cJan, travel: 0.55 },
        { ...btn("Feb"), t: cFeb, travel: 0.25 },
        { ...btn("Mar"), t: cMar, travel: 0.25 },
        { ...btn("Apr"), t: cApr, travel: 0.25 },
      ],
    },
  });
}

// Beat 5: the ranked table and the three decisions.
{
  const rowsTo8 = union(...S.apr.rows.slice(0, 8).map((r) => r.row));
  const col = (th) => pad({ x: R[th].x, y: R[th].y, w: R[th].w, h: rowsTo8.y + rowsTo8.h - R[th].y }, -2, 0);
  // one example row per decision: the last High row sits right above the first Medium and Low rows
  const example = { High: S.apr.rows.filter((r) => r.level === "High").at(-1), Medium: S.apr.rows.find((r) => r.level === "Medium"), Low: S.apr.rows.find((r) => r.level === "Low") };
  const rowBox = (level) => pad(example[level].row, -3, -2);
  files.b5 = dashScene("b5", {
    images: [shot("apr")],
    camera: [
      { t: win.b5[0], c: CAM.outlook2 },
      { t: win.b5[0] + 0.95, c: CAM.fleet, ease: "power2.inOut" },
      { t: win.b5[1], c: CAM.fleet2 },
    ],
    highlight: [{
      in: W("b5", "ranked") - 0.15, out: win.b5[1] - 0.3,
      steps: [
        { rect: col("th_5") },
        { t: W("b5", "clear") - 0.35, rect: col("th_6") },
        { t: W("b5", "schedule") - 0.2, rect: rowBox("High") },
        { t: W("b5", "plan") - 0.2, rect: rowBox("Medium") },
        { t: W("b5", "or") - 0.1, rect: rowBox("Low") },
      ],
    }],
  });
}

// Beat 6: select an aircraft (real clicks in capture), then why, then its history.
{
  const c007 = W("b6", "Select") + 0.8;
  const c008 = W("b6", "For") + 0.55;
  const tSlow = W("b6", "slow");
  const tHist = W("b6", "history");
  const cell = (id) => ({ x: ROW[id].aircraft.x + 60, y: ROW[id].row.y + ROW[id].row.h / 2 + 4 });
  const factor = (n) => pad(R[`factor_${n}`], 9, 5);
  files.b6 = dashScene("b6", {
    images: [shot("apr"), shot("apr_007", c007 + 0.03), shot("apr_008", c008 + 0.03)],
    camera: [
      { t: win.b6[0], c: CAM.fleet2 },
      { t: win.b6[0] + 0.9, c: CAM.pair, ease: "power2.inOut" },
      { t: tSlow - 1.05, c: CAM.pair2 },
      { t: tSlow - 0.15, c: CAM.detail, ease: "power2.inOut" },
      { t: W("b6", "and", 2) - 0.4, c: CAM.detail2 },
      { t: tHist + 0.2, c: CAM.history, ease: "power2.inOut" },
      { t: win.b6[1], c: CAM.history2 },
    ],
    highlight: [
      {
        in: tSlow - 0.1, out: W("b6", "and", 2) - 0.5,
        steps: [
          { rect: factor(1) },
          { t: W("b6", "very") - 0.3, rect: factor(2) },
          { t: W("b6", "drive") - 0.1, rect: pad(union(R.hero, R.scale), 9, 9) },
        ],
      },
      { in: tHist + 0.3, out: win.facts[0] + 0.15, steps: [{ rect: pad(R.section_risk_by_month, -5) }] },
    ],
    pointer: {
      from: { x: 720, y: 900 }, show: win.b6[0] + 0.5, hide: c008 + 0.7,
      clicks: [{ ...cell("B787-007"), t: c007, travel: 0.5 }, { ...cell("B787-008"), t: c008, travel: 0.6 }],
    },
  });
}

// ------------------------------------------------------------------ title card
{
  const out = r3(tLift - win.title[0]);
  files.title = scene("title", `      <style>
        ${FONT_FACE}
        #root { position: absolute; inset: 0; overflow: hidden; }
        #title-curtain { position: absolute; inset: 0; background: ${NAVY}; }
        #title-lockup { position: absolute; left: 0; right: 0; top: 0; height: 860px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: ${PAPER}; font-family: ${FONT}; }
        #title-event { font-size: 28px; font-weight: 600; letter-spacing: 4px; text-transform: uppercase; color: rgba(252, 252, 251, 0.66); }
        #title-row { display: flex; align-items: center; gap: 38px; margin-top: 58px; }
        #title-mark { display: block; }
        #title-name { font-size: 156px; font-weight: 600; line-height: 1; letter-spacing: -2px; }
        #title-line { margin-top: 36px; font-size: 48px; font-weight: 400; color: rgba(252, 252, 251, 0.82); }
        #title-rule { display: block; width: 96px; height: 4px; border-radius: 2px; background: ${SERIES}; margin-top: 46px; }
        #title-team { margin-top: 40px; font-size: 30px; color: rgba(252, 252, 251, 0.66); }
      </style>
      <div id="root" data-composition-id="title" data-width="1920" data-height="1080">
        <div id="title-curtain" data-layout-allow-overflow>
          <div id="title-lockup">
            <p id="title-event">${esc(EVENT)}</p>
            <div id="title-row">
              ${MARK("title-mark", 136)}
              <h1 id="title-name">${esc(NAME)}</h1>
            </div>
            <p id="title-line">${esc(LINE)}</p>
            <span id="title-rule"></span>
            <p id="title-team">${esc(TEAM)}</p>
          </div>
        </div>
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
          // The name and its line are on screen from frame 0 (that frame is the thumbnail); the rest arrives around them.
          tl.fromTo("#title-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "expo.out" }, 0.25);
          tl.fromTo("#title-event", { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power2.out" }, 0.45);
          tl.fromTo("#title-team", { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power2.out" }, 0.6);
          tl.fromTo("#title-lockup", { opacity: 1 }, { opacity: 0, duration: 0.24, ease: "power2.in", immediateRender: false }, ${r3(out - 0.2)});
          tl.fromTo("#title-curtain", { yPercent: 0 }, { yPercent: -100, duration: 0.72, ease: "power3.inOut", immediateRender: false }, ${out});
          window.__timelines["title"] = tl;
        })();
      </script>`);
}

// ------------------------------------------------------------------ model facts card (beat 7)
{
  const L = (t) => r3(t - win.facts[0]);
  files.facts = scene("facts", `      <style>
        ${FONT_FACE}
        #root { position: absolute; inset: 0; overflow: hidden; }
        #facts-sheet { position: absolute; inset: 0; background: ${PAGE_BG}; box-shadow: 0 -24px 70px rgba(11, 11, 11, 0.22); }
        #facts-wrap { position: absolute; left: 170px; right: 170px; top: 0; height: 870px; display: flex; flex-direction: column; justify-content: center; color: ${INK}; font-family: ${FONT}; }
        #facts-eyebrow { font-size: 28px; font-weight: 600; letter-spacing: 4px; text-transform: uppercase; color: ${INK2}; }
        #facts-head { margin-top: 16px; font-size: 96px; font-weight: 600; line-height: 1.05; letter-spacing: -1.5px; }
        #facts-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-top: 62px; }
        .facts-tile { position: relative; height: 290px; padding: 34px 38px 36px; display: flex; flex-direction: column; justify-content: space-between; background: ${PAPER}; border: 1px solid rgba(11, 11, 11, 0.1); border-radius: 20px; box-shadow: 0 1px 2px rgba(11, 11, 11, 0.05), 0 10px 30px rgba(11, 11, 11, 0.07); }
        .facts-value { font-size: 112px; font-weight: 600; line-height: 1; letter-spacing: -2px; color: ${NAVY}; white-space: nowrap; }
        .facts-value.is-words { font-size: 58px; line-height: 1.1; letter-spacing: -1px; }
        .facts-label { font-size: 33px; line-height: 1.25; color: ${INK2}; }
        .facts-glyph { position: absolute; right: 34px; top: 36px; width: 52px; height: 52px; }
        #facts-foot { margin-top: 54px; display: flex; align-items: center; gap: 18px; font-size: 40px; }
        #facts-dot { display: block; width: 16px; height: 16px; border-radius: 50%; background: ${SERIES}; }
      </style>
      <div id="root" data-composition-id="facts" data-width="1920" data-height="1080">
        <div id="facts-sheet" data-layout-allow-overflow>
          <div id="facts-wrap">
            <p id="facts-eyebrow">The model behind it</p>
            <h2 id="facts-head">Built not to overfit</h2>
            <div id="facts-tiles">
              <div id="facts-tile-1" class="facts-tile">
                <span class="facts-value is-words">Unseen aircraft</span>
                <span class="facts-label">Tested on aircraft it had never seen</span>
              </div>
              <div id="facts-tile-2" class="facts-tile">
                ${CHECK("facts-glyph")}
                <span class="facts-value">6 of 6</span>
                <span class="facts-label">failures caught</span>
              </div>
              <div id="facts-tile-3" class="facts-tile">
                ${WARN("facts-glyph")}
                <span class="facts-value">1</span>
                <span class="facts-label">false alarm</span>
              </div>
            </div>
            <p id="facts-foot"><span id="facts-dot"></span><span id="facts-foot-text">Scores new data the moment it arrives</span></p>
          </div>
        </div>
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
          tl.fromTo("#facts-sheet", { yPercent: 100 }, { yPercent: 0, duration: 0.6, ease: "power3.out" }, 0);
          tl.fromTo("#facts-eyebrow", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, 0.4);
          tl.fromTo("#facts-head", { opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.3, ease: "power2.out" }, 0.5);
          tl.fromTo("#facts-tile-1", { opacity: 0, y: 36 }, { opacity: 1, y: 0, duration: 0.55, ease: "expo.out" }, ${L(W("b7", "Tested") - 0.12)});
          tl.fromTo("#facts-tile-2", { opacity: 0, y: 36 }, { opacity: 1, y: 0, duration: 0.55, ease: "expo.out" }, ${L(W("b7", "caught") - 0.12)});
          tl.fromTo("#facts-tile-3", { opacity: 0, y: 36 }, { opacity: 1, y: 0, duration: 0.55, ease: "expo.out" }, ${L(W("b7", "one") - 0.2)});
          tl.fromTo("#facts-foot", { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, ${L(W("b7", "scores") - 0.3)});
          window.__timelines["facts"] = tl;
        })();
      </script>`);
}

// ------------------------------------------------------------------ end card (beat 8)
{
  const L = (t) => r3(t - win.end[0]);
  const tName = L(W("b8", "AcuMain:"));
  files.end = scene("end", `      <style>
        ${FONT_FACE}
        #root { position: absolute; inset: 0; overflow: hidden; }
        #end-curtain { position: absolute; inset: 0; background: ${NAVY}; color: ${PAPER}; font-family: ${FONT}; }
        #end-benefits, #end-lockup { position: absolute; left: 0; right: 0; top: 0; height: 870px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        #end-list { display: flex; flex-direction: column; gap: 40px; }
        .end-benefit { display: flex; align-items: center; gap: 30px; font-size: 76px; font-weight: 600; line-height: 1.1; letter-spacing: -1px; }
        .end-check { width: 58px; height: 58px; flex: none; }
        #end-row { display: flex; align-items: center; gap: 34px; }
        #end-mark { display: block; }
        #end-name { font-size: 140px; font-weight: 600; line-height: 1; letter-spacing: -2px; }
        #end-line { margin-top: 30px; font-size: 42px; color: rgba(252, 252, 251, 0.82); }
        #end-tagline { margin-top: 56px; font-size: 60px; font-weight: 600; letter-spacing: -0.5px; }
        #end-link { margin-top: 50px; padding: 12px 32px 14px; font-size: 34px; border: 2px solid rgba(252, 252, 251, 0.42); border-radius: 999px; }
        #end-credit { margin-top: 38px; font-size: 28px; color: rgba(252, 252, 251, 0.66); }
      </style>
      <div id="root" data-composition-id="end" data-width="1920" data-height="1080">
        <div id="end-curtain" data-layout-allow-overflow>
          <div id="end-benefits">
            <div id="end-list">
              <p id="end-benefit-1" class="end-benefit">${CHECK("end-check")}<span>Fewer surprise groundings</span></p>
              <p id="end-benefit-2" class="end-benefit">${CHECK("end-check")}<span>Better planning</span></p>
              <p id="end-benefit-3" class="end-benefit">${CHECK("end-check")}<span>More aircraft ready to fly</span></p>
            </div>
          </div>
          <div id="end-lockup">
            <div id="end-row">
              ${MARK("end-mark", 122)}
              <h2 id="end-name">${esc(NAME)}</h2>
            </div>
            <p id="end-line">${esc(LINE)}</p>
            <p id="end-tagline">${esc(TAGLINE)}</p>
            <p id="end-link">${esc(LINK)}</p>
            <p id="end-credit">${esc(EVENT)} · ${esc(TEAM)}</p>
          </div>
        </div>
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
          tl.fromTo("#end-curtain", { yPercent: -100 }, { yPercent: 0, duration: 0.6, ease: "power3.out" }, 0);
          tl.fromTo("#end-benefit-1", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out" }, ${L(W("b8", "Fewer") - 0.1)});
          tl.fromTo("#end-benefit-2", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out" }, ${L(W("b8", "Better") - 0.12)});
          tl.fromTo("#end-benefit-3", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out" }, ${L(W("b8", "More") - 0.12)});
          tl.fromTo("#end-benefits", { opacity: 1 }, { opacity: 0, duration: 0.22, ease: "power2.in", immediateRender: false }, ${r3(tName - 0.34)});
          tl.fromTo("#end-mark", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.55, ease: "expo.out" }, ${r3(tName - 0.1)});
          tl.fromTo("#end-name", { opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.3, ease: "power2.out" }, ${r3(tName - 0.04)});
          tl.fromTo("#end-line", { opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power2.out" }, ${r3(tName + 0.3)});
          tl.fromTo("#end-tagline", { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${L(W("b8", "predict") - 0.12)});
          tl.fromTo("#end-link", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" }, ${L(W("b8", "happens.") + 0.35)});
          tl.fromTo("#end-credit", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" }, ${L(W("b8", "happens.") + 0.55)});
          window.__timelines["end"] = tl;
        })();
      </script>`);
}

// ------------------------------------------------------------------ subtitles track
files.captions = scene("captions", `      <style>
        ${FONT_FACE}
        #root { position: absolute; inset: 0; }
        .cap { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center; padding: 0 192px 108px; } /* inside the 80% title-safe box */
        .cap-text { display: block; max-width: 1536px; padding: 14px 34px 18px; border-radius: 16px; background: rgba(11, 11, 11, 0.94); color: ${PAPER}; font-family: ${FONT}; font-size: 46px; font-weight: 600; line-height: 1.22; text-align: center; box-shadow: 0 10px 30px rgba(11, 11, 11, 0.3); }
      </style>
      <div id="root" data-composition-id="captions" data-width="1920" data-height="1080">
${cues.map((c, i) => `        <div id="cap-${i + 1}" class="clip cap" data-start="${c.start}" data-duration="${r3(c.end - c.start)}" data-track-index="0"><p id="cap-${i + 1}-text" class="cap-text">${esc(c.text)}</p></div>`).join("\n")}
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
${cues.map((c, i) => `          tl.fromTo("#cap-${i + 1}-text", { opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none" }, ${c.start});
          tl.fromTo("#cap-${i + 1}-text", { opacity: 1 }, { opacity: 0, duration: 0.1, ease: "none", immediateRender: false }, ${r3(c.end - 0.1)});`).join("\n")}
          window.__timelines["captions"] = tl;
        })();
      </script>`);

// ------------------------------------------------------------------ narration track: one file, each beat at its start time
mkdirSync(join(HF, "assets", "voice"), { recursive: true });
{
  const inputs = beats.flatMap((b) => ["-i", join(HF, b.file)]);
  const delays = beats.map((b, i) => `[${i}:a]aresample=48000,adelay=${Math.round(b.voiceStart * 1000)}:all=1[a${i}]`).join(";");
  // +6 dB brings the voice to about -16 LUFS; the limiter keeps peaks under -1.5 dBFS.
  const mix = `${beats.map((_, i) => `[a${i}]`).join("")}amix=inputs=${beats.length}:normalize=0:dropout_transition=0,apad=whole_dur=${TOTAL},volume=6dB,alimiter=limit=0.84:attack=5:release=60:level=0,aformat=channel_layouts=stereo[out]`;
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", `${delays};${mix}`, "-map", "[out]", "-t", String(TOTAL), "-ar", "48000", "-c:a", "pcm_s16le", join(HF, "assets", "voice", "narration.wav")], { stdio: "inherit" });
}

// ------------------------------------------------------------------ root composition
const host = (id, track, z, kind = "graphics") => `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${win[id]?.[0] ?? 0}" data-duration="${win[id] ? dur(id) : TOTAL}" data-track-index="${track}" data-track-kind="${kind}" data-width="1920" data-height="1080" style="z-index: ${z}"></div>`;
const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>${NAME} demo</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: ${NAVY}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${NAVY}; }
    </style>
  </head>
  <body>
    <!-- Generated by demo/src/compose.mjs. Edit that file (or narration.json) and run it again. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">
${["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => host(id, 1, 1)).join("\n")}
${host("title", 2, 5)}
${host("facts", 3, 6)}
${host("end", 4, 7)}
${host("captions", 5, 20, "captions")}
      <audio id="narration" src="assets/voice/narration.wav" data-start="0" data-duration="${TOTAL}" data-track-index="6" data-volume="1"></audio>
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
mkdirSync(join(HF, "compositions"), { recursive: true });
writeFileSync(join(HF, "index.html"), index);
for (const [id, html] of Object.entries(files)) writeFileSync(join(HF, "compositions", `${id}.html`), html);
writeFileSync(join(HF, "timing.json"), JSON.stringify({ total: TOTAL, scenes: win, beats: beats.map((b) => ({ id: b.id, voiceStart: r3(b.voiceStart), voiceEnd: r3(b.voiceStart + b.duration) })), cues, cameras: CAM }, null, 1));

console.log(`word edges moved onto the sound: ${snapped} (largest ${r3(snapMax)} s)`);
console.log(`total ${TOTAL}s · ${cues.length} subtitle lines · scenes: ${Object.entries(win).map(([k, v]) => `${k} ${v[0]}-${v[1]}`).join(", ")}`);
