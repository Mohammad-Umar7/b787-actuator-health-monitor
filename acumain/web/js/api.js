// Talks to the server. Every failure becomes an Error with a message that can be shown to the user as it is.

async function request(method, path, body, isForm = false) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  } catch {
    throw Object.assign(new Error("The AcuMain server is not answering. Check that it is still running."), { offline: true });
  }
  let data = null;
  try { data = await response.json(); } catch { /* an empty or non-JSON answer */ }
  if (!response.ok) {
    const detail = data?.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) ? "The request was not understood by the server." : `The server answered with an error (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status, code: data?.code });
  }
  return data;
}

const q = (params) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) usp.set(k, v);
  const s = usp.toString();
  return s ? `?${s}` : "";
};
const id = encodeURIComponent;

export const api = {
  health: () => request("GET", "/api/health"),
  meta: () => request("GET", "/api/meta"),
  history: () => request("GET", "/api/history"),
  batches: () => request("GET", "/api/batches"),
  batch: (b) => request("GET", `/api/batches/${id(b)}`),
  records: (b, params) => request("GET", `/api/batches/${id(b)}/records${q(params)}`),
  record: (b, r) => request("GET", `/api/batches/${id(b)}/records/${id(r)}`),
  upload: (file, name) => {
    const form = new FormData();
    form.append("file", file);
    if (name) form.append("name", name);
    return request("POST", "/api/batches", form, true);
  },
  removeBatch: (b) => request("DELETE", `/api/batches/${id(b)}`),
  resetBatch: (b) => request("POST", `/api/batches/${id(b)}/reset`),
  predict: (values) => request("POST", "/api/predict", { values }),
  addRecord: (values) => request("POST", "/api/batches/record", { values }),
  startRun: (body) => request("POST", "/api/agent/runs", body),
  runs: (limit = 50) => request("GET", `/api/agent/runs${q({ limit })}`),
  run: (r) => request("GET", `/api/agent/runs/${id(r)}`),
  proposals: (b) => request("GET", `/api/batches/${id(b)}/proposals`),
  decide: (p, decision, note, override = false) => request("POST", `/api/proposals/${id(p)}/decision`, { decision, note, override }),
  decideMany: (b, body) => request("POST", `/api/batches/${id(b)}/proposals/decision`, body),
  workOrders: (b) => request("GET", `/api/work-orders${q({ batch_id: b })}`),
  partsRequests: (b) => request("GET", `/api/parts-requests${q({ batch_id: b })}`),
  decidePartsRequest: (r, decision, note, override = false) => request("POST", `/api/parts-requests/${id(r)}/decision`, { decision, note, override }),
  setStock: (body) => request("POST", "/api/demo/stock", body),
  outage: (enabled) => request("POST", "/api/demo/outage", { enabled }),
};
