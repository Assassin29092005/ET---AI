"""Monte Carlo confidence band for the SPR supply-gap forecast.

Replaces the earlier stylized parametric band (``unc = base * (0.15 + 0.012*d)``)
with a true percentile band computed from N=200 perturbed trajectories.

Perturbations (all stdlib ``random``; deterministic under a seed):
  * intensity           — Normal(mean=input, sd=0.10), clipped to [0.05, 1.0]
                          — operator-provided input; the noise represents
                            how badly the analyst can misjudge severity
  * crude_price_elasticity — Normal(mean=doc, sd=10% of doc)
                          — priced-in uncertainty in the scenario's own
                            documented elasticity (from SCENARIOS.params)
  * crude_volume_share  — Normal(mean=doc, sd=5% of doc), clipped [0.05, 1.0]
                          — refinery-import share ambiguity
  * exposure_kbpd       — Lognormal(mean=input, sd=0.15 on log scale)
                          — refinery slate + grade-substitution uncertainty;
                            lognormal because exposure is strictly positive
                            and can have upside tails
  * shock_days offset   — Uniform int in [-3, +3]
                          — timing uncertainty on when the shock peaks/ends

Non-crude scenarios (rare earth, solar, uranium, coking coal): return a flat
zero-band because SPR is a crude-only tool; no gap → no perturbation.

Output shape backward-compatible with the previous forecast:
  ``[{day, central, low, high}, ...]``
where ``central`` is the p50 across samples, ``low`` is p10, ``high`` is p90.
Additional aggregate stats returned via ``aggregate()``.

Performance: 200 samples × 60 days ≈ 12 k arithmetic ops; ~10 ms end-to-end.
"""
from __future__ import annotations

import math
import random
import statistics
from dataclasses import dataclass


# Scenarios whose primary commodity is crude — SPR only insures against these.
_CRUDE_SCENARIOS: frozenset[str] = frozenset({
    "hormuz_partial_closure",
    "opec_emergency_cut",
    "red_sea_suspension",
})

# Perturbation stddevs, kept as named constants so tests + docs can reference them.
INTENSITY_STDDEV = 0.10          # additive, Gaussian
ELASTICITY_STDDEV_FRAC = 0.10    # multiplicative, applied to documented elasticity
SHARE_STDDEV_FRAC = 0.05         # multiplicative, applied to documented volume share
EXPOSURE_LOGNORMAL_SIGMA = 0.15  # multiplicative log-space sigma
SHOCK_DAYS_JITTER = 3            # +/- days on the shock-window boundary

DEFAULT_SAMPLES = 200
DEFAULT_SEED = 42


@dataclass
class SampledParams:
    intensity: float
    elasticity: float
    volume_share: float
    exposure_kbpd: float
    shock_days: int


def _clip(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _sample_params(
    rng: random.Random,
    *,
    intensity: float,
    exposure_kbpd: float,
    scenario_params: dict,
    base_shock_days: int,
) -> SampledParams:
    """Draw one perturbed parameter tuple."""
    doc_elasticity = float(scenario_params.get("crude_price_elasticity", 0.30))
    doc_share = float(scenario_params.get("crude_volume_share", 0.40))
    i = _clip(rng.gauss(intensity, INTENSITY_STDDEV), 0.05, 1.0)
    el = max(0.01, rng.gauss(doc_elasticity, ELASTICITY_STDDEV_FRAC * abs(doc_elasticity)))
    sh = _clip(rng.gauss(doc_share, SHARE_STDDEV_FRAC * abs(doc_share)), 0.05, 1.0)
    # Lognormal: draw normal then exponentiate; center on log(exposure).
    exp_log = math.log(max(exposure_kbpd, 1.0))
    ex = math.exp(rng.gauss(exp_log, EXPOSURE_LOGNORMAL_SIGMA))
    sd = base_shock_days + rng.randint(-SHOCK_DAYS_JITTER, SHOCK_DAYS_JITTER)
    sd = max(3, sd)  # keep the shock at least 3 days long — a real disruption
    return SampledParams(intensity=i, elasticity=el, volume_share=sh, exposure_kbpd=ex, shock_days=sd)


def _trajectory(params: SampledParams, horizon: int) -> list[float]:
    """Compute one full daily-gap trajectory from a sampled parameter tuple.

    Shape matches the original _spr_gap_forecast:
      * days [0, shock_days)         → full peak
      * days [shock_days, 2·shock_days) → 40% decay plateau
      * days [2·shock_days, horizon) → zero
    """
    # Peak scales with the SAMPLED intensity × exposure × the elasticity-vs-share
    # ratio (a proxy for how tightly the market clears — higher elasticity or
    # higher share both raise the realised gap).
    ratio = (params.elasticity / 0.30) * (params.volume_share / 0.40)
    peak = params.exposure_kbpd * params.intensity * ratio
    out: list[float] = []
    for d in range(horizon):
        if d < params.shock_days:
            out.append(peak)
        elif d < 2 * params.shock_days:
            out.append(peak * 0.4)
        else:
            out.append(0.0)
    return out


def _percentiles(samples: list[float], probs: tuple[float, float, float] = (0.10, 0.50, 0.90)) -> tuple[float, float, float]:
    """Compute (p_low, p_mid, p_high). Statistics.quantiles handles n<2 poorly
    so we short-circuit; for n>=2 we ask for 99 cut-points (n=100) and index."""
    if not samples:
        return 0.0, 0.0, 0.0
    if len(samples) == 1:
        v = samples[0]
        return v, v, v
    cuts = statistics.quantiles(samples, n=100, method="inclusive")
    # cuts has 99 elements: cuts[i-1] is the i-th percentile (1..99).
    def _at(p: float) -> float:
        idx = max(0, min(98, int(round(p * 100.0)) - 1))
        return float(cuts[idx])
    return _at(probs[0]), _at(probs[1]), _at(probs[2])


def monte_carlo_gap_forecast(
    scenario_id: str | None,
    intensity: float,
    exposure_kbpd: float,
    horizon: int,
    *,
    scenario_params: dict | None = None,
    n_samples: int = DEFAULT_SAMPLES,
    rng_seed: int = DEFAULT_SEED,
    base_shock_days: int | None = None,
) -> dict:
    """Return a Monte Carlo gap forecast with per-day p10/p50/p90.

    Backward-compatible with _spr_gap_forecast's callers:
      * ``central`` list is the p50 path — feed straight into the LP.
      * ``forecast`` list is [{day, central, low, high}] — for the chart.
      * ``peak`` scalar is p50 of the daily maxima.
      * ``uncertainty`` dict adds aggregate percentiles + prob-above thresholds.

    Non-crude scenarios return a flat zero-forecast (no SPR relevance).
    """
    horizon = max(1, int(horizon))
    base_shock_days = base_shock_days if base_shock_days is not None else min(21, max(7, horizon // 3))

    # Non-crude → no SPR-relevant gap. Emit the shape the caller expects.
    if scenario_id and scenario_id not in _CRUDE_SCENARIOS:
        zeros = [0.0] * horizon
        forecast = [{"day": d, "central": 0.0, "low": 0.0, "high": 0.0} for d in range(horizon)]
        return {
            "central": zeros,
            "forecast": forecast,
            "peak": 0.0,
            "uncertainty": _empty_uncertainty(n_samples),
        }

    if scenario_params is None:
        scenario_params = {}
    rng = random.Random(rng_seed)

    # Draw N sampled trajectories.
    trajectories: list[list[float]] = []
    peaks: list[float] = []
    for _ in range(int(n_samples)):
        sp = _sample_params(
            rng,
            intensity=intensity,
            exposure_kbpd=exposure_kbpd,
            scenario_params=scenario_params,
            base_shock_days=base_shock_days,
        )
        traj = _trajectory(sp, horizon)
        trajectories.append(traj)
        peaks.append(max(traj) if traj else 0.0)

    # Per-day percentiles across samples.
    forecast: list[dict] = []
    central: list[float] = []
    for d in range(horizon):
        day_samples = [trajectories[i][d] for i in range(n_samples)]
        p10, p50, p90 = _percentiles(day_samples)
        forecast.append({
            "day": d,
            "central": round(p50, 1),
            "low": round(p10, 1),
            "high": round(p90, 1),
        })
        central.append(round(p50, 1))

    # Aggregate stats over the sampled peaks.
    peak_p10, peak_p50, peak_p90 = _percentiles(peaks)
    prob_above = lambda x: sum(1 for p in peaks if p >= x) / max(1, len(peaks))  # noqa: E731

    return {
        "central": central,
        "forecast": forecast,
        "peak": round(peak_p50, 1),
        "uncertainty": {
            "method": "Monte Carlo (N=%d, stddev perturbation on intensity/elasticity/share/exposure/shock_days)" % n_samples,
            "samples": int(n_samples),
            "rngSeed": int(rng_seed),
            "peakP10": round(peak_p10, 1),
            "peakP50": round(peak_p50, 1),
            "peakP90": round(peak_p90, 1),
            "probAbove500Kbpd": round(prob_above(500.0), 3),
            "probAbove1000Kbpd": round(prob_above(1000.0), 3),
            "probAbove2000Kbpd": round(prob_above(2000.0), 3),
            "perturbations": {
                "intensity_stddev": INTENSITY_STDDEV,
                "elasticity_stddev_frac": ELASTICITY_STDDEV_FRAC,
                "share_stddev_frac": SHARE_STDDEV_FRAC,
                "exposure_lognormal_sigma": EXPOSURE_LOGNORMAL_SIGMA,
                "shock_days_jitter": SHOCK_DAYS_JITTER,
            },
        },
    }


def _empty_uncertainty(n_samples: int) -> dict:
    return {
        "method": "no SPR-relevant gap for this scenario (non-crude)",
        "samples": int(n_samples),
        "rngSeed": DEFAULT_SEED,
        "peakP10": 0.0,
        "peakP50": 0.0,
        "peakP90": 0.0,
        "probAbove500Kbpd": 0.0,
        "probAbove1000Kbpd": 0.0,
        "probAbove2000Kbpd": 0.0,
        "perturbations": {
            "intensity_stddev": INTENSITY_STDDEV,
            "elasticity_stddev_frac": ELASTICITY_STDDEV_FRAC,
            "share_stddev_frac": SHARE_STDDEV_FRAC,
            "exposure_lognormal_sigma": EXPOSURE_LOGNORMAL_SIGMA,
            "shock_days_jitter": SHOCK_DAYS_JITTER,
        },
    }
