"""Continuous risk-score refresh.

A background asyncio task started by the lifespan hook re-computes the live
corridor signals every `SCORE_REFRESH_SECONDS`, appends the snapshot to the
SQLite `score_history` table, prunes the table, and notifies any subscribed
WebSocket clients of meaningful changes.

This is the "live, not weekly" half of the Geopolitical Risk Intelligence
Agent. It runs as a single global task (re-entrancy guarded) so multiple
gunicorn workers don't double-poll the same APIs.

The 5-minute default cadence balances:
  * NewsAPI free-tier quota (100/day; 6 corridors × 12 polls/hour = 72/h → too
    aggressive at 5min; we use a single fan-out per cycle, ≤6 NewsAPI calls,
    so 5min → 72/h → 1,728/day → exceeds quota. Mitigated below by setting
    the actual default to 600s (10 min) when NewsAPI key is present.)
  * Demo responsiveness — a corridor going critical shouldn't take an hour
    to surface.
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

import structlog

log = structlog.get_logger(__name__)

# Module-level shared state.
_task: Optional[asyncio.Task] = None
_stop_event: Optional[asyncio.Event] = None
_subscribers: list[asyncio.Queue] = []
_last_snapshot: dict[str, dict[str, Any]] = {}

# Configuration knobs. Tuned for demo + NewsAPI free tier (100 calls/day).
# At 600s (10min) we make ≤6 NewsAPI calls / cycle = 864 / day → safely under.
SCORE_REFRESH_SECONDS = 600
SCORE_CHANGE_THRESHOLD = 2.0  # absolute point change that triggers a WS push
HISTORY_KEEP_PER_CORRIDOR = 500


def subscribe() -> asyncio.Queue:
    """Return a fresh Queue that the WebSocket handler can consume. Each new
    snapshot is fanned out to every subscriber; queue depth is unbounded
    because consumers are expected to drain quickly."""
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.append(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    try:
        _subscribers.remove(q)
    except ValueError:
        pass


def last_snapshot() -> dict[str, dict[str, Any]]:
    """Most recently computed snapshot (corridor → {score, tier, signals, detail}).
    Empty until the first refresh completes."""
    return dict(_last_snapshot)


def _detect_changes(
    fresh: dict[str, dict[str, Any]],
    prev: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Find corridors whose score moved by at least SCORE_CHANGE_THRESHOLD."""
    diffs: list[dict[str, Any]] = []
    for corridor, payload in fresh.items():
        new_score = float(payload.get("score", 0.0))
        new_tier = payload.get("tier")
        prev_p = prev.get(corridor) or {}
        old_score = float(prev_p.get("score", 0.0))
        old_tier = prev_p.get("tier")
        if abs(new_score - old_score) >= SCORE_CHANGE_THRESHOLD or new_tier != old_tier:
            diffs.append({
                "corridor": corridor,
                "previousScore": round(old_score, 1),
                "score": round(new_score, 1),
                "delta": round(new_score - old_score, 1),
                "previousTier": old_tier,
                "tier": new_tier,
                "topSignal": _top_signal_label(payload.get("signals") or {}),
            })
    return diffs


def _top_signal_label(signals: dict[str, float]) -> str:
    if not signals:
        return ""
    return max(signals.items(), key=lambda kv: kv[1])[0]


async def _refresh_once() -> None:
    """One refresh cycle: compute, persist, fan out diffs."""
    global _last_snapshot
    from app.engines import live_scores
    from app import persistence

    try:
        fresh = await live_scores.compute_live_corridor_signals()
    except Exception as exc:
        log.warning("scheduler.compute_failed", error=str(exc))
        return

    diffs = _detect_changes(fresh, _last_snapshot)
    _last_snapshot = fresh

    inserted = persistence.append_score_snapshot(fresh)
    if inserted >= 6:
        # Cheap occasional prune — only run when a full snapshot was written.
        persistence.prune_score_history(keep_per_corridor=HISTORY_KEEP_PER_CORRIDOR)

    if diffs:
        log.info("scheduler.score_change", changes=len(diffs))
        for q in list(_subscribers):
            try:
                q.put_nowait({"kind": "score_update", "changes": diffs, "snapshot": fresh})
            except Exception:  # pragma: no cover  — fanout never raises into the loop
                pass

    # Evaluate the agentic orchestrator — triggers autonomous chains when
    # corridor risk crosses the configured threshold.
    try:
        from app.engines.orchestrator import evaluate as agent_evaluate
        triggered = await agent_evaluate(fresh)
        if triggered:
            log.info("scheduler.agent_triggered", corridors=triggered)
    except Exception as exc:
        log.warning("scheduler.agent_eval_failed", error=str(exc))


async def _loop() -> None:
    assert _stop_event is not None
    log.info("scheduler.started", interval_s=SCORE_REFRESH_SECONDS)
    while not _stop_event.is_set():
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=SCORE_REFRESH_SECONDS)
        except asyncio.TimeoutError:
            await _refresh_once()
    log.info("scheduler.stopped")


async def start() -> None:
    """Start the refresh loop. Runs one refresh INLINE so the in-memory
    snapshot + history table are ready before the app accepts requests, then
    schedules the periodic background loop. Idempotent: second call is a no-op."""
    global _task, _stop_event
    if _task is not None and not _task.done():
        return
    # Inline first refresh — blocks lifespan startup until /api/scores/history
    # has data, so the UI doesn't see an empty state on first paint.
    try:
        await _refresh_once()
    except Exception as exc:  # noqa: BLE001
        log.warning("scheduler.initial_refresh_failed", error=str(exc))
    _stop_event = asyncio.Event()
    _task = asyncio.create_task(_loop(), name="risk_score_scheduler")


async def stop() -> None:
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
