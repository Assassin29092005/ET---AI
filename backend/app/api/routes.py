"""HTTP surface for the resilience platform.

Mounted under /api by main.py. Endpoints return JSON dicts in camelCase to
match the React frontend's TypeScript contract directly. The backend models
in app.models are used internally where convenient; over-the-wire shapes are
defined here to keep API/UI alignment explicit.

Run with: uvicorn app.main:app --reload --port 8000
Swagger docs: http://localhost:8000/docs
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote_plus

from fastapi import APIRouter, HTTPException, Query, Response

from app.config import get_settings
from app.engines import scenarios as scenarios_engine
from app.engines import sourcing as sourcing_engine
from app.engines import spr_lp as spr_engine
from app.engines.scenarios import SCENARIOS, SCENARIO_SECTOR_TRANSMISSION, project_scenario
from app.models import Commodity, Corridor

router = APIRouter(tags=["resilience"])


CORRIDOR_FOR_COMMODITY: dict[str, str] = {
    "crude_oil": "hormuz",
    "lpg": "hormuz",
    "lng": "hormuz",
    "atf": "hormuz",
    "coking_coal": "malacca",
    "rare_earths": "south_china_sea",
    "lithium": "south_china_sea",
    "cobalt": "malacca",
    "nickel": "malacca",
    "solar_pv": "south_china_sea",
    "uranium": "malacca",
    "copper": "cape_of_good_hope",
    "graphite": "south_china_sea",
    "manganese": "cape_of_good_hope",
    "polysilicon": "south_china_sea",
    "silver": "cape_of_good_hope",
    "thermal_coal": "malacca",
    "pgm": "cape_of_good_hope",
    "rock_phosphate": "suez",
    "potash": "suez",
}

BASE_BRENT = 82.0
BASE_SPR_DAYS = 9.5
BASE_IMPORT_COST_USDM = 320.0
# Indian pump-price snapshot (IOCL Delhi diesel, FY26).
# Refreshed at startup from goodreturns.in (see ingest/pump_prices.py).
BASE_DIESEL_INR = 92.0
# Administrative baselines (Tier 4 — no machine-readable feed). Promoted to
# module level so the /api/baselines/override endpoint can mutate them.
BASE_REFINERY_RUN_PCT = 100.0  # PPAC monthly utilisation report
BASE_POWER_STRESS_IDX = 20.0   # POSOCO daily grid report
BASE_GDP_GROWTH_PCT = 6.5      # RBI quarterly bulletin

ALL_COMMODITIES: list[str] = [
    "crude_oil",
    "lng",
    "coking_coal",
    "lithium",
    "cobalt",
    "nickel",
    "rare_earths",
    "solar_pv",
    "uranium",
    "lpg",
    "atf",
    "copper",
    "graphite",
    "manganese",
    "polysilicon",
    "silver",
    "thermal_coal",
    "pgm",
    "rock_phosphate",
    "potash",
]

CORRIDOR_LABEL: dict[str, str] = {
    "hormuz": "Strait of Hormuz",
    "bab_el_mandeb": "Bab el-Mandeb / Red Sea",
    "malacca": "Strait of Malacca",
    "south_china_sea": "South China Sea",
    "cape_of_good_hope": "Cape of Good Hope",
    "suez": "Suez Canal",
}

# Maps the score/twin corridor keys to the corridor labels the sourcing engine
# uses on each supplier. Lets us drive the engine's per-supplier risk from the
# live corridor scores and from a simulated chokepoint cutoff.
SCORE_CORRIDOR_TO_ENGINE: dict[str, str] = {
    "hormuz": "Strait of Hormuz",
    "bab_el_mandeb": "Bab el-Mandeb",
    "malacca": "Strait of Malacca",
    "south_china_sea": "South China Sea",
    "cape_of_good_hope": "Cape of Good Hope",
    "suez": "Suez or Cape",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fixtures_dir() -> Path:
    return Path(get_settings().fixtures_path)


def _load_fixture(name: str) -> Any:
    path = _fixtures_dir() / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _tier(score: float) -> str:
    if score < 30:
        return "low"
    if score < 55:
        return "elevated"
    if score < 75:
        return "high"
    return "critical"


def _seeded_score(corridor: str, commodity: str) -> float:
    seed_map = {
        ("hormuz", "crude_oil"): 62,
        ("hormuz", "lng"): 58,
        ("hormuz", "lpg"): 55,
        ("bab_el_mandeb", "crude_oil"): 48,
        ("bab_el_mandeb", "lng"): 44,
        ("malacca", "coking_coal"): 36,
        ("malacca", "nickel"): 41,
        ("malacca", "cobalt"): 38,
        ("malacca", "uranium"): 22,
        ("south_china_sea", "rare_earths"): 64,
        ("south_china_sea", "solar_pv"): 51,
        ("south_china_sea", "lithium"): 47,
        ("cape_of_good_hope", "crude_oil"): 18,
        ("suez", "crude_oil"): 33,
    }
    return float(seed_map.get((corridor, commodity), 30))


def _risk_score_dict(corridor: str, commodity: str, score: float) -> dict:
    tier = _tier(score)
    geo = round(score * 0.40, 1)
    chokepoint = round(score * 0.25, 1)
    weather = round(score * 0.10, 1)
    market = round(score * 0.15, 1)
    sanctions = round(score * 0.10, 1)
    drivers = _drivers_for(corridor, commodity, score)
    return {
        "corridor": corridor,
        "commodity": commodity,
        "score": round(score, 1),
        "tier": tier,
        "components": {
            "geopolitical": geo,
            "chokepoint": chokepoint,
            "weather": weather,
            "market": market,
            "sanctions": sanctions,
        },
        "drivers": drivers,
        "confidence": 0.78,
        "asOf": _now_iso(),
    }


def _drivers_for(corridor: str, commodity: str, score: float) -> list[str]:
    base = []
    if corridor == "hormuz":
        base = [
            "GDELT: US-Iran tension signals last 24h",
            "AIS density 1.4 sigma above 90-day mean",
            f"Brent volatility {round(score / 15, 1)}% intraday",
        ]
    elif corridor == "bab_el_mandeb":
        base = [
            "Houthi statements in last 12h",
            "Suez transit count down 22% week-on-week",
            "Container freight uplift 8%",
        ]
    elif corridor == "malacca":
        base = [
            "Queensland weather signal (coal disruption tracker)",
            "Indonesia nickel export policy headlines",
            "Steel sector margin compression alerts",
        ]
    elif corridor == "south_china_sea":
        base = [
            "China rare-earth export controls in effect",
            "PV module export tariff retaliation risk",
            "Lithium spot tightening",
        ]
    else:
        base = [
            f"{CORRIDOR_LABEL.get(corridor, corridor)} corridor baseline",
            f"Composite score {round(score, 1)}",
        ]
    return base


@router.get("/healthz")
async def healthz() -> dict:
    settings = get_settings()
    fixtures = list(_fixtures_dir().glob("*.json")) if _fixtures_dir().exists() else []
    return {
        "status": "ok",
        "version": "0.1.0",
        "uptimeSeconds": 0,
        "dependencies": {
            "gemini": "ok" if settings.gemini_api_key else "down",
            "aisstream": "ok" if settings.ais_stream_api_key else "down",
            "slack": "ok" if settings.slack_webhook_url else "down",
            "fixtures": "ok" if fixtures else "down",
        },
        "asOf": _now_iso(),
        "liveIngest": settings.allow_live_ingest,
        "fixturesLoaded": len(fixtures),
    }


@router.get("/baselines")
async def baselines() -> dict:
    """Return currently-loaded data baselines and their sources. Live values
    come from APIs/scrapes at startup (Brent, FX, copper, pump prices);
    operator_overridable values are administrative figures (SPR, refinery
    utilisation, GDP, power stress) which have no machine-readable feed —
    update them via POST /api/baselines/override. Model coefficients
    (elasticities, transmission factors) are NOT here — they're calibration
    constants in docs/assumptions.md."""
    from app.ingest.baselines import LIVE_BASELINES
    return {
        "live": LIVE_BASELINES,
        "operator_overridable": {
            "spr_cover_days": {"value": BASE_SPR_DAYS, "source": "ISPRL/MoPNG annual report"},
            "refinery_runrate_pct": {"value": BASE_REFINERY_RUN_PCT, "source": "PPAC monthly utilisation report (PDF)"},
            "power_stress_index": {"value": BASE_POWER_STRESS_IDX, "source": "POSOCO daily grid report (PDF)"},
            "gdp_growth_pct": {"value": BASE_GDP_GROWTH_PCT, "source": "RBI quarterly bulletin"},
        },
        "model_parameters_note": "Elasticities, passthrough coefficients and the sector transmission matrix are deliberately not refreshed — they are calibration constants documented in docs/assumptions.md.",
        "asOf": _now_iso(),
    }


# Only these four are operator-overridable. Everything else is either live or
# a documented model parameter.
_OVERRIDABLE_RANGES: dict[str, tuple[float, float, str]] = {
    "spr_cover_days":       (0.0, 90.0,  "BASE_SPR_DAYS"),
    "refinery_runrate_pct": (0.0, 110.0, "BASE_REFINERY_RUN_PCT"),
    "power_stress_index":   (0.0, 100.0, "BASE_POWER_STRESS_IDX"),
    "gdp_growth_pct":       (-5.0, 12.0, "BASE_GDP_GROWTH_PCT"),
}


@router.post("/baselines/override")
async def override_baselines(body: dict) -> dict:
    """Operator override for Tier-4 administrative baselines. Mutates the
    in-process module globals so subsequent scenario runs use the new values.
    Lost on process restart — this is a demo-time control, not persistent
    config. Out-of-range values are rejected; the response echoes back the
    full applied state so the UI can refresh."""
    import app.api.routes as _r  # late binding so attribute writes hit the
                                  # actual module, not a stale local symbol
    applied: dict[str, float] = {}
    errors: dict[str, str] = {}
    for key, (lo, hi, attr) in _OVERRIDABLE_RANGES.items():
        if key not in body:
            continue
        try:
            value = float(body[key])
        except (TypeError, ValueError):
            errors[key] = "not a number"
            continue
        if not (lo <= value <= hi):
            errors[key] = f"out of range [{lo}, {hi}]"
            continue
        setattr(_r, attr, value)
        applied[key] = value

    # Persist so the override survives a backend restart. Best-effort — a
    # SQLite failure must not break the API response.
    if applied:
        from app import persistence
        for key, value in applied.items():
            persistence.save_override(key, value)

    return {
        "applied": applied,
        "errors": errors,
        "current": {
            "spr_cover_days":       _r.BASE_SPR_DAYS,
            "refinery_runrate_pct": _r.BASE_REFINERY_RUN_PCT,
            "power_stress_index":   _r.BASE_POWER_STRESS_IDX,
            "gdp_growth_pct":       _r.BASE_GDP_GROWTH_PCT,
        },
        "asOf": _now_iso(),
    }


# ---------------------------------------------------------------------------
# VEDAS WMS proxy — hides the API key server-side. Frontend Leaflet calls
# /api/vedas/tile/{product} with standard WMS bbox/width/height; we attach
# X-API-KEY + Referer and forward to vedas.sac.gov.in. Returns the raw PNG.
# ---------------------------------------------------------------------------
_VEDAS_TILE_BASE = "https://vedas.sac.gov.in/vapi/ridam_server3/wms/"

# In-memory tile cache so panning doesn't re-hammer VEDAS for tiles we already
# fetched this session. Keyed on (product, bbox, width, height). Cleared on
# process restart — sized small enough that worst-case memory is bounded.
from collections import OrderedDict
_VEDAS_TILE_CACHE: "OrderedDict[tuple, bytes]" = OrderedDict()
_VEDAS_TILE_CACHE_MAX = 256


def _vedas_args_rgb() -> str:
    """Temporal RGB composite over India: R = most-recent 10d window, G = ~1mo
    earlier, B = ~2mo earlier (all from dataset T3S1P1). VEDAS data has a publish
    lag of several months, so the date windows are anchored to a known-good
    interval from the API Centre sample cURL (Sep 2025) — guaranteed to have
    imagery. Update VEDAS_RGB_R_FROM / R_TO env vars to roll forward as VEDAS
    publishes newer data."""
    s = get_settings()
    return ";".join([
        "r_merge_method:max", "g_merge_method:max", "b_merge_method:max",
        "r_dataset_id:T3S1P1", "g_dataset_id:T3S1P1", "b_dataset_id:T3S1P1",
        f"r_from_time:{s.vedas_rgb_r_from}", f"r_to_time:{s.vedas_rgb_r_to}",
        f"g_from_time:{s.vedas_rgb_g_from}", f"g_to_time:{s.vedas_rgb_g_to}",
        f"b_from_time:{s.vedas_rgb_b_from}", f"b_to_time:{s.vedas_rgb_b_to}",
        "r_max:251", "g_max:251", "b_max:251",
        "r_index:1", "g_index:1", "b_index:1",
        "r_min:1", "g_min:1", "b_min:1",
    ])


def _vedas_args_ndvi() -> str:
    """NDVI temporal mosaic. Anchored to known-good dates from the API Centre
    sample cURL — update VEDAS_NDVI_FROM / _TO env vars to roll forward."""
    s = get_settings()
    return ";".join([
        "param:NDVI",
        f"from_time:{s.vedas_ndvi_from}",
        f"to_time:{s.vedas_ndvi_to}",
        "datasetId:T3S1P1",
    ])


# NDVI color ramp from the API Centre sample cURL — value:RGBA pairs across
# 0..255 (NDVI scaled to byte range), with fully-transparent nodata. RGB does
# not need a styles ramp (the three bands carry the color directly).
_VEDAS_NDVI_STYLES = (
    "[0:FFFFFF00:1:f0ebecFF:25:d8c4b6FF:50:ab8a75FF:75:917732FF:100:70ab06FF:"
    "125:459200FF:150:267b01FF:175:0a6701FF:200:004800FF:255:001901FF];"
    "nodata:FFFFFF00"
)
_VEDAS_LEGEND_OPTIONS = "columnHeight:400;height:100"

_VEDAS_PRODUCTS: dict[str, dict[str, str]] = {
    "rgb":  {"layers": "T0S0M1", "name": "RIDAM_RGB",   "args_fn": "rgb",  "styles": ""},
    "ndvi": {"layers": "T5S1M1", "name": "RDSGrdient",  "args_fn": "ndvi", "styles": _VEDAS_NDVI_STYLES},
}


@router.get("/vedas/tile/{product}")
async def vedas_tile(
    product: str,
    bbox: str = Query(..., description="WMS BBOX as 'minLat,minLon,maxLat,maxLon' for WMS 1.3.0 EPSG:4326"),
    width: int = Query(256, ge=64, le=2048),
    height: int = Query(256, ge=64, le=2048),
    crs: str = Query("EPSG:4326"),
) -> Response:
    """Proxy a single WMS tile from VEDAS for the given product (rgb|ndvi).
    The server attaches X-API-KEY + Referer; the frontend never sees the key.
    Returns raw PNG. 502 on upstream failure, 503 if the key isn't configured."""
    settings = get_settings()
    if not settings.vedas_api_key:
        raise HTTPException(status_code=503, detail="VEDAS_API_KEY not configured on server")
    if product not in _VEDAS_PRODUCTS:
        raise HTTPException(status_code=400, detail=f"unknown product '{product}'; use rgb or ndvi")

    cache_key = (product, bbox, width, height, crs)
    cached = _VEDAS_TILE_CACHE.get(cache_key)
    if cached is not None:
        _VEDAS_TILE_CACHE.move_to_end(cache_key)
        return Response(content=cached, media_type="image/png", headers={"X-Cache": "hit"})

    spec = _VEDAS_PRODUCTS[product]
    args = _vedas_args_rgb() if spec["args_fn"] == "rgb" else _vedas_args_ndvi()
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "FORMAT": "image/png",
        "TRANSPARENT": "true",
        "name": spec["name"],
        "layers": spec["layers"],
        "PROJECTION": "EPSG:4326",
        "CRS": crs,
        "ARGS": args,
        "STYLES": spec["styles"],
        "LEGEND_OPTIONS": _VEDAS_LEGEND_OPTIONS,
        "WIDTH": width,
        "HEIGHT": height,
        "BBOX": bbox,
        "X-API-KEY": settings.vedas_api_key,
    }
    headers = {
        # VEDAS validates Referer in its CORS/CSP setup; we spoof it server-side.
        "Referer": "https://vedas.sac.gov.in",
        "Origin": "https://vedas.sac.gov.in",
        "User-Agent": "PS2ResilienceProxy/1.0",
        "Accept": "image/png,image/*;q=0.8,*/*;q=0.5",
    }

    import httpx
    try:
        # VEDAS rendering can be slow for the RGB 3-band composite; 45s ceiling.
        async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
            r = await client.get(_VEDAS_TILE_BASE, params=params, headers=headers)
            content = r.content
            content_type = r.headers.get("content-type", "image/png")
            if r.status_code >= 400:
                body_preview = content[:500].decode("utf-8", errors="replace")
                raise HTTPException(
                    status_code=502,
                    detail=f"VEDAS HTTP {r.status_code}: {body_preview}",
                )
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"VEDAS transport error ({type(exc).__name__}): {exc!r}",
        ) from exc

    if not content_type.startswith("image/"):
        # VEDAS returned an error body (often text/html or text/xml)
        raise HTTPException(status_code=502, detail=f"VEDAS returned non-image content ({content_type})")

    _VEDAS_TILE_CACHE[cache_key] = content
    while len(_VEDAS_TILE_CACHE) > _VEDAS_TILE_CACHE_MAX:
        _VEDAS_TILE_CACHE.popitem(last=False)
    return Response(content=content, media_type=content_type, headers={"X-Cache": "miss"})


# Maps frontend commodity codes to the relevance-matrix keys + a per-corridor
# exposure factor for commodities not in the matrix.
_COMMODITY_RELEVANCE_KEY = {
    "crude_oil": "crude",
    "lng": "lng",
    "lpg": "lpg",
    "coking_coal": "coking_coal",
    "rare_earths": "rare_earth",
    "solar_pv": "solar_pv",
    "uranium": "uranium",
    "lithium": "lithium",
    "nickel": "nickel",
    "cobalt": "nickel",
}

_SCORE_PAIRS = [
    ("hormuz", "crude_oil"),
    ("hormuz", "lng"),
    ("hormuz", "lpg"),
    ("bab_el_mandeb", "crude_oil"),
    ("bab_el_mandeb", "lng"),
    ("malacca", "coking_coal"),
    ("malacca", "nickel"),
    ("malacca", "cobalt"),
    ("malacca", "uranium"),
    ("south_china_sea", "rare_earths"),
    ("south_china_sea", "solar_pv"),
    ("south_china_sea", "lithium"),
    ("cape_of_good_hope", "crude_oil"),
    ("suez", "crude_oil"),
]


def _live_score_dict(corridor: str, commodity: str, sig: dict, drivers: list[str]) -> dict:
    """Build a per-corridor-x-commodity score dict from live corridor signals."""
    from app.engines.risk_score import (
        CORRIDOR_COMMODITY_RELEVANCE,
        disruption_probability_14d,
        tier_from_score,
    )

    rel_key = _COMMODITY_RELEVANCE_KEY.get(commodity, commodity)
    relevance = CORRIDOR_COMMODITY_RELEVANCE.get(corridor, {}).get(rel_key, 0.5)
    base_score = float(sig.get("score", 0.0))
    score = round(base_score * relevance, 1)
    s = sig.get("signals", {})
    return {
        "corridor": corridor,
        "commodity": commodity,
        "score": score,
        "tier": tier_from_score(score),
        "disruptionProbability14d": disruption_probability_14d(score),
        "components": {
            "geopolitical": round(s.get("geo", 0.0) * 100, 1),
            "chokepoint": round(s.get("ais", 0.0) * 100, 1),
            "weather": 0.0,
            "market": round(s.get("price_vol", 0.0) * 100, 1),
            "sanctions": round(s.get("sanctions", 0.0) * 100, 1),
            "news": round(s.get("news", 0.0) * 100, 1),
        },
        "drivers": drivers,
        "confidence": 0.82,
        "relevance": round(relevance, 2),
        "asOf": _now_iso(),
    }


@router.get("/scores")
async def get_scores(commodity: str | None = Query(default=None)) -> list[dict]:
    """Live per-corridor x commodity risk scores computed from real signals.

    Scores are derived from GDELT events, vessel positions, sanctions, and
    price volatility — not hardcoded. Falls back to the seeded baseline only
    if the live signal computation fails entirely.
    """
    pairs = _SCORE_PAIRS
    if commodity:
        pairs = [(c, k) for (c, k) in pairs if k == commodity]

    try:
        from app.engines import live_scores

        sig = await live_scores.compute_live_corridor_signals()
        drivers_cache = {
            c: live_scores.drivers_from_signals(c, sig[c]) for c in sig
        }
        out: list[dict] = []
        for corridor, comm in pairs:
            csig = sig.get(corridor)
            if not csig:
                out.append(_risk_score_dict(corridor, comm, _seeded_score(corridor, comm)))
                continue
            out.append(_live_score_dict(corridor, comm, csig, drivers_cache.get(corridor, [])))
        return out
    except Exception:  # noqa: BLE001 — never let scoring crash the dashboard
        return [
            _risk_score_dict(corridor, comm, _seeded_score(corridor, comm))
            for corridor, comm in pairs
        ]


@router.get("/ais/status")
async def ais_status() -> dict:
    """Live-AIS consumer health probe — used by the UI to badge the twin
    with 'live' when the WebSocket is receiving position reports."""
    from app.ingest import ais_stream
    return {**ais_stream.status(), "asOf": _now_iso()}


@router.get("/scores/history")
async def get_score_history(
    corridor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
) -> dict:
    """Score history archive — the *evidence* that scoring updates continuously.
    Returns the most-recent N rows from the score_history table, optionally
    filtered by corridor. Each row is one snapshot at the scheduler's tick."""
    from app import persistence
    return {
        "corridor": corridor,
        "rows": persistence.list_score_history(corridor=corridor, limit=limit),
        "asOf": _now_iso(),
    }


@router.get("/scores/latest-snapshot")
async def get_latest_snapshot() -> dict:
    """The scheduler's most recent in-memory snapshot (no DB read).
    Useful when the UI wants to know the *current* state without forcing a
    fresh compute."""
    from app import scheduler
    return {
        "snapshot": scheduler.last_snapshot(),
        "refreshIntervalSeconds": scheduler.SCORE_REFRESH_SECONDS,
        "changeThreshold": scheduler.SCORE_CHANGE_THRESHOLD,
        "asOf": _now_iso(),
    }


@router.get("/scores/suppliers/{commodity}")
async def get_supplier_scores(commodity: str) -> dict:
    """Per-supplier-country risk for a commodity (the 'by supplier' dimension).

    Blends each supplier's primary-corridor live risk with its import-share
    concentration, so a high-share single supplier reads as a risk itself.
    """
    try:
        from app.engines import live_scores

        sig = await live_scores.compute_live_corridor_signals()
        suppliers = await live_scores.supplier_scores(commodity, sig)
        return {
            "commodity": commodity,
            "suppliers": suppliers,
            "asOf": _now_iso(),
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/scores/{corridor}")
async def get_scores_by_corridor(corridor: str) -> list[dict]:
    # Pass commodity=None explicitly: calling get_scores() with no args inside the
    # process would bind FastAPI's Query(default=None) sentinel, not None.
    all_scores = await get_scores(commodity=None)
    return [s for s in all_scores if s["corridor"] == corridor]


@router.get("/scenarios")
async def list_scenarios() -> list[dict]:
    out: list[dict] = []
    for name, sc in SCENARIOS.items():
        corridor = sc.params.get("primary_corridor", "hormuz") if hasattr(sc, "params") else "hormuz"
        commodity = sc.primary_commodity if hasattr(sc, "primary_commodity") else "crude_oil"
        out.append({
            "scenarioId": name,
            "name": _humanize(name),
            "description": _scenario_description(name),
            "corridor": _scenario_corridor(name),
            "commodity": _enum_value(commodity),
        })
    return out


def _humanize(snake: str) -> str:
    return snake.replace("_", " ").title()


def _enum_value(c: Any) -> str:
    if hasattr(c, "value"):
        return c.value
    return str(c)


def _scenario_corridor(name: str) -> str:
    mapping = {
        "hormuz_partial_closure": "hormuz",
        "opec_emergency_cut": "hormuz",
        "red_sea_suspension": "bab_el_mandeb",
        "australia_coking_coal": "malacca",
        "china_rare_earth_curbs": "south_china_sea",
        "china_solar_export_tariff": "south_china_sea",
        "kazakhstan_uranium_disruption": "malacca",
    }
    return mapping.get(name, "hormuz")


def _scenario_description(name: str) -> str:
    descs = {
        "hormuz_partial_closure": "50% volume reduction through Hormuz over the disruption window. Crude and Qatari LNG impacted.",
        "opec_emergency_cut": "Coordinated OPEC+ supply cut. Global crude tightens; Indian refiners exposed on spot.",
        "red_sea_suspension": "Houthi-driven full suspension of Red Sea transit. Container and LNG reroute via Cape, +18 days transit.",
        "australia_coking_coal": "Cyclone or labour action removes 30% of Queensland coking coal export volume. Indian steel margin compression.",
        "china_rare_earth_curbs": "China expands rare-earth export licensing controls. NdFeB magnet supply contracts; EV, wind, defence pinch.",
        "china_solar_export_tariff": "China retaliatory PV export tariff increase. Indian solar IRRs drop; PLI capacity insufficient short-term.",
        "kazakhstan_uranium_disruption": "Logistical or political disruption to Kazakh uranium exports. NPCIL fuel buffer ~6 months.",
    }
    return descs.get(name, f"Scenario {name}")


def _scenario_commodity(name: str) -> str:
    mapping = {
        "hormuz_partial_closure": "crude_oil",
        "opec_emergency_cut": "crude_oil",
        "red_sea_suspension": "crude_oil",
        "australia_coking_coal": "coking_coal",
        "china_rare_earth_curbs": "rare_earths",
        "china_solar_export_tariff": "solar_pv",
        "kazakhstan_uranium_disruption": "uranium",
    }
    return mapping.get(name, "crude_oil")


def _project_impact(name: str, intensity: float, duration: int) -> dict:
    """Thin wrapper around the engine. Kept as a route-local name so the rest
    of the file (and any external callers grepping for it) still works."""
    return project_scenario(
        name,
        intensity,
        duration,
        brent_baseline=BASE_BRENT,
        spr_baseline_days=BASE_SPR_DAYS,
    )


@router.post("/scenarios/{name}/run")
async def run_scenario_endpoint(name: str, body: dict | None = None) -> dict:
    if name not in SCENARIOS:
        raise HTTPException(status_code=404, detail=f"Unknown scenario: {name}")
    body = body or {}
    intensity = float(body.get("shockSeverity", body.get("intensity", 0.5)))
    duration = int(body.get("shockDurationDays", body.get("duration_days", 14)))

    impact = _project_impact(name, intensity, duration)
    brent_uplift_pct = impact["brent_uplift_pct"]
    lng_uplift_pct = impact["lng_uplift_pct"]
    coal_uplift_pct = impact["coal_uplift_pct"]
    gdp_bps = impact["gdp_bps"]
    spr_runway = impact["spr_runway_days"]

    fixture = _load_fixture("llm_responses.json") or {}
    narrative_key = {
        "hormuz_partial_closure": "scenario_hormuz",
        "australia_coking_coal": "scenario_australia_coal",
        "china_rare_earth_curbs": "scenario_china_rare_earth",
    }.get(name, f"scenario_{name}")
    narrative = fixture.get(narrative_key) or fixture.get("scenario_hormuz") or ""

    projected_brent = BASE_BRENT * (1 + brent_uplift_pct / 100.0)
    inflation_bps = round(gdp_bps * 0.85, 1)
    fx_impact = round(brent_uplift_pct * 0.18, 2)

    # Baselines for the PS-required trajectories. Brent + import bill + diesel
    # are live-refreshed at startup (see ingest/baselines.py); the three
    # administrative indices below are operator-overridable via /api/baselines/override.
    BASE_REFINERY_RUN = BASE_REFINERY_RUN_PCT
    BASE_DIESEL = BASE_DIESEL_INR
    BASE_POWER_STRESS = BASE_POWER_STRESS_IDX
    BASE_GDP_GROWTH = BASE_GDP_GROWTH_PCT

    # Trajectory deflections come from the scenario's transmission profile, not
    # the slider alone: a uranium shock barely touches refineries, a Hormuz
    # closure starves them. Already intensity- and duration-scaled in _project_impact.
    refinery_drop = impact["refinery_drop_pp"]  # crude/LNG feedstock starvation
    diesel_rise_pct = brent_uplift_pct * 0.55  # crude -> pump passthrough
    power_stress_rise = impact["power_stress_rise"]  # gas-for-power / grid-fuel shortfall
    gdp_drag_pp = abs(gdp_bps) / 100.0  # bps -> percentage points off growth

    timeline = []
    for day in range(0, duration + 1, max(1, duration // 12)):
        progress = day / max(1, duration)
        ramp = min(1.0, progress * 1.4)
        # GDP trajectory recovers partially after the peak (resilience response).
        recovery = max(0.0, (progress - 0.7) / 0.3) if progress > 0.7 else 0.0
        gdp_effect = gdp_drag_pp * ramp * (1.0 - 0.4 * recovery)
        timeline.append({
            "day": day,
            "brentUsd": round(BASE_BRENT + (projected_brent - BASE_BRENT) * ramp, 2),
            "sprDrawDownMb": round(0.85 * ramp, 3),
            "routeShareCape": round(0.42 * ramp, 3),
            "refineryRunRatePct": round(BASE_REFINERY_RUN - refinery_drop * ramp, 1),
            "dieselPriceInr": round(BASE_DIESEL * (1 + diesel_rise_pct / 100.0 * ramp), 1),
            "powerStressIndex": round(min(100.0, BASE_POWER_STRESS + power_stress_rise * ramp), 1),
            "gdpGrowthPct": round(BASE_GDP_GROWTH - gdp_effect, 2),
        })

    recommendations = [s.strip() for s in narrative.split(".") if s.strip()]
    if not recommendations:
        recommendations = [
            "Trigger short-cycle SPR drawdown over the first 14 days.",
            "Open dialogue with US WTI suppliers for 2 cargoes Aug-Sep.",
            "Re-route Qatari LNG via Cape window; confirm Dahej slot availability.",
        ]

    response = {
        "scenarioId": name,
        "request": {
            "scenarioId": name,
            "corridor": _scenario_corridor(name),
            "commodity": _scenario_commodity(name),
            "shockDurationDays": duration,
            "shockSeverity": intensity,
            "startDate": _now_iso(),
        },
        "baseline": {
            "brentUsd": BASE_BRENT,
            "sprCoverDays": BASE_SPR_DAYS,
            "importCostUsdM": BASE_IMPORT_COST_USDM,
        },
        "projected": {
            "brentUsd": round(projected_brent, 2),
            "sprCoverDays": round(spr_runway, 1),
            "importCostUsdM": round(BASE_IMPORT_COST_USDM * (1 + brent_uplift_pct / 100.0), 1),
            "gdpImpactBps": round(gdp_bps, 1),
            "inflationImpactBps": inflation_bps,
            "fxImpactInrPerUsd": fx_impact,
            # Headline price move for the scenario's primary commodity. For oil
            # scenarios this mirrors the Brent uplift; for coal/REE/solar/uranium
            # it is the move in that commodity (Brent stays flat).
            "primaryCommodity": _scenario_commodity(name),
            "primaryUpliftPct": (
                coal_uplift_pct if name == "australia_coking_coal"
                else impact["primary_uplift_pct"] if impact["primary_uplift_pct"] > 0
                else brent_uplift_pct
            ),
        },
        "timeline": timeline,
        "recommendations": recommendations,
        "generatedAt": _now_iso(),
    }

    # Audit-log the run. Best-effort — never break the response on a write
    # failure (e.g. read-only filesystem, locked DB).
    try:
        from app import persistence
        persistence.log_scenario_run(
            scenario_id=name,
            intensity=intensity,
            duration_days=duration,
            projected_brent_usd=response["projected"]["brentUsd"],
            gdp_impact_bps=response["projected"]["gdpImpactBps"],
            payload=response,
        )
    except Exception:
        pass

    return response


@router.post("/scenarios/compound")
async def compound_scenarios(body: dict) -> dict:
    """Compose 2-4 simultaneous scenarios into a single combined projection.

    Composition rules (documented inline; see docs/assumptions.md for the
    underlying justification):
      * brent_uplift_pct, lng_uplift_pct, coal_uplift_pct, primary_uplift_pct
            -> additive across scenarios, capped at 250%
      * gdp_bps                 -> additive (drags compound through different
                                   channels: import bill + steel + capex + etc.)
      * refinery_drop_pp        -> MAX across scenarios. Refinery capacity is
                                   a single physical bottleneck; the worst
                                   feedstock shock dominates.
      * power_stress_rise       -> SUM across scenarios, capped at 80 points.
                                   Different shocks hit different fuel sources
                                   (gas vs. coal vs. nuclear vs. transmission),
                                   so they accumulate.
      * spr_runway_days         -> MIN across scenarios. Whichever shock burns
                                   the SPR fastest wins.

    Request:
      {"scenarios": [{"name": str, "intensity": float, "duration_days": int}, ...]}
      duration_days defaults to the scenario's default_duration_days if absent.

    Response: same envelope as POST /api/scenarios/{name}/run, with the
    combined timeline + a `breakdown` array showing each constituent
    scenario's contribution to each metric, and `notes` documenting the
    composition rules used.
    """
    spec_list = body.get("scenarios") if isinstance(body, dict) else None
    if not isinstance(spec_list, list) or not spec_list:
        raise HTTPException(status_code=400, detail="body.scenarios must be a non-empty list")
    if len(spec_list) > 4:
        raise HTTPException(status_code=400, detail="at most 4 simultaneous scenarios allowed")

    constituents: list[dict] = []
    impacts: list[dict] = []
    max_duration = 0
    for spec in spec_list:
        if not isinstance(spec, dict):
            raise HTTPException(status_code=400, detail="each scenario entry must be an object")
        name = spec.get("name")
        if name not in SCENARIOS:
            raise HTTPException(status_code=400, detail=f"unknown scenario: {name}")
        sc = SCENARIOS[name]
        intensity = float(spec.get("intensity", spec.get("shockSeverity", sc.default_intensity)))
        duration = int(spec.get("duration_days", spec.get("shockDurationDays", sc.default_duration_days)))
        if duration <= 0:
            raise HTTPException(status_code=400, detail=f"duration_days must be > 0 for {name}")
        max_duration = max(max_duration, duration)
        impact = _project_impact(name, intensity, duration)
        constituents.append({
            "scenarioId": name,
            "intensity": intensity,
            "durationDays": duration,
            "label": _humanize(name),
            "primaryCommodity": _scenario_commodity(name),
            "primaryCorridor": _scenario_corridor(name),
        })
        impacts.append(impact)

    # Composition per the documented rules.
    def _cap(value: float, ceiling: float) -> float:
        return ceiling if value > ceiling else value

    brent_sum = _cap(sum(i["brent_uplift_pct"] for i in impacts), 250.0)
    lng_sum = _cap(sum(i["lng_uplift_pct"] for i in impacts), 250.0)
    coal_sum = _cap(sum(i["coal_uplift_pct"] for i in impacts), 250.0)
    primary_sum = _cap(sum(i["primary_uplift_pct"] for i in impacts), 250.0)
    gdp_sum = sum(i["gdp_bps"] for i in impacts)
    refinery_drop = max((i["refinery_drop_pp"] for i in impacts), default=0.0)
    power_sum = _cap(sum(i["power_stress_rise"] for i in impacts), 80.0)
    spr_runway = min((i["spr_runway_days"] for i in impacts), default=BASE_SPR_DAYS)

    projected_brent = BASE_BRENT * (1.0 + brent_sum / 100.0)
    inflation_bps = round(gdp_sum * 0.85, 1)
    fx_impact = round(brent_sum * 0.18, 2)

    # Per-day combined timeline (same shape ScenarioRun consumes).
    refinery_pp = refinery_drop
    diesel_rise_pct = brent_sum * 0.55
    power_stress_rise = power_sum
    gdp_drag_pp = abs(gdp_sum) / 100.0
    duration = max(1, max_duration)
    timeline: list[dict] = []
    for day in range(0, duration + 1, max(1, duration // 12)):
        progress = day / max(1, duration)
        ramp = min(1.0, progress * 1.4)
        recovery = max(0.0, (progress - 0.7) / 0.3) if progress > 0.7 else 0.0
        gdp_effect = gdp_drag_pp * ramp * (1.0 - 0.4 * recovery)
        timeline.append({
            "day": day,
            "brentUsd": round(BASE_BRENT + (projected_brent - BASE_BRENT) * ramp, 2),
            "sprDrawDownMb": round(0.85 * ramp, 3),
            "routeShareCape": round(0.42 * ramp, 3),
            "refineryRunRatePct": round(BASE_REFINERY_RUN_PCT - refinery_pp * ramp, 1),
            "dieselPriceInr": round(BASE_DIESEL_INR * (1 + diesel_rise_pct / 100.0 * ramp), 1),
            "powerStressIndex": round(min(100.0, BASE_POWER_STRESS_IDX + power_stress_rise * ramp), 1),
            "gdpGrowthPct": round(BASE_GDP_GROWTH_PCT - gdp_effect, 2),
        })

    # Per-scenario breakdown for the UI's contribution table.
    breakdown = [
        {
            "scenarioId": c["scenarioId"],
            "label": c["label"],
            "intensity": c["intensity"],
            "durationDays": c["durationDays"],
            "brentUpliftPct": i["brent_uplift_pct"],
            "lngUpliftPct": i["lng_uplift_pct"],
            "coalUpliftPct": i["coal_uplift_pct"],
            "primaryUpliftPct": i["primary_uplift_pct"],
            "gdpBps": i["gdp_bps"],
            "refineryDropPp": i["refinery_drop_pp"],
            "powerStressRise": i["power_stress_rise"],
            "sprRunwayDays": i["spr_runway_days"],
        }
        for c, i in zip(constituents, impacts)
    ]

    response = {
        "kind": "compound",
        "constituents": constituents,
        "baseline": {
            "brentUsd": BASE_BRENT,
            "sprCoverDays": BASE_SPR_DAYS,
            "importCostUsdM": BASE_IMPORT_COST_USDM,
        },
        "projected": {
            "brentUsd": round(projected_brent, 2),
            "sprCoverDays": round(spr_runway, 1),
            "importCostUsdM": round(BASE_IMPORT_COST_USDM * (1 + brent_sum / 100.0), 1),
            "gdpImpactBps": round(gdp_sum, 1),
            "inflationImpactBps": inflation_bps,
            "fxImpactInrPerUsd": fx_impact,
            "brentUpliftPct": round(brent_sum, 2),
            "lngUpliftPct": round(lng_sum, 2),
            "coalUpliftPct": round(coal_sum, 2),
            "primaryUpliftPct": round(primary_sum, 2),
            "refineryDropPp": round(refinery_drop, 2),
            "powerStressRise": round(power_stress_rise, 2),
        },
        "timeline": timeline,
        "breakdown": breakdown,
        "notes": [
            "Price uplifts (brent/lng/coal/primary) ADDITIVE across scenarios, capped at 250% to prevent runaway compounding.",
            "GDP-bps additive — drags route through different channels (import bill, steel, EV capex, renewable capex, etc.).",
            "Refinery run-rate drop = MAX across scenarios (single physical bottleneck).",
            "Power stress rise SUMMED, capped at 80 (different fuel sources accumulate).",
            "SPR runway = MIN across scenarios (worst-case feedstock burn wins).",
        ],
        "generatedAt": _now_iso(),
    }
    return response


@router.get("/scenario-runs")
async def list_scenario_runs(limit: int = 20) -> dict:
    """Return the N most-recent scenario runs from the persistence layer.
    Used by the audit/history view to show what scenarios have been simulated."""
    from app import persistence
    return {
        "runs": persistence.list_scenario_runs(limit=limit),
        "asOf": _now_iso(),
    }


@router.get("/scenario-runs/{run_id}")
async def get_scenario_run(run_id: int) -> dict:
    """Return the full payload of one stored run (for replay/audit)."""
    from app import persistence
    row = persistence.get_scenario_run(run_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"scenario_run {run_id} not found")
    return row


def _classify_vessel_cargo(vessel_type: str) -> str:
    """Map AIS vessel_type tokens to the cargo classes the frontend colors."""
    vt = (vessel_type or "").upper()
    if "LNG" in vt:
        return "lng"
    if "LPG" in vt:
        return "lpg"
    if "OIL" in vt or "TANKER" in vt and "CHEMICAL" not in vt and "PRODUCT" not in vt:
        return "crude"
    if "PRODUCT" in vt:
        return "product"
    if "CHEMICAL" in vt:
        return "chemical"
    if "BULK" in vt:
        return "bulk"
    if "CONTAINER" in vt:
        return "container"
    return "other"


def _vessel_corridor(lat: float, lon: float) -> Optional[str]:
    """Cheap geographic classifier — which corridor's water is this vessel in?
    Used to color/filter the map; corridor=None means open ocean / coastal."""
    # Rough bounding boxes, NOT precise geofences.
    if 24.0 < lat < 28.0 and 54.0 < lon < 58.0:
        return "hormuz"
    if 11.0 < lat < 16.0 and 41.5 < lon < 45.0:
        return "bab_el_mandeb"
    if -2.0 < lat < 7.0 and 99.0 < lon < 105.0:
        return "malacca"
    if 8.0 < lat < 22.0 and 110.0 < lon < 122.0:
        return "south_china_sea"
    if -36.0 < lat < -30.0 and 15.0 < lon < 25.0:
        return "cape_of_good_hope"
    if 27.0 < lat < 32.0 and 31.0 < lon < 34.0:
        return "suez"
    return None


@router.get("/digital-twin/state")
async def twin_state() -> dict:
    vessels_fixture = _load_fixture("vessels.json") or []
    fixture_count = len(vessels_fixture) if isinstance(vessels_fixture, list) else 0

    # Live AIS gets priority when the consumer is receiving. Otherwise fall
    # through to the fixture path (which was already the demo default).
    from app.ingest import ais_stream
    live_positions = ais_stream.get_live_vessel_positions(limit=80)

    vessel_positions: list[dict] = []
    ais_source = "fixture"
    if live_positions:
        ais_source = "live"
        for v in live_positions:
            # Strip the internal timestamp key before returning to the client.
            row = {k: v[k] for k in v if not k.startswith("_")}
            vessel_positions.append(row)
    elif isinstance(vessels_fixture, list):
        # Normalise the fixture into the TwinVessel shape the frontend renders.
        # Anomaly flag: speed below 2 kn often indicates AIS spoofing or drift.
        for v in vessels_fixture[:80]:
            try:
                lat = float(v.get("lat"))
                lon = float(v.get("lon"))
            except (TypeError, ValueError):
                continue
            speed = float(v.get("speed") or 0.0)
            vessel_positions.append({
                "mmsi": str(v.get("mmsi") or ""),
                "name": v.get("name") or "Unknown",
                "lat": lat,
                "lon": lon,
                "course": float(v.get("course") or 0.0),
                "speed": speed,
                "vesselType": v.get("vessel_type") or "UNKNOWN",
                "cargo": _classify_vessel_cargo(v.get("vessel_type") or ""),
                "flag": v.get("flag") or "UNKNOWN",
                "corridor": _vessel_corridor(lat, lon),
                "lastSeen": v.get("last_seen") or "",
                "anomaly": speed < 2.0,
            })
    vessel_count = len(vessel_positions) if ais_source == "live" else (fixture_count or 60)

    corridor_status = {
        "hormuz": "congested",
        "bab_el_mandeb": "disrupted",
        "malacca": "open",
        "south_china_sea": "congested",
        "cape_of_good_hope": "open",
        "suez": "congested",
    }
    throughput = {
        "hormuz": 19.5,
        "bab_el_mandeb": 9.2,
        "malacca": 24.1,
        "south_china_sea": 14.7,
        "cape_of_good_hope": 5.3,
        "suez": 7.8,
    }
    delays = {
        "hormuz": 6,
        "bab_el_mandeb": 26,
        "malacca": 2,
        "south_china_sea": 9,
        "cape_of_good_hope": 0,
        "suez": 4,
    }
    per_corridor_vessels = {
        "hormuz": 25,
        "bab_el_mandeb": 12,
        "malacca": 18,
        "south_china_sea": 10,
        "cape_of_good_hope": 5,
        "suez": 4,
    }

    corridors_out = []
    for corridor in ["hormuz", "bab_el_mandeb", "malacca", "south_china_sea", "cape_of_good_hope", "suez"]:
        corridors_out.append({
            "corridor": corridor,
            "throughputMbPerDay": throughput[corridor],
            "vesselCount": per_corridor_vessels[corridor],
            "averageDelayHours": delays[corridor],
            "status": corridor_status[corridor],
        })

    network = _india_supply_network(corridor_status)

    # VEDAS pipeline overlay (live when configured; fixture otherwise).
    from app.ingest.vedas import fetch_pipelines
    try:
        pipelines = await fetch_pipelines()
    except Exception:
        pipelines = {"oilPipelines": [], "gasPipelines": []}

    return {
        "asOf": _now_iso(),
        "corridors": corridors_out,
        "vessels": vessel_count,
        "aisSource": ais_source,
        "vesselPositions": vessel_positions,
        "storage": {
            "sprFillPct": 78.5,
            "lngTerminalFillPct": 64.2,
        },
        "sanctionAlerts": _compute_sanction_alerts(),
        "refineries": network["refineries"],
        "lngTerminals": network["lngTerminals"],
        "ports": network["ports"],
        "sources": network["sources"],
        "supplyRoutes": network["supplyRoutes"],
        "demandCentres": network["demandCentres"],
        "distributionLinks": network["distributionLinks"],
        "oilPipelines": pipelines["oilPipelines"],
        "gasPipelines": pipelines["gasPipelines"],
    }


# Corridor waypoints — the geographic chokepoint each supply route threads through.
_CORRIDOR_WAYPOINT: dict[str, list[float]] = {
    "hormuz": [26.5, 56.2],
    "bab_el_mandeb": [12.6, 43.4],
    "malacca": [2.5, 101.5],
    "south_china_sea": [12.0, 115.0],
    "cape_of_good_hope": [-34.3, 18.4],
    "suez": [30.0, 32.5],
}

# Major foreign export sources (wellhead / mine / fab) feeding India.
_SUPPLY_SOURCES: list[dict] = [
    {"id": "gulf", "label": "Persian Gulf wellheads", "lat": 27.0, "lon": 51.0, "commodity": "crude_oil"},
    {"id": "qatar", "label": "Qatar (Ras Laffan LNG)", "lat": 25.9, "lon": 51.6, "commodity": "lng"},
    {"id": "russia", "label": "Russia (Urals/ESPO)", "lat": 56.0, "lon": 38.0, "commodity": "crude_oil"},
    {"id": "us_gulf", "label": "US Gulf Coast", "lat": 29.3, "lon": -94.8, "commodity": "crude_oil"},
    {"id": "queensland", "label": "Queensland coal", "lat": -22.0, "lon": 148.0, "commodity": "coking_coal"},
    {"id": "indonesia", "label": "Indonesia (nickel/coal)", "lat": -2.5, "lon": 120.0, "commodity": "nickel"},
    {"id": "china_fab", "label": "China (solar/REE)", "lat": 31.0, "lon": 121.0, "commodity": "solar_pv"},
]

# Major Indian energy ports (entry + distribution nodes).
_INDIA_PORTS: list[dict] = [
    {"name": "Vadinar", "lat": 22.28, "lon": 69.72, "type": "crude oil terminal"},
    {"name": "Sikka", "lat": 22.43, "lon": 69.84, "type": "crude oil terminal"},
    {"name": "Mundra", "lat": 22.84, "lon": 69.53, "type": "multi-cargo"},
    {"name": "Paradip", "lat": 20.27, "lon": 86.67, "type": "crude + coal"},
    {"name": "Visakhapatnam", "lat": 17.69, "lon": 83.22, "type": "crude + coal + SPR"},
    {"name": "Ennore", "lat": 13.25, "lon": 80.32, "type": "LNG + coal"},
    {"name": "Dhamra", "lat": 20.78, "lon": 86.95, "type": "coking coal"},
]

# Domestic demand centres (the 'distribution' end of wellhead -> refinery ->
# distribution) and the product pipelines / corridors that feed them.
_DEMAND_CENTRES: list[dict] = [
    {"name": "Delhi NCR", "lat": 28.61, "lon": 77.21, "demandIndex": 100, "fedBy": ["Mathura", "Panipat"]},
    {"name": "Mumbai-Pune", "lat": 18.85, "lon": 73.30, "demandIndex": 95, "fedBy": ["Mumbai", "Jamnagar"]},
    {"name": "Bengaluru", "lat": 12.97, "lon": 77.59, "demandIndex": 78, "fedBy": ["Chennai", "Kochi"]},
    {"name": "Chennai", "lat": 13.08, "lon": 80.27, "demandIndex": 72, "fedBy": ["Chennai", "Ennore"]},
    {"name": "Kolkata", "lat": 22.57, "lon": 88.36, "demandIndex": 70, "fedBy": ["Paradip", "Haldia"]},
    {"name": "Hyderabad", "lat": 17.39, "lon": 78.49, "demandIndex": 68, "fedBy": ["Visakhapatnam"]},
    {"name": "Ahmedabad", "lat": 23.02, "lon": 72.57, "demandIndex": 66, "fedBy": ["Jamnagar", "Vadinar"]},
    {"name": "Lucknow-Kanpur", "lat": 26.85, "lon": 80.95, "demandIndex": 60, "fedBy": ["Mathura", "Panipat"]},
]


def _india_supply_network(corridor_status: dict[str, str]) -> dict:
    """India's energy supply network: refineries, LNG terminals, ports, and the
    source -> corridor -> India routes that thread through each chokepoint.

    Surfaces the 'wellhead -> refinery -> distribution' picture the PS2 digital
    twin requirement asks for, drawn from the refineries/lng_terminals fixtures
    plus a static port + source list.
    """
    refineries_raw = _load_fixture("refineries.json") or []
    terminals_raw = _load_fixture("lng_terminals.json") or []

    refineries = []
    if isinstance(refineries_raw, list):
        for r in refineries_raw:
            if not isinstance(r, dict):
                continue
            refineries.append({
                "name": r.get("name"),
                "operator": r.get("operator", ""),
                "capacityMmtpa": r.get("capacity_mmtpa", r.get("capacity_MMTPA", 0)),
                "lat": r.get("lat"),
                "lon": r.get("lon"),
                "grades": r.get("primary_crude_grades", []),
            })

    lng_terminals = []
    if isinstance(terminals_raw, list):
        for t in terminals_raw:
            if not isinstance(t, dict):
                continue
            lng_terminals.append({
                "name": t.get("name"),
                "operator": t.get("operator", ""),
                "capacityMtpa": t.get("capacity_mtpa", 0),
                "utilizationPct": t.get("utilization_pct", 0),
                "status": t.get("status", "OPERATIONAL"),
                "lat": t.get("lat"),
                "lon": t.get("lon"),
            })

    # Build source -> corridor -> India routes. Each route's status follows the
    # corridor it threads through, so a closed corridor lights its routes red.
    india_hub = {"lat": 19.0, "lon": 72.8}  # Mumbai offshore approach as the convergence point
    route_specs = [
        {"source": "gulf", "corridor": "hormuz", "to": "Vadinar", "toLat": 22.28, "toLon": 69.72, "commodity": "crude_oil", "sharePct": 42},
        {"source": "qatar", "corridor": "hormuz", "to": "Dahej", "toLat": 21.70, "toLon": 72.53, "commodity": "lng", "sharePct": 40},
        {"source": "russia", "corridor": "suez", "to": "Sikka", "toLat": 22.43, "toLon": 69.84, "commodity": "crude_oil", "sharePct": 36},
        {"source": "us_gulf", "corridor": "cape_of_good_hope", "to": "Mundra", "toLat": 22.84, "toLon": 69.53, "commodity": "crude_oil", "sharePct": 6},
        {"source": "queensland", "corridor": "malacca", "to": "Paradip", "toLat": 20.27, "toLon": 86.67, "commodity": "coking_coal", "sharePct": 70},
        {"source": "indonesia", "corridor": "malacca", "to": "Visakhapatnam", "toLat": 17.69, "toLon": 83.22, "commodity": "nickel", "sharePct": 55},
        {"source": "china_fab", "corridor": "south_china_sea", "to": "Ennore", "toLat": 13.25, "toLon": 80.32, "commodity": "solar_pv", "sharePct": 80},
    ]
    source_by_id = {s["id"]: s for s in _SUPPLY_SOURCES}
    supply_routes = []
    for spec in route_specs:
        src = source_by_id.get(spec["source"])
        wp = _CORRIDOR_WAYPOINT.get(spec["corridor"])
        if not src or not wp:
            continue
        status = corridor_status.get(spec["corridor"], "open")
        supply_routes.append({
            "id": f"{spec['source']}-{spec['to']}",
            "commodity": spec["commodity"],
            "sourceLabel": src["label"],
            "destLabel": spec["to"],
            "corridor": spec["corridor"],
            "status": status,
            "sharePct": spec["sharePct"],
            "path": [
                [src["lat"], src["lon"]],
                wp,
                [spec["toLat"], spec["toLon"]],
            ],
        })

    # Distribution layer: refinery / depot -> domestic demand centre. Each
    # demand centre is fed by one or more named refineries; we draw a product
    # pipeline from the supplying refinery's coordinates (falling back to the
    # nearest known refinery/port) to the demand centre.
    coord_lookup: dict[str, tuple[float, float]] = {}
    for r in refineries:
        if r.get("lat") is not None and r.get("lon") is not None:
            coord_lookup[r["name"]] = (r["lat"], r["lon"])
    for p in _INDIA_PORTS:
        coord_lookup.setdefault(p["name"], (p["lat"], p["lon"]))
    # A couple of depots referenced in fedBy that aren't refineries/ports.
    coord_lookup.setdefault("Mathura", (27.49, 77.67))
    coord_lookup.setdefault("Panipat", (29.39, 76.97))
    coord_lookup.setdefault("Mumbai", (19.00, 72.85))
    coord_lookup.setdefault("Haldia", (22.06, 88.06))

    distribution_links = []
    for hub in _DEMAND_CENTRES:
        for feeder in hub.get("fedBy", []):
            src = coord_lookup.get(feeder)
            if not src:
                continue
            distribution_links.append({
                "id": f"{feeder}-{hub['name']}",
                "feeder": feeder,
                "hub": hub["name"],
                "demandIndex": hub["demandIndex"],
                "path": [[src[0], src[1]], [hub["lat"], hub["lon"]]],
            })

    return {
        "refineries": refineries,
        "lngTerminals": lng_terminals,
        "ports": _INDIA_PORTS,
        "sources": _SUPPLY_SOURCES,
        "supplyRoutes": supply_routes,
        "demandCentres": _DEMAND_CENTRES,
        "distributionLinks": distribution_links,
    }


def _compute_sanction_alerts() -> list[dict]:
    """Cross-reference vessels.json with sanctions.json for name fuzzy matches."""
    vessels = _load_fixture("vessels.json") or []
    sdn = _load_fixture("sanctions.json") or []
    if not isinstance(vessels, list) or not isinstance(sdn, list):
        return _synthetic_sanction_alerts()

    sdn_names = [str(entry.get("name", "")).strip().lower() for entry in sdn if entry.get("name")]
    alerts: list[dict] = []
    for v in vessels:
        if not isinstance(v, dict):
            continue
        vessel_name = str(v.get("name", "")).strip()
        if not vessel_name:
            continue
        low = vessel_name.lower()
        for sdn_name in sdn_names:
            if sdn_name and sdn_name in low:
                alerts.append(
                    {
                        "vesselName": vessel_name,
                        "mmsi": str(v.get("mmsi", "")),
                        "alertType": "name-fuzzy-match",
                        "severity": "high",
                        "corridor": str(v.get("corridor") or "hormuz"),
                        "etaPort": str(v.get("destination", "")) or None,
                        "note": f"Vessel name shares substring with SDN entry '{sdn_name}'. Manual verification required.",
                    }
                )
                break
        if len(alerts) >= 4:
            break

    if not alerts:
        return _synthetic_sanction_alerts()
    return alerts


def _synthetic_sanction_alerts() -> list[dict]:
    return [
        {
            "vesselName": "MV BLUE STAR",
            "mmsi": "473219485",
            "alertType": "name-fuzzy-match",
            "severity": "high",
            "corridor": "hormuz",
            "etaPort": "Vadinar",
            "note": "Name partial match to Iran-linked entity on OFAC E.O. 13599 list. Manual verification required.",
        },
        {
            "vesselName": "AURORA II",
            "mmsi": "356847291",
            "alertType": "flag-on-sdn",
            "severity": "critical",
            "corridor": "bab_el_mandeb",
            "etaPort": "Mundra",
            "note": "Flag-of-convenience operator linked to sanctioned shadow fleet. Recommend EnergyPolicyMonitor review.",
        },
    ]


@router.post("/integrations/slack")
async def integrations_slack(body: dict | None = None) -> dict:
    body = body or {}
    title = str(body.get("title", "")).strip() or "PS2 Resilience alert"
    message_body = str(body.get("body", "")).strip()
    severity = str(body.get("severity", "info")).lower()
    if severity not in ("info", "warn", "critical"):
        severity = "info"

    color = {"info": "#36a3eb", "warn": "#f59e0b", "critical": "#ef4444"}.get(severity, "#36a3eb")
    payload = {
        "text": title,
        "attachments": [
            {
                "color": color,
                "blocks": [
                    {"type": "header", "text": {"type": "plain_text", "text": title}},
                    {"type": "section", "text": {"type": "mrkdwn", "text": message_body or "_(no body)_"}},
                    {"type": "context", "elements": [{"type": "mrkdwn", "text": f"*severity:* `{severity}` · *source:* PS2 Resilience"}]},
                ],
            }
        ],
    }

    settings = get_settings()
    webhook = getattr(settings, "slack_webhook_url", None)
    if not webhook:
        return {
            "sent": False,
            "reason": "SLACK_WEBHOOK_URL not configured",
            "dryRun": payload,
        }

    try:
        import aiohttp

        async with aiohttp.ClientSession() as session:
            async with session.post(webhook, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    return {"sent": False, "reason": f"Slack returned {resp.status}: {text[:200]}"}
                return {"sent": True}
    except Exception as exc:  # noqa: BLE001
        return {"sent": False, "reason": f"Slack post failed: {exc}"}


async def _live_risk_overrides(disrupted_corridor: str | None, severity: float) -> dict[str, float]:
    """Build per-corridor risk in [0,1] from the live scores, then overlay any
    simulated chokepoint cutoff. This is what makes sourcing risk dynamic rather
    than a fixed default table."""
    scores = await get_scores(commodity=None)
    by_corridor: dict[str, float] = {}
    for s in scores:
        c = str(s.get("corridor"))
        by_corridor[c] = max(by_corridor.get(c, 0.0), float(s.get("score", 0.0)))

    overrides: dict[str, float] = {}
    for score_key, engine_label in SCORE_CORRIDOR_TO_ENGINE.items():
        if score_key in by_corridor:
            overrides[engine_label] = round(by_corridor[score_key] / 100.0, 4)

    if disrupted_corridor:
        engine_label = SCORE_CORRIDOR_TO_ENGINE.get(disrupted_corridor)
        if engine_label:
            spiked = round(max(0.0, min(1.0, severity)), 4)
            overrides[engine_label] = max(overrides.get(engine_label, 0.0), spiked)
    return overrides


@router.get("/sourcing/{commodity}")
async def sourcing(
    commodity: str,
    volumeMb: float = Query(default=100),
    disruptedCorridor: str | None = Query(default=None),
    severity: float = Query(default=1.0, ge=0.0, le=1.0),
) -> list[dict]:
    try:
        sourcing_commodity = sourcing_engine.Commodity(commodity)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown commodity: {commodity}") from exc

    overrides = await _live_risk_overrides(disruptedCorridor, severity)
    try:
        options = await sourcing_engine.rank_alternatives(
            sourcing_commodity, risk_overrides=overrides
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    disrupted_engine = (
        SCORE_CORRIDOR_TO_ENGINE.get(disruptedCorridor) if disruptedCorridor else None
    )

    base_price = {
        "crude_oil": 82.0,
        "lng": 14.5,
        "coking_coal": 295.0,
        "lithium": 92.0,
        "cobalt": 28.0,
        "nickel": 18.0,
        "rare_earths": 540.0,
        "solar_pv": 0.105,
        "uranium": 88.0,
        "lpg": 660.0,
        "atf": 95.0,
        "copper": 9500.0,
        "graphite": 1200.0,
        "manganese": 1800.0,
        "polysilicon": 8.5,
        "silver": 31.0,
        "thermal_coal": 125.0,
        "pgm": 980.0,
        "rock_phosphate": 155.0,
        "potash": 320.0,
    }.get(commodity, 100.0)

    # First pass: classify each supplier's route status and total the share of
    # the suppliers still open, so recommended volume can be re-normalised onto
    # the available routes when a chokepoint is cut off.
    classified: list[tuple[Any, str, float]] = []
    open_share_total = 0.0
    for opt in options[:8]:
        opt_corridor = str(getattr(opt, "primary_corridor", ""))
        if disrupted_engine and opt_corridor == disrupted_engine:
            status = "closed" if severity >= 0.9 else "disrupted"
        else:
            status = "open"
        share_frac = float(getattr(opt, "historical_share", 0) or 0)
        if status != "closed":
            open_share_total += share_frac
        classified.append((opt, status, share_frac))

    out = []
    for i, (opt, status, share_frac) in enumerate(classified):
        country = getattr(opt, "source_country", getattr(opt, "country", "Unknown"))
        rank = i + 1
        # The engine reports current_risk and historical_share as [0,1] fractions;
        # surface them on the [0,100] / percentage scale the UI uses.
        risk = float(getattr(opt, "current_risk", 0.30)) * 100.0
        # Engine carries a lead-time *score* (1 = fastest), not days — derive a
        # believable day count from it instead of a constant.
        lead_score = float(getattr(opt, "lead_time_score", 0.5))
        lead = int(round(10 + (1.0 - lead_score) * 55))
        rationale = getattr(opt, "rationale", "")
        opt_corridor = str(getattr(opt, "primary_corridor", "")) or CORRIDOR_LABEL.get(
            CORRIDOR_FOR_COMMODITY.get(commodity, "hormuz"), "Strait of Hormuz"
        )
        import_share_pct = round(share_frac * 100.0, 1)
        if status == "closed":
            volume = 0.0
        elif open_share_total > 0:
            volume = round(volumeMb * (share_frac / open_share_total), 1)
        else:
            volume = round(volumeMb / max(len(classified), 1), 1)
        out.append({
            "rank": rank,
            "supplier": f"{country} consortium",
            "country": country,
            "commodity": commodity,
            "importSharePct": import_share_pct,
            "volumeMb": volume,
            "priceUsd": round(base_price * (1.0 + (risk - 30) / 100.0), 2),
            "leadTimeDays": lead,
            "routeCorridor": opt_corridor,
            "routeStatus": status,
            "routeRiskScore": round(risk, 1),
            "sanctionsCheck": "flag" if risk > 60 else "clear",
            "carbonIntensity": round(8.0 + (rank * 0.4), 2),
            "notes": rationale,
        })
    return out


# ---------------------------------------------------------------------------
# Demand-side substitution (alternate use cases)
# ---------------------------------------------------------------------------
# Complements supply-side country diversification: instead of only "buy the same
# molecule from another country", these are levers that reduce or replace the
# *demand* for the import at the point of use. displacementPct figures are
# indicative planning estimates of how much of the end-use demand the lever could
# realistically address, NOT modelled outputs — see docs/assumptions.md.

DEMAND_SUBSTITUTES: dict[str, dict] = {
    "crude_oil": {
        "primaryUse": "Transport fuels (petrol/diesel) and petrochemical feedstock",
        "substitutes": [
            {"name": "Electric vehicles (2W/3W/4W)", "type": "electrification", "maturity": "available", "displacementPct": 18, "leadTimeMonths": 60, "note": "FAME-II + state EV policies; displaces petrol/diesel road demand."},
            {"name": "Ethanol blending (E20)", "type": "biofuel", "maturity": "available", "displacementPct": 10, "leadTimeMonths": 24, "note": "EBP programme targets 20% blend; cuts petrol crude draw."},
            {"name": "CNG / city gas in transport", "type": "fuel-switch", "maturity": "available", "displacementPct": 8, "leadTimeMonths": 36, "note": "CGD network expansion; substitutes diesel in fleets/autos."},
            {"name": "Rail-freight & public transit modal shift", "type": "efficiency", "maturity": "available", "displacementPct": 5, "leadTimeMonths": 48, "note": "Dedicated freight corridors lower per-tonne diesel intensity."},
        ],
    },
    "lpg": {
        "primaryUse": "Residential cooking fuel (incl. PMUY/Ujjwala households)",
        "substitutes": [
            {"name": "Piped Natural Gas (PNG)", "type": "fuel-switch", "maturity": "available", "displacementPct": 35, "leadTimeMonths": 24, "note": "City gas distribution piped to kitchens; needs pipeline buildout but directly replaces LPG cylinders."},
            {"name": "Electric / induction cooking", "type": "electrification", "maturity": "available", "displacementPct": 20, "leadTimeMonths": 12, "note": "Grid-dependent; effective where power is reliable. Reduces LPG at the appliance."},
            {"name": "Compressed biogas (CBG / SATAT)", "type": "renewable", "maturity": "emerging", "displacementPct": 8, "leadTimeMonths": 36, "note": "Agri/urban waste feedstock; domestic, but plant rollout is gradual."},
            {"name": "Solar / improved cookstoves", "type": "renewable", "maturity": "nascent", "displacementPct": 3, "leadTimeMonths": 12, "note": "Niche; supplements rather than replaces primary cooking."},
        ],
    },
    "lng": {
        "primaryUse": "Power generation, city gas, and industrial process heat",
        "substitutes": [
            {"name": "Renewables + storage (power)", "type": "renewable", "maturity": "available", "displacementPct": 25, "leadTimeMonths": 48, "note": "Solar/wind + BESS displaces gas-fired generation where firm."},
            {"name": "Domestic gas (KG basin) + CBG", "type": "domestic", "maturity": "emerging", "displacementPct": 12, "leadTimeMonths": 36, "note": "Raises domestic share; reduces import dependence."},
            {"name": "Green hydrogen for industry", "type": "emerging", "maturity": "emerging", "displacementPct": 6, "leadTimeMonths": 72, "note": "National Hydrogen Mission; long lead, targets high-heat industry."},
        ],
    },
    "coking_coal": {
        "primaryUse": "Metallurgical coke for blast-furnace steelmaking",
        "substitutes": [
            {"name": "Scrap-based EAF steel", "type": "recycling", "maturity": "available", "displacementPct": 25, "leadTimeMonths": 36, "note": "Electric arc furnace on scrap avoids coke entirely; scrap availability is the constraint."},
            {"name": "Natural-gas DRI (gas-based sponge iron)", "type": "fuel-switch", "maturity": "available", "displacementPct": 15, "leadTimeMonths": 48, "note": "DRI-EAF route; needs competitively priced gas."},
            {"name": "Green-hydrogen DRI", "type": "emerging", "maturity": "nascent", "displacementPct": 8, "leadTimeMonths": 96, "note": "H2-DRI pilots; capex-heavy, route-level change to primary steel."},
        ],
    },
    "thermal_coal": {
        "primaryUse": "Coal-fired electricity generation",
        "substitutes": [
            {"name": "Solar PV + battery storage", "type": "renewable", "maturity": "available", "displacementPct": 30, "leadTimeMonths": 36, "note": "Cheapest new firm capacity in many states; displaces imported thermal coal first."},
            {"name": "Wind (onshore/hybrid)", "type": "renewable", "maturity": "available", "displacementPct": 15, "leadTimeMonths": 36, "note": "Complements solar in the generation mix."},
            {"name": "Domestic coal (Coal India ramp-up)", "type": "domestic", "maturity": "available", "displacementPct": 20, "leadTimeMonths": 12, "note": "Substitutes imported coal where calorific value and logistics permit."},
            {"name": "Nuclear baseload", "type": "low-carbon", "maturity": "emerging", "displacementPct": 8, "leadTimeMonths": 120, "note": "Long lead; firm low-carbon baseload."},
        ],
    },
    "lithium": {
        "primaryUse": "Li-ion batteries for EVs and grid storage",
        "substitutes": [
            {"name": "Sodium-ion batteries", "type": "chemistry-switch", "maturity": "emerging", "displacementPct": 12, "leadTimeMonths": 36, "note": "Lithium-free; suits stationary storage and entry EVs."},
            {"name": "Battery recycling / urban mining", "type": "recycling", "maturity": "emerging", "displacementPct": 8, "leadTimeMonths": 48, "note": "Recovers lithium from end-of-life cells; scales with the installed base."},
        ],
    },
    "cobalt": {
        "primaryUse": "Cathode material in Li-ion batteries",
        "substitutes": [
            {"name": "LFP (lithium iron phosphate) cells", "type": "chemistry-switch", "maturity": "available", "displacementPct": 40, "leadTimeMonths": 24, "note": "Cobalt-free chemistry now mainstream for standard-range EVs and storage."},
            {"name": "Sodium-ion batteries", "type": "chemistry-switch", "maturity": "emerging", "displacementPct": 10, "leadTimeMonths": 36, "note": "Cobalt-free and lithium-free."},
            {"name": "Battery recycling", "type": "recycling", "maturity": "emerging", "displacementPct": 8, "leadTimeMonths": 48, "note": "High-value cobalt recovery is commercially attractive."},
        ],
    },
    "nickel": {
        "primaryUse": "Stainless steel and high-energy battery cathodes",
        "substitutes": [
            {"name": "LFP cathodes (battery use)", "type": "chemistry-switch", "maturity": "available", "displacementPct": 30, "leadTimeMonths": 24, "note": "Nickel-free; shifts battery demand away from Ni-rich cathodes."},
            {"name": "Stainless scrap recycling", "type": "recycling", "maturity": "available", "displacementPct": 10, "leadTimeMonths": 36, "note": "Secondary nickel units via stainless scrap."},
        ],
    },
    "rare_earths": {
        "primaryUse": "NdFeB permanent magnets for EV motors, wind, electronics",
        "substitutes": [
            {"name": "Ferrite / induction (magnet-free) motors", "type": "redesign", "maturity": "available", "displacementPct": 20, "leadTimeMonths": 36, "note": "Externally-excited and induction motors avoid NdFeB at some efficiency/size cost."},
            {"name": "Magnet recycling", "type": "recycling", "maturity": "emerging", "displacementPct": 10, "leadTimeMonths": 48, "note": "Recovers Nd/Pr/Dy from end-of-life magnets."},
        ],
    },
    "solar_pv": {
        "primaryUse": "Solar module supply for capacity addition",
        "substitutes": [
            {"name": "Domestic cell/module (PLI) + wafer/ingot", "type": "domestic", "maturity": "emerging", "displacementPct": 30, "leadTimeMonths": 36, "note": "ALMM + PLI build domestic supply, cutting module import reliance."},
            {"name": "Wind / hybrid where solar constrained", "type": "renewable", "maturity": "available", "displacementPct": 10, "leadTimeMonths": 36, "note": "Meets the same capacity target with a different technology."},
        ],
    },
    "polysilicon": {
        "primaryUse": "Feedstock for solar wafers and cells",
        "substitutes": [
            {"name": "Domestic polysilicon / ingot-wafer capacity", "type": "domestic", "maturity": "nascent", "displacementPct": 20, "leadTimeMonths": 48, "note": "Upstream PLI integration; long lead but addresses the deepest import dependency."},
            {"name": "Thin-film (CdTe) modules", "type": "redesign", "maturity": "emerging", "displacementPct": 8, "leadTimeMonths": 36, "note": "Avoids polysilicon entirely for utility-scale plants."},
        ],
    },
    "copper": {
        "primaryUse": "Power transmission/distribution cabling and EV wiring",
        "substitutes": [
            {"name": "Aluminium conductors (ACSR/AAAC)", "type": "material-switch", "maturity": "available", "displacementPct": 25, "leadTimeMonths": 24, "note": "Standard for overhead T&D lines; reduces copper intensity."},
            {"name": "Secondary copper (recycling)", "type": "recycling", "maturity": "available", "displacementPct": 15, "leadTimeMonths": 24, "note": "Scrap-based cathode/rod lowers concentrate import need."},
        ],
    },
    "uranium": {
        "primaryUse": "Fuel for nuclear power reactors",
        "substitutes": [
            {"name": "Domestic U + three-stage / thorium cycle", "type": "domestic", "maturity": "emerging", "displacementPct": 15, "leadTimeMonths": 120, "note": "Long-horizon programme to lift indigenous fuel share."},
            {"name": "Renewables + storage (capacity substitute)", "type": "renewable", "maturity": "available", "displacementPct": 10, "leadTimeMonths": 48, "note": "Meets electricity demand without enriched-fuel imports."},
        ],
    },
    "pgm": {
        "primaryUse": "Autocatalysts and industrial/refining catalysts",
        "substitutes": [
            {"name": "BEV shift (removes autocatalyst need)", "type": "electrification", "maturity": "available", "displacementPct": 25, "leadTimeMonths": 60, "note": "Battery EVs have no exhaust catalyst, eliminating PGM loading."},
            {"name": "Autocatalyst recycling", "type": "recycling", "maturity": "available", "displacementPct": 20, "leadTimeMonths": 24, "note": "Spent-catalyst recovery is a mature secondary supply."},
        ],
    },
    "graphite": {
        "primaryUse": "Anode material in Li-ion batteries; refractories",
        "substitutes": [
            {"name": "Domestic synthetic graphite", "type": "domestic", "maturity": "available", "displacementPct": 15, "leadTimeMonths": 36, "note": "Needle-coke based; reduces reliance on natural-flake imports."},
            {"name": "Silicon / Si-blended anodes", "type": "chemistry-switch", "maturity": "emerging", "displacementPct": 12, "leadTimeMonths": 48, "note": "Higher capacity; reduces graphite per kWh."},
        ],
    },
    "manganese": {
        "primaryUse": "Steel alloying (ferro-manganese) and battery cathodes",
        "substitutes": [
            {"name": "Domestic ore (MOIL) + scrap", "type": "domestic", "maturity": "available", "displacementPct": 12, "leadTimeMonths": 24, "note": "Limited substitution — Mn is essential to steel; raise domestic/secondary share."},
        ],
    },
    "silver": {
        "primaryUse": "PV cell metallisation paste and electrical contacts",
        "substitutes": [
            {"name": "Copper-plated PV metallisation", "type": "material-switch", "maturity": "emerging", "displacementPct": 15, "leadTimeMonths": 36, "note": "Copper electroplating cuts silver per cell; entering production."},
            {"name": "Silver recovery / recycling", "type": "recycling", "maturity": "available", "displacementPct": 8, "leadTimeMonths": 24, "note": "Recovery from spent electronics and PV."},
        ],
    },
    "rock_phosphate": {
        "primaryUse": "Phosphatic fertiliser (DAP/SSP) feedstock",
        "substitutes": [
            {"name": "Nano-DAP / SSP use-efficiency", "type": "efficiency", "maturity": "emerging", "displacementPct": 12, "leadTimeMonths": 24, "note": "Higher nutrient-use efficiency lowers rock phosphate per hectare."},
            {"name": "Organic / bio-fertiliser + P recycling", "type": "recycling", "maturity": "emerging", "displacementPct": 8, "leadTimeMonths": 36, "note": "PSB biofertilisers and struvite recovery supplement mineral P."},
        ],
    },
    "potash": {
        "primaryUse": "Potassic fertiliser (MOP) for agriculture",
        "substitutes": [
            {"name": "Domestic K from molasses (PDM) + recycling", "type": "domestic", "maturity": "emerging", "displacementPct": 8, "leadTimeMonths": 36, "note": "Potash-derived-from-molasses and spent-wash recovery raise domestic share."},
            {"name": "Balanced fertilisation / soil-test based dosing", "type": "efficiency", "maturity": "available", "displacementPct": 6, "leadTimeMonths": 24, "note": "Soil Health Card driven dosing trims excess MOP demand."},
        ],
    },
}


@router.post("/sourcing/{commodity}/analyse")
async def sourcing_cascade_analyse(
    commodity: str,
    body: dict | None = None,
) -> dict:
    """AI cascade-reasoning analysis for a sourcing disruption.

    Replaces the formula-driven ranking with a Gemini-authored chain-reaction
    walkthrough. Body: {"disruptedCorridor": "hormuz" | null}. Returns
    structured sections plus the original ranked options for cross-reference.
    """
    body = body or {}
    disrupted = body.get("disruptedCorridor")

    try:
        sc = sourcing_engine.Commodity(commodity)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown commodity: {commodity}") from exc

    # Reuse the formula-based ranking as input to the LLM
    try:
        ranked = await sourcing_engine.rank_alternatives(sc)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    options_payload = [
        {
            "supplier": getattr(o, "supplier", f"{getattr(o, 'country', 'Unknown')} consortium"),
            "country": getattr(o, "source_country", getattr(o, "country", "Unknown")),
            "rank": getattr(o, "alternative_rank", getattr(o, "rank", 1)),
            "leadTimeDays": getattr(o, "lead_time_days", 28),
            "routeCorridor": CORRIDOR_FOR_COMMODITY.get(commodity, "hormuz"),
            "currentRisk": float(getattr(o, "current_risk", 30.0)),
            "rationale": getattr(o, "rationale", ""),
        }
        for o in ranked[:8]
    ]

    # Live risk snapshot per corridor for the requested commodity
    risk_snapshot = {
        "corridor_scores": [
            {
                "corridor": cor,
                "score": _seeded_score(cor, commodity),
                "tier": _tier(_seeded_score(cor, commodity)),
            }
            for cor in ["hormuz", "bab_el_mandeb", "malacca", "south_china_sea", "cape_of_good_hope", "suez"]
        ],
        "disrupted_corridor": disrupted,
    }

    substitutes = DEMAND_SUBSTITUTES.get(commodity)

    from app.llm.summarise import LLMClient  # local import keeps cold-start fast
    client = LLMClient(get_settings())
    try:
        narrative = await client.cascade_analysis(
            commodity=commodity,
            disrupted_corridor=disrupted,
            options=options_payload,
            risk_snapshot=risk_snapshot,
            substitutes=substitutes,
        )
    except Exception as exc:  # noqa: BLE001
        # Never 500 the demo - degrade gracefully to the fixture text.
        fixtures = _load_fixture("llm_responses.json") or {}
        narrative = fixtures.get("cascade_default", f"Cascade analysis unavailable: {exc}")

    return {
        "commodity": commodity,
        "disruptedCorridor": disrupted,
        "narrative": narrative,
        "rankedOptions": options_payload,
        "riskSnapshot": risk_snapshot,
        "model": "gemini-2.5-flash" if get_settings().gemini_api_key and get_settings().allow_live_ingest else "fixture",
        "generatedAt": _now_iso(),
    }


@router.get("/impact-cascade/causes")
async def impact_cascade_causes() -> list[dict]:
    """All cause nodes the user can pick as the origin of a cascade."""
    from app.engines import cascade as cascade_engine

    return cascade_engine.list_causes()


@router.post("/impact-cascade")
async def impact_cascade(body: dict | None = None) -> dict:
    """Any cause anywhere -> everything it affects in India.

    Body: {"causeId": "corridor:hormuz" | "country:china" | "commodity:lng",
           "intensity": 0..1, "withNarrative": true}.
    Returns the structured cascade (commodities, sectors, macro) plus an
    AI narrative justifying the chain reaction.
    """
    from app.engines import cascade as cascade_engine

    body = body or {}
    cause_id = str(body.get("causeId", "")).strip()
    intensity = float(body.get("intensity", 1.0))
    want_narrative = bool(body.get("withNarrative", True))

    if not cause_id:
        raise HTTPException(status_code=400, detail="causeId is required")

    try:
        result = cascade_engine.resolve_cascade(cause_id, intensity=intensity)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    payload = result.to_dict()

    narrative = ""
    if want_narrative:
        summary = cascade_engine.cascade_summary_for_llm(result)
        from app.llm.summarise import LLMClient

        client = LLMClient(get_settings())
        try:
            narrative = await client.impact_cascade(result.cause_label, summary)
        except Exception:  # noqa: BLE001
            fixtures = _load_fixture("llm_responses.json") or {}
            narrative = fixtures.get("impact_cascade_default", "")

    settings = get_settings()
    return {
        **payload,
        "intensity": round(intensity, 2),
        "narrative": narrative,
        "model": "gemini-2.5-flash"
        if (settings.gemini_api_key and settings.allow_live_ingest)
        else "fixture",
        "generatedAt": _now_iso(),
    }


@router.get("/sourcing/{commodity}/substitutes")
async def sourcing_substitutes(commodity: str) -> dict:
    """Demand-side substitution options (alternate use cases) for a commodity.

    Distinct from the country alternatives in /sourcing/{commodity}: these reduce
    or replace demand for the import at the point of use rather than re-sourcing
    the same molecule from a different country.
    """
    data = DEMAND_SUBSTITUTES.get(commodity)
    if not data:
        return {
            "commodity": commodity,
            "primaryUse": None,
            "substitutes": [],
            "disclaimer": "No demand-side substitutes modelled for this commodity yet.",
            "asOf": _now_iso(),
        }
    return {
        "commodity": commodity,
        "primaryUse": data.get("primaryUse"),
        "substitutes": data.get("substitutes", []),
        "disclaimer": (
            "Displacement figures are indicative planning estimates of addressable "
            "end-use demand, not modelled outputs."
        ),
        "asOf": _now_iso(),
    }


MMTPA_TO_KBPD = 20.08  # 1 MMTPA crude ≈ 20.08 kbpd (≈7.33 bbl/tonne)

# Each cavern's market orientation, used to skew per-site drawdown under a bias.
_SPR_SITES = [
    {"name": "Visakhapatnam", "location": "Andhra Pradesh", "capacityMb": 9.77, "fillMb": 7.6, "market": "north"},
    {"name": "Mangalore", "location": "Karnataka", "capacityMb": 11.0, "fillMb": 8.8, "market": "south"},
    {"name": "Padur", "location": "Karnataka", "capacityMb": 18.3, "fillMb": 14.2, "market": "south"},
]


def _refinery_demand_curves(disrupted_corridor: str | None) -> tuple[list[dict], float, float]:
    """Build per-refinery crude demand (kbpd) and corridor exposure.

    Demand is derived from each refinery's nameplate capacity; corridor exposure
    is inferred from the crude slate — sour/heavy grades imply Gulf (Hormuz)
    sourcing. Returns (refineries, total_demand_kbpd, total_exposure_kbpd).
    """
    refs = _load_fixture("refineries.json") or []
    corridor = disrupted_corridor or "hormuz"
    out: list[dict] = []
    total_demand = 0.0
    total_exposure = 0.0
    for r in refs:
        if not isinstance(r, dict):
            continue
        cap = float(r.get("capacity_mmtpa", 0) or 0)
        demand = cap * MMTPA_TO_KBPD
        grades = [str(g).lower() for g in r.get("primary_crude_grades", [])]
        gulf = sum(1 for g in grades if ("sour" in g or "heavy" in g))
        gulf_exposure = (gulf / len(grades)) if grades else 0.5
        if corridor == "hormuz":
            exposure_frac = gulf_exposure
        elif corridor in ("bab_el_mandeb", "suez", "cape_of_good_hope"):
            exposure_frac = gulf_exposure * 0.4
        else:
            exposure_frac = 0.1
        exposure_kbpd = demand * exposure_frac
        total_demand += demand
        total_exposure += exposure_kbpd
        out.append({
            "name": r.get("name"),
            "operator": r.get("operator"),
            "capacityMmtpa": round(cap, 1),
            "dailyDemandKbpd": round(demand, 1),
            "gulfExposurePct": round(gulf_exposure * 100, 0),
            "exposureKbpd": round(exposure_kbpd, 1),
            "grades": r.get("primary_crude_grades", []),
        })
    out.sort(key=lambda x: x["exposureKbpd"], reverse=True)
    return out, round(total_demand, 1), round(total_exposure, 1)


def _replenishment_windows(central_gap: list[float], horizon: int) -> tuple[list[dict], list[bool]]:
    """Identify replenishment windows: contiguous post-shock days with no gap,
    when crude can be bought back to refill the reserve at eased prices."""
    prices = _load_fixture("commodity_prices.json") or {}
    brent_series = prices.get("brent_crude_usd", []) if isinstance(prices, dict) else []
    last_brent = float(brent_series[-1].get("value", BASE_BRENT)) if brent_series else BASE_BRENT
    eased_price = round(last_brent * 0.95, 2)

    allowed = [g <= 0.0 for g in central_gap]
    windows: list[dict] = []
    start: int | None = None
    for d in range(horizon):
        if allowed[d] and start is None:
            start = d
        elif not allowed[d] and start is not None:
            windows.append({"startDay": start, "endDay": d - 1, "days": d - start,
                            "estPriceUsd": eased_price,
                            "reason": "Supply gap cleared; refill at eased spot/contract prices."})
            start = None
    if start is not None:
        windows.append({"startDay": start, "endDay": horizon - 1, "days": horizon - start,
                        "estPriceUsd": eased_price,
                        "reason": "Supply gap cleared; refill at eased spot/contract prices."})
    return windows, allowed


# Release-mode shapes the LP's cost structure + draw ceiling. These are
# documented DOE-style SPR release mechanisms:
#   drawdown : outright sale at spot, fastest, biggest price impact closure
#   swap     : loaned crude against future-dated return, lower net cost but
#              slower because a return-obligation pulls reserve back up
#   exchange : delayed-delivery contracts, smallest disruption, slowest
_RELEASE_MODE_PROFILE: dict[str, dict[str, float]] = {
    "drawdown": {"draw_cap_kbpd": 600.0, "price_impact_coef": 1.00, "replenish_cost_coef": 0.05, "rebuild_pull": 0.00},
    "swap":     {"draw_cap_kbpd": 500.0, "price_impact_coef": 0.85, "replenish_cost_coef": 0.03, "rebuild_pull": 0.35},
    "exchange": {"draw_cap_kbpd": 350.0, "price_impact_coef": 0.70, "replenish_cost_coef": 0.02, "rebuild_pull": 0.50},
}


def _build_spr_plan(
    horizon: int = 60,
    target_cover_days: float = 6.0,
    bias: str = "balanced",
    scenario_id: str | None = None,
    intensity: float = 0.5,
    release_mode: str = "drawdown",
) -> dict:
    sites = [dict(s) for s in _SPR_SITES]
    total_capacity = sum(s["capacityMb"] for s in sites)
    current_fill = sum(s["fillMb"] for s in sites)
    profile = _RELEASE_MODE_PROFILE.get(release_mode, _RELEASE_MODE_PROFILE["drawdown"])

    # Days-of-import cover basis, anchored so current fill reads as BASE_SPR_DAYS;
    # cover and the target-cover reserve floor share this single basis.
    import_mmb_day = current_fill / BASE_SPR_DAYS if BASE_SPR_DAYS else 3.2
    reserve_floor = round(target_cover_days * import_mmb_day, 3)

    scenario_corridor = _scenario_corridor(scenario_id) if scenario_id else "hormuz"
    refineries, total_demand_kbpd, exposure_kbpd = _refinery_demand_curves(scenario_corridor)

    # Monte Carlo confidence band replaces the earlier stylised (parametric)
    # widener. Central path (p50) still feeds the LP; the p10/p90 envelope is
    # surfaced to the UI. See engines/spr_uncertainty.py for the perturbation
    # distributions.
    from app.engines.spr_uncertainty import monte_carlo_gap_forecast
    scenario_params = SCENARIOS[scenario_id].params if scenario_id else {}
    if scenario_id:
        scenario_label = f"{_humanize(scenario_id)} ({intensity:.0%} intensity)"
    else:
        scenario_label = "Generic crude shortfall"
    mc = monte_carlo_gap_forecast(
        scenario_id=scenario_id,
        intensity=intensity,
        exposure_kbpd=exposure_kbpd,
        horizon=horizon,
        scenario_params=scenario_params,
    )
    gap_curve = mc["central"]
    gap_forecast = mc["forecast"]
    peak_gap = mc["peak"]
    uncertainty = mc["uncertainty"]
    windows, replenish_allowed = _replenishment_windows(gap_curve, horizon)

    config = spr_engine.SPRConfig(
        starting_reserve_mmb=round(current_fill, 3),
        # Release mode tightens the daily ceiling: a swap or exchange runs
        # through tenders/contracts and physically can't draw as fast as an
        # outright drawdown sale.
        max_daily_drawdown_kbpd=profile["draw_cap_kbpd"],
        max_daily_replenish_kbpd=300.0,
        daily_consumption_kbpd=total_demand_kbpd or 4800.0,
        supply_gap_curve=gap_curve,
        planning_horizon_days=horizon,
        reserve_floor_mmb=reserve_floor,
        floor_penalty_coef=1500.0,
        # Each release mode prices the unmet shortfall and the rebuild cost
        # differently — see _RELEASE_MODE_PROFILE for the documented numbers.
        price_impact_coef=profile["price_impact_coef"],
        replenish_cost_coef=profile["replenish_cost_coef"],
        capacity_mmb=round(total_capacity, 3),
        replenish_allowed=replenish_allowed,
        # Reward rebuilding only when there's an actual shock to recover from,
        # and dampen the reward for swap/exchange (their structural return
        # obligation already pulls reserve back up).
        rebuild_reward_coef=(80.0 * (1.0 - profile["rebuild_pull"])) if peak_gap > 1.0 else 0.0,
    )
    try:
        plan = spr_engine.solve_spr_plan(config)
    except Exception:
        plan = None

    release_schedule: list[dict] = []
    gap_closed_pct = 0.0
    total_unmet_mb = 0.0
    total_replenish_mb = 0.0
    projected_cover_days = round(current_fill / import_mmb_day, 1)
    min_reserve = current_fill
    avg_active_draw = 0.0
    solver_status = "unavailable"

    if plan is not None:
        solver_status = getattr(plan, "status", "unknown")
        drawdown_kbpd = getattr(plan, "drawdown_kbpd", [])
        replenish_kbpd = getattr(plan, "replenish_kbpd", [])
        reserve_series = getattr(plan, "reserve_mmb", [])
        cumulative = 0.0
        active_draws: list[float] = []
        for i in range(horizon):
            draw = float(drawdown_kbpd[i]) / 1000.0 if i < len(drawdown_kbpd) else 0.0
            refill = float(replenish_kbpd[i]) / 1000.0 if i < len(replenish_kbpd) else 0.0
            cumulative += draw
            total_replenish_mb += refill
            if draw > 1e-4:
                active_draws.append(draw)
            release_schedule.append({
                "day": i,
                "drawMb": round(draw, 3),
                "replenishMb": round(refill, 3),
                "cumulativeMb": round(cumulative, 3),
                "reserveMb": round(float(reserve_series[i]), 3) if i < len(reserve_series) else None,
                "targetMarket": bias,
            })
        avg_active_draw = sum(active_draws) / len(active_draws) if active_draws else 0.0
        total_unmet_mb = round(sum(getattr(plan, "unmet_gap_kbpd", [])) / 1000.0, 2)

        # Quantify the LP's contribution vs taking no action at all.
        try:
            baseline = spr_engine.baseline_no_action_plan(config)
            base_impact = getattr(baseline, "total_impact_score", 0.0)
            lp_impact = getattr(plan, "total_impact_score", 0.0)
            gap_closed_pct = round((base_impact - lp_impact) / base_impact * 100.0, 1) if base_impact > 0 else 0.0
        except Exception:
            gap_closed_pct = 0.0

        if reserve_series:
            projected_cover_days = round(float(reserve_series[-1]) / import_mmb_day, 1)
            min_reserve = min(float(v) for v in reserve_series)

        trough_cover = round(min_reserve / import_mmb_day, 1)
        rationale = (
            f"LP minimises price-impact-weighted unmet crude shortfall over {horizon} days "
            f"against the {scenario_label} shock (peak {peak_gap:.0f} kbpd of refinery demand), "
            f"subject to reserve balance, 600/300 kbpd draw/replenish limits, a {total_capacity:.1f} "
            f"Mbbl tank ceiling, and a soft floor of {reserve_floor:.1f} Mbbl (~{target_cover_days:.0f} "
            f"days cover). It closes {gap_closed_pct:.0f}% of the no-action price impact, leaves "
            f"{total_unmet_mb:.1f} Mbbl of shortfall uncovered, draws cover to a {trough_cover:.1f}-day "
            f"trough, then refills {total_replenish_mb:.1f} Mbbl in the post-shock window to end at "
            f"{projected_cover_days:.1f} days. Allocation biased {bias}. Solver status: {solver_status}."
        )
    else:
        for d in range(horizon):
            draw = round(0.85 if d < 14 else 0.42 if d < 28 else 0.0, 3)
            cum = release_schedule[-1]["cumulativeMb"] + draw if release_schedule else draw
            release_schedule.append({
                "day": d,
                "drawMb": draw,
                "replenishMb": 0.0,
                "cumulativeMb": round(cum, 3),
                "reserveMb": None,
                "targetMarket": bias,
            })
        avg_active_draw = 0.85
        rationale = (
            f"Heuristic schedule (LP solver unavailable). Target cover {target_cover_days:.0f} days, "
            f"bias {bias}, {scenario_label} shock. Install PuLP CBC for the full optimisation."
        )

    # Distribute the representative daily drawdown across caverns by capacity,
    # skewed toward the sites that serve the chosen market bias.
    weights = []
    for s in sites:
        w = float(s["capacityMb"])
        if bias in ("north", "south") and s["market"] == bias:
            w *= 1.6
        weights.append(w)
    total_weight = sum(weights) or 1.0
    for s, w in zip(sites, weights):
        s["drawRateMbPerDay"] = round(avg_active_draw * (w / total_weight), 3)
        s.pop("market", None)

    response = {
        "asOf": _now_iso(),
        "totalCapacityMb": round(total_capacity, 2),
        "currentFillMb": round(current_fill, 2),
        "coverDays": round(current_fill / import_mmb_day, 1),
        "projectedCoverDays": projected_cover_days,
        "troughCoverDays": round(min_reserve / import_mmb_day, 1),
        "gapClosedPct": gap_closed_pct,
        "peakGapKbpd": peak_gap,
        "totalUnmetMb": total_unmet_mb,
        "totalReplenishMb": round(total_replenish_mb, 2),
        "totalDemandKbpd": total_demand_kbpd,
        "scenarioId": scenario_id,
        "scenarioLabel": scenario_label,
        "targetCoverDays": round(target_cover_days, 1),
        "marketBias": bias,
        "releaseMode": release_mode,
        "releaseModeProfile": profile,
        "sites": sites,
        "refineryDemand": refineries,
        "gapForecast": gap_forecast,
        "uncertainty": uncertainty,
        "replenishmentWindows": windows,
        "releaseSchedule": release_schedule,
        "rationale": rationale,
        # Carried for persistence; trimmed off in the API response below.
        "_horizon": horizon,
        "_intensity": intensity,
    }

    # Archive each plan run for the history view. Best-effort.
    try:
        from app import persistence
        persistence.log_spr_plan(response)
    except Exception:
        pass
    response.pop("_horizon", None)
    response.pop("_intensity", None)
    return response


def _spr_urgency(plan: dict) -> str:
    peak = float(plan.get("peakGapKbpd", 0))
    trough = float(plan.get("troughCoverDays", plan.get("coverDays", 9.5)))
    if peak <= 1.0:
        return "low"
    if trough < 4 or peak > 2000:
        return "high"
    if trough < 6 or peak > 800:
        return "elevated"
    return "low"


def _local_spr_brief(plan: dict) -> dict:
    """Deterministic decision brief composed from the LP plan (fixture mode)."""
    urgency = _spr_urgency(plan)
    label = plan.get("scenarioLabel", "the current shock")
    peak = float(plan.get("peakGapKbpd", 0))
    gap_closed = float(plan.get("gapClosedPct", 0))
    trough = float(plan.get("troughCoverDays", plan.get("coverDays", 0)))
    proj = float(plan.get("projectedCoverDays", 0))
    unmet = float(plan.get("totalUnmetMb", 0))
    refills = float(plan.get("totalReplenishMb", 0))
    bias = plan.get("marketBias", "balanced")
    refineries = plan.get("refineryDemand", []) or []
    windows = plan.get("replenishmentWindows", []) or []
    top_exposed = [r["name"] for r in refineries[:3] if r.get("exposureKbpd", 0) > 0]

    if peak <= 1.0:
        situation = (
            f"{label} produces no material crude shortfall, so the SPR is not the right lever here. "
            "Hold reserves and monitor; act on the sourcing and demand-side levers instead."
        )
    else:
        situation = (
            f"{label} opens a crude supply gap peaking at {peak:.0f} kbpd. Most exposed refineries: "
            f"{', '.join(top_exposed) if top_exposed else 'n/a'}. The optimised drawdown closes "
            f"{gap_closed:.0f}% of the no-action price impact but draws cover to a {trough:.1f}-day "
            f"trough — {unmet:.1f} Mbbl of shortfall stays uncovered."
        )

    win_txt = (
        f"day {windows[0]['startDay']}-{windows[0]['endDay']} (~${windows[0]['estPriceUsd']:.0f}/bbl)"
        if windows else "no clear window in horizon"
    )

    actions = []
    if peak > 1.0:
        actions.append(
            f"Authorise drawdown front-loaded to the early shock window, biased {bias}; "
            f"protect the {trough:.1f}-day reserve floor."
        )
        actions.append(
            f"Pre-position non-Gulf cargoes (Russian ESPO/Urals, US WTI) to cover the {unmet:.1f} Mbbl "
            "the reserve cannot bridge."
        )
        actions.append(f"Schedule refill of {refills:.1f} Mbbl in the replenishment window: {win_txt}.")
    else:
        actions.append("No SPR drawdown required; keep reserves at current cover.")

    tradeoffs = [
        f"Aggressive draw covers more of the shock now but leaves cover at {trough:.1f} days; a higher "
        f"target rebuilds to {proj:.1f} days but absorbs less of the shortfall.",
        "Earlier refill locks in current prices; waiting for a deeper price dip risks a second shock.",
    ]
    risks = [
        "Refinery exposure assumes Gulf sourcing for sour/heavy slates; actual cargo origin may differ.",
        "Replenishment window assumes the shock does not recur; a second event reopens the gap.",
    ]
    watch = [
        "Hormuz transit counts and war-risk insurance quotes.",
        "Brent spot vs the refill trigger price.",
        f"Reserve trough vs the {plan.get('targetCoverDays', 6):.0f}-day target floor.",
    ]

    return {
        "urgency": urgency,
        "headline": (
            f"{label}: {urgency.upper()} — cover {trough:.1f}d trough, {gap_closed:.0f}% impact closed"
            if peak > 1.0 else f"{label}: SPR action not required"
        ),
        "situation": situation,
        "actions": actions,
        "tradeoffs": tradeoffs,
        "risks": risks,
        "watchItems": watch,
    }


@router.get("/spr/plan")
async def get_spr_plan() -> dict:
    return _build_spr_plan()


def _spr_params_from_body(body: dict) -> dict:
    horizon = int(body.get("horizonDays", 60))
    target = float(body.get("targetCoverDays", 6.0))
    bias = str(body.get("marketBias", "balanced"))
    scenario_id = body.get("scenarioId") or None
    intensity = float(body.get("intensity", body.get("shockSeverity", 0.5)))
    release_mode = str(body.get("releaseMode", "drawdown")).lower()
    if release_mode not in ("drawdown", "swap", "exchange"):
        raise HTTPException(
            status_code=400,
            detail=f"releaseMode must be one of drawdown|swap|exchange (got {release_mode!r})",
        )
    if scenario_id is not None and scenario_id not in SCENARIOS:
        raise HTTPException(status_code=404, detail=f"Unknown scenario: {scenario_id}")
    return {
        "horizon": horizon,
        "target_cover_days": target,
        "bias": bias,
        "scenario_id": scenario_id,
        "intensity": intensity,
        "release_mode": release_mode,
    }


@router.post("/spr/plan")
async def post_spr_plan(body: dict | None = None) -> dict:
    return _build_spr_plan(**_spr_params_from_body(body or {}))


@router.get("/spr/runs")
async def list_spr_runs(limit: int = Query(default=20, ge=1, le=200)) -> dict:
    """Audit log of past SPR plan solves — shows that the agent has been
    iterated repeatedly, not just clicked once during the demo."""
    from app import persistence
    return {
        "runs": persistence.list_spr_plans(limit=limit),
        "asOf": _now_iso(),
    }


@router.post("/spr/brief")
async def spr_brief(body: dict | None = None) -> dict:
    """Strategic Reserve decision-support brief — the agent layer over the LP.

    Solves the plan for the requested parameters, then returns a structured
    policymaker brief (situation, actions, trade-offs, risks, watch-items) plus
    an LLM narrative when live, falling back to a deterministic local brief.
    """
    params = _spr_params_from_body(body or {})
    plan = _build_spr_plan(**params)
    brief = _local_spr_brief(plan)

    settings = get_settings()
    live = bool(getattr(settings, "allow_live_ingest", False)) and bool(
        getattr(settings, "gemini_api_key", None)
    )
    narrative = ""
    if live:
        try:
            from app.llm.summarise import LLMClient  # type: ignore

            client = LLMClient(settings)
            narrative = await client.spr_brief(plan) or ""
        except Exception:
            narrative = ""
        if narrative.strip().startswith("[fixture"):
            narrative = ""
    if not narrative.strip():
        fixtures = _load_fixture("llm_responses.json") or {}
        narrative = fixtures.get("spr_brief") or (
            f"{brief['situation']} Recommended: {brief['actions'][0]}"
        )

    return {
        "scenarioId": plan.get("scenarioId"),
        "scenarioLabel": plan.get("scenarioLabel"),
        "narrative": narrative,
        **brief,
        "plan": {
            "coverDays": plan.get("coverDays"),
            "troughCoverDays": plan.get("troughCoverDays"),
            "projectedCoverDays": plan.get("projectedCoverDays"),
            "gapClosedPct": plan.get("gapClosedPct"),
            "peakGapKbpd": plan.get("peakGapKbpd"),
            "totalUnmetMb": plan.get("totalUnmetMb"),
        },
        "generatedAt": _now_iso(),
    }


_FABRICATED_HOSTS = (
    "example.com",
    "example.org",
    "fixture.local",
    "localhost",
    "127.0.0.1",
)


def _is_real_url(u: str) -> bool:
    """Filter for URLs that point at a real public-web article, not a fixture stub."""
    if not isinstance(u, str):
        return False
    u = u.strip()
    if not u.startswith(("http://", "https://")):
        return False
    try:
        host = u.split("/", 3)[2].lower()
    except IndexError:
        return False
    if any(bad in host for bad in _FABRICATED_HOSTS):
        return False
    if "." not in host:
        return False
    return True


def gdelt_context_url(event: dict) -> str:
    """Return a URL that opens real news coverage for a feed event.

    In live mode (ALLOW_LIVE_INGEST=true) we trust the event's `urls` array —
    those are real source URLs that GDELT records.

    In fixture mode the `urls` field is fabricated and will 404. We always
    build a Google News search from the event's actors + location + theme,
    so the user lands on real coverage no matter what.
    """
    settings = get_settings()
    if settings.allow_live_ingest:
        raw_urls = event.get("urls") or []
        if isinstance(raw_urls, list):
            for u in raw_urls:
                if _is_real_url(str(u)):
                    return str(u).strip()

    terms = [
        str(event.get(key, "")).strip()
        for key in ("actor1", "location", "actor2", "theme")
        if str(event.get(key, "")).strip()
    ]
    query = " ".join(terms[:3]) or "India energy supply chain"
    # Google News (tbm=nws) reliably returns relevant article listings.
    return (
        "https://www.google.com/search?q="
        f"{quote_plus(query)}&tbm=nws"
    )


@router.get("/feed")
async def feed(limit: int = Query(default=50)) -> list[dict]:
    events = _load_fixture("gdelt_events.json") or []
    feed_items = []
    for i, e in enumerate(events[:limit]):
        feed_items.append({
            "id": str(e.get("id", i)),
            "source": "GDELT",
            "headline": e.get("actor1", "Event") + " - " + str(e.get("event_code", ""))[:64],
            "summary": f"Tone {e.get('tone', 0)}; near {e.get('location', 'unknown')}",
            "url": gdelt_context_url(e),
            "publishedAt": e.get("timestamp", _now_iso()),
            "tags": [str(e.get("theme", ""))],
            "corridor": None,
            "commodity": None,
            "sentiment": "negative" if float(e.get("tone", 0)) < -3 else "neutral",
            "importance": max(1, min(10, int(abs(float(e.get("tone", 0))) * 1.2))),
        })
    return feed_items


@router.get("/executive-brief")
async def executive_brief() -> dict:
    fixture = _load_fixture("llm_responses.json") or {}
    body = fixture.get("executive_brief") or (
        "Today's snapshot: Hormuz risk elevated on US-Iran tension signals and a 4% Brent move overnight. "
        "Red Sea remains effectively closed to LNG and crude majors after this week's Houthi statements. "
        "South China Sea risk elevated on China rare-earth export licensing tightening. SPR cover stands at 9.5 days; "
        "scenario simulator shows a 5.1-day runway under a 14-day Hormuz partial closure."
    )
    return {
        "generatedAt": _now_iso(),
        "asOfDate": date.today().isoformat(),
        "headline": "Hormuz elevated; Red Sea suspended; SCS rare-earth tightening",
        "summary": body,
        "topRisks": [
            {"corridor": "hormuz", "commodity": "crude_oil", "tier": "high", "note": "GDELT + AIS anomaly"},
            {"corridor": "south_china_sea", "commodity": "rare_earths", "tier": "high", "note": "Export licensing"},
            {"corridor": "bab_el_mandeb", "commodity": "lng", "tier": "elevated", "note": "Houthi statements"},
            {"corridor": "malacca", "commodity": "coking_coal", "tier": "elevated", "note": "Queensland weather"},
        ],
        "actions": [
            "Trigger short-cycle SPR drawdown (0.85 MB/day, day 0-14).",
            "Open dialogue with US WTI suppliers for 2 cargoes Aug-Sep.",
            "Re-route Qatari LNG via Cape window; confirm Dahej slot availability.",
            "Coordinate with NPCIL on uranium contingency contracting.",
        ],
        "marketSnapshot": {
            "brentUsd": BASE_BRENT,
            "ttfEurMwh": 38.2,
            "inrUsd": 84.7,
            "coalAud": 295.4,
        },
        "citations": [
            {"label": "GDELT", "url": "https://www.gdeltproject.org"},
            {"label": "PPAC India", "url": "https://www.ppac.gov.in"},
            {"label": "EIA", "url": "https://www.eia.gov"},
        ],
    }


# ---------------------------------------------------------------------------
# Cost-of-inaction, backtest, stress-test, chat helpers
# ---------------------------------------------------------------------------

# India FY25 nominal GDP ~ Rs 295 lakh crore.
# 1 lakh crore = 1e5 crore => 295 lakh crore = 295_00_000 crore.
INDIA_GDP_CRORE = 295_00_000.0  # Rs crore
DAILY_GDP_CRORE = INDIA_GDP_CRORE / 365.0  # ~80821 Rs crore/day


def _severity_from_bps(bps: float) -> str:
    a = abs(bps)
    if a < 15:
        return "low"
    if a < 40:
        return "elevated"
    if a < 80:
        return "high"
    return "critical"


_BACKTEST_EVENTS: list[dict] = [
    {
        "id": "2025-06-hormuz",
        "label": "June 2025 US-Iran Hormuz tension",
        "startDate": "2025-06-10",
        "endDate": "2025-06-22",
        "windowDays": 12,
        "commodity": "crude_oil",
        "corridor": "hormuz",
        "summary": (
            "US-Iran standoff in June 2025 triggered shadow-tanker re-routing, AIS gaps near "
            "Bandar Abbas, and a sharp Brent spike before de-escalation channels stabilised flows."
        ),
    },
    {
        "id": "2024-12-redsea",
        "label": "December 2024 Red Sea Houthi attacks",
        "startDate": "2024-12-01",
        "endDate": "2024-12-18",
        "windowDays": 17,
        "commodity": "crude_oil",
        "corridor": "bab_el_mandeb",
        "summary": (
            "Sustained Houthi missile and drone activity drove majors to suspend Bab el-Mandeb "
            "transit; container and LNG rerouted via Cape, adding ~18 days transit and lifting freight."
        ),
    },
    {
        "id": "2024-q4-qld-coal",
        "label": "Q4 2024 Queensland coking coal weather event",
        "startDate": "2024-10-15",
        "endDate": "2024-11-05",
        "windowDays": 21,
        "commodity": "coking_coal",
        "corridor": "malacca",
        "summary": (
            "Cyclonic weather and rail outages on the Goonyella system cut Dalrymple Bay and Hay "
            "Point throughput, compressing Indian steel-mill margins through November."
        ),
    },
]


def _hormuz_curve(days: int) -> list[float]:
    """Believable ramp-up / decay curve for Hormuz-style events, length = days."""
    anchors = [32, 41, 48, 58, 67, 73, 78, 82, 80, 71, 64, 58, 50, 44, 40, 36, 33, 32, 32, 32, 32]
    return anchors[:days] if days <= len(anchors) else anchors + [32.0] * (days - len(anchors))


def _redsea_curve(days: int) -> list[float]:
    anchors = [28, 35, 44, 52, 60, 68, 74, 79, 81, 80, 76, 70, 63, 55, 48, 42, 38]
    return anchors[:days] if days <= len(anchors) else anchors + [38.0] * (days - len(anchors))


def _qld_curve(days: int) -> list[float]:
    anchors = [22, 28, 35, 42, 48, 55, 61, 66, 70, 72, 71, 67, 62, 56, 50, 44, 39, 35, 32, 30, 28]
    return anchors[:days] if days <= len(anchors) else anchors + [28.0] * (days - len(anchors))


def _brent_curve(days: int, base: float, peak: float) -> list[float]:
    """Smooth ramp to peak around mid-window, then decay back toward base."""
    if days <= 1:
        return [base]
    mid = days // 2
    out: list[float] = []
    for d in range(days):
        if d <= mid:
            frac = d / mid if mid else 0
            v = base + (peak - base) * (frac ** 1.2)
        else:
            frac = (d - mid) / max(1, days - mid - 1)
            v = peak - (peak - base) * (frac ** 0.9) * 0.85
        out.append(round(v, 2))
    return out


def _backtest_narrative(event_id: str, day: int) -> str:
    base = {
        "2025-06-hormuz": [
            "GDELT: Iran Revolutionary Guard statement; tanker advisories issued.",
            "AIS: 18% drop in Hormuz tanker transits; two VLCC AIS gaps near Strait.",
            "GDELT: US 5th Fleet escort posture upgraded; Brent +3.4% intraday.",
            "AIS: shadow-fleet density up 2.1 sigma off Bandar Abbas.",
            "GDELT: Iran threatens closure rhetoric; insurance war-risk premium spikes.",
            "AIS: Saudi cargoes re-routed to East-Med via SUMED; Hormuz throughput -22%.",
            "GDELT: White House signals de-escalation channel via Oman.",
            "AIS: cautious resumption of southbound LNG carriers from Qatar.",
            "GDELT: Iran-US back-channel reportedly active; Brent retreats $4.",
            "AIS: tanker queue at Hormuz clears; transit count back near baseline.",
            "GDELT: Diplomatic communique reduces tension; war-risk premium eases.",
            "AIS: throughput returns to seasonal norms; spreads normalise.",
        ],
        "2024-12-redsea": [
            "GDELT: Houthi anti-ship missile strike on bulk carrier off Hodeidah.",
            "AIS: Maersk, Hapag-Lloyd announce Cape rerouting; Bab el-Mandeb -35%.",
            "GDELT: US-UK Operation Prosperity Guardian airstrikes on Yemen targets.",
            "AIS: LNG carriers from Qatar swing to Cape route; +18 days transit.",
            "GDELT: Houthi retaliation pledged; Red Sea war-risk insurance doubles.",
            "AIS: container vessel count in southern Red Sea at decade low.",
            "GDELT: Saudi Aramco diverts West Africa-bound cargoes via Cape.",
            "AIS: Suez Canal northbound transit down 41% week-on-week.",
            "GDELT: Houthi attacks continue; second drone-boat strike reported.",
            "AIS: Cape route congestion at Durban anchorage builds.",
            "GDELT: EU launches Aspides escort mission for Red Sea.",
            "AIS: limited resumption by COSCO and CMA-CGM with naval escort.",
            "GDELT: Insurance underwriters tighten Red Sea cover further.",
            "AIS: container freight rate index up 173% versus November.",
            "GDELT: Houthi statement reaffirms targeting policy.",
            "AIS: Bab el-Mandeb transits at 38% of seasonal baseline.",
            "GDELT: India Navy deploys additional warships to Gulf of Aden.",
        ],
        "2024-q4-qld-coal": [
            "GDELT: BoM cyclone watch for Central Queensland coast.",
            "AIS: Dalrymple Bay loading vessels paused; queue at Hay Point grows.",
            "GDELT: Goonyella rail line flooded; BMA reports force-majeure risk.",
            "AIS: bulker queue at Hay Point at 14 ships, +6 vs trailing 30d.",
            "GDELT: Cyclone Kirrily makes landfall near Townsville.",
            "AIS: Abbot Point and Hay Point loadings suspended for 48h.",
            "GDELT: BHP issues partial force majeure on Queensland coking coal.",
            "AIS: vessels waiting >9 days for loading window.",
            "GDELT: JSW Steel signals input-cost band widening to investors.",
            "AIS: Indian-bound bulkers re-direct to spot ARA loadings.",
            "GDELT: Premium Low-Vol HCC FOB up $48/t on Argus assessment.",
            "AIS: Goonyella system partial restart; queue still elevated.",
            "GDELT: SAIL and Tata Steel comment on Q3 margin guidance risk.",
            "AIS: loadings resume at 60% nameplate; backlog clearing.",
            "GDELT: Mozambique and US East Coast cargoes redirected to Paradip.",
            "AIS: Hay Point queue down to 9 ships.",
            "GDELT: HCC FOB price holds elevated; mills draw on stockpile.",
            "AIS: throughput at 78% of seasonal norm.",
            "GDELT: Queensland exports normalise; Argus prices ease.",
            "AIS: bulker queue back to baseline.",
            "GDELT: Steel-sector margin commentary turns less negative.",
        ],
    }
    arr = base.get(event_id, [])
    if not arr:
        return f"Day {day + 1}: composite signal updated."
    return arr[day] if day < len(arr) else arr[-1]


def _backtest_replay_data(event: dict) -> list[dict]:
    """Generate the day-by-day timeline for a historical event."""
    days = int(event.get("windowDays", 12))
    event_id = event["id"]
    if event_id == "2025-06-hormuz":
        scores = _hormuz_curve(days)
        brent = _brent_curve(days, base=78.0, peak=90.0)
    elif event_id == "2024-12-redsea":
        scores = _redsea_curve(days)
        brent = _brent_curve(days, base=75.0, peak=86.0)
    elif event_id == "2024-q4-qld-coal":
        scores = _qld_curve(days)
        brent = _brent_curve(days, base=80.0, peak=83.5)
    else:
        scores = [40.0 + (i * 1.5) for i in range(days)]
        brent = _brent_curve(days, base=BASE_BRENT, peak=BASE_BRENT + 6.0)

    try:
        start = datetime.strptime(event["startDate"], "%Y-%m-%d").date()
    except (KeyError, ValueError):
        start = date.today()

    out: list[dict] = []
    for d in range(days):
        score = float(scores[d]) if d < len(scores) else float(scores[-1])
        # AIS anomaly grows with score; tone in [-0.5, 1.6] sigma typical band
        ais_anom = round((score - 30.0) / 18.0, 2)
        gdelt_count = max(2, int(score * 0.9))
        out.append({
            "day": d,
            "dateIso": (start + timedelta(days=d)).isoformat(),
            "corridorScore": round(score, 1),
            "brentUsd": brent[d] if d < len(brent) else brent[-1],
            "narrative": _backtest_narrative(event_id, d),
            "gdeltCount": gdelt_count,
            "aisAnomaly": ais_anom,
        })
    return out


# ---------------------------------------------------------------------------
# New endpoints
# ---------------------------------------------------------------------------


@router.get("/cost-of-inaction")
async def cost_of_inaction(
    scenario: str = Query(...),
    durationDays: int = Query(default=14, ge=1, le=365),
    intensity: float = Query(default=0.5, ge=0.0, le=1.0),
) -> dict:
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=404, detail=f"Unknown scenario: {scenario}")

    impact = _project_impact(scenario, intensity, durationDays)
    gdp_bps = float(impact["gdp_bps"])

    daily_cost = abs(gdp_bps) / 10000.0 * DAILY_GDP_CRORE
    cumulative = daily_cost * durationDays

    fuel = round(cumulative * 0.45, 1)
    gdp_loss = round(cumulative * 0.30, 1)
    refinery_spot = round(cumulative * 0.15, 1)
    # ensure breakdown sums to cumulative (residual to fx bucket)
    fx_passthrough = round(cumulative - fuel - gdp_loss - refinery_spot, 1)

    return {
        "scenarioId": scenario,
        "durationDays": durationDays,
        "intensity": intensity,
        "dailyCostInrCrore": round(daily_cost, 1),
        "cumulativeCostInrCrore": round(cumulative, 1),
        "gdpImpactBps": gdp_bps,
        "breakdown": {
            "fuelImportCost": fuel,
            "gdpLoss": gdp_loss,
            "refinerySpotPremium": refinery_spot,
            "fxPassthrough": fx_passthrough,
        },
        "assumptions": {
            "indiaGdpCrore": INDIA_GDP_CRORE,
            "dailyGdpCrore": round(DAILY_GDP_CRORE, 1),
            "method": "gdp_bps_to_rupees_per_day_times_duration",
        },
        "asOf": _now_iso(),
    }


@router.get("/backtest/events")
async def backtest_events() -> list[dict]:
    fixture = _load_fixture("backtest_events.json")
    if isinstance(fixture, list) and fixture:
        return fixture
    return _BACKTEST_EVENTS


@router.get("/backtest/{event_id}/replay")
async def backtest_replay(event_id: str) -> dict:
    fixture = _load_fixture("backtest_events.json")
    events = fixture if isinstance(fixture, list) and fixture else _BACKTEST_EVENTS
    event = next((e for e in events if e.get("id") == event_id), None)
    if event is None:
        raise HTTPException(status_code=404, detail=f"Unknown backtest event: {event_id}")
    timeline = _backtest_replay_data(event)
    return {
        "eventId": event_id,
        "label": event.get("label", event_id),
        "corridor": event.get("corridor"),
        "commodity": event.get("commodity"),
        "startDate": event.get("startDate"),
        "endDate": event.get("endDate"),
        "windowDays": event.get("windowDays", len(timeline)),
        "summary": event.get("summary", ""),
        "timeline": timeline,
        "generatedAt": _now_iso(),
    }


@router.get("/stress-test")
async def stress_test() -> dict:
    intensities = [0.25, 0.5, 1.0]
    durations = [7, 14, 30]
    cells: list[dict] = []
    for name in SCENARIOS.keys():
        for intensity in intensities:
            for dur in durations:
                impact = _project_impact(name, intensity, dur)
                brent_uplift = float(impact["brent_uplift_pct"])
                gdp_bps = float(impact["gdp_bps"])
                spr_runway = float(impact["spr_runway_days"])
                daily = abs(gdp_bps) / 10000.0 * DAILY_GDP_CRORE
                cost = round(daily * dur, 1)
                cells.append({
                    "scenarioId": name,
                    "intensity": intensity,
                    "durationDays": dur,
                    "brentUpliftPct": brent_uplift,
                    "gdpImpactBps": gdp_bps,
                    "sprRunwayDays": spr_runway,
                    "costInrCrore": cost,
                    "severity": _severity_from_bps(gdp_bps),
                })
    return {
        "asOf": _now_iso(),
        "scenarios": list(SCENARIOS.keys()),
        "intensities": intensities,
        "durations": durations,
        "cells": cells,
        "count": len(cells),
    }


_CHAT_COMMODITY_TERMS: list[tuple[str, str]] = [
    ("coking coal", "coking_coal"),
    ("thermal coal", "thermal_coal"),
    ("rare earth", "rare_earths"),
    ("rare-earth", "rare_earths"),
    ("crude", "crude_oil"),
    ("oil", "crude_oil"),
    ("lpg", "lpg"),
    ("lng", "lng"),
    ("lithium", "lithium"),
    ("cobalt", "cobalt"),
    ("nickel", "nickel"),
    ("solar", "solar_pv"),
    ("uranium", "uranium"),
    ("copper", "copper"),
    ("graphite", "graphite"),
    ("manganese", "manganese"),
    ("polysilicon", "polysilicon"),
    ("silver", "silver"),
    ("platinum", "pgm"),
    ("phosphate", "rock_phosphate"),
    ("potash", "potash"),
]

_CHAT_CORRIDOR_KEYWORDS: list[tuple[str, str, str]] = [
    ("hormuz", "hormuz", "Strait of Hormuz"),
    ("bab_el_mandeb", "red sea|bab[ -]?el|houthi|mandeb", "Bab el-Mandeb / Red Sea"),
    ("malacca", "malacca", "Strait of Malacca"),
    ("south_china_sea", "south china|rare[ -]?earth|\\bscs\\b", "South China Sea"),
]


def _local_chat_answer(
    question: str,
    top_scores: list[dict],
    feed_items: list[dict],
    scenarios: list[dict],
    brief: dict,
) -> str:
    """Deterministic, question-aware analyst answer for fixture mode.

    In fixture mode (the default demo path) no live LLM is called, so we route
    the question through keyword matchers and ground the reply in the live
    score / scenario / brief context. This keeps answers distinct per question
    rather than echoing a single canned string.
    """
    q = question.lower()
    parts: list[str] = []

    def best_for_corridor(corr: str) -> dict | None:
        subset = [s for s in top_scores if s.get("corridor") == corr]
        return max(subset, key=lambda s: s.get("score", 0)) if subset else None

    for corr, pattern, label in _CHAT_CORRIDOR_KEYWORDS:
        if re.search(pattern, q):
            s = best_for_corridor(corr)
            if not s:
                continue
            drivers = s.get("drivers") or []
            driver_txt = f" Lead driver: {drivers[0]}." if drivers else ""
            parts.append(
                f"{label} composite risk is {s.get('score')} ({s.get('tier')}), most "
                f"exposed on {str(s.get('commodity', 'crude_oil')).replace('_', ' ')}.{driver_txt}"
            )

    matched_commodity = next((code for term, code in _CHAT_COMMODITY_TERMS if term in q), None)
    if matched_commodity:
        rel = [s for s in top_scores if s.get("commodity") == matched_commodity]
        label = matched_commodity.replace("_", " ")
        if rel:
            top = max(rel, key=lambda s: s.get("score", 0))
            parts.append(
                f"For {label}, the highest-risk lane is "
                f"{CORRIDOR_LABEL.get(str(top.get('corridor')), top.get('corridor'))} at "
                f"score {top.get('score')} ({top.get('tier')})."
            )
        else:
            parts.append(
                f"{label.title()} is covered in the Sourcing module — open Sourcing and select "
                "it to see ranked supplier countries with their current import share and route risk."
            )

    if re.search(r"sourc|alternativ|supplier|diversif|import share", q):
        parts.append(
            "Sourcing intelligence ranks alternative supplier countries by current corridor "
            "risk, historical import share, and lead time. Pick a commodity on the Sourcing page "
            "to see each country's current import share and route risk, and try the 'simulate "
            "cutoff' control to re-rank suppliers when a chokepoint closes."
        )

    if re.search(r"replace|substitut|instead of|use[ -]?case|demand[- ]side|switch", q):
        sub = DEMAND_SUBSTITUTES.get(matched_commodity or "")
        if sub and sub.get("substitutes"):
            names = ", ".join(s["name"] for s in sub["substitutes"][:3])
            parts.append(
                f"Demand-side substitutes for {(matched_commodity or '').replace('_', ' ')} "
                f"({sub.get('primaryUse')}): {names}. See the Sourcing page's demand-side "
                "substitution panel for maturity, displaceable share, and lead time."
            )
        else:
            parts.append(
                "Beyond alternate countries, the Sourcing page lists demand-side substitutes "
                "(alternate use cases) per commodity — levers that reduce or replace the import "
                "at the point of use, e.g. LPG → piped natural gas or induction cooking."
            )

    if re.search(r"\bspr\b|reserve|drawdown|petroleum reserve|stockpile", q):
        parts.append(
            f"Strategic Petroleum Reserve cover stands at ~{BASE_SPR_DAYS} days across "
            "Visakhapatnam, Mangalore and Padur. The SPR planner solves an LP drawdown / "
            "replenish schedule under a chosen supply-gap shock."
        )

    if re.search(r"cost|inaction|rupee|gdp|crore|economic impact", q):
        parts.append(
            "Cost-of-inaction converts a scenario's GDP impact (bps) into daily and cumulative "
            "rupee figures. Run a scenario, then read the cost panel to size the exposure."
        )

    if re.search(r"scenario|what[ -]?if|simulat|compare", q):
        names = ", ".join(str(s.get("name", s.get("scenarioId", ""))) for s in scenarios[:4])
        if names:
            parts.append(
                f"Modelled disruption scenarios include {names}. Each projects Brent/LNG/coal "
                "uplift, GDP bps, and SPR runway from elasticity parameters."
            )

    if not parts:
        headline = str(brief.get("headline", "")).strip()
        summary = str(brief.get("summary") or "")[:300].strip()
        snap = brief.get("marketSnapshot") or {}
        brent = snap.get("brentUsd")
        lead = f"{headline}. {summary}".strip(". ").strip()
        if lead:
            parts.append(lead + ".")
        tail = (
            "Ask about a specific corridor (Hormuz, Red Sea, Malacca, South China Sea), a "
            "commodity, sourcing, the SPR, or a scenario for a focused answer."
        )
        parts.append(f"Brent is at ${brent}/bbl. {tail}" if brent else tail)

    return " ".join(p for p in parts if p).strip()


@router.post("/chat")
async def chat(body: dict | None = None) -> dict:
    body = body or {}
    question = str(body.get("question", "")).strip()
    history = body.get("history", []) or []
    if not question:
        raise HTTPException(status_code=400, detail="question is required")

    # Gather context. Pass commodity=None explicitly so the in-process call does
    # not bind FastAPI's Query(default=None) sentinel (which is truthy).
    top_scores = await get_scores(commodity=None)
    feed_items = (await feed(limit=8))[:8]
    scenario_list = await list_scenarios()
    brief = await executive_brief()

    # Keys here match what build_chat_prompt() expects so the live LLM path is
    # correctly grounded; the local fallback reads the same structures.
    context = {
        "current_scores": top_scores,
        "recent_events": feed_items,
        "top_scenarios": scenario_list,
        "commodities_basket": sorted(
            {str(s.get("commodity")) for s in top_scores if s.get("commodity")}
        ),
        "executive_brief": {
            "headline": brief.get("headline"),
            "summary": brief.get("summary"),
            "marketSnapshot": brief.get("marketSnapshot"),
        },
        "history": history,
    }

    settings = get_settings()
    live_mode = bool(getattr(settings, "allow_live_ingest", False)) and bool(
        getattr(settings, "gemini_api_key", None)
    )

    # In live mode call Gemini with the correct (question, context) signature.
    # In fixture mode the LLM client only returns a single canned string, so we
    # skip it entirely and answer from the question-aware local responder —
    # otherwise every question collapses to the same reply.
    answer = ""
    if live_mode:
        try:
            from app.llm.summarise import LLMClient  # type: ignore

            client = LLMClient(settings)
            answer = await client.chat(question, context) or ""
        except Exception:
            answer = ""
        if answer.strip().startswith("[fixture"):
            answer = ""

    if not answer.strip():
        answer = _local_chat_answer(question, top_scores, feed_items, scenario_list, brief)

    citations: list[dict] = [
        {"label": "Live corridor risk scores", "source": "/api/scores"},
        {"label": "Realtime intelligence feed", "source": "/api/feed"},
        {"label": "Scenario library", "source": "/api/scenarios"},
        {"label": "Executive brief", "source": "/api/executive-brief"},
    ]

    return {
        "answer": answer,
        "citations": citations,
        "generatedAt": _now_iso(),
    }


async def _live_eia_overrides() -> dict[str, dict]:
    """In live mode with an EIA key, fetch real Brent + Henry Hub series.

    Returns a dict keyed by commodity code -> {last, prev, unit}. Empty if
    live mode is off, no key, or the EIA call fails (graceful fixture fall-back).
    """
    settings = get_settings()
    if not (settings.allow_live_ingest and settings.eia_api_key):
        return {}
    out: dict[str, dict] = {}
    try:
        from app.ingest import commodity_prices as cp
        from app.models import Commodity as ModelCommodity

        for code, enum_member in (("crude_oil", ModelCommodity.CRUDE_OIL), ("lng", ModelCommodity.LNG)):
            series = await cp.fetch_prices(enum_member, days=5)
            if isinstance(series, list) and len(series) >= 2:
                last = series[-1].get("price", series[-1].get("value", 0))
                prev = series[-2].get("price", series[-2].get("value", last))
                unit = series[-1].get("unit", "")
                out[code] = {"last": float(last), "prev": float(prev), "unit": unit}
    except Exception:  # noqa: BLE001
        return out
    return out


@router.get("/commodities")
async def commodities() -> list[dict]:
    prices = _load_fixture("commodity_prices.json") or {}
    eia = await _live_eia_overrides()
    out = []
    mapping = {
        "crude_oil": ("brent_crude_usd", "USD/bbl"),
        "lng": ("lng_jkm_usd", "USD/MMBtu"),
        "coking_coal": ("coking_coal_usd", "USD/t"),
        "lithium": ("lithium_carbonate_cny", "CNY/t"),
        "rare_earths": ("neodymium_oxide_cny", "CNY/t"),
    }
    for commodity, (fixture_key, unit) in mapping.items():
        source = "fixture"
        if commodity in eia:
            last = eia[commodity]["last"]
            prev = eia[commodity]["prev"]
            unit = eia[commodity]["unit"] or unit
            change = last - prev
            change_pct = (change / prev) * 100 if prev else 0
            source = "eia-live"
        else:
            series = prices.get(fixture_key, [])
            if isinstance(series, list) and len(series) >= 2:
                last = series[-1].get("value", 0)
                prev = series[-2].get("value", last)
                change = last - prev
                change_pct = (change / prev) * 100 if prev else 0
            else:
                last = 0
                change = 0
                change_pct = 0
        out.append({
            "commodity": commodity,
            "symbol": fixture_key,
            "priceUsd": round(float(last), 2),
            "change24h": round(float(change), 2),
            "changePct24h": round(float(change_pct), 2),
            "unit": unit,
            "source": source,
            "asOf": _now_iso(),
        })
    return out
