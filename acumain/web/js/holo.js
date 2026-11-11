// A hologram of the aircraft and its nose landing gear actuator, for one record.
//
// The aircraft is a Boeing 787-8 drawn to its published dimensions (56.7 m long, 60.1 m span, 16.9 m tall, a 5.8 m
// fuselage, raked wing tips, serrated engine nacelles), built here from curves; nothing is downloaded. The nose
// landing gear is modelled in more detail and swings on its retraction actuator.
//
// What moves is driven by the record's own result, so every aircraft looks different:
//   - the actuator and its target ring take the colour of the risk level;
//   - the gear swings as slowly as the actuation time says, next to a ghost that swings at the speed of a new actuator;
//   - hydraulic fluid drips from the actuator's seal as fast as the leakage level says, and rings spread where it lands;
//   - a missing reading is shown as missing.
// It is an illustration of the readings, not a scan of the aircraft, and the page says so under the picture.
import { esc, fmtRisk } from "./ui.js";

const TAU = Math.PI * 2;
const CYAN = [104, 226, 255], ICE = [196, 246, 255], DEEP = [44, 122, 232], WHITE = [232, 251, 255], RED = [255, 88, 66], AMBER = [255, 188, 72], GREY = [132, 154, 166], GREEN = [96, 255, 170];
const LEVEL_COLOR = { High: RED, Medium: AMBER, Low: CYAN, "Not scored": GREY };
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
const blend = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round);
const GROUND = -5.1, R = 2.9;

// ---------------------------------------------------------------- small geometry helpers. Metres: x to the nose, y up, z to the right
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (stops, z) => {                                   // a value read off a list of [position, value] pairs
  for (let i = 1; i < stops.length; i++) if (z <= stops[i][0]) { const [a, va] = stops[i - 1], [b, vb] = stops[i]; return va + (vb - va) * (z - a) / (b - a); }
  return stops[stops.length - 1][1];
};
const ringX = (x, cy, cz, r, n = 24) => Array.from({ length: n + 1 }, (_, i) => [x, cy + r * Math.cos(i / n * TAU), cz + r * Math.sin(i / n * TAU)]);
const ringZ = (x, y, z, r, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x + r * Math.cos(i / n * TAU), y + r * Math.sin(i / n * TAU), z]);
const ringY = (x, y, z, r, n = 14) => Array.from({ length: n + 1 }, (_, i) => [x + r * Math.cos(i / n * TAU), y, z + r * Math.sin(i / n * TAU)]);
// A cylinder between two points: rings and a few lines along it.
function tube(a, b, r, rings = 2, lines = 6) {
  const u = unit(sub(b, a)), v = unit(cross(u, Math.abs(u[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1])), w = cross(u, v);
  const at = (t, k) => { const c = mix(a, b, t), q = k * TAU; return [c[0] + r * (Math.cos(q) * v[0] + Math.sin(q) * w[0]), c[1] + r * (Math.cos(q) * v[1] + Math.sin(q) * w[1]), c[2] + r * (Math.cos(q) * v[2] + Math.sin(q) * w[2])]; };
  const out = [];
  for (let i = 0; i < rings; i++) { const t = rings === 1 ? 0.5 : i / (rings - 1); out.push(Array.from({ length: 13 }, (_, k) => at(t, k / 12))); }
  for (let k = 0; k < lines; k++) out.push([at(0, k / lines), at(1, k / lines)]);
  return out;
}

// ---------------------------------------------------------------- the airframe
function fuselage(x) {                                         // [height of the centre line, radius] at station x
  if (x > 22) { const t = (29 - x) / 7; return [-0.42 * (1 - t) ** 1.6, R * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2.3))]; }
  if (x < -10) { const t = (-10 - x) / 17.7; return [1.9 * t ** 1.5, R * (1 - 0.9 * t ** 1.2)]; }
  return [0, R];
}
const WING = { le: (z) => (z < 26 ? 9.2 - 0.675 * (z - 2.9) : 9.2 - 0.675 * 23.1 - 1.6 * (z - 26)), chord: (z) => lerp([[2.9, 11.5], [9.5, 6.9], [26, 2.4], [30.05, 0.5]], z),
  y: (z) => -1.55 + (z - 2.9) * 0.105 + 2.2 * ((z - 2.9) / 27.15) ** 2.4 };
const ENGINE = { x: 9.5, y: -2.75, z: 9.75 };
const NAV = [[WING.le(30.05) - 0.2, WING.y(30.05), -30.05, RED], [WING.le(30.05) - 0.2, WING.y(30.05), 30.05, GREEN]];        // red to port, green to starboard
// The outline of a wing section: an eye shape from the leading edge to the trailing edge and back.
function section(le, chord, y, z, thick) {
  const pts = [];
  for (let i = 0; i <= 8; i++) { const u = i / 8; pts.push([le - chord * u, y + thick * 3.1 * Math.sqrt(u) * (1 - u), z]); }
  for (let i = 7; i >= 0; i--) { const u = i / 8; pts.push([le - chord * u, y - thick * 1.5 * Math.sqrt(u) * (1 - u), z]); }
  return pts;
}

function buildAirframe(dense) {
  const body = [], gear = [], skin = [], marks = [];           // lines of the airframe, of the main gear, faces lit faintly, and windows and doors
  // A window or a door: a small outline on the skin. It is drawn only while it faces the viewer, which is what
  // makes the fuselage read as a solid body and not as a cage.
  const mark = (pts, kind) => {
    const mid = pts.reduce((sum, q) => [sum[0] + q[0] / pts.length, sum[1] + q[1] / pts.length, sum[2] + q[2] / pts.length], [0, 0, 0]);
    marks.push(Object.assign([...pts, pts[0]], { mid, axis: [mid[0], fuselage(mid[0])[0], 0], kind, at: mid[0] }));
  };
  const onSkin = (x, y, side) => { const [cy, r] = fuselage(x); return [x, y, side * Math.sqrt(Math.max(0.05, r * r - (y - cy) ** 2))]; };
  const step = dense ? 1 : 2, stringers = dense ? 24 : 12;
  for (let x = 28.7; x >= -27.3; x -= step) { const [cy, r] = fuselage(x); const ring = ringX(x, cy, 0, r, dense ? 24 : 18); body.push(ring); skin.push(ring); }
  for (let k = 0; k < stringers; k++) {
    const a = k / stringers * TAU, line = [];
    for (let x = 29; x >= -27.7; x -= 1) { const [cy, r] = fuselage(x); line.push([x, cy + r * Math.cos(a), r * Math.sin(a)]); }
    body.push(line);
  }
  for (const side of [1, -1]) {
    // flight deck windows: three panes a side
    mark([[27.35, 0.95, side * 1.0], [26.3, 1.55, side * 1.62], [25.75, 1.4, side * 1.95], [26.75, 0.72, side * 1.42]], "glass");
    mark([[25.62, 1.38, side * 2.03], [24.9, 1.4, side * 2.36], [24.95, 0.78, side * 2.6], [25.75, 0.66, side * 2.2]], "glass");
    mark([[24.78, 1.38, side * 2.42], [24.2, 1.3, side * 2.58], [24.28, 0.82, side * 2.74], [24.84, 0.8, side * 2.63]], "glass");
    // cabin windows, in a row, leaving room for the doors
    const doors = [22.9, 12.5, -6.5, -17.2];
    for (let x = 21.0; x > -15.6; x -= dense ? 0.62 : 1.05) {
      if (doors.some((door) => x < door + 0.35 && x > door - 1.45)) continue;
      mark([onSkin(x, 0.48, side), onSkin(x - 0.3, 0.48, side), onSkin(x - 0.3, 1.0, side), onSkin(x, 1.0, side)], "glass");
    }
    // passenger doors, each with its small window, and on the right side the two cargo doors
    for (const x of doors) {
      const cy = fuselage(x)[0];
      mark([onSkin(x, cy - 0.9, side), onSkin(x - 1.07, cy - 0.9, side), onSkin(x - 1.07, cy + 0.2, side), onSkin(x - 1.07, cy + 1.05, side), onSkin(x, cy + 1.05, side), onSkin(x, cy + 0.2, side)], "door");
      mark([onSkin(x - 0.4, cy + 0.5, side), onSkin(x - 0.67, cy + 0.5, side), onSkin(x - 0.67, cy + 0.82, side), onSkin(x - 0.4, cy + 0.82, side)], "glass");
    }
    if (side === 1) for (const x of [18.5, -9.5]) mark([onSkin(x, -2.3, side), onSkin(x - 2.6, -2.3, side), onSkin(x - 2.6, -1.6, side), onSkin(x - 2.6, -0.75, side), onSkin(x, -0.75, side), onSkin(x, -1.6, side)], "door");
    // wing: sections every 1.4 m, the edges, and the lines of the spars and the flap hinge
    const stations = [];
    for (let z = 2.9; z < 30.05; z += dense ? 1.4 : 2.8) stations.push(z);
    stations.push(30.05);
    for (const z of stations) body.push(section(WING.le(z), WING.chord(z), WING.y(z), side * z, WING.chord(z) * 0.11));
    for (const u of [0, 0.16, 0.42, 0.7, 1]) body.push(stations.map((z) => [WING.le(z) - WING.chord(z) * u, WING.y(z) + WING.chord(z) * 0.11 * 3.1 * Math.sqrt(u) * (1 - u), side * z]));
    skin.push([...stations.map((z) => [WING.le(z), WING.y(z), side * z]), ...stations.slice().reverse().map((z) => [WING.le(z) - WING.chord(z), WING.y(z), side * z])]);
    // wing-to-body fairing
    body.push([[11.5, -2.2, side * 2.2], [9, -2.7, side * 3.3], [2, -3.2, side * 3.5], [-4.5, -2.9, side * 3.2], [-8, -2.3, side * 2.2]]);
    // engine: nacelle with its serrated trailing edge, core nozzle and pylon (the fan is drawn turning, each frame)
    const ez = side * ENGINE.z, ey = ENGINE.y, shape = [[10.2, 1.62], [9.6, 1.8], [8.6, 1.86], [7.4, 1.84], [6.2, 1.75], [5.2, 1.64]];
    for (const [x, r] of shape) { const ring = ringX(x, ey, ez, r, dense ? 22 : 16); body.push(ring); skin.push(ring); }
    body.push(Array.from({ length: 37 }, (_, i) => [i % 2 ? 4.55 : 5.2, ey + 1.62 * Math.cos(i / 36 * TAU), ez + 1.62 * Math.sin(i / 36 * TAU)]));
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; body.push(shape.map(([x, r]) => [x, ey + r * Math.cos(a), ez + r * Math.sin(a)])); }
    body.push(ringX(ENGINE.x, ey, ez, 0.42, 12), [[ENGINE.x, ey + 0.42, ez], [10.0, ey, ez], [ENGINE.x, ey - 0.42, ez]], ringX(4.9, ey, ez, 0.95, 14), ringX(3.5, ey, ez, 0.62, 12), [[3.5, ey + 0.62, ez], [2.7, ey, ez], [3.5, ey - 0.62, ez]]);
    body.push([[8.9, ey + 1.86, ez], [5.4, WING.y(9.75) - 0.2, ez], [3.6, WING.y(9.75) - 0.25, ez], [5.0, ey + 1.6, ez]]);
    // tailplane
    const tz = [0.9, 2.7, 4.5, 6.3, 8.1, 9.9], tle = (z) => -20.2 - 0.73 * (z - 0.9), tch = (z) => 5.6 - 3.9 * (z - 0.9) / 9, ty = (z) => 1.45 + 0.12 * z;
    for (const z of tz) body.push(section(tle(z), tch(z), ty(z), side * z, tch(z) * 0.09));
    for (const u of [0, 0.68, 1]) body.push(tz.map((z) => [tle(z) - tch(z) * u, ty(z), side * z]));
    skin.push([...tz.map((z) => [tle(z), ty(z), side * z]), ...tz.slice().reverse().map((z) => [tle(z) - tch(z), ty(z), side * z])]);
    // main landing gear: strut, side brace and a four-wheel bogie
    const gz = side * 4.9;
    gear.push(...tube([0.8, -1.6, gz], [0.8, -4.47, gz], 0.2, 3, 6), [[0.8, -3.0, gz], [0.8, -1.7, side * 3.2]], [[-0.05, -4.47, gz], [1.65, -4.47, gz]]);
    for (const x of [0.1, 1.5]) for (const z of [-0.62, -0.3, 0.3, 0.62]) gear.push(ringZ(x, -4.47, gz + z, 0.63, 16));
  }
  // fin and rudder
  const fin = (h) => [mix([-16.3, 2.75, 0], [-25.3, 11.8, 0], h), mix([-25.6, 2.2, 0], [-27.9, 11.8, 0], h)];
  body.push([fin(0)[0], fin(1)[0], fin(1)[1], fin(0)[1]], [mix(...fin(0), 0.68), mix(...fin(1), 0.68)]);
  for (const h of [0.17, 0.34, 0.5, 0.67, 0.84]) body.push(fin(h));
  skin.push([fin(0)[0], fin(1)[0], fin(1)[1], fin(0)[1]]);
  for (const line of body) line.at = line.reduce((sum, p) => sum + p[0], 0) / line.length;       // where along the aircraft a line sits, for the build-up scan
  for (const face of skin) face.at = face.reduce((sum, p) => sum + p[0], 0) / face.length;
  return { body, gear, skin, marks };
}

// ---------------------------------------------------------------- the nose landing gear. It turns about its pivot; the actuator follows.
const PIVOT = [23.6, -2.75, 0], AXLE = [23.42, -4.6, 0], KNEE = [23.52, -3.85, 0], LUG = [23.3, -3.35, 0.2], BRACE_LOW = [23.56, -3.7, 0];
const ACT_FIX = [21.95, -2.72, 0.2], BRACE_FIX = [25.0, -2.8, 0], BODY_LEN = 1.0, SWING = 0.6;
function buildNoseGear() {
  const moving = [];
  moving.push(...tube(PIVOT, KNEE, 0.14, 3, 8), ...tube(KNEE, AXLE, 0.085, 2, 6), ringY(KNEE[0], KNEE[1] + 0.12, 0, 0.2), [[AXLE[0], AXLE[1], -0.56], [AXLE[0], AXLE[1], 0.56]]);
  for (const side of [1, -1]) {
    for (const z of [0.26, 0.5]) moving.push(ringZ(AXLE[0], AXLE[1], side * z, 0.5, 22), ringZ(AXLE[0], AXLE[1], side * z, 0.4, 18));
    moving.push(ringZ(AXLE[0], AXLE[1], side * 0.38, 0.22, 12));
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; moving.push([[AXLE[0] + 0.5 * Math.cos(a), AXLE[1] + 0.5 * Math.sin(a), side * 0.26], [AXLE[0] + 0.5 * Math.cos(a), AXLE[1] + 0.5 * Math.sin(a), side * 0.5]]); }
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; moving.push([[AXLE[0] + 0.22 * Math.cos(a), AXLE[1] + 0.22 * Math.sin(a), side * 0.38], [AXLE[0] + 0.4 * Math.cos(a), AXLE[1] + 0.4 * Math.sin(a), side * 0.38]]); }
    moving.push([[23.62, -3.9, side * 0.06], [23.95, -4.25, side * 0.06], [23.5, -4.55, side * 0.06]]);                       // torque links
    moving.push(ringX(23.74, -3.3, side * 0.22, 0.09, 10));                                                                   // taxi lights
  }
  moving.push([[LUG[0], LUG[1], 0.06], [LUG[0], LUG[1], 0.3]], ringZ(LUG[0], LUG[1], LUG[2], 0.07, 8));
  // what stays with the fuselage: the wheel well and its doors
  const fixed = [[[22.0, -2.9, -0.72], [25.4, -2.9, -0.72], [25.4, -2.9, 0.72], [22.0, -2.9, 0.72], [22.0, -2.9, -0.72]]];
  for (const side of [1, -1]) {
    fixed.push([[23.95, -2.9, side * 0.74], [25.4, -2.9, side * 0.74], [25.4, -3.72, side * 0.98], [23.95, -3.72, side * 0.98], [23.95, -2.9, side * 0.74]]);
    fixed.push([[22.0, -2.9, side * 0.74], [23.3, -2.9, side * 0.74], [23.3, -3.5, side * 0.92], [22.0, -3.5, side * 0.92], [22.0, -2.9, side * 0.74]]);
  }
  fixed.push(ringZ(ACT_FIX[0], ACT_FIX[1], ACT_FIX[2], 0.1, 8), [[ACT_FIX[0], ACT_FIX[1], 0.05], [ACT_FIX[0], ACT_FIX[1] + 0.22, 0.05], [ACT_FIX[0], ACT_FIX[1] + 0.22, 0.35], [ACT_FIX[0], ACT_FIX[1], 0.35]]);
  return { moving, fixed };
}
// Turn a point of the gear about the pivot by an angle: positive swings the wheels forward and up, into the well.
const turn = (p, a) => { const x = p[0] - PIVOT[0], y = p[1] - PIVOT[1], c = Math.cos(a), s = Math.sin(a); return [PIVOT[0] + x * c - y * s, PIVOT[1] + x * s + y * c, p[2]]; };
// The actuator and the folding brace for a given gear angle.
function linkage(angle) {
  const lug = turn(LUG, angle), dir = unit(sub(lug, ACT_FIX)), seal = [ACT_FIX[0] + dir[0] * BODY_LEN, ACT_FIX[1] + dir[1] * BODY_LEN, ACT_FIX[2] + dir[2] * BODY_LEN];
  const low = turn(BRACE_LOW, angle), half = Math.hypot(low[0] - BRACE_FIX[0], low[1] - BRACE_FIX[1]) / 2, link = 0.95, rise = Math.sqrt(Math.max(0, link * link - half * half));
  const along = unit([low[0] - BRACE_FIX[0], low[1] - BRACE_FIX[1], 0]), midway = mix(BRACE_FIX, low, 0.5), knee = [midway[0] - along[1] * rise, midway[1] + Math.abs(along[0]) * rise, 0];
  const port = (t) => { const p = mix(ACT_FIX, seal, t); return [[p[0], p[1] + 0.11, p[2]], [p[0] - 0.05, p[1] + 0.3, p[2]], [p[0] - 0.3, -2.62, p[2] + 0.1]]; };
  return { lug, seal,
    cylinder: [...tube(ACT_FIX, seal, 0.11, 5, 8), ...tube(mix(ACT_FIX, seal, 0.93), seal, 0.14, 2, 8)],
    rod: [...tube(seal, lug, 0.05, 2, 4), ringZ(lug[0], lug[1], lug[2], 0.1, 10)],
    hoses: [port(0.22), port(0.8)],
    brace: [-0.2, 0.2].flatMap((z) => [[[BRACE_FIX[0], BRACE_FIX[1], z], [knee[0], knee[1], z], [low[0], low[1], z]]]).concat([[[knee[0], knee[1], -0.2], [knee[0], knee[1], 0.2]]]) };
}

const MODEL = {};
function model(dense) {
  const key = dense ? "dense" : "light";
  if (!MODEL[key]) {
    const grid = [];
    for (let i = -60; i <= 60; i += 5) { grid.push([[i, GROUND, -55], [i, GROUND, 55]]); if (Math.abs(i) <= 55) grid.push([[-60, GROUND, i], [60, GROUND, i]]); }
    const ticks = Array.from({ length: 72 }, (_, i) => { const a = i / 72 * TAU, r1 = 36, r2 = i % 6 ? 37.2 : 39; return [[1 + r1 * Math.cos(a), GROUND + 0.02, r1 * Math.sin(a)], [1 + r2 * Math.cos(a), GROUND + 0.02, r2 * Math.sin(a)]]; });
    MODEL[key] = { ...buildAirframe(dense), ...buildNoseGear(), grid, base: [[12, 24, 36].map((r) => ringY(1, GROUND + 0.02, 0, r, 64)), ticks].flat() };
  }
  return MODEL[key];
}

// ---------------------------------------------------------------- what the record says, as the picture needs it
function reading(d) {
  const op = d.readings?.operation, leak = d.readings?.leakage;
  const level = d.scorable === false ? "Not scored" : d.level || "Not scored";
  const slower = /(\d+)% slower/.exec(op?.text || "");
  const opLevel = op?.level ?? null;
  return {
    level, color: LEVEL_COLOR[level] || GREY, risk: d.risk, aircraft: String(d.aircraft_id || ""), time: d.time_left || "",
    op: opLevel, opName: op?.level_name || null, opText: op?.text || "",
    slow: opLevel == null ? 1 : slower ? 1 + Number(slower[1]) / 100 : [1, 1.25, 1.6, 2.1][opLevel] || 1,       // how much longer one swing takes than on a new actuator
    leak: leak?.level ?? null, leakName: leak?.level_name || null, leakText: leak?.text || "",
  };
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// ---------------------------------------------------------------- the frame around the picture
export function holoHtml(d, big = false) {
  const r = reading(d);
  const said = r.level === "Not scored" ? "no prediction, because the key readings are missing"
    : `${fmtRisk(r.risk)} risk, operation time ${r.opName ? r.opName.toLowerCase() : "not recorded"}, leakage ${r.leakName ? r.leakName.toLowerCase() : "not recorded"}`;
  return `<div class="holo ${big ? "holo-big" : ""}" data-holo>
    <canvas role="img" aria-label="Hologram of aircraft ${esc(r.aircraft)}, a Boeing 787, and its nose landing gear actuator: ${esc(said)}."></canvas>
    <div class="holo-bar">
      <button type="button" data-holo-view="whole" aria-pressed="false">Aircraft</button>
      <button type="button" data-holo-view="detail" aria-pressed="true">Actuator</button>
      ${big ? "" : '<button type="button" data-r="holo-big" aria-label="Open the hologram larger">Enlarge</button>'}
    </div>
  </div>
  <p class="fine holo-fine">An illustration drawn from this record's readings on a Boeing 787-8 outline, not a scan of the aircraft. Drag to turn it, scroll to zoom.</p>`;
}

// ---------------------------------------------------------------- drawing
export function mountHolo(root, d, { tour = true } = {}) {
  const canvas = root?.querySelector("canvas");
  if (!canvas) return null;
  const r = reading(d), main = canvas.getContext("2d");
  const light = document.createElement("canvas"), lightCtx = light.getContext("2d");          // everything that glows is drawn here first
  const soft = document.createElement("canvas"), softCtx = soft.getContext("2d");             // a small copy of it, blurred, is the glow
  let g = main;
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches && !new URLSearchParams(location.search).has("motion");
  const missing = r.level === "Not scored";
  const VIEW = {
    whole: { target: [1.5, 0.4, 0], dist: 96, pitch: 0.26, yaw: 0.92 },
    detail: { target: [22.9, -3.6, 0.1], dist: 6.4, pitch: 0.1, yaw: -0.5 },
  };
  const S = { gone: false, view: tour && !calm ? "whole" : "detail", from: null, t: 1, since: 0, born: performance.now(), spin: 0, drag: null, zoom: 1, dy: 0, dp: 0, last: 0, clock: 0, cam: null,
    drops: [], rings: [], nextDrop: 300, touched: false, motes: Array.from({ length: 26 }, () => [Math.random(), Math.random(), 0.4 + Math.random() * 0.6]) };
  S.cam = { ...VIEW[S.view], target: VIEW[S.view].target.slice() };
  const mark = () => { for (const b of root.querySelectorAll("[data-holo-view]")) b.setAttribute("aria-pressed", String(b.dataset.holoView === S.view)); };
  const setView = (name) => {
    if (S.view === name) return;
    S.from = { target: S.cam.target.slice(), dist: S.cam.dist * S.zoom, yaw: S.cam.yaw + S.spin + S.dy, pitch: S.cam.pitch + S.dp };
    Object.assign(S, { view: name, t: 0, since: performance.now(), spin: 0, dy: 0, dp: 0, zoom: 1 });
    mark();
  };
  mark();
  // The picture opens on the whole aircraft, to show where the actuator sits, then moves in on it.
  const timer = S.view === "whole" ? setTimeout(() => { if (!S.gone && !S.touched) setView("detail"); }, 3600) : null;

  root.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-holo-view]");
    if (b) { S.touched = true; setView(b.dataset.holoView); }
  });
  canvas.addEventListener("pointerdown", (ev) => { S.drag = [ev.clientX, ev.clientY]; S.touched = true; canvas.setPointerCapture?.(ev.pointerId); canvas.classList.add("is-dragging"); });
  canvas.addEventListener("pointermove", (ev) => {
    if (!S.drag) return;
    S.dy += (ev.clientX - S.drag[0]) * 0.008;
    S.dp = Math.max(-0.45, Math.min(1.0, S.dp + (ev.clientY - S.drag[1]) * 0.006));
    S.drag = [ev.clientX, ev.clientY];
  });
  const release = () => { S.drag = null; canvas.classList.remove("is-dragging"); };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (ev) => { ev.preventDefault(); S.touched = true; S.zoom = Math.max(0.4, Math.min(2.6, S.zoom * (ev.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });

  let W = 0, H = 0, cam = null, focal = 0, reveal = null;
  const project = (p) => {
    const x = p[0] - cam.target[0], y = p[1] - cam.target[1], z = p[2] - cam.target[2];
    const x1 = x * cam.cy + z * cam.sy, z1 = -x * cam.sy + z * cam.cy;
    const y1 = y * cam.cp - z1 * cam.sp, depth = y * cam.sp + z1 * cam.cp + cam.dist;
    if (depth < 0.6) return null;
    const s = focal / depth;
    return [W / 2 + x1 * s, H * 0.5 - y1 * s, depth];
  };
  // Lines are drawn in three passes by distance: the near side brighter and whiter, the far side dimmer and bluer.
  function strokeAll(lines, color, alpha, width, dash, useReveal = false) {
    if (alpha <= 0.01) return;
    const near = cam.dist * 0.88, far = cam.dist * 1.14, buckets = [[], [], []];
    for (const line of lines) {
      if (useReveal && reveal != null && line.at < reveal) continue;
      const pts = [];
      let depth = 0, ok = true;
      for (const p of line) { const q = project(p); if (!q) { ok = false; break; } pts.push(q); depth += q[2]; }
      if (ok && pts.length > 1) buckets[depth / pts.length < near ? 0 : depth / pts.length < far ? 1 : 2].push(pts);
    }
    const tint = color === CYAN;
    g.setLineDash(dash || []);
    buckets.forEach((set, i) => {
      if (!set.length) return;
      g.beginPath();
      for (const pts of set) { g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]); }
      g.lineWidth = width * [1.15, 1, 0.85][i];
      g.strokeStyle = rgba(tint ? [blend(CYAN, ICE, 0.5), CYAN, blend(CYAN, DEEP, 0.6)][i] : color, alpha * [1, 0.6, 0.26][i]);
      g.stroke();
    });
    g.setLineDash([]);
  }
  // Faces lit very faintly. Where many overlap, the aircraft looks like a body of light instead of bare wire.
  function fillAll(faces, color, alpha, useReveal = false) {
    if (alpha <= 0.002) return;
    g.fillStyle = rgba(color, alpha);
    for (const face of faces) {
      if (useReveal && reveal != null && face.at < reveal) continue;
      const pts = face.map(project);
      if (pts.some((p) => !p)) continue;
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]); g.closePath(); g.fill();
    }
  }
  // Windows and doors, each drawn only while it is on the side of the fuselage that faces the viewer.
  function marksAll(list, alpha) {
    if (alpha <= 0.02) return;
    const glass = [], door = [];
    for (const m of list) {
      if (reveal != null && m.at < reveal) continue;
      const mid = project(m.mid), axis = project(m.axis);
      if (!mid || !axis || mid[2] >= axis[2] - 0.15) continue;
      const pts = m.map(project);
      if (pts.every(Boolean)) (m.kind === "door" ? door : glass).push(pts);
    }
    const path = (set) => { g.beginPath(); for (const pts of set) { g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]); } };
    if (glass.length) { path(glass); g.fillStyle = rgba(ICE, alpha * 0.32); g.fill(); g.lineWidth = 0.8; g.strokeStyle = rgba(ICE, alpha * 0.9); g.stroke(); }
    if (door.length) { path(door); g.lineWidth = 1.3; g.strokeStyle = rgba(WHITE, alpha * 0.85); g.stroke(); }
  }
  const glowDot = (p, radius, color, alpha) => {
    if (!p || alpha <= 0.01) return;
    const halo = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], radius);
    halo.addColorStop(0, rgba(WHITE, alpha)); halo.addColorStop(0.25, rgba(color, alpha * 0.85)); halo.addColorStop(1, rgba(color, 0));
    g.fillStyle = halo; g.beginPath(); g.arc(p[0], p[1], radius, 0, TAU); g.fill();
  };
  function wrap(text, max) {
    const out = [];
    let line = "";
    for (const word of String(text || "").split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > max && line) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out.slice(0, 3);
  }
  // A label in a fixed place on the picture, with a leader line to the part it names.
  function label(anchor, fx, fy, title, text, color, right = false) {
    const p = project(anchor);
    if (!p) return;
    const size = Math.max(9.5, Math.min(14.5, W / 46)), pad = size * 0.8;
    g.font = `700 ${size}px "Cascadia Mono", "Cascadia Code", ui-monospace, Consolas, monospace`;
    const lines = [title, ...wrap(text, W * (W < 560 ? 0.42 : 0.3))];
    const wide = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2.2, high = lines.length * size * 1.48 + pad * 1.3;
    const x = right ? Math.max(8, Math.min(W - wide - 8, W * fx - wide)) : Math.max(8, Math.min(W - wide - 8, W * fx)), y = Math.max(8, Math.min(H - high - 40, H * fy));
    const fromX = right ? x : x + wide, baseY = y + high;
    g.lineWidth = 1; g.strokeStyle = rgba(color, 0.85);
    g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(fromX + (right ? -18 : 18), baseY); g.lineTo(right ? x + wide : x, baseY); g.stroke();
    g.beginPath(); g.arc(p[0], p[1], 3, 0, TAU); g.fillStyle = rgba(color, 1); g.fill();
    const glass = g.createLinearGradient(0, y, 0, y + high);
    glass.addColorStop(0, "rgba(6,22,32,0.86)"); glass.addColorStop(1, "rgba(3,12,18,0.72)");
    g.fillStyle = glass; g.fillRect(x, y, wide, high);
    g.fillStyle = rgba(color, 0.95); g.fillRect(right ? x + wide - 3 : x, y, 3, high);                 // a bar of the label's colour on its outer edge
    g.textBaseline = "top"; g.textAlign = "left";
    lines.forEach((l, i) => { g.fillStyle = i === 0 ? rgba(color, 1) : rgba(WHITE, 0.86); g.fillText(l, x + pad + (right ? 0 : 4), y + pad * 0.75 + i * size * 1.48); });
  }
  // A target ring around a point: two broken circles turning against each other, and four ticks.
  function reticle(p, radius, color, alpha) {
    if (!p || alpha <= 0.01) return;
    const spin = calm ? 0.4 : S.clock / 900;
    g.strokeStyle = rgba(color, alpha); g.lineWidth = 1.6;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(p[0], p[1], radius, spin + i * TAU / 3, spin + i * TAU / 3 + 1.25); g.stroke(); }
    g.lineWidth = 1; g.setLineDash([2, 5]);
    g.beginPath(); g.arc(p[0], p[1], radius * 1.32, -spin * 0.6, -spin * 0.6 + TAU); g.stroke();
    g.setLineDash([]);
    for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + TAU / 8; g.beginPath(); g.moveTo(p[0] + Math.cos(a) * radius * 1.5, p[1] + Math.sin(a) * radius * 1.5); g.lineTo(p[0] + Math.cos(a) * radius * 1.72, p[1] + Math.sin(a) * radius * 1.72); g.stroke(); }
  }

  const ease = (t) => t * t * (3 - 2 * t);
  const DRIP_EVERY = [0, 1500, 460, 130];                      // by leakage level: a drop every so many milliseconds
  const BASE = 2300;                                           // one swing of a new actuator, in the picture's own time
  const BUILD = 1500;                                          // how long the aircraft takes to appear, nose first
  function draw() {
    const now = performance.now();                                      // one clock for everything, whoever asked for this frame
    const dt = Math.max(0, Math.min(120, now - (S.last || now)));
    S.last = now; S.clock = now - S.born;                               // by the clock, so a slow tab shows the right moment
    const dpr = Math.min(2, window.devicePixelRatio || 1), wide = canvas.clientWidth || 440, high = canvas.clientHeight || 300;
    if (canvas.width !== Math.round(wide * dpr) || canvas.height !== Math.round(high * dpr)) {
      canvas.width = light.width = Math.round(wide * dpr); canvas.height = light.height = Math.round(high * dpr);
      soft.width = Math.max(1, Math.round(wide / 2)); soft.height = Math.max(1, Math.round(high / 2));
    }
    W = wide; H = high; focal = H * 1.55;
    const big = W >= 620, M = model(big);

    // the camera: on its way from one view to the other, plus whatever the viewer turned or zoomed
    const to = VIEW[S.view];
    if (S.t < 1) S.t = Math.max(0, Math.min(1, (now - S.since) / 1800));
    const k = S.from ? ease(S.t) : 1, a = S.from || to;
    S.cam = { target: mix(a.target, to.target, k), dist: a.dist + (to.dist - a.dist) * k, pitch: a.pitch + (to.pitch - a.pitch) * k, yaw: a.yaw + (to.yaw - a.yaw) * k };
    if (!calm && !S.drag && S.view === "whole") S.spin += dt * 0.00021;
    const sway = S.view === "detail" && !calm && !S.touched ? Math.sin(S.clock / 3000) * 0.32 * k : 0;
    const yaw = S.cam.yaw + S.spin + S.dy + sway, pitch = S.cam.pitch + S.dp + (calm ? 0 : Math.sin(S.clock / 2300) * 0.012);
    cam = { target: S.cam.target, dist: S.cam.dist * S.zoom, cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch) };
    const close = S.view === "detail" ? k : 1 - k;                      // 0 on the whole aircraft, 1 on the actuator
    const built = calm || !tour ? 1 : Math.min(1, S.clock / BUILD);     // the aircraft appears from the nose backwards
    reveal = built < 1 ? 29.5 - built * 58 : null;

    // the gear's swing: this actuator, and a new one for comparison. Shown only up close.
    const mine = BASE * r.slow, cycle = mine + 700 + 1500 + 900, at = S.clock % cycle;
    const swing = (span) => (at < span ? ease(at / span) : at < mine + 700 ? 1 : at < mine + 2200 ? 1 - ease((at - mine - 700) / 1500) : 0);
    const moving = close > 0.55 && !calm && r.op != null;
    const angle = moving ? swing(mine) * SWING : 0, ghost = moving && r.slow > 1.04 ? swing(BASE) * SWING : angle;
    const link = linkage(angle);
    const midAct = mix(ACT_FIX, link.lug, 0.5);

    // ---- everything that glows, on its own layer
    g = lightCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.lineJoin = "round"; g.lineCap = "round";
    g.globalCompositeOperation = "lighter";                             // overlapping light adds up
    strokeAll(M.grid, CYAN, 0.13 * (1 - close * 0.45), 1);
    strokeAll(M.base, CYAN, 0.34 * (1 - close), 1.1);
    fillAll(M.skin, CYAN, (big ? 0.011 : 0.018) * (1 - close * 0.7), true);
    strokeAll(M.body, CYAN, (big ? 0.34 : 0.4) * (1 - close * 0.8), big ? 0.75 : 0.85, null, true);
    marksAll(M.marks, 1 - close * 1.4);
    strokeAll(M.gear, CYAN, 0.72 * (1 - close * 0.5), 1, null, false);
    // the engine fans, turning
    if (close < 0.9 && built > 0.4) {
      const turnBy = calm ? 0 : S.clock / 260, fans = [];
      for (const side of [1, -1]) for (let i = 0; i < 16; i++) { const q = i / 16 * TAU + turnBy * side; fans.push([[ENGINE.x, ENGINE.y + 0.42 * Math.cos(q), side * ENGINE.z + 0.42 * Math.sin(q)], [ENGINE.x - 0.2, ENGINE.y + 1.56 * Math.cos(q + 0.32), side * ENGINE.z + 1.56 * Math.sin(q + 0.32)]]); }
      strokeAll(fans, ICE, 0.75 * (1 - close), 0.9);
    }
    // the scan that builds the aircraft, then keeps running down the fuselage
    if (close < 0.9 && !calm) {
      const x = built < 1 ? reveal : 29 - ((S.clock / 3600) % 1) * 57, [cy, rad] = fuselage(Math.max(-27.5, Math.min(28.9, x)));
      strokeAll([ringX(x, cy, 0, rad * 1.06 + 0.1, 30)], WHITE, (built < 1 ? 1 : 0.75) * (1 - close), built < 1 ? 2 : 1.4);
    }
    // navigation lights: red to port, green to starboard, a white strobe on the tail, a red beacon on top
    if (built >= 1 && close < 0.8) {
      const fade = 1 - close, flash = calm ? 0.6 : (S.clock % 1300 < 110 ? 1 : 0.12), beat = calm ? 0.7 : 0.55 + 0.45 * Math.sin(S.clock / 420);
      for (const [x, y, z, c] of NAV) glowDot(project([x, y, z]), big ? 13 : 8, c, 0.95 * fade);
      glowDot(project([-27.6, 2.1, 0]), big ? 16 : 10, WHITE, flash * fade);
      glowDot(project([4, R + 0.1, 0]), big ? 13 : 8, RED, beat * fade);
    }
    strokeAll(M.fixed, CYAN, 0.3 + close * 0.34, 1);
    if (ghost !== angle) strokeAll(M.moving.map((line) => line.map((p) => turn(p, ghost))), WHITE, 0.42 * close, 0.9, [3, 4]);
    const gearLines = angle ? M.moving.map((line) => line.map((p) => turn(p, angle))) : M.moving;
    strokeAll(gearLines, close > 0.5 ? ICE : CYAN, 0.6 + close * 0.3, 1 + close * 0.35);
    strokeAll(link.brace, close > 0.5 ? ICE : CYAN, 0.5 + close * 0.3, 1);
    // the actuator, in the colour of this aircraft's risk, with fluid moving through its hoses
    const actAlpha = built < 1 ? built : 1;
    strokeAll([...link.cylinder, ...link.hoses], r.color, actAlpha, 1.4 + close * 0.8, missing ? [4, 4] : null);
    strokeAll(link.rod, r.color, actAlpha, 1.25 + close * 0.65, missing ? [4, 4] : null);
    if (close > 0.5 && !missing && !calm) for (const hose of link.hoses) { const u = (S.clock / 900) % 1; glowDot(project(u < 0.5 ? mix(hose[2], hose[1], u * 2) : mix(hose[1], hose[0], u * 2 - 1)), 5, WHITE, 0.8 * close); }
    glowDot(project(midAct), (big ? 30 : 20) * (1 - close * 0.4), r.color, (0.55 + (calm ? 0 : 0.25 * Math.sin(S.clock / 300))) * actAlpha * (missing ? 0.4 : 1));
    if (close > 0.3 && r.leak) {
      // leakage: fluid dripping from the rod seal, faster the higher the level; rings spread where each drop lands
      const c = r.leak >= 3 ? RED : AMBER;
      S.nextDrop -= dt;
      if (S.nextDrop <= 0 && !calm) { S.drops.push({ x: link.seal[0] + (Math.random() - 0.5) * 0.07, y: link.seal[1] - 0.14, z: link.seal[2] + (Math.random() - 0.5) * 0.07, v: 0 }); S.nextDrop = DRIP_EVERY[r.leak] * (0.7 + Math.random() * 0.6); }
      for (let i = S.drops.length - 1; i >= 0; i--) {
        const drop = S.drops[i];
        drop.v += dt * 0.0000105; drop.y -= drop.v * dt;
        if (drop.y <= GROUND) { S.rings.push({ x: drop.x, z: drop.z, born: S.clock }); S.drops.splice(i, 1); continue; }
        const p = project([drop.x, drop.y, drop.z]), tail = project([drop.x, drop.y + 0.1 + drop.v * 34, drop.z]);
        if (!p || !tail) continue;
        g.beginPath(); g.moveTo(tail[0], tail[1]); g.lineTo(p[0], p[1]); g.lineWidth = 2.4; g.strokeStyle = rgba(c, 0.95 * close); g.stroke();
        glowDot(p, 5, c, 0.9 * close);
      }
      S.rings = S.rings.filter((ring) => S.clock - ring.born < 1100).slice(-14);
      const pools = calm ? [{ x: link.seal[0], z: link.seal[2], born: S.clock - 500 }] : S.rings;
      for (const ring of pools) {
        const age = (S.clock - ring.born) / 1100, size = 0.06 + age * (0.2 + r.leak * 0.09);
        strokeAll([ringY(ring.x, GROUND + 0.01, ring.z, size, 20)], c, (1 - age) * close, 1.5);
      }
      glowDot(project([link.seal[0], GROUND + 0.02, link.seal[2]]), 16 + r.leak * 5, c, 0.38 * close);
      glowDot(project(link.seal), 10, c, (0.7 + (calm ? 0 : 0.3 * Math.sin(S.clock / 200))) * close);
    }
    g.globalCompositeOperation = "source-over";

    // ---- the picture: the dark room, the projector's light, then the glow and the sharp lines over it
    g = main;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.filter = "none";
    const room = g.createLinearGradient(0, 0, 0, H);
    room.addColorStop(0, "#020a10"); room.addColorStop(0.55, "#051a24"); room.addColorStop(1, "#02090e");
    g.fillStyle = room; g.fillRect(0, 0, W, H);
    const floor = project([cam.target[0], GROUND, cam.target[2]]);
    if (floor) {                                                        // light pooling on the floor under the aircraft
      const fy = Math.min(H * 0.98, Math.max(H * 0.5, floor[1]));
      const pool = g.createRadialGradient(W / 2, fy, 4, W / 2, fy, W * 0.62);
      pool.addColorStop(0, "rgba(64,190,235,0.16)"); pool.addColorStop(0.45, "rgba(28,110,160,0.07)"); pool.addColorStop(1, "rgba(0,0,0,0)");
      g.save(); g.translate(0, fy); g.scale(1, 0.34); g.translate(0, -fy); g.fillStyle = pool; g.fillRect(0, fy - W, W, W * 2); g.restore();
    }
    // the projector's beam, rising from under the picture
    const beam = g.createLinearGradient(0, H, 0, H * 0.18);
    beam.addColorStop(0, `rgba(96,214,255,${0.1 * (1 - close * 0.4)})`); beam.addColorStop(1, "rgba(96,214,255,0)");
    g.fillStyle = beam; g.beginPath(); g.moveTo(W * 0.4, H); g.lineTo(W * 0.6, H); g.lineTo(W * 0.96, H * 0.16); g.lineTo(W * 0.04, H * 0.16); g.closePath(); g.fill();
    if (!calm) {                                                        // dust in the beam
      for (const mote of S.motes) {
        const y = 1 - ((S.clock / 14000 * mote[2] + mote[1]) % 1), x = 0.5 + (mote[0] - 0.5) * (0.25 + (1 - y) * 0.7);
        g.fillStyle = `rgba(170,238,255,${0.5 * mote[2] * Math.sin(y * Math.PI)})`; g.fillRect(x * W, y * H, 1.4, 1.4);
      }
    }
    softCtx.clearRect(0, 0, soft.width, soft.height);
    softCtx.drawImage(light, 0, 0, soft.width, soft.height);
    g.globalCompositeOperation = "lighter";
    g.filter = `blur(${big ? 9 : 6}px)`; g.globalAlpha = 0.5; g.drawImage(soft, 0, 0, W, H);        // the wide glow, kept low so the lines stay readable
    g.filter = `blur(${big ? 3 : 2}px)`; g.globalAlpha = 0.3; g.drawImage(soft, 0, 0, W, H);        // the tight glow
    g.filter = "none"; g.globalAlpha = 1 - (calm ? 0 : 0.05 * Math.max(0, Math.sin(S.clock / 97) - 0.6));     // a slight flicker
    g.drawImage(light, 0, 0, W, H);
    g.globalAlpha = 1; g.globalCompositeOperation = "source-over";

    // the target ring on the actuator
    reticle(project(midAct), close > 0.5 ? Math.max(26, H * 0.2) : (big ? 22 : 14), r.color, (close > 0.5 ? 0.55 : 0.95) * (built < 1 ? built : 1));

    // the labels
    if (close < 0.5) {
      g.globalAlpha = (1 - close * 2) * (built < 1 ? Math.max(0, built * 2 - 1) : 1);
      label([25.5, 2.6, 0], 0.035, 0.07, `AIRCRAFT · ${r.aircraft.toUpperCase()}`, "Boeing 787-8, drawn to its real dimensions", CYAN);
      label(midAct, 0.965, 0.6, "NOSE LANDING GEAR ACTUATOR", missing ? "No prediction: key readings missing" : `${fmtRisk(r.risk)} chance of failing within 30 days`, r.color, true);
      g.globalAlpha = 1;
    } else {
      g.globalAlpha = (close - 0.5) * 2;
      label(mix(ACT_FIX, link.seal, 0.4), 0.03, 0.06, missing ? "ACTUATOR · NO PREDICTION" : `ACTUATOR · ${fmtRisk(r.risk)} · ${r.level.toUpperCase()} RISK`,
        missing ? "Both key readings are missing. Repeat the test." : r.level === "Low" ? "No failure expected within 30 days" : r.time ? `Typically fails in ${r.time}` : "", r.color);
      label(turn(AXLE, angle), 0.97, 0.07, `OPERATION TIME · ${r.op == null ? "NOT RECORDED" : r.opName.toUpperCase()}`,
        r.op == null ? "This reading is missing" : `${cap(r.opText)}.${r.slow > 1.04 ? " Dashed: a new actuator." : ""}`, r.op == null ? GREY : r.op >= 2 ? r.color : CYAN, true);
      label(link.seal, 0.03, 0.66, `LEAKAGE · ${r.leak == null ? "NOT RECORDED" : r.leakName.toUpperCase()}`,
        r.leak == null ? "This reading is missing" : `${cap(r.leakText)}.`, r.leak == null ? GREY : r.leak >= 3 ? RED : r.leak >= 1 ? AMBER : CYAN);
      g.globalAlpha = 1;
    }

    // the projector's scan lines, the dark edges of the room, the corner marks and the strip that says what this is
    g.fillStyle = "rgba(104,226,255,0.028)";
    for (let y = (S.clock / 70) % 4; y < H; y += 4) g.fillRect(0, y, W, 1);
    const edge = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
    edge.addColorStop(0, "rgba(0,0,0,0)"); edge.addColorStop(1, "rgba(0,4,8,0.62)");
    g.fillStyle = edge; g.fillRect(0, 0, W, H);
    g.strokeStyle = rgba(CYAN, 0.55); g.lineWidth = 1.2;
    for (const [x, y, sx, sy] of [[8, 8, 1, 1], [W - 8, 8, -1, 1], [8, H - 34, 1, -1], [W - 8, H - 34, -1, -1]]) { g.beginPath(); g.moveTo(x + 14 * sx, y); g.lineTo(x, y); g.lineTo(x, y + 14 * sy); g.stroke(); }
    const size = Math.max(9, Math.min(12, W / 56));
    g.font = `700 ${size}px "Cascadia Mono", ui-monospace, Consolas, monospace`; g.textBaseline = "alphabetic";
    g.strokeStyle = rgba(CYAN, 0.35); g.lineWidth = 1; g.beginPath(); g.moveTo(10, H - 30); g.lineTo(W - 10, H - 30); g.stroke();
    g.fillStyle = rgba(r.color === CYAN ? CYAN : r.color, 0.95); g.textAlign = "right";
    g.fillText(`${W < 560 ? "NOSE GEAR" : "B787-8 · NOSE LANDING GEAR"} · ${missing ? "NO PREDICTION" : `RISK ${fmtRisk(r.risk)}`}`, W - 12, H - 11);
  }
  function tick() {
    if (S.gone || !document.body.contains(canvas)) { S.gone = true; clearTimeout(timer); return; }
    draw();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  // A tab in the background gets no animation frames; keep the picture current there with a slow heartbeat.
  const beat = setInterval(() => {
    if (S.gone || !document.body.contains(canvas)) { clearInterval(beat); return; }
    if (performance.now() - S.last > 500) draw();
  }, 350);
  return { destroy() { S.gone = true; clearTimeout(timer); clearInterval(beat); } };
}
