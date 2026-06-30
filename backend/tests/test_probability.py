"""Tests for the score → 14-day disruption probability calibration."""
from __future__ import annotations

import pytest

from app.engines.risk_score import disruption_probability_14d


def test_probability_zero_score_near_zero():
    assert disruption_probability_14d(0.0) < 0.01


def test_probability_full_score_high():
    p = disruption_probability_14d(100.0)
    assert 0.85 < p < 0.96  # capped at 0.95


def test_probability_is_monotonic():
    """A higher risk score must never decrease the disruption probability."""
    prev = -1.0
    for s in range(0, 101, 5):
        p = disruption_probability_14d(float(s))
        assert p >= prev, f"non-monotone at score={s}: {p} < {prev}"
        prev = p


def test_probability_midpoint_around_28pct():
    """Score of 50 should map to roughly 1 in 3 (logistic midpoint=60 chosen so).
    The 'elevated' tier should signal real-but-not-imminent risk."""
    p = disruption_probability_14d(50.0)
    assert 0.20 < p < 0.40


def test_probability_clipped_for_out_of_range_input():
    """Negative or >100 scores must not blow up — they clip to [0, 1] outputs."""
    assert disruption_probability_14d(-100.0) >= 0.0
    assert disruption_probability_14d(1000.0) <= 1.0


@pytest.mark.parametrize("score", [25.0, 50.0, 75.0, 90.0])
def test_probability_returns_finite_float(score):
    p = disruption_probability_14d(score)
    assert isinstance(p, float)
    assert 0.0 <= p <= 1.0
