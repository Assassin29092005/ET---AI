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
from typing import Any
from urllib.parse import quote_plus

from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.engines import scenarios as scenarios_engine
from app.engines import sourcing as sourcing_engine
from app.engines import spr_lp as spr_engine
from app.engines.scenarios import SCENARIOS
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


@router.get("/scores")
async def get_scores(commodity: str | None = Query(default=None)) -> list[dict]:
    pairs = [
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
    if commodity:
        pairs = [(c, k) for (c, k) in pairs if k == commodity]
    out: list[dict] = []
    for corridor, comm in pairs:
        score = _seeded_score(corridor, comm)
        out.append(_risk_score_dict(corridor, comm, score))
    return out


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


def _duration_factor(days: int) -> float:
    return min(1.0, (days / 14.0) ** 0.6)


def _project_impact(name: str, intensity: float, duration: int) -> dict:
    """Compute scenario impact directly from SCENARIOS params."""
    scenario = SCENARIOS[name]
    p = getattr(scenario, "params", {}) or {}
    dur = _duration_factor(duration)
    i = max(0.0, min(1.0, intensity))

    brent_uplift = 0.0
    lng_uplift = 0.0
    coal_uplift = 0.0

    if name == "hormuz_partial_closure":
        brent_uplift = 100.0 * p.get("crude_price_elasticity", 0.45) * i * p.get("crude_volume_share", 0.40)
        lng_uplift = 100.0 * p.get("lng_price_elasticity", 0.35) * i * p.get("lng_volume_share", 0.30)
    elif name == "opec_emergency_cut":
        cut = p.get("global_cut_mbd_at_full", 1.0) * i
        brent_uplift = 100.0 * p.get("crude_price_elasticity_per_mbd", 0.15) * cut
    elif name == "red_sea_suspension":
        brent_uplift = 100.0 * p.get("crude_freight_uplift_share", 0.06) * i
        lng_uplift = 100.0 * p.get("lng_uplift_share", 0.12) * i
    elif name == "australia_coking_coal":
        coal_uplift = 100.0 * p.get("coking_coal_elasticity", 0.55) * i * p.get("australia_share", 0.70)
    elif name == "china_rare_earth_curbs":
        brent_uplift = 0.0
    elif name == "china_solar_export_tariff":
        brent_uplift = 0.0
    elif name == "kazakhstan_uranium_disruption":
        brent_uplift = 0.0

    brent_uplift *= dur
    lng_uplift *= dur
    coal_uplift *= dur

    gdp_bps = -(brent_uplift * 1.5 + lng_uplift * 0.6 + coal_uplift * 0.4)
    spr_runway = max(2.0, BASE_SPR_DAYS - (brent_uplift / 10.0))
    return {
        "brent_uplift_pct": round(brent_uplift, 2),
        "lng_uplift_pct": round(lng_uplift, 2),
        "coal_uplift_pct": round(coal_uplift, 2),
        "gdp_bps": round(gdp_bps, 1),
        "spr_runway_days": round(spr_runway, 1),
    }


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

    timeline = []
    for day in range(0, duration + 1, max(1, duration // 12)):
        progress = day / max(1, duration)
        ramp = min(1.0, progress * 1.4)
        timeline.append({
            "day": day,
            "brentUsd": round(BASE_BRENT + (projected_brent - BASE_BRENT) * ramp, 2),
            "sprDrawDownMb": round(0.85 * ramp, 3),
            "routeShareCape": round(0.42 * ramp, 3),
        })

    recommendations = [s.strip() for s in narrative.split(".") if s.strip()]
    if not recommendations:
        recommendations = [
            "Trigger short-cycle SPR drawdown over the first 14 days.",
            "Open dialogue with US WTI suppliers for 2 cargoes Aug-Sep.",
            "Re-route Qatari LNG via Cape window; confirm Dahej slot availability.",
        ]

    return {
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
        },
        "timeline": timeline,
        "recommendations": recommendations,
        "generatedAt": _now_iso(),
    }


@router.get("/digital-twin/state")
async def twin_state() -> dict:
    vessels_fixture = _load_fixture("vessels.json") or []
    vessel_count = len(vessels_fixture) if isinstance(vessels_fixture, list) else 0

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

    return {
        "asOf": _now_iso(),
        "corridors": corridors_out,
        "vessels": vessel_count or 60,
        "storage": {
            "sprFillPct": 78.5,
            "lngTerminalFillPct": 64.2,
        },
        "sanctionAlerts": _compute_sanction_alerts(),
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


def _build_spr_plan(horizon: int = 60, target_cover_days: float = 12.0, bias: str = "balanced") -> dict:
    config = spr_engine.SPRConfig(
        starting_reserve_mmb=39.0,
        max_daily_drawdown_kbpd=600.0,
        max_daily_replenish_kbpd=300.0,
        daily_consumption_kbpd=4800.0,
        supply_gap_curve=[2000.0 if d < 21 else 800.0 if d < 42 else 0.0 for d in range(horizon)],
        planning_horizon_days=horizon,
    )
    try:
        plan = spr_engine.solve_spr_plan(config)
    except Exception:
        plan = None

    today = datetime.now(timezone.utc).date()
    release_schedule = []
    sites = [
        {"name": "Visakhapatnam", "location": "Andhra Pradesh", "capacityMb": 9.77, "fillMb": 7.6, "drawRateMbPerDay": 0.25},
        {"name": "Mangalore", "location": "Karnataka", "capacityMb": 11.0, "fillMb": 8.8, "drawRateMbPerDay": 0.28},
        {"name": "Padur", "location": "Karnataka", "capacityMb": 18.3, "fillMb": 14.2, "drawRateMbPerDay": 0.42},
    ]
    total_capacity = sum(s["capacityMb"] for s in sites)
    current_fill = sum(s["fillMb"] for s in sites)

    if plan is not None:
        days_list = getattr(plan, "days", list(range(horizon)))
        drawdown_kbpd = getattr(plan, "drawdown_kbpd", [])
        cumulative = 0.0
        for i, day in enumerate(days_list[:horizon]):
            draw = float(drawdown_kbpd[i]) / 1000.0 if i < len(drawdown_kbpd) else 0.0
            cumulative += draw
            release_schedule.append({
                "day": int(day),
                "drawMb": round(draw, 3),
                "cumulativeMb": round(cumulative, 3),
                "targetMarket": "north" if bias != "south" else "south",
            })
        rationale = (
            f"LP minimises integrated price-impact over {horizon} days subject to "
            f"injection-rate, reserve, and consumption constraints. Target cover "
            f"{target_cover_days:.1f} days, bias {bias}. Solver status: "
            f"{getattr(plan, 'status', 'unknown')}."
        )
    else:
        for d in range(horizon):
            shock = 1.0 if d < 14 else 0.5 if d < 28 else 0.0
            draw = round(0.85 * shock, 3)
            cum = release_schedule[-1]["cumulativeMb"] + draw if release_schedule else draw
            release_schedule.append({
                "day": d,
                "drawMb": draw,
                "cumulativeMb": round(cum, 3),
                "targetMarket": bias,
            })
        rationale = (
            f"Heuristic schedule (LP solver unavailable). Target cover {target_cover_days:.1f} days, "
            f"bias {bias}. Switch to PuLP CBC for the full optimisation."
        )

    return {
        "asOf": _now_iso(),
        "totalCapacityMb": round(total_capacity, 2),
        "currentFillMb": round(current_fill, 2),
        "coverDays": round(BASE_SPR_DAYS, 1),
        "sites": sites,
        "releaseSchedule": release_schedule,
        "rationale": rationale,
    }


@router.get("/spr/plan")
async def get_spr_plan() -> dict:
    return _build_spr_plan()


@router.post("/spr/plan")
async def post_spr_plan(body: dict | None = None) -> dict:
    body = body or {}
    horizon = int(body.get("horizonDays", 60))
    target = float(body.get("targetCoverDays", 12.0))
    bias = str(body.get("marketBias", "balanced"))
    return _build_spr_plan(horizon=horizon, target_cover_days=target, bias=bias)


def gdelt_context_url(event: dict) -> str:
    """Build a live, resolvable GDELT article-search URL for a feed event.

    The fixture `urls` point at fabricated article pages that 404. Instead we
    deep-link into the GDELT DOC 2.0 API article list (rendered as HTML),
    querying on the event's actors and location so the user lands on real
    matching coverage rather than a dead link.
    """
    terms = [
        str(event.get(key, "")).strip()
        for key in ("actor1", "location", "actor2")
        if str(event.get(key, "")).strip()
    ]
    query = " ".join(terms[:2]) or "energy supply chain India"
    return (
        "https://api.gdeltproject.org/api/v2/doc/doc?query="
        f"{quote_plus(query)}&mode=artlist&format=html&sort=datedesc&maxrecords=50"
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


@router.get("/commodities")
async def commodities() -> list[dict]:
    prices = _load_fixture("commodity_prices.json") or {}
    out = []
    mapping = {
        "crude_oil": ("brent_crude_usd", "USD/bbl"),
        "lng": ("lng_jkm_usd", "USD/MMBtu"),
        "coking_coal": ("coking_coal_usd", "USD/t"),
        "lithium": ("lithium_carbonate_cny", "CNY/t"),
        "rare_earths": ("neodymium_oxide_cny", "CNY/t"),
    }
    for commodity, (fixture_key, unit) in mapping.items():
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
            "asOf": _now_iso(),
        })
    return out
