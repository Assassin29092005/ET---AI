"""Tests for the SPR release-mode strategy (drawdown / swap / exchange)."""
from __future__ import annotations

import pytest

from app.api.routes import _RELEASE_MODE_PROFILE


def test_every_documented_mode_has_a_profile():
    for mode in ("drawdown", "swap", "exchange"):
        assert mode in _RELEASE_MODE_PROFILE


def test_drawdown_has_highest_draw_cap():
    """Spot drawdown sells crude outright — no logistical bottleneck like a tender."""
    caps = {k: v["draw_cap_kbpd"] for k, v in _RELEASE_MODE_PROFILE.items()}
    assert caps["drawdown"] >= caps["swap"]
    assert caps["swap"] >= caps["exchange"]


def test_exchange_has_lowest_price_impact():
    """Delayed-delivery contracts move physical crude later → softer near-term price."""
    coefs = {k: v["price_impact_coef"] for k, v in _RELEASE_MODE_PROFILE.items()}
    assert coefs["drawdown"] > coefs["swap"]
    assert coefs["swap"] > coefs["exchange"]


def test_drawdown_rebuild_pull_is_zero():
    """Outright drawdown has no return obligation; swap and exchange do."""
    assert _RELEASE_MODE_PROFILE["drawdown"]["rebuild_pull"] == 0.0
    assert _RELEASE_MODE_PROFILE["swap"]["rebuild_pull"] > 0
    assert _RELEASE_MODE_PROFILE["exchange"]["rebuild_pull"] > 0


def test_post_spr_plan_with_release_mode(client, disable_persistence):
    r = client.post("/api/spr/plan", json={
        "horizonDays": 30, "targetCoverDays": 6.0, "intensity": 0.6,
        "scenarioId": "hormuz_partial_closure", "releaseMode": "swap",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["releaseMode"] == "swap"
    assert "releaseModeProfile" in body
    # Swap should set a lower draw cap than drawdown
    assert body["releaseModeProfile"]["draw_cap_kbpd"] < 600.0


def test_post_spr_plan_rejects_unknown_release_mode(client):
    r = client.post("/api/spr/plan", json={"releaseMode": "bogus"})
    assert r.status_code == 400


@pytest.mark.parametrize("mode", ["drawdown", "swap", "exchange"])
def test_all_modes_return_valid_plan(client, disable_persistence, mode):
    r = client.post("/api/spr/plan", json={
        "horizonDays": 21,
        "intensity": 0.5,
        "scenarioId": "hormuz_partial_closure",
        "releaseMode": mode,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["releaseMode"] == mode
    assert "releaseSchedule" in body
    assert len(body["releaseSchedule"]) > 0
