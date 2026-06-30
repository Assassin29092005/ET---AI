"""Tests for the news-signal sentiment + aggregation logic."""
from __future__ import annotations

import pytest

from app.engines.live_scores import (
    CORRIDOR_NEWS_QUERIES,
    _NEG_TOKENS,
    _POS_TOKENS,
    _sentiment_score,
)
from app.engines.risk_score import (
    WEIGHT_AIS,
    WEIGHT_GEO,
    WEIGHT_NEWS,
    WEIGHT_PRICE,
    WEIGHT_SANCTIONS,
)


def test_weights_sum_to_one_with_news_added():
    """Re-balancing for news must preserve the unit-sum invariant."""
    total = WEIGHT_GEO + WEIGHT_AIS + WEIGHT_SANCTIONS + WEIGHT_PRICE + WEIGHT_NEWS
    assert abs(total - 1.0) < 1e-9


def test_every_corridor_has_a_news_query():
    """The scheduler iterates corridors; every one must have a query string."""
    from app.engines.live_scores import CORRIDOR_CENTROID
    for c in CORRIDOR_CENTROID:
        assert c in CORRIDOR_NEWS_QUERIES, f"missing news query for {c}"


def test_negative_sentiment_for_attack_headline():
    s = _sentiment_score("Drone attack on tanker in Strait of Hormuz")
    assert s < 0


def test_positive_sentiment_for_ceasefire_headline():
    s = _sentiment_score("Ceasefire agreement reached, shipping resumes through Bab el-Mandeb")
    assert s > 0


def test_neutral_for_no_keywords():
    s = _sentiment_score("Oil prices remained stable today")
    assert s == 0.0


def test_mixed_sentiment_averages_to_some_value():
    # 2 NEG tokens (attack, threat) vs 1 POS (deal) → (1-2)/3 = -0.333.
    # We deliberately avoid words containing 'ease' (matches inside 'ceasefire')
    # so the assertion isn't sensitive to substring-vs-word matching.
    text = "Drone attack on tanker raises threat to Hormuz; oil traders discuss deal"
    s = _sentiment_score(text)
    # 3 NEG (drone, attack, threat) vs 1 POS (deal) → (1-3)/4 = -0.5 exactly.
    assert s == pytest.approx(-0.5)


def test_neg_pos_token_lists_disjoint():
    """A sanity check that no token appears in both — would cancel oddly."""
    overlap = set(_NEG_TOKENS) & set(_POS_TOKENS)
    assert overlap == set()
