"""Tests for the Monte Carlo SPR gap-forecast uncertainty engine."""
from __future__ import annotations

import pytest

from app.engines.spr_uncertainty import (
    DEFAULT_SAMPLES,
    DEFAULT_SEED,
    _CRUDE_SCENARIOS,
    monte_carlo_gap_forecast,
)


# ---------------------------------------------------------------------------
# Output shape + backward compatibility
# ---------------------------------------------------------------------------
def test_output_has_backward_compatible_shape():
    """The dict must expose central, forecast, peak, uncertainty — the old
    _spr_gap_forecast callers rely on the first three."""
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30)
    for key in ("central", "forecast", "peak", "uncertainty"):
        assert key in r


def test_forecast_row_shape():
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30)
    for row in r["forecast"]:
        for key in ("day", "central", "low", "high"):
            assert key in row
        assert row["low"] <= row["central"] <= row["high"]


def test_central_matches_forecast_p50():
    """The exposed central path must equal the p50 of the forecast rows."""
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30)
    for i, row in enumerate(r["forecast"]):
        assert r["central"][i] == row["central"]


def test_horizon_lengths_line_up():
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.5, 500.0, horizon=45)
    assert len(r["central"]) == 45
    assert len(r["forecast"]) == 45


# ---------------------------------------------------------------------------
# Non-crude scenarios produce zero band
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("non_crude", [
    "australia_coking_coal",
    "china_rare_earth_curbs",
    "china_solar_export_tariff",
    "kazakhstan_uranium_disruption",
])
def test_non_crude_scenarios_return_zero_gap(non_crude):
    r = monte_carlo_gap_forecast(non_crude, 1.0, 500.0, horizon=30)
    assert all(v == 0.0 for v in r["central"])
    assert r["peak"] == 0.0
    assert r["uncertainty"]["peakP50"] == 0.0


def test_crude_scenarios_produce_positive_peak():
    for c in _CRUDE_SCENARIOS:
        r = monte_carlo_gap_forecast(c, 0.8, 500.0, horizon=30)
        assert r["peak"] > 0, f"crude scenario {c} produced zero peak"


# ---------------------------------------------------------------------------
# Percentile ordering + monotonicity
# ---------------------------------------------------------------------------
def test_peak_percentiles_are_ordered():
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30)
    u = r["uncertainty"]
    assert u["peakP10"] <= u["peakP50"] <= u["peakP90"]


def test_per_day_percentiles_are_ordered():
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30)
    for row in r["forecast"]:
        assert row["low"] <= row["central"] <= row["high"]


def test_prob_thresholds_are_monotone_non_increasing():
    """P(peak > 500) >= P(peak > 1000) >= P(peak > 2000) — always."""
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.9, 1500.0, horizon=30)
    u = r["uncertainty"]
    assert u["probAbove500Kbpd"] >= u["probAbove1000Kbpd"]
    assert u["probAbove1000Kbpd"] >= u["probAbove2000Kbpd"]


# ---------------------------------------------------------------------------
# Determinism (seed)
# ---------------------------------------------------------------------------
def test_same_seed_produces_identical_output():
    a = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30, rng_seed=42)
    b = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30, rng_seed=42)
    assert a["central"] == b["central"]
    assert a["uncertainty"]["peakP50"] == b["uncertainty"]["peakP50"]


def test_different_seeds_produce_different_output():
    a = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30, rng_seed=1)
    b = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30, rng_seed=999)
    # Central paths *may* coincide occasionally but the peak percentiles very
    # rarely will if the seeds differ meaningfully.
    assert a["uncertainty"]["peakP50"] != b["uncertainty"]["peakP50"] \
        or a["uncertainty"]["peakP10"] != b["uncertainty"]["peakP10"]


# ---------------------------------------------------------------------------
# Behavioural: higher intensity → higher peak
# ---------------------------------------------------------------------------
def test_higher_intensity_raises_peak():
    low = monte_carlo_gap_forecast("hormuz_partial_closure", 0.2, 500.0, horizon=30)
    high = monte_carlo_gap_forecast("hormuz_partial_closure", 0.9, 500.0, horizon=30)
    assert high["peak"] > low["peak"]


def test_higher_exposure_raises_peak():
    low = monte_carlo_gap_forecast("hormuz_partial_closure", 0.5, 200.0, horizon=30)
    high = monte_carlo_gap_forecast("hormuz_partial_closure", 0.5, 1500.0, horizon=30)
    assert high["peak"] > low["peak"]


# ---------------------------------------------------------------------------
# Aggregate metadata
# ---------------------------------------------------------------------------
def test_uncertainty_carries_method_string():
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30)
    assert "Monte Carlo" in r["uncertainty"]["method"]
    assert r["uncertainty"]["samples"] == DEFAULT_SAMPLES
    assert r["uncertainty"]["rngSeed"] == DEFAULT_SEED


def test_uncertainty_documents_perturbations():
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0, horizon=30)
    p = r["uncertainty"]["perturbations"]
    for key in ("intensity_stddev", "elasticity_stddev_frac", "share_stddev_frac",
                "exposure_lognormal_sigma", "shock_days_jitter"):
        assert key in p


def test_small_sample_size_still_works():
    """N=10 should give the same shape, just noisier bands."""
    r = monte_carlo_gap_forecast("hormuz_partial_closure", 0.6, 500.0,
                                 horizon=30, n_samples=10)
    assert r["uncertainty"]["samples"] == 10
    assert len(r["central"]) == 30
