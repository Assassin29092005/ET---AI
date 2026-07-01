"""FastAPI entrypoint for the PS2 Energy Resilience platform.

Exposes the public HTTP surface used by the React dashboard and any external
clients. Live ingestion workers (AIS, GDELT, PPAC) attach as background tasks
when ``allow_live_ingest`` is enabled in configuration.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app.api.websocket import ws_feed
from app.config import get_settings


def _configure_logging() -> None:
    logging.basicConfig(
        format="%(message)s",
        level=logging.INFO,
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


_configure_logging()
log = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    log.info(
        "startup.config",
        environment=settings.environment,
        allow_live_ingest=settings.allow_live_ingest,
        fixtures_path=str(settings.fixtures_path),
        gemini_model=settings.gemini_model,
        gemini_model_fast=settings.gemini_model_fast,
        gemini_enabled=bool(settings.gemini_api_key),
        ais_stream_enabled=bool(settings.ais_stream_api_key),
        slack_enabled=bool(settings.slack_webhook_url),
        gdelt_enabled=settings.gdelt_enabled,
    )
    # Initialise the persistence layer (creates SQLite tables if missing) and
    # restore any operator overrides that survived the prior process.
    try:
        from app import persistence
        persistence.init_db()
        persistence.apply_persisted_overrides()
    except Exception as exc:
        log.warning("startup.persistence_failed", error=str(exc))

    # Pull live spot baselines (Brent / LNG / copper / USD-INR / import bill)
    # before the app starts handling requests, so the first response already
    # reflects live spot prices instead of FY26 calibration snapshots.
    try:
        from app.ingest.baselines import refresh_live_baselines
        snapshot = await refresh_live_baselines()
        log.info("startup.baselines_refreshed", live=snapshot)
    except Exception as exc:
        log.warning("startup.baselines_failed", error=str(exc))

    # Start the continuous risk-score refresh loop. This is the "live, not
    # weekly" half of the Geopolitical Risk Intelligence Agent — see scheduler.py.
    # Awaits one initial refresh inline so the snapshot is ready immediately.
    try:
        from app import scheduler
        await scheduler.start()
    except Exception as exc:
        log.warning("startup.scheduler_failed", error=str(exc))

    # Start the live AIS consumer. Runs a single WebSocket subscription with
    # the 6 corridor bounding boxes when AISSTREAM_API_KEY is set; no-op
    # otherwise so the fixture path still serves the demo.
    try:
        from app.ingest import ais_stream
        await ais_stream.start()
    except Exception as exc:
        log.warning("startup.ais_stream_failed", error=str(exc))

    yield

    # Graceful shutdown — let the scheduler finish its current cycle.
    try:
        from app import scheduler
        await scheduler.stop()
    except Exception:
        pass
    try:
        from app.ingest import ais_stream
        await ais_stream.stop()
    except Exception:
        pass
    log.info("shutdown.complete")


app = FastAPI(
    title="PS2 Energy Resilience API",
    description=(
        "AI-driven situational awareness, scenario simulation, sourcing diversification "
        "and SPR optimisation for India's strategic energy and critical-mineral imports."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")
app.add_api_websocket_route("/ws/feed", ws_feed)


@app.get("/healthz", tags=["meta"])
async def healthz() -> dict[str, str]:
    """Liveness probe used by orchestrators and the frontend boot sequence."""
    return {"status": "ok", "service": "ps2-energy-resilience"}
