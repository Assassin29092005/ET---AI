"""Tests for the continuous risk-score scheduler change-detection logic."""
from __future__ import annotations

from app import scheduler


def test_detect_changes_flags_score_movement_above_threshold():
    prev = {"hormuz": {"score": 30.0, "tier": "elevated"}}
    fresh = {"hormuz": {"score": 33.0, "tier": "elevated"}}
    diffs = scheduler._detect_changes(fresh, prev)
    assert len(diffs) == 1
    assert diffs[0]["delta"] == 3.0


def test_detect_changes_ignores_subthreshold_movement():
    prev = {"hormuz": {"score": 30.0, "tier": "elevated"}}
    fresh = {"hormuz": {"score": 31.0, "tier": "elevated"}}  # +1 < 2.0 threshold
    diffs = scheduler._detect_changes(fresh, prev)
    assert diffs == []


def test_detect_changes_flags_tier_change_even_if_below_threshold():
    """A tier transition is always reportable, even on a small numeric move."""
    prev = {"hormuz": {"score": 49.0, "tier": "elevated"}}
    fresh = {"hormuz": {"score": 50.2, "tier": "high"}}
    diffs = scheduler._detect_changes(fresh, prev)
    assert len(diffs) == 1
    assert diffs[0]["previousTier"] == "elevated"
    assert diffs[0]["tier"] == "high"


def test_detect_changes_first_observation_emits_diff_from_zero():
    """When prev is empty, all corridors are reported as changes from 0.0."""
    fresh = {"hormuz": {"score": 35.0, "tier": "elevated"}}
    diffs = scheduler._detect_changes(fresh, {})
    assert len(diffs) == 1
    assert diffs[0]["previousScore"] == 0.0


def test_top_signal_label_picks_highest():
    s = scheduler._top_signal_label({"geo": 0.2, "ais": 0.8, "sanctions": 0.3})
    assert s == "ais"


def test_top_signal_label_empty_returns_blank():
    assert scheduler._top_signal_label({}) == ""


def test_subscribe_returns_distinct_queues():
    q1 = scheduler.subscribe()
    q2 = scheduler.subscribe()
    assert q1 is not q2
    scheduler.unsubscribe(q1)
    scheduler.unsubscribe(q2)
