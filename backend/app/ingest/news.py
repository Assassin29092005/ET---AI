"""News headline ingestion.

Sources:
  - NewsAPI: https://newsapi.org/docs/endpoints/everything
  - Fallback: GDELT DOC API for article search (no key required).

Returns headlines normalized to {title, source, published_at, url, description}.
"""

from __future__ import annotations

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

_NEWSAPI_URL = "https://newsapi.org/v2/everything"
_GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc"
_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "news.json"
_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)


async def fetch_headlines(query: str, hours: int = 24) -> list[dict]:
    """Search news headlines matching the query within the last `hours`."""
    if not settings.allow_live_ingest:
        log.info("news.fixture_mode", query=query, hours=hours)
        return _load_fixture(query, hours)

    if settings.newsapi_key:
        try:
            return await _fetch_newsapi(query, hours)
        except httpx.HTTPError as exc:
            log.warning("news.newsapi_failed", error=str(exc))

    try:
        return await _fetch_gdelt_articles(query, hours)
    except httpx.HTTPError as exc:
        log.warning("news.gdelt_failed", error=str(exc))
        return _load_fixture(query, hours)


async def _fetch_newsapi(query: str, hours: int) -> list[dict]:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    params = {
        "q": query,
        "from": since,
        "sortBy": "publishedAt",
        "language": "en",
        "pageSize": 50,
        "apiKey": settings.newsapi_key,
    }
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(3),
        wait=wait_exponential(min=1, max=8),
        retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
        reraise=True,
    ):
        with attempt:
            async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
                resp = await client.get(_NEWSAPI_URL, params=params)
                resp.raise_for_status()
                payload = resp.json()

    return [
        {
            "title": a.get("title", ""),
            "source": (a.get("source") or {}).get("name", ""),
            "published_at": a.get("publishedAt"),
            "url": a.get("url"),
            "description": a.get("description", ""),
        }
        for a in payload.get("articles", [])
    ]


async def _fetch_gdelt_articles(query: str, hours: int) -> list[dict]:
    params = {
        "query": query,
        "mode": "ArtList",
        "format": "JSON",
        "maxrecords": "50",
        "timespan": f"{int(hours)}h",
        "sort": "DateDesc",
    }
    async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
        resp = await client.get(_GDELT_DOC_API, params=params)
        resp.raise_for_status()
        payload = resp.json()

    return [
        {
            "title": a.get("title", ""),
            "source": a.get("domain", ""),
            "published_at": a.get("seendate"),
            "url": a.get("url"),
            "description": a.get("snippet", ""),
        }
        for a in payload.get("articles", [])
    ]


def load_corridor_fixture() -> dict[str, list[dict]]:
    """Return the raw per-corridor news snapshot ``{corridor: [article, ...]}``.

    Used by the scoring engine in fixture mode to read articles per corridor
    directly, mirroring how the GDELT snapshot is consumed — the fixture is a
    static current-state snapshot, so no time filtering is applied. Keys
    starting with ``_`` (e.g. ``_comment``) are ignored. Returns ``{}`` if the
    file is missing or is a legacy flat array.
    """
    if not _FIXTURE_PATH.exists():
        log.warning("news.fixture_missing", path=str(_FIXTURE_PATH))
        return {}
    with _FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        return {}
    return {
        k: v
        for k, v in data.items()
        if not k.startswith("_") and isinstance(v, list)
    }


def _load_fixture(query: str, hours: int) -> list[dict]:
    """Keyword-filtered flat read, used as the live-path last-resort fallback.

    Accepts both the per-corridor dict shape and a legacy flat array. The
    fixture is treated as a static snapshot, so rows are not dropped by age.
    """
    if not _FIXTURE_PATH.exists():
        log.warning("news.fixture_missing", path=str(_FIXTURE_PATH))
        return []
    with _FIXTURE_PATH.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    if isinstance(data, dict):
        rows: list[dict] = []
        for k, v in data.items():
            if not k.startswith("_") and isinstance(v, list):
                rows.extend(v)
    else:
        rows = data

    needles = [t.lower() for t in query.split() if t]
    out: list[dict] = []
    for r in rows:
        title = (r.get("title") or "").lower()
        desc = (r.get("description") or "").lower()
        if needles and not any(n in title or n in desc for n in needles):
            continue
        out.append(r)
    return out
