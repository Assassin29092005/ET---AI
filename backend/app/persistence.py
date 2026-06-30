"""SQLite-backed persistence for operator overrides and scenario-run history.

Two tables, stdlib `sqlite3` only — no new dependencies:

  baseline_overrides
    key TEXT PRIMARY KEY    -- spr_cover_days, refinery_runrate_pct, ...
    value REAL              -- the overridden value
    applied_at TEXT         -- ISO timestamp

  scenario_runs
    id INTEGER PRIMARY KEY AUTOINCREMENT
    scenario_id TEXT
    intensity REAL
    duration_days INTEGER
    projected_brent_usd REAL
    gdp_impact_bps REAL
    ran_at TEXT
    payload_json TEXT       -- full response, for replay/audit

Design notes
------------
* DB file lives at `backend/data/state.db` (gitignored).
* Connection-per-call: SQLite is fine with this and FastAPI's threaded sync
  endpoints; the cost is tiny vs. the request itself, and we avoid stale-
  connection / thread-safety pitfalls.
* All write failures are caught and logged — persistence is best-effort and
  must never break the API path.
* Startup hook reads baseline_overrides and mutates `app.api.routes` module
  globals so the override survives a restart.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

import structlog

log = structlog.get_logger(__name__)

_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "state.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS baseline_overrides (
    key         TEXT PRIMARY KEY,
    value       REAL NOT NULL,
    applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenario_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id          TEXT NOT NULL,
    intensity            REAL NOT NULL,
    duration_days        INTEGER NOT NULL,
    projected_brent_usd  REAL,
    gdp_impact_bps       REAL,
    ran_at               TEXT NOT NULL,
    payload_json         TEXT
);

CREATE INDEX IF NOT EXISTS idx_scenario_runs_ran_at ON scenario_runs(ran_at DESC);

CREATE TABLE IF NOT EXISTS score_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    corridor    TEXT NOT NULL,
    score       REAL NOT NULL,
    tier        TEXT,
    signals_json TEXT,
    computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_score_history_corr_time
    ON score_history(corridor, computed_at DESC);

CREATE TABLE IF NOT EXISTS spr_plan_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id          TEXT,
    intensity            REAL,
    horizon_days         INTEGER,
    target_cover_days    REAL,
    bias                 TEXT,
    release_mode         TEXT,
    peak_gap_kbpd        REAL,
    gap_closed_pct       REAL,
    trough_cover_days    REAL,
    projected_cover_days REAL,
    ran_at               TEXT NOT NULL,
    payload_json         TEXT
);

CREATE INDEX IF NOT EXISTS idx_spr_plan_runs_ran_at ON spr_plan_runs(ran_at DESC);
"""


def db_path() -> Path:
    return _DB_PATH


def _connect() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # WAL gives us concurrent readers + a single writer; perfect for an HTTP API.
    conn = sqlite3.connect(_DB_PATH, isolation_level=None, timeout=5.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Idempotent — create tables if they don't exist. Safe to call on every startup."""
    try:
        with _connect() as conn:
            conn.executescript(_SCHEMA)
        log.info("persistence.init_ok", path=str(_DB_PATH))
    except sqlite3.Error as exc:
        log.warning("persistence.init_failed", error=str(exc), path=str(_DB_PATH))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Baseline overrides
# ---------------------------------------------------------------------------
def save_override(key: str, value: float) -> bool:
    """Upsert a single baseline override. Returns True on success."""
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO baseline_overrides(key, value, applied_at) VALUES(?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, applied_at=excluded.applied_at",
                (key, float(value), _now_iso()),
            )
        return True
    except sqlite3.Error as exc:
        log.warning("persistence.save_override_failed", key=key, error=str(exc))
        return False


def load_overrides() -> dict[str, float]:
    """Return all stored overrides as a {key: value} dict. Empty on failure."""
    try:
        with _connect() as conn:
            rows = conn.execute("SELECT key, value FROM baseline_overrides").fetchall()
            return {r["key"]: float(r["value"]) for r in rows}
    except sqlite3.Error as exc:
        log.warning("persistence.load_overrides_failed", error=str(exc))
        return {}


# ---------------------------------------------------------------------------
# Scenario-run audit log
# ---------------------------------------------------------------------------
def log_scenario_run(
    *,
    scenario_id: str,
    intensity: float,
    duration_days: int,
    projected_brent_usd: Optional[float],
    gdp_impact_bps: Optional[float],
    payload: dict[str, Any],
) -> Optional[int]:
    """Insert a row into scenario_runs. Returns the new row id, or None on failure."""
    try:
        with _connect() as conn:
            cur = conn.execute(
                "INSERT INTO scenario_runs"
                "(scenario_id, intensity, duration_days, projected_brent_usd, "
                " gdp_impact_bps, ran_at, payload_json) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    scenario_id,
                    float(intensity),
                    int(duration_days),
                    None if projected_brent_usd is None else float(projected_brent_usd),
                    None if gdp_impact_bps is None else float(gdp_impact_bps),
                    _now_iso(),
                    json.dumps(payload, default=str),
                ),
            )
            return int(cur.lastrowid or 0)
    except sqlite3.Error as exc:
        log.warning("persistence.log_run_failed", scenario_id=scenario_id, error=str(exc))
        return None


def list_scenario_runs(limit: int = 20) -> list[dict[str, Any]]:
    """Return the N most-recent scenario runs (sans the bulky payload_json)."""
    try:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT id, scenario_id, intensity, duration_days, projected_brent_usd, "
                "       gdp_impact_bps, ran_at "
                "FROM scenario_runs ORDER BY id DESC LIMIT ?",
                (max(1, min(int(limit), 200)),),
            ).fetchall()
            return [dict(r) for r in rows]
    except sqlite3.Error as exc:
        log.warning("persistence.list_runs_failed", error=str(exc))
        return []


def get_scenario_run(run_id: int) -> Optional[dict[str, Any]]:
    """Fetch the full payload (parsed JSON) for one run, or None if missing."""
    try:
        with _connect() as conn:
            row = conn.execute(
                "SELECT id, scenario_id, intensity, duration_days, projected_brent_usd, "
                "       gdp_impact_bps, ran_at, payload_json "
                "FROM scenario_runs WHERE id = ?",
                (int(run_id),),
            ).fetchone()
        if not row:
            return None
        out = dict(row)
        try:
            out["payload"] = json.loads(out.pop("payload_json") or "null")
        except json.JSONDecodeError:
            out["payload"] = None
        return out
    except sqlite3.Error as exc:
        log.warning("persistence.get_run_failed", id=run_id, error=str(exc))
        return None


# ---------------------------------------------------------------------------
# Startup hook
# ---------------------------------------------------------------------------
# Map of override-table key -> module-global on app.api.routes that should
# be patched at startup with the stored value (if present).
_OVERRIDE_BINDINGS: dict[str, str] = {
    "spr_cover_days": "BASE_SPR_DAYS",
    "refinery_runrate_pct": "BASE_REFINERY_RUN_PCT",
    "power_stress_index": "BASE_POWER_STRESS_IDX",
    "gdp_growth_pct": "BASE_GDP_GROWTH_PCT",
}


# ---------------------------------------------------------------------------
# Risk-score history (continuous-monitoring archive)
# ---------------------------------------------------------------------------
def append_score_snapshot(snapshot: dict[str, dict[str, Any]]) -> int:
    """Append a complete corridor snapshot (one row per corridor) to history.
    Returns the count of rows inserted. Best-effort — returns 0 on failure."""
    if not isinstance(snapshot, dict) or not snapshot:
        return 0
    now = _now_iso()
    rows = []
    for corridor, payload in snapshot.items():
        if not isinstance(payload, dict):
            continue
        rows.append((
            str(corridor),
            float(payload.get("score") or 0.0),
            str(payload.get("tier") or ""),
            json.dumps(payload.get("signals") or {}, default=str),
            now,
        ))
    if not rows:
        return 0
    try:
        with _connect() as conn:
            conn.executemany(
                "INSERT INTO score_history(corridor, score, tier, signals_json, computed_at) "
                "VALUES(?, ?, ?, ?, ?)",
                rows,
            )
        return len(rows)
    except sqlite3.Error as exc:
        log.warning("persistence.score_history_failed", error=str(exc))
        return 0


def list_score_history(corridor: Optional[str] = None, limit: int = 50) -> list[dict[str, Any]]:
    """Most-recent N rows, optionally filtered by corridor."""
    try:
        with _connect() as conn:
            if corridor:
                rows = conn.execute(
                    "SELECT id, corridor, score, tier, computed_at FROM score_history "
                    "WHERE corridor = ? ORDER BY id DESC LIMIT ?",
                    (corridor, max(1, min(int(limit), 500))),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, corridor, score, tier, computed_at FROM score_history "
                    "ORDER BY id DESC LIMIT ?",
                    (max(1, min(int(limit), 500)),),
                ).fetchall()
            return [dict(r) for r in rows]
    except sqlite3.Error as exc:
        log.warning("persistence.list_score_history_failed", error=str(exc))
        return []


def latest_scores_per_corridor() -> dict[str, dict[str, Any]]:
    """Return the single newest row for each corridor (used by the scheduler
    to compare against the freshly-computed snapshot)."""
    try:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT corridor, score, tier, computed_at FROM score_history WHERE id IN "
                "(SELECT MAX(id) FROM score_history GROUP BY corridor)"
            ).fetchall()
            return {r["corridor"]: dict(r) for r in rows}
    except sqlite3.Error as exc:
        log.warning("persistence.latest_scores_failed", error=str(exc))
        return {}


def prune_score_history(keep_per_corridor: int = 500) -> int:
    """Cap the history table per-corridor so it doesn't grow unbounded.
    Returns the number of rows deleted."""
    try:
        with _connect() as conn:
            cur = conn.execute(
                "DELETE FROM score_history WHERE id NOT IN ("
                "  SELECT id FROM score_history sh1 WHERE id IN ("
                "    SELECT id FROM score_history sh2 "
                "    WHERE sh2.corridor = sh1.corridor "
                "    ORDER BY id DESC LIMIT ?"
                "  )"
                ")",
                (int(keep_per_corridor),),
            )
            return int(cur.rowcount or 0)
    except sqlite3.Error as exc:
        log.warning("persistence.prune_failed", error=str(exc))
        return 0


# ---------------------------------------------------------------------------
# SPR plan archival
# ---------------------------------------------------------------------------
def log_spr_plan(plan: dict[str, Any]) -> Optional[int]:
    """Persist one SPR plan run for audit / history charts."""
    try:
        with _connect() as conn:
            cur = conn.execute(
                "INSERT INTO spr_plan_runs"
                "(scenario_id, intensity, horizon_days, target_cover_days, bias, release_mode, "
                " peak_gap_kbpd, gap_closed_pct, trough_cover_days, projected_cover_days, "
                " ran_at, payload_json) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    plan.get("scenarioId"),
                    plan.get("_intensity"),
                    plan.get("_horizon"),
                    plan.get("targetCoverDays"),
                    plan.get("marketBias"),
                    plan.get("releaseMode") or "drawdown",
                    plan.get("peakGapKbpd"),
                    plan.get("gapClosedPct"),
                    plan.get("troughCoverDays"),
                    plan.get("projectedCoverDays"),
                    _now_iso(),
                    json.dumps(plan, default=str),
                ),
            )
            return int(cur.lastrowid or 0)
    except sqlite3.Error as exc:
        log.warning("persistence.log_spr_plan_failed", error=str(exc))
        return None


def list_spr_plans(limit: int = 20) -> list[dict[str, Any]]:
    """Most-recent N SPR plan runs (sans bulky payload)."""
    try:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT id, scenario_id, intensity, horizon_days, target_cover_days, bias, "
                "       release_mode, peak_gap_kbpd, gap_closed_pct, trough_cover_days, "
                "       projected_cover_days, ran_at "
                "FROM spr_plan_runs ORDER BY id DESC LIMIT ?",
                (max(1, min(int(limit), 200)),),
            ).fetchall()
            return [dict(r) for r in rows]
    except sqlite3.Error as exc:
        log.warning("persistence.list_spr_plans_failed", error=str(exc))
        return []


def apply_persisted_overrides() -> dict[str, float]:
    """Read every stored override and patch the matching routes.py module
    global. Returns the set of {key: value} that was actually applied."""
    persisted = load_overrides()
    if not persisted:
        return {}
    from app.api import routes as _r
    applied: dict[str, float] = {}
    for key, attr in _OVERRIDE_BINDINGS.items():
        if key in persisted and hasattr(_r, attr):
            setattr(_r, attr, float(persisted[key]))
            applied[key] = float(persisted[key])
    if applied:
        log.info("persistence.overrides_restored", **applied)
    return applied
