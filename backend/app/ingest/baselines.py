"""Live refresh of *data* baselines used by the scenario projection.

Distinct from `ingest/commodity_prices.py` (which fetches per-commodity time
series for the risk-score price-vol component); this module pulls the CURRENT
spot values that anchor the scenario model's projections (Brent today, Henry
Hub today, USD/INR today). On startup the FastAPI lifespan hook calls
`refresh_live_baselines()`; the function mutates the corresponding module
globals in `app.api.routes` and `app.engines.scenarios` so every subsequent
request reflects live spot prices.

Model parameters (elasticities, transmission coefficients, the
SCENARIO_SECTOR_TRANSMISSION matrix) are deliberately NOT touched — those are
calibration constants documented in `docs/assumptions.md`, not data.

Graceful degradation: every fetch is wrapped in a broad try/except. A failed
or missing API leaves the documented fallback value in place; the app never
fails to start because a third-party endpoint is down.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

import httpx
import structlog

from app.config import get_settings
from app.models import Commodity

log = structlog.get_logger(__name__)
_settings = get_settings()


# Public snapshot of what was actually live-loaded (timestamp + value), so the
# UI/health probe can show "Brent baseline: $83.42 live, refreshed 12:04 UTC".
LIVE_BASELINES: dict[str, dict] = {}


async def _fetch_usd_inr() -> Optional[float]:
    """USD->INR via the EU Commission's Frankfurter feed (free, no key, ECB ref)."""
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            r = await client.get(
                "https://api.frankfurter.dev/v1/latest",
                params={"base": "USD", "symbols": "INR"},
            )
            r.raise_for_status()
            data = r.json()
            inr = data.get("rates", {}).get("INR")
            return float(inr) if inr else None
    except Exception as exc:
        log.warning("baselines.fx_failed", error=str(exc))
        return None


async def _latest_price(commodity: Commodity) -> Optional[float]:
    """Tail of the commodity_prices series — last available daily close."""
    from app.ingest import commodity_prices  # local import to avoid cycles
    try:
        series = await commodity_prices.fetch_prices(commodity, days=3)
        if not series:
            return None
        # Series is chronological; trust the last point.
        latest = series[-1]
        price = latest.get("price") if isinstance(latest, dict) else None
        return float(price) if price is not None else None
    except Exception as exc:
        log.warning("baselines.price_failed", commodity=commodity.value, error=str(exc))
        return None


def _stamp(key: str, value: float, source: str) -> None:
    LIVE_BASELINES[key] = {
        "value": round(value, 4),
        "source": source,
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
    }


async def refresh_live_baselines() -> dict[str, dict]:
    """Refresh every data baseline we have a key (or a free API) for, and
    mutate the consuming modules' globals so subsequent requests see live
    values. Returns the LIVE_BASELINES snapshot for logging."""
    if not _settings.allow_live_ingest:
        log.info("baselines.skip_fixture_mode")
        # Seed the 5 core display values from documented calibration constants
        # so the /api/baselines endpoint (and the Baselines page) is never empty.
        from app.api import routes
        from app.engines import scenarios as scen
        _stamp("brent_usd_bbl", routes.BASE_BRENT, "fixture (FY26 calibration)")
        _stamp("henry_hub_usd_mmbtu", scen.BASELINE.get("jkm_usd_mmbtu", 12.5),
               "fixture (FY26 calibration)")
        _stamp("copper_usd_t", 8400.0, "fixture (FY26 calibration)")
        _stamp("inr_per_usd", scen.BASELINE.get("inr_per_usd", 83.5),
               "fixture (FY26 calibration)")
        mbd = scen.BASELINE.get("india_crude_import_mbd", 5.10)
        bill = round(mbd * 1000.0 * routes.BASE_BRENT / 1000.0, 1)
        _stamp("india_import_bill_usdm", bill, "derived: crude_mbd × Brent")
        return LIVE_BASELINES

    # Fan out — all five fetches are independent.
    from app.ingest.pump_prices import fetch_indian_pump_prices

    brent, lng, copper, fx, pumps = await asyncio.gather(
        _latest_price(Commodity.CRUDE_OIL),
        _latest_price(Commodity.LNG),
        _latest_price(Commodity.COPPER),
        _fetch_usd_inr(),
        fetch_indian_pump_prices(),
        return_exceptions=False,
    )

    # Patch into the modules that actually serve the API — routes.py is the
    # integration layer; scenarios.py BASELINE dict is also kept in sync so
    # the engine helpers (which the route mostly bypasses, but exist) agree.
    from app.api import routes
    from app.engines import scenarios

    if brent:
        routes.BASE_BRENT = brent
        scenarios.BASELINE["brent_usd_bbl"] = brent
        _stamp("brent_usd_bbl", brent, "EIA/Alpha Vantage")
    else:
        _stamp("brent_usd_bbl", routes.BASE_BRENT, "fixture (FY26 calibration)")
    if lng:
        scenarios.BASELINE["jkm_usd_mmbtu"] = lng
        _stamp("henry_hub_usd_mmbtu", lng, "EIA")
    else:
        _stamp("henry_hub_usd_mmbtu", scenarios.BASELINE.get("jkm_usd_mmbtu", 12.5),
               "fixture (FY26 calibration)")
    if copper:
        _stamp("copper_usd_t", copper, "Alpha Vantage")
    else:
        _stamp("copper_usd_t", 8400.0, "fixture (FY26 calibration)")
    if fx:
        scenarios.BASELINE["inr_per_usd"] = fx
        _stamp("inr_per_usd", fx, "Frankfurter (ECB)")
    else:
        _stamp("inr_per_usd", 83.5, "fixture (FY26 calibration)")

    # Daily import bill: derived from crude_mbd × Brent. Compute from
    # whichever Brent value we ended up with (live or fixture fallback).
    effective_brent = brent if brent else routes.BASE_BRENT
    mbd = scenarios.BASELINE.get("india_crude_import_mbd", 5.10)
    bill = round(mbd * 1000.0 * effective_brent / 1000.0, 1)
    if brent and fx:
        routes.BASE_IMPORT_COST_USDM = bill
    _stamp("india_import_bill_usdm", bill, "derived: crude_mbd × Brent")

    if isinstance(pumps, dict):
        if "diesel" in pumps:
            routes.BASE_DIESEL_INR = pumps["diesel"]
            _stamp("diesel_inr_per_l", pumps["diesel"], "goodreturns.in (scraped)")
        if "petrol" in pumps:
            _stamp("petrol_inr_per_l", pumps["petrol"], "goodreturns.in (scraped)")
        if "lpg" in pumps:
            _stamp("lpg_inr_per_cyl", pumps["lpg"], "goodreturns.in (scraped)")
        if "cng" in pumps:
            _stamp("cng_inr_per_kg", pumps["cng"], "goodreturns.in (scraped)")

    return LIVE_BASELINES
