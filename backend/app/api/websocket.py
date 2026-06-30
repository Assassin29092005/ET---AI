"""WebSocket endpoints for live push updates to the frontend.

/ws/feed pushes new FeedItem dicts every 8 seconds in fixture mode, simulating
real-time GDELT and news ingestion. The initial connection receives a small
back-fill (5 most recent items) so the UI is populated immediately.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.config import get_settings

logger = logging.getLogger(__name__)


SYNTHETIC_HEADLINES: list[dict[str, Any]] = [
    {
        "source": "GDELT",
        "headline": "Iranian Foreign Ministry statement raises Hormuz transit concerns",
        "corridor": "hormuz",
        "commodity": "crude_oil",
    },
    {
        "source": "AISStream",
        "headline": "VLCC density 1.7 sigma above 90-day baseline near Strait of Hormuz",
        "corridor": "hormuz",
        "commodity": "crude_oil",
    },
    {
        "source": "OFAC",
        "headline": "New SDN listing affects shadow tanker operator linked to Iran exports",
        "corridor": "hormuz",
        "commodity": "crude_oil",
    },
    {
        "source": "Reuters",
        "headline": "Queensland coking coal export terminal disruption advisory issued",
        "corridor": "malacca",
        "commodity": "coking_coal",
    },
    {
        "source": "BloombergNEF",
        "headline": "China tightens rare-earth export licensing pace through Q3",
        "corridor": "south_china_sea",
        "commodity": "rare_earths",
    },
    {
        "source": "EIA",
        "headline": "Brent crude open 3.2 percent higher on Gulf maritime incident",
        "corridor": "hormuz",
        "commodity": "crude_oil",
    },
    {
        "source": "GDELT",
        "headline": "Houthi statement signals further attacks on commercial shipping in Bab el-Mandeb",
        "corridor": "bab_el_mandeb",
        "commodity": "crude_oil",
    },
    {
        "source": "Argus Media",
        "headline": "JKM LNG spot premium widens on Hormuz uncertainty",
        "corridor": "hormuz",
        "commodity": "lng",
    },
    {
        "source": "MOFCOM watch",
        "headline": "Indonesia signals nickel ore export quota tightening for H2 2026",
        "corridor": "malacca",
        "commodity": "nickel",
    },
    {
        "source": "GACC",
        "headline": "China PV module exports to India down 12 percent month-on-month",
        "corridor": "south_china_sea",
        "commodity": "solar_pv",
    },
    {
        "source": "Mineral Commodity Bulletin",
        "headline": "Lithium carbonate spot edges higher on Chile permitting delays",
        "corridor": "south_china_sea",
        "commodity": "lithium",
    },
    {
        "source": "WNA",
        "headline": "Kazatomprom logistics advisory: rail corridor maintenance window in Q3",
        "corridor": "malacca",
        "commodity": "uranium",
    },
]


def _fixture_initial_items(limit: int = 5) -> list[dict[str, Any]]:
    """Load up to {limit} most-recent FeedItem-shaped dicts from gdelt_events.json."""
    fixtures_dir = Path(get_settings().fixtures_path)
    path = fixtures_dir / "gdelt_events.json"
    if not path.exists():
        return []
    try:
        events = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(events, list):
        return []
    out: list[dict[str, Any]] = []
    for i, e in enumerate(events[:limit]):
        out.append(_event_to_feed_item(e, idx=i))
    return out


def _event_to_feed_item(e: dict[str, Any], idx: int = 0) -> dict[str, Any]:
    from app.api.routes import gdelt_context_url

    tone = float(e.get("tone", 0))
    return {
        "id": str(e.get("id", f"ws-{idx}")),
        "source": "GDELT",
        "headline": f"{e.get('actor1', 'Event')} - {str(e.get('event_code', ''))[:64]}",
        "summary": f"Tone {tone}; near {e.get('location', 'unknown')}",
        "url": gdelt_context_url(e),
        "publishedAt": e.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "tags": [str(e.get("theme", ""))],
        "corridor": None,
        "commodity": None,
        "sentiment": "negative" if tone < -3 else "neutral",
        "importance": max(1, min(10, int(abs(tone) * 1.2))),
    }


def _synthetic_feed_item(seq: int, rng: random.Random) -> dict[str, Any]:
    h = rng.choice(SYNTHETIC_HEADLINES)
    importance = rng.randint(4, 9)
    sentiment = "negative" if importance >= 7 else "neutral"
    return {
        "id": f"ws-live-{seq}",
        "source": h["source"],
        "headline": h["headline"],
        "summary": h["headline"] + " Live ingest synthetic frame.",
        "url": "",
        "publishedAt": datetime.now(timezone.utc).isoformat(),
        "tags": ["live", "synthetic"],
        "corridor": h["corridor"],
        "commodity": h["commodity"],
        "sentiment": sentiment,
        "importance": importance,
    }


async def _live_gdelt_items(seen: set[str]) -> list[dict[str, Any]]:
    """Pull fresh GDELT events. Returns FeedItem-shaped dicts not yet pushed."""
    try:
        from app.api.routes import gdelt_context_url
        from app.ingest import gdelt as gdelt_ingest

        events = await gdelt_ingest.fetch_events(window_hours=2)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ws_feed.live_gdelt_failed", error=str(exc))
        return []

    out: list[dict[str, Any]] = []
    for e in events[:20]:
        evt_id = str(e.get("id") or e.get("url") or e.get("timestamp", ""))
        if not evt_id or evt_id in seen:
            continue
        seen.add(evt_id)
        tone = float(e.get("tone", 0))
        out.append({
            "id": evt_id,
            "source": "GDELT",
            "headline": f"{e.get('actor1', 'Event')} - {str(e.get('event_code', ''))[:64]}",
            "summary": f"Tone {tone}; near {e.get('location', 'unknown')}",
            "url": gdelt_context_url(e),
            "publishedAt": e.get("timestamp", datetime.now(timezone.utc).isoformat()),
            "tags": [str(e.get("theme", ""))],
            "corridor": None,
            "commodity": None,
            "sentiment": "negative" if tone < -3 else "neutral",
            "importance": max(1, min(10, int(abs(tone) * 1.2))),
        })
    return out


async def _score_update_pump(websocket: WebSocket, queue: asyncio.Queue) -> None:
    """Drain the scheduler's notification queue and forward each event to the
    client. Runs as a sibling task alongside the feed loop so headlines and
    score updates are independently paced."""
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        return
    except Exception as exc:  # noqa: BLE001
        logger.warning("ws_feed: score-update pump errored: %s", exc)


async def ws_feed(websocket: WebSocket) -> None:
    """Push FeedItem dicts AND score-update events to the client.

    Sequence:
    1. Initial back-fill from fixtures (FeedItems).
    2. Subscribe to the scheduler's score-change queue — a sibling pump pushes
       {kind: "score_update", changes: [...]} every time a corridor's score
       moves by SCORE_CHANGE_THRESHOLD points or its tier changes.
    3. In live mode: poll GDELT every 60s for fresh headlines.
       In fixture mode: emit synthetic headlines every 8s for visible motion.
    """
    from app import scheduler

    settings = get_settings()
    live = bool(settings.allow_live_ingest)
    await websocket.accept()
    queue = scheduler.subscribe()
    pump_task = asyncio.create_task(_score_update_pump(websocket, queue))
    try:
        for item in _fixture_initial_items(limit=5):
            await websocket.send_json(item)
            await asyncio.sleep(0.05)

        # Push the current snapshot immediately so the UI starts populated
        # with score data instead of waiting for the first scheduler change.
        snap = scheduler.last_snapshot()
        if snap:
            await websocket.send_json({"kind": "score_snapshot", "snapshot": snap})

        if live:
            seen: set[str] = set()
            poll_interval = 60.0
            while True:
                items = await _live_gdelt_items(seen)
                for it in items:
                    await websocket.send_json(it)
                    await asyncio.sleep(0.05)
                await asyncio.sleep(poll_interval)
        else:
            rng = random.Random()
            seq = 0
            while True:
                await asyncio.sleep(8.0)
                seq += 1
                item = _synthetic_feed_item(seq, rng)
                await websocket.send_json(item)
    except WebSocketDisconnect:
        logger.info("ws_feed: client disconnected cleanly")
    except Exception as exc:  # noqa: BLE001
        logger.exception("ws_feed: error %s", exc)
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        pump_task.cancel()
        scheduler.unsubscribe(queue)


__all__ = ["ws_feed"]
