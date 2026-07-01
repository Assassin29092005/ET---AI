"""Live AISStream WebSocket consumer.

One long-lived asyncio task subscribes to AISStream.io with SIX corridor
bounding boxes and maintains a rolling per-corridor deque of the most recent
position reports. Exposes cheap synchronous getters used by:

  * app.engines.live_scores._ais_signals  — vessel-count anomaly per corridor
  * app.api.routes.twin_state              — vessel dots on the digital twin

Design decisions
----------------
* **Single socket, multi-bbox subscription** — AISStream supports up to 6
  bboxes per subscription. One connection avoids the 6× reconnect / auth
  cost we'd hit with per-corridor sockets.
* **Rolling deques** — one `deque(maxlen=200)` per corridor. `deque.append`
  is O(1) and inherently drops the oldest when full. asyncio is
  single-threaded so no lock needed.
* **Auth-fail detection** — the AISStream server sends `{"error": ...}` frames
  when the API key is bad. We stop retrying in that case (no reconnect spin).
* **Exponential backoff** — 1s → 60s cap, reset on any successful frame.
* **Graceful fallback** — when the key is absent or the connection has
  never succeeded, the getters return empty structures so downstream code
  falls through to the fixture path.
* **Cancellation-safe** — CancelledError propagates cleanly through the
  connection's async context manager; the deques persist for the next start.
"""
from __future__ import annotations

import asyncio
import json
from collections import deque
from datetime import datetime, timezone
from typing import Optional

import structlog

log = structlog.get_logger(__name__)

_AIS_WS_URL = "wss://stream.aisstream.io/v0/stream"

# Corridor bounding boxes — approximate chokepoint geography. Format is
# [[south, west], [north, east]] as required by AISStream.
CORRIDOR_BBOXES: dict[str, list[list[float]]] = {
    "hormuz":            [[24.0, 54.0], [28.0, 58.0]],
    "bab_el_mandeb":     [[11.0, 41.5], [16.0, 45.0]],
    "malacca":           [[-2.0, 99.0], [7.0, 105.0]],
    "south_china_sea":   [[8.0, 110.0], [22.0, 122.0]],
    "cape_of_good_hope": [[-36.0, 15.0], [-30.0, 25.0]],
    "suez":              [[27.0, 31.0], [32.0, 34.0]],
}

# Per-corridor rolling buffer. Access is O(1); pop-front is automatic when full.
_BUFFERS: dict[str, deque] = {c: deque(maxlen=200) for c in CORRIDOR_BBOXES}

# Task lifecycle.
_task: Optional[asyncio.Task] = None
_stop_event: Optional[asyncio.Event] = None
_connected_at: Optional[str] = None  # ISO ts of most recent successful frame

# Backoff bounds.
_INITIAL_BACKOFF = 1.0
_MAX_BACKOFF = 60.0


# ---------------------------------------------------------------------------
# Public getters (used by live_scores and the twin route)
# ---------------------------------------------------------------------------
def get_live_vessel_counts() -> dict[str, int]:
    """Number of distinct MMSIs seen recently per corridor. Empty dict when
    the stream isn't producing data (unset key, connection down, etc.)."""
    if _connected_at is None:
        return {}
    return {c: len({p["mmsi"] for p in buf}) for c, buf in _BUFFERS.items()}


def get_live_vessel_positions(limit: int = 80) -> list[dict]:
    """Most-recent positions across all corridors, newest-first, capped."""
    if _connected_at is None:
        return []
    combined: list[dict] = []
    for buf in _BUFFERS.values():
        combined.extend(buf)
    combined.sort(key=lambda p: p.get("_ts", ""), reverse=True)
    return combined[:limit]


def status() -> dict:
    """Health probe — used by /api/digital-twin/state to report ais_source."""
    return {
        "connected_at": _connected_at,
        "corridor_buffer_sizes": {c: len(buf) for c, buf in _BUFFERS.items()},
        "task_running": bool(_task and not _task.done()),
    }


# ---------------------------------------------------------------------------
# Consumer internals
# ---------------------------------------------------------------------------
def _in_bbox(lat: float, lon: float, bbox: list[list[float]]) -> bool:
    s, w = bbox[0]
    n, e = bbox[1]
    return s <= lat <= n and w <= lon <= e


def _classify_corridor(lat: float, lon: float) -> Optional[str]:
    """Cheap bbox membership — first hit wins. Corridor bboxes are disjoint."""
    for c, bbox in CORRIDOR_BBOXES.items():
        if _in_bbox(lat, lon, bbox):
            return c
    return None


def _to_position(msg: dict) -> Optional[dict]:
    """Extract a normalised position dict from an AISStream message, or None
    if the frame isn't a usable PositionReport."""
    if not isinstance(msg, dict):
        return None
    if msg.get("MessageType") != "PositionReport":
        return None
    try:
        meta = msg.get("MetaData") or {}
        pr = msg["Message"]["PositionReport"]
        lat = float(pr.get("Latitude"))
        lon = float(pr.get("Longitude"))
    except (KeyError, TypeError, ValueError):
        return None
    corridor = _classify_corridor(lat, lon)
    if corridor is None:
        return None
    mmsi = str(pr.get("UserID") or meta.get("MMSI") or "")
    if not mmsi:
        return None
    speed = float(pr.get("Sog") or 0.0)
    return {
        "mmsi": mmsi,
        "name": (meta.get("ShipName") or "").strip() or "Unknown",
        "lat": lat,
        "lon": lon,
        "course": float(pr.get("Cog") or 0.0),
        "speed": speed,
        "vesselType": "AISSTREAM_LIVE",
        "cargo": "other",  # AISStream doesn't reliably send cargo; classify server-side later
        "flag": (meta.get("ShipName") or "")[:3] or "??",  # flag inference is out of scope
        "corridor": corridor,
        "lastSeen": meta.get("time_utc") or datetime.now(timezone.utc).isoformat(),
        "anomaly": speed < 2.0,
        "_ts": meta.get("time_utc") or datetime.now(timezone.utc).isoformat(),
    }


async def _consume(api_key: str) -> None:
    """Open the socket, subscribe, forward each position report to the buffer.

    Returns normally on graceful stop, or raises after the outer loop should
    give up (auth rejection). Any transient error propagates so the outer
    reconnect loop can back off and retry.
    """
    global _connected_at
    import websockets

    subscription = {
        "APIKey": api_key,
        "BoundingBoxes": list(CORRIDOR_BBOXES.values()),
        "FilterMessageTypes": ["PositionReport"],
    }
    log.info("ais_stream.connecting")
    async with websockets.connect(_AIS_WS_URL, ping_interval=20, ping_timeout=30) as ws:
        await ws.send(json.dumps(subscription))
        log.info("ais_stream.subscribed", bboxes=len(subscription["BoundingBoxes"]))
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            # AISStream reports errors as {"error": ...}. If it's an auth
            # failure, don't reconnect — treat as terminal.
            if isinstance(msg, dict) and "error" in msg:
                err = str(msg["error"]).lower()
                log.warning("ais_stream.server_error", error=msg["error"])
                if "unauthor" in err or "invalid" in err or "api" in err:
                    raise PermissionError("AISStream rejected the API key")
                continue
            pos = _to_position(msg)
            if pos is None:
                continue
            corridor = pos["corridor"]
            _BUFFERS[corridor].append(pos)
            _connected_at = pos["_ts"]


async def _run_forever(api_key: str) -> None:
    """Outer supervisor — exponential backoff on failure, terminate on auth error."""
    assert _stop_event is not None
    backoff = _INITIAL_BACKOFF
    while not _stop_event.is_set():
        try:
            await _consume(api_key)
            # _consume returned normally — either the server closed the socket
            # cleanly or the async-for finished. Retry.
            backoff = _INITIAL_BACKOFF
        except PermissionError as exc:
            log.error("ais_stream.auth_failed", error=str(exc))
            return  # bad key — don't retry
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never let the task die silently
            log.warning("ais_stream.disconnected", error=str(exc), backoff_s=backoff)
        # Backoff, but wake early if we're being stopped.
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=backoff)
        except asyncio.TimeoutError:
            backoff = min(backoff * 2.0, _MAX_BACKOFF)
        else:
            return  # stop requested


async def start() -> None:
    """Kick off the background consumer if a key is configured. Idempotent."""
    global _task, _stop_event
    if _task is not None and not _task.done():
        return
    from app.config import get_settings
    settings = get_settings()
    if not settings.ais_stream_api_key:
        log.info("ais_stream.skip_no_key")
        return
    if not settings.allow_live_ingest:
        log.info("ais_stream.skip_fixture_mode")
        return
    _stop_event = asyncio.Event()
    _task = asyncio.create_task(
        _run_forever(settings.ais_stream_api_key), name="ais_stream_consumer"
    )
    log.info("ais_stream.task_started")


async def stop() -> None:
    """Signal the consumer to shut down. Cancels after a brief grace period."""
    global _task, _stop_event
    if _stop_event is not None:
        _stop_event.set()
    if _task is not None:
        try:
            await asyncio.wait_for(_task, timeout=2.0)
        except asyncio.TimeoutError:
            _task.cancel()
        _task = None
    _stop_event = None
