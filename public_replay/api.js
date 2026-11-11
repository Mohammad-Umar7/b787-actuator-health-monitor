// The public copy's stand-in for the server.
//
// The real dashboard talks to a Python server that runs the failure model and the agents. A static host cannot run
// those, so this file answers the same calls from recorded data: reviews that the real agents ran, saved step by
// step. Everything the visitor decides (approve, reject, change) is worked out here and kept in their own browser.
// What needs the model or the agents (a new review, an upload, a question) is refused with a plain message.
const BUILD = "__BUILD__";                       // set when the copy is built; a new build forgets decisions from an older one
const KEY = `acumain-public-${BUILD}`;
const UNREACHABLE = "The recorded data could not be loaded. Check your connection and reload the page.";

const cache = new Map();
function load(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(`data/${path}`).then((r) => {
      if (!r.ok) throw new Error(UNREACHABLE);
      return r.json();
    }).catch(() => { cache.delete(path); throw Object.assign(new Error(UNREACHABLE), { offline: true }); }));
  }
  return cache.get(path);
}
const core = () => load("core.json");
const fail = (message, status = 400) => Promise.reject(Object.assign(new Error(message), { status }));
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");

// ---- what this visitor decided, kept in this browser only
const fresh = () => ({ proposals: {}, requests: {}, orders: [], next: 1 });
let mem = null;
function mine() {
  if (!mem) {
    try { mem = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { mem = null; }
    if (!mem || typeof mem !== "object" || !Array.isArray(mem.orders)) mem = fresh();
  }
  return mem;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* a private window: decisions last until the page is closed */ }
}

const withDecision = (p) => ({ ...p, ...(mine().proposals[p.id] || {}) });
const withRequestDecision = (r) => ({ ...r, ...(mine().requests[r.id] || {}) });
async function proposalsOf(batchId) {
  return (await core()).proposals.filter((p) => !batchId || p.batch_id === batchId).map(withDecision);
}
async function batchView(b) {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const p of await proposalsOf(b.id)) if (p.status in counts) counts[p.status] += 1;
  return { ...b, proposals: counts, active_run: null };
}
async function findBatch(batchId) {
  const b = (await core()).batches.find((x) => x.id === batchId);
  return b || fail("That batch does not exist.", 404);
}

export const api = {
  isPublic: true,
  resetPublic() { mem = fresh(); save(); },

  health: async () => (await core()).health,
  meta: async () => (await core()).meta,
  history: () => load("history.json"),
  batches: async () => Promise.all((await core()).batches.map(batchView)),
  batch: async (b) => batchView(await findBatch(b)),

  async records(b, params = {}) {
    await findBatch(b);
    let rows = await load(`rows/${b}.json`);
    const { level, issues, q, offset = 0, limit = 50 } = params;
    if (level && level !== "Any") rows = rows.filter((r) => r.level === level);
    if (issues) rows = rows.filter((r) => r.issues > 0);
    if (q) {
      const text = String(q).trim().toLowerCase();
      rows = rows.filter((r) => r.record_id.toLowerCase().includes(text) || String(r.aircraft_id).toLowerCase().includes(text));
    }
    const byRecord = new Map((await proposalsOf(b)).map((p) => [p.record_id, p]));
    const page = rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(limit, 500))).map(({ chunk, ...row }) => {
      const p = byRecord.get(row.record_id);
      return p ? { ...row, proposal: { id: p.id, action: p.action, status: p.status, work_order_id: p.work_order_id } } : row;
    });
    return { total: rows.length, offset, rows: page };
  },

  async record(b, recordId) {
    await findBatch(b);
    const row = (await load(`rows/${b}.json`)).find((r) => r.record_id === recordId);
    if (!row) return fail("That record is not in this batch.", 404);
    const detail = (await load(`records/${b}/${row.chunk}.json`))[recordId];
    if (!detail) return fail("That record is not in this batch.", 404);
    return { ...detail, proposal: (await proposalsOf(b)).find((p) => p.record_id === recordId) || null };
  },

  upload: () => fail("This public copy only replays recorded reviews. To review your own file, run the Docker package.", 422),
  removeBatch: () => fail("Files cannot be removed from the public copy."),
  async resetBatch(b) {
    const batch = await findBatch(b);
    const m = mine(), c = await core();
    for (const p of c.proposals) if (p.batch_id === b) delete m.proposals[p.id];
    for (const r of c.requests) if (r.batch_id === b) delete m.requests[r.id];
    m.orders = m.orders.filter((o) => o.batch_id !== b);
    save();
    return batchView(batch);
  },
  predict: () => fail("A new prediction needs the failure model, which the public copy does not run. Run the Docker package."),
  // The four examples of the single-record form were reviewed and recorded. Any other record needs the real model.
  async addRecord(values) {
    const c = await core();
    const id = c.examples[String(values?.Aircraft_ID || "").trim()];
    if (!id) return fail("The public copy can replay the four examples only. Typing your own readings works in the Docker package.", 422);
    return batchView(await findBatch(id));
  },
  startRun: (body) => fail(body?.kind === "question" ? "A question needs the live agents. Run the Docker package to ask one."
    : "A new review needs the failure model and the agents. Run the Docker package to start one."),
  runs: async (limit = 50) => (await core()).runs.slice(0, limit),
  run: (runId) => load(`runs/${runId}.json`),

  proposals: async (b) => { await findBatch(b); return proposalsOf(b); },
  // The same rules as the server: only a pending action can be decided, unless the visitor is changing a decision.
  async decide(id, decision, _note, override = false) {
    if (!["approved", "rejected"].includes(decision)) return fail("decision must be 'approved' or 'rejected'.");
    const p = (await proposalsOf()).find((x) => x.id === id);
    if (!p) return fail("That proposal does not exist.", 404);
    if (p.status === decision) return p;
    if (p.status !== "pending" && !override) return fail(`This proposal was already ${p.status}, so nothing changed. The list has been refreshed.`, 409);
    const m = mine();
    if (p.status === "approved" && p.work_order_id) {
      const order = m.orders.find((o) => o.id === p.work_order_id);
      if (order) Object.assign(order, { status: "Cancelled (simulated)", cancelled_at: now() });
    }
    let workOrder = null;
    if (decision === "approved") {
      workOrder = `WO-SIM-${String(m.next++).padStart(4, "0")}`;
      m.orders.unshift({ id: workOrder, proposal_id: p.id, batch_id: p.batch_id, record_id: p.record_id, aircraft_id: p.aircraft_id, action: p.action,
        status: "Created (simulated)", created_at: now(), cancelled_at: null });
    }
    m.proposals[id] = { status: decision, decided_at: now(), decided_by: "planner", decision_note: null, work_order_id: workOrder };
    save();
    return { ...p, ...m.proposals[id] };
  },
  async decideMany(b, body = {}) {
    const open = (await proposalsOf(b)).filter((p) => p.status === "pending" && (!body.action || p.action === body.action) && (!body.ids || body.ids.includes(p.id)));
    const done = [];
    for (const p of open) done.push(await api.decide(p.id, body.decision));
    return done;
  },
  workOrders: async (b) => mine().orders.filter((o) => !b || o.batch_id === b),
  partsRequests: async (b) => (await core()).requests.filter((r) => !b || r.batch_id === b).map(withRequestDecision),
  async decidePartsRequest(id, decision, _note, override = false) {
    if (!["approved", "rejected"].includes(decision)) return fail("decision must be 'approved' or 'rejected'.");
    const base = (await core()).requests.find((r) => r.id === id);
    if (!base) return fail("That parts request does not exist.", 404);
    const r = withRequestDecision(base);
    if (r.status === decision) return r;
    if (r.status !== "pending" && !override) return fail(`This parts request was already ${r.status}, so nothing changed.`, 409);
    mine().requests[id] = { status: decision, decided_at: now(), decision_note: null };
    save();
    return withRequestDecision(base);
  },
  setStock: () => fail("The stock situations can be changed in the Docker package. This public copy replays recorded reviews."),
  outage: () => fail("An outage can be simulated in the Docker package. This public copy replays recorded reviews."),
};
