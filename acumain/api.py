"""The web server: a JSON API over the services, and the dashboard's static files.

Interactive API documentation is served at /docs.
"""
from __future__ import annotations

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, schema
from .config import ARTIFACTS, WEB
from .model import ACTIONS, LEVEL_NAMES, ModelUnavailable
from .services import RequestError, Services


class RunRequest(BaseModel):
    batch_id: str
    kind: str = "review"
    question: str | None = None
    record_ids: list[str] | None = None
    list_size: int = 25
    selected: str | None = None
    screen: dict | None = None
    team: bool = True          # a review is done by the team of agents unless this is switched off


class Decision(BaseModel):
    decision: str
    note: str | None = None    # optional; the dashboard does not ask for one
    override: bool = False     # change a decision that was already taken


class BulkDecision(BaseModel):
    decision: str
    ids: list[str] | None = None
    action: str | None = None
    note: str | None = None


class Outage(BaseModel):
    enabled: bool


class StockChange(BaseModel):
    preset: str | None = None              # "plenty", "short" or "none"
    store: int | None = None
    warehouse: int | None = None
    warehouse_days: int | None = None
    supplier_days: int | None = None
    supplier_available: bool | None = None
    outage: bool | None = None             # simulate the stock system being unreachable


class RecordInput(BaseModel):
    values: dict = Field(default_factory=dict)


def create_app(services: Services | None = None) -> FastAPI:
    svc = services or Services()
    app = FastAPI(title="AcuMain", version=__version__, description="Actuator failure risk, an agent that drafts the action list, and a human who approves it.")
    app.state.services = svc

    @app.middleware("http")
    async def always_fresh(request, call_next):
        """The browser must check for a newer page and data every time, so an update is never hidden by its cache."""
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response

    @app.exception_handler(RequestError)
    async def request_error(_request, err: RequestError):
        return JSONResponse(status_code=err.status, content={"detail": str(err)})

    @app.exception_handler(ModelUnavailable)
    async def model_unavailable(_request, err: ModelUnavailable):
        return JSONResponse(status_code=503, content={"detail": str(err), "code": "MODEL_UNAVAILABLE"})

    # ------------------------------------------------------------------ status and reference data
    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": __version__, "model": svc.model.info(), "agent": svc.agent_status(), "stock": svc.stock.status()}

    @app.get("/api/meta")
    def meta():
        ref = svc.model.reference
        return {"fields": schema.describe(), "id_columns": schema.ID_COLUMNS, "actions": ACTIONS, "level_names": LEVEL_NAMES,
                "thresholds": ref.get("thresholds"), "baseline": ref.get("baseline"), "failing": ref.get("failing"),
                "timeframe": ref.get("timeframe"), "validation": ref.get("validation"), "training": ref.get("training"),
                "limits": {"max_rows": schema.MAX_ROWS, "max_selected": 100, "max_list_size": 60}}

    @app.get("/api/history")
    def history():
        return FileResponse(ARTIFACTS / "history.json", media_type="application/json")

    @app.get("/api/files/template.csv")
    def template():
        return PlainTextResponse(schema.template_csv(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="acumain_template.csv"'})

    @app.get("/api/files/sample_upload.csv")
    def sample_upload():
        return FileResponse(ARTIFACTS / "sample_upload.csv", media_type="text/csv", filename="acumain_sample_upload.csv")

    # ------------------------------------------------------------------ batches and records
    def batch_view(batch) -> dict:
        out = svc.batches.summary(batch)
        proposals = svc.store.list_proposals(batch_id=batch.id)
        out["proposals"] = {status: sum(p["status"] == status for p in proposals) for status in ("pending", "approved", "rejected")}
        out["active_run"] = svc.store.active_run(batch.id)
        return out

    @app.get("/api/batches")
    def batches():
        return [batch_view(b) for b in svc.batches.all()]

    @app.post("/api/batches", status_code=201)
    async def upload(file: UploadFile = File(...), name: str | None = Form(None)):
        content = await file.read(schema.MAX_BYTES + 1)
        return batch_view(svc.upload(content, file.filename or "upload.csv", name))

    @app.post("/api/batches/record", status_code=201)
    def add_record(body: RecordInput):
        """One record typed into the form, stored as a file with a single record so the team can review it."""
        return batch_view(svc.add_record(body.values))

    @app.get("/api/batches/{batch_id}")
    def batch(batch_id: str):
        return batch_view(svc.batch(batch_id))

    @app.delete("/api/batches/{batch_id}")
    def remove(batch_id: str):
        svc.remove(batch_id)
        return {"removed": batch_id}

    @app.post("/api/batches/{batch_id}/reset")
    def reset(batch_id: str):
        svc.reset(batch_id)
        return batch_view(svc.batch(batch_id))

    @app.get("/api/batches/{batch_id}/records")
    def records(batch_id: str, level: str | None = None, q: str | None = None, issues: bool = False, sort: str = "risk",
                desc: bool = True, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500)):
        b = svc.batch(batch_id)
        page = svc.batches.rows(b, level=level, query=q, only_issues=issues, sort=sort, descending=desc, offset=offset, limit=limit)
        proposals = svc.proposals_by_record(batch_id)
        for row in page["rows"]:
            p = proposals.get(row["record_id"])
            if p:
                row["proposal"] = {"id": p["id"], "action": p["action"], "status": p["status"], "work_order_id": p["work_order_id"]}
        return page

    @app.get("/api/batches/{batch_id}/records/{record_id:path}")     # ":path" so an ID containing a slash still resolves
    def record(batch_id: str, record_id: str):
        detail = svc.batches.detail(svc.batch(batch_id), record_id)
        if detail is None:
            raise RequestError("That record is not in this batch.", 404)
        detail["proposal"] = svc.proposals_by_record(batch_id).get(record_id)
        return detail

    @app.post("/api/predict")
    def predict(body: RecordInput):
        return svc.preview(body.values)

    # ------------------------------------------------------------------ the agent
    @app.post("/api/agent/runs", status_code=202)
    def start_run(body: RunRequest):
        run_id = svc.start_run(body.batch_id, body.kind, body.question, body.record_ids, body.list_size, body.selected, body.screen,
                               as_team=body.team)
        return {"run_id": run_id}

    @app.get("/api/agent/runs")
    def runs(limit: int = Query(50, ge=1, le=200)):
        return svc.store.list_runs(limit)

    @app.get("/api/agent/runs/{run_id}")
    def run(run_id: str):
        found = svc.store.get_run(run_id)
        if found is None:
            raise HTTPException(404, "That run does not exist.")
        return found

    # ------------------------------------------------------------------ proposals and (simulated) work orders
    @app.get("/api/batches/{batch_id}/proposals")
    def proposals(batch_id: str):
        svc.batch(batch_id)
        return svc.store.list_proposals(batch_id=batch_id)

    @app.post("/api/proposals/{proposal_id}/decision")
    def decide(proposal_id: str, body: Decision):
        return svc.decide(proposal_id, body.decision, body.note, body.override)

    @app.post("/api/batches/{batch_id}/proposals/decision")
    def decide_many(batch_id: str, body: BulkDecision):
        return svc.decide_many(batch_id, body.decision, body.ids, body.action, body.note)

    @app.get("/api/work-orders")
    def work_orders(batch_id: str | None = None):
        return svc.store.list_work_orders(batch_id)

    # ------------------------------------------------------------------ spare parts (simulated)
    @app.get("/api/parts-requests")
    def parts_requests(batch_id: str | None = None):
        return svc.store.list_parts_requests(batch_id=batch_id)

    @app.post("/api/parts-requests/{request_id}/decision")
    def decide_parts_request(request_id: str, body: Decision):
        return svc.decide_parts_request(request_id, body.decision, body.note, body.override)

    @app.get("/api/demo/stock")
    def stock():
        return svc.stock.status()

    @app.post("/api/demo/stock")
    def set_stock(body: StockChange):
        """Change the simulated spare-parts situation, to show how the agents handle plenty, a shortage or nothing at all."""
        values = body.model_dump(exclude={"preset", "outage"}, exclude_none=True)
        return svc.set_stock(values or None, body.preset, body.outage)

    # ------------------------------------------------------------------ demo control
    @app.post("/api/demo/outage")
    def outage(body: Outage):
        """Switch the prediction model off or on, to demonstrate how a failed model call is handled."""
        svc.model.simulated_outage = body.enabled
        return svc.model.info()

    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
    return app
