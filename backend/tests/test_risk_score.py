"""Tests for the risk-score engine helpers (the public-API-facing ones).

`compute_corridor_score` itself is currently dead code (incompatible with the
production-served `RiskScore` model); the live scores route uses
`engines/live_scores.py`. We test the pure helpers that DO have callers."""
from __future__ import annotations

import pytest

from app.engines.risk_score import (
    CORRIDOR_COMMODITY_RELEVANCE,
    CONTRIBUTOR_LABELS,
    TIER_BANDS,
    WEIGHT_AIS,
    WEIGHT_GEO,
    WEIGHT_NEWS,
    WEIGHT_PRICE,
    WEIGHT_SANCTIONS,
    _clip01,
    _extract_signals,
    tier_from_score,
)


def test_weights_sum_to_one():
    total = WEIGHT_GEO + WEIGHT_AIS + WEIGHT_SANCTIONS + WEIGHT_PRICE + WEIGHT_NEWS
    assert total == pytest.approx(1.0)


def test_tier_bands_cover_zero_to_one_hundred():
    """No gaps and no overlaps in the tier-band partition."""
    bands = sorted(TIER_BANDS, key=lambda b: b[0])
    assert bands[0][0] == 0.0
    for prev, nxt in zip(bands, bands[1:]):
        assert prev[1] == nxt[0]
    assert bands[-1][1] >= 100.0


@pytest.mark.parametrize(
    "score,expected",
    [
        (0.0, "low"),
        (24.9, "low"),
        (25.0, "elevated"),
        (49.9, "elevated"),
        (50.0, "high"),
        (74.9, "high"),
        (75.0, "critical"),
        (100.0, "critical"),
    ],
)
def test_tier_from_score(score, expected):
    assert tier_from_score(score) == expected


def test_clip01_clips_below_zero():
    assert _clip01(-5.0) == 0.0


def test_clip01_clips_above_one():
    assert _clip01(2.0) == 1.0


def test_clip01_passthrough():
    assert _clip01(0.5) == 0.5


def test_extract_signals_returns_zeros_when_missing():
    sub = _extract_signals({}, "hormuz")
    assert sub == {"geo": 0.0, "ais_anomaly": 0.0, "sanctions": 0.0, "price_vol": 0.0}


def test_extract_signals_reads_corridor_values():
    signals = {"corridors": {"hormuz": {"geo": 0.7, "ais_anomaly": 0.3, "sanctions": 0.2, "price_vol": 0.4}}}
    sub = _extract_signals(signals, "hormuz")
    assert sub["geo"] == 0.7
    assert sub["ais_anomaly"] == 0.3
    assert sub["sanctions"] == 0.2
    assert sub["price_vol"] == 0.4


def test_extract_signals_clips_out_of_range_values():
    signals = {"corridors": {"hormuz": {"geo": 5.0, "ais_anomaly": -1.0}}}
    sub = _extract_signals(signals, "hormuz")
    assert sub["geo"] == 1.0
    assert sub["ais_anomaly"] == 0.0


def test_relevance_matrix_includes_strategic_commodities():
    """Crude must show full Hormuz exposure; coking coal must show Malacca."""
    assert CORRIDOR_COMMODITY_RELEVANCE["hormuz"]["crude"] >= 0.9
    assert CORRIDOR_COMMODITY_RELEVANCE["malacca"]["coking_coal"] >= 0.9


def test_relevance_matrix_keeps_nonsense_combos_low():
    """Coking coal through Hormuz is not a real flow — exposure should be tiny."""
    assert CORRIDOR_COMMODITY_RELEVANCE["hormuz"]["coking_coal"] < 0.2


def test_contributor_labels_cover_all_subsignals():
    for key in ("geo", "ais_anomaly", "sanctions", "price_vol"):
        assert key in CONTRIBUTOR_LABELS
