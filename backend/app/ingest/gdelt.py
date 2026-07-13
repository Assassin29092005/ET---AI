"""GDELT 2.0 event ingestion.

Source: GDELT Project 2.0 GKG / Events API
  - Docs: https://www.gdeltproject.org/data.html
  - Events 2.0: http://data.gdeltproject.org/gdeltv2/lastupdate.txt
  - GKG themes: https://blog.gdeltproject.org/gdelt-global-knowledge-graph-categorical-themes/

GDELT is queried for energy-relevant themes (ENERGY, TANKER, OIL_GAS, MARITIME,
EMBARGO, SANCTIONS) to surface geopolitical events affecting India's import
corridors. Each event carries an actor pair, geo-location, average tone, and
a CAMEO event code.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import structlog
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.config import get_settings

settings = get_settings()

log = structlog.get_logger(__name__)

_GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc"
_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "gdelt_events.json"
_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)


async def fetch_events(
    window_hours: int = 24,
    themes: list[str] | None = None,
) -> list[dict]:
    """Fetch GDELT events for the given themes within a rolling window.

    Args:
        window_hours: Lookback window in hours.
        themes: GDELT GKG themes (e.g. ENERGY, TANKER, OIL_GAS). Defaults to
            the energy-relevant set.

    Returns:
        List of normalized events with keys: timestamp, actors, location, lat,
        lon, tone, event_code, urls.
    """
    themes = themes or [
        "ENERGY", "TANKER", "OIL_GAS",
        "MARITIME", "EMBARGO", "BLOCKADE",
        "MILITARY", "ARMEDCONFLICT", "SANCTIONS",
        "ECON_OILPRICE", "TERROR",
    ]

    if not settings.allow_live_ingest:
        log.info("gdelt.fixture_mode", themes=themes, window_hours=window_hours)
        return _load_fixture(themes, window_hours)

    query = " OR ".join(f"theme:{t}" for t in themes)
    params = {
        "query": query,
        "mode": "ArtList",
        "format": "JSON",
        "maxrecords": "75",
        "timespan": f"{int(window_hours)}h",
        "sort": "DateDesc",
    }

    try:
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential(min=1, max=8),
            retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
            reraise=True,
        ):
            with attempt:
                async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
                    resp = await client.get(_GDELT_DOC_API, params=params)
                    resp.raise_for_status()
                    payload = resp.json()
    except httpx.HTTPError as exc:
        log.warning("gdelt.live_failed", error=str(exc))
        return _load_fixture(themes, window_hours)

    return [_normalize_article(a) for a in payload.get("articles", [])]


def _normalize_article(article: dict) -> dict:
    return {
        "timestamp": article.get("seendate"),
        "actors": [article.get("sourcecountry", "")],
        "location": article.get("location", ""),
        "lat": article.get("lat"),
        "lon": article.get("lon"),
        "tone": float(article.get("tone", 0.0)) if article.get("tone") is not None else 0.0,
        "event_code": article.get("event_code", "ARTICLE"),
        "urls": [article.get("url")] if article.get("url") else [],
    }


def _load_fixture(themes: list[str], window_hours: int) -> list[dict]:
    if not _FIXTURE_PATH.exists():
        log.warning("gdelt.fixture_missing", path=str(_FIXTURE_PATH))
        return []

    with _FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        events = json.load(fh)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    theme_keys = {t.upper() for t in themes}
    filtered: list[dict] = []
    for ev in events:
        ev_themes = {t.upper() for t in ev.get("themes", [])}
        if theme_keys and not (ev_themes & theme_keys):
            continue
        try:
            ts = datetime.fromisoformat(str(ev["timestamp"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            ts = datetime.now(timezone.utc)
        if ts < cutoff:
            continue
        filtered.append(ev)
    return filtered


# CSV mirror parsing kept available for direct GDELT 2.0 export consumption.
def _parse_export_csv(text: str) -> list[dict]:
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    rows: list[dict] = []
    for r in reader:
        if len(r) < 60:
            continue
        rows.append(
            {
                "timestamp": r[1],
                "actors": [r[6], r[16]],
                "location": r[39],
                "lat": float(r[40]) if r[40] else None,
                "lon": float(r[41]) if r[41] else None,
                "tone": float(r[34]) if r[34] else 0.0,
                "event_code": r[26],
                "urls": [r[57]],
            }
        )
    return rows
