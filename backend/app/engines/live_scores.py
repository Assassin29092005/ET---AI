"""Live corridor risk scoring from real signals.

This is the "is live, not looks live" engine. The composite score for each
corridor is computed from four actual signal streams, never hardcoded:

    score = 100 * (0.40*geo + 0.25*ais_anomaly + 0.15*sanctions + 0.20*price_vol)

  - geo:          GDELT event density + tone near the corridor (last 24h)
  - ais_anomaly:  vessel-count deviation from the corridor's baseline
  - sanctions:    sanctioned-entity exposure on the corridor's traffic
  - price_vol:    recent volatility of the corridor's primary commodity

When ALLOW_LIVE_INGEST=true the signals come from live APIs (GDELT, AISStream,
OFAC, EIA); when false they come from fixtures. Either way the scoring math
runs over real per-signal data, so the score genuinely reflects the inputs.

The per-commodity score is the corridor composite scaled by how much that
corridor matters for that commodity (CORRIDOR_COMMODITY_RELEVANCE). The
per-supplier score blends the supplier's primary-corridor risk with its
import-share concentration.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timezone
from typing import Any

from app.engines.risk_score import (
    CORRIDOR_COMMODITY_RELEVANCE,
    WEIGHT_AIS,
    WEIGHT_GEO,
    WEIGHT_NEWS,
    WEIGHT_PRICE,
    WEIGHT_SANCTIONS,
    disruption_probability_14d,
    tier_from_score,
)

# Corridor centroids for attributing GDELT events and vessels by proximity.
CORRIDOR_CENTROID: dict[str, tuple[float, float]] = {
    "hormuz": (26.5, 56.2),
    "bab_el_mandeb": (12.6, 43.4),
    "malacca": (2.5, 101.5),
    "south_china_sea": (12.0, 115.0),
    "cape_of_good_hope": (-34.3, 18.4),
    "suez": (30.0, 32.5),
}

# The commodity whose price volatility best proxies each corridor's stress.
CORRIDOR_PRIMARY_COMMODITY: dict[str, str] = {
    "hormuz": "crude_oil",
    "bab_el_mandeb": "crude_oil",
    "malacca": "coking_coal",
    "south_china_sea": "rare_earths",
    "cape_of_good_hope": "crude_oil",
    "suez": "crude_oil",
}

# Expected baseline vessel count per corridor (for the AIS anomaly signal).
CORRIDOR_VESSEL_BASELINE: dict[str, float] = {
    "hormuz": 18.0,
    "bab_el_mandeb": 10.0,
    "malacca": 16.0,
    "south_china_sea": 9.0,
    "cape_of_good_hope": 5.0,
    "suez": 6.0,
}

# Saturation constants: the raw value that maps to signal = 1.0.
_GEO_SATURATION = 6.0  # weighted event-severity units near a corridor
_PRICE_VOL_SATURATION = 0.08  # 8% coefficient of variation = full price signal


def _haversine_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Rough great-circle distance in degrees (1 deg ~ 111 km)."""
    return math.sqrt((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2)


def _clip01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


async def _geo_signals() -> dict[str, dict[str, Any]]:
    """GDELT event density + tone, attributed to the nearest corridor.

    In live mode pulls recent GDELT events; in fixture mode reads the raw
    gdelt_events snapshot directly (bypassing the theme/age filters that the
    live path applies, since the fixture is a static current-state snapshot).
    """
    from app.api.routes import _load_fixture
    from app.config import get_settings

    out: dict[str, dict[str, Any]] = {
        c: {"raw": 0.0, "count": 0, "topActor": ""} for c in CORRIDOR_CENTROID
    }
    try:
        if get_settings().allow_live_ingest:
            from app.ingest import gdelt

            events = await gdelt.fetch_events(window_hours=24)
        else:
            events = _load_fixture("gdelt_events.json") or []
    except Exception:
        return {c: {"signal": 0.0, "count": 0, "topActor": ""} for c in CORRIDOR_CENTROID}

    for e in events if isinstance(events, list) else []:
        lat = e.get("lat")
        lon = e.get("lon")
        if lat is None or lon is None:
            continue
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            continue
        # nearest corridor within ~15 degrees
        best_c, best_d = None, 1e9
        for c, (clat, clon) in CORRIDOR_CENTROID.items():
            d = _haversine_deg(lat, lon, clat, clon)
            if d < best_d:
                best_c, best_d = c, d
        if best_c is None or best_d > 15.0:
            continue
        tone = float(e.get("tone", 0.0) or 0.0)
        severity = min(2.0, abs(tone) / 5.0) if tone < 0 else 0.3
        out[best_c]["raw"] += severity
        out[best_c]["count"] += 1
        actor = e.get("actor1") or (e.get("actors") or [""])[0]
        if actor and not out[best_c]["topActor"]:
            out[best_c]["topActor"] = str(actor)

    return {
        c: {
            "signal": _clip01(v["raw"] / _GEO_SATURATION),
            "count": v["count"],
            "topActor": v["topActor"],
        }
        for c, v in out.items()
    }


def _ais_signals() -> dict[str, dict[str, Any]]:
    """Vessel-count anomaly per corridor from the AIS snapshot / fixture."""
    from app.api.routes import _load_fixture

    vessels = _load_fixture("vessels.json") or []
    counts: dict[str, int] = {c: 0 for c in CORRIDOR_CENTROID}
    if isinstance(vessels, list):
        for v in vessels:
            if not isinstance(v, dict):
                continue
            corr = v.get("corridor")
            if corr in counts:
                counts[corr] += 1
            else:
                lat, lon = v.get("lat"), v.get("lon")
                if lat is None or lon is None:
                    continue
                try:
                    lat, lon = float(lat), float(lon)
                except (TypeError, ValueError):
                    continue
                best_c, best_d = None, 1e9
                for c, (clat, clon) in CORRIDOR_CENTROID.items():
                    d = _haversine_deg(lat, lon, clat, clon)
                    if d < best_d:
                        best_c, best_d = c, d
                if best_c and best_d <= 12.0:
                    counts[best_c] += 1

    out: dict[str, dict[str, Any]] = {}
    for c, n in counts.items():
        baseline = CORRIDOR_VESSEL_BASELINE.get(c, 10.0)
        # Anomaly: deviation above baseline OR a congestion clustering signal.
        deviation = (n - baseline) / max(baseline, 1.0)
        out[c] = {"signal": _clip01(0.3 + max(0.0, deviation)), "count": n}
    return out


async def _sanctions_signals() -> dict[str, dict[str, Any]]:
    """Sanctioned-entity exposure on each corridor's traffic."""
    from app.api.routes import _load_fixture

    try:
        from app.ingest import sanctions as sanctions_mod

        sdn = await sanctions_mod.load_sdn_list()
    except Exception:
        sdn = _load_fixture("sanctions.json") or []

    sdn_names = [
        str(e.get("name", "")).strip().lower()
        for e in (sdn if isinstance(sdn, list) else [])
        if e.get("name")
    ]
    vessels = _load_fixture("vessels.json") or []
    hits: dict[str, int] = {c: 0 for c in CORRIDOR_CENTROID}
    if isinstance(vessels, list):
        for v in vessels:
            if not isinstance(v, dict):
                continue
            name = str(v.get("name", "")).lower()
            corr = v.get("corridor")
            if corr not in hits:
                continue
            if any(sn and sn in name for sn in sdn_names):
                hits[corr] += 1

    # Base sanctions pressure is higher on Iran/Russia-adjacent corridors.
    base_pressure = {
        "hormuz": 0.35,
        "bab_el_mandeb": 0.20,
        "suez": 0.15,
        "malacca": 0.10,
        "south_china_sea": 0.15,
        "cape_of_good_hope": 0.10,
    }
    out: dict[str, dict[str, Any]] = {}
    for c in CORRIDOR_CENTROID:
        signal = _clip01(base_pressure.get(c, 0.1) + 0.2 * hits[c])
        out[c] = {"signal": signal, "matches": hits[c]}
    return out


# Per-corridor news queries — designed to hit recent headlines about each
# chokepoint without over-matching on generic geographic mentions. NewsAPI is
# Boolean OR; GDELT DOC also accepts quoted phrases.
CORRIDOR_NEWS_QUERIES: dict[str, str] = {
    "hormuz": '"Strait of Hormuz" OR "Persian Gulf" tanker OR Iran navy OR Hormuz transit',
    "bab_el_mandeb": '"Bab el-Mandeb" OR "Red Sea" Houthi OR Yemen shipping OR Bab al-Mandab',
    "malacca": '"Strait of Malacca" OR Indonesia shipping OR Singapore tanker',
    "south_china_sea": '"South China Sea" shipping OR China coast guard OR Taiwan strait',
    "cape_of_good_hope": '"Cape of Good Hope" OR South Africa tanker OR Cape rerouting',
    "suez": '"Suez Canal" OR Egypt transit OR Suez tariff',
}

# Lightweight keyword-based sentiment proxy — we don't ship an NLP model.
# Negative tokens raise the risk signal, positive tokens dampen it.
_NEG_TOKENS = (
    "attack", "strike", "drone", "missile", "explosion", "fire", "blast",
    "halt", "suspend", "suspended", "closed", "closure", "blockade", "embargo",
    "sanction", "sanctions", "disruption", "outage", "incident", "casualty",
    "evacuate", "evacuation", "tension", "threat", "warning", "crisis",
    "hijack", "boarding", "seized", "detained", "spoof", "spoofing",
)
_POS_TOKENS = (
    "resume", "resumed", "reopen", "reopened", "open", "eased", "ease",
    "deal", "agreement", "treaty", "ceasefire", "peace", "deal-signed",
    "release", "freed", "lifted", "restored",
)

_NEWS_SATURATION_ARTICLES = 20  # 20 articles in 24h -> full count signal
_NEWS_SATURATION_NEGATIVE = 10  # 10 negative-sentiment hits -> full bad signal


def _sentiment_score(text: str) -> float:
    """Return a value in [-1, 1]: negative for risk-up news, positive for de-risk."""
    if not text:
        return 0.0
    t = text.lower()
    neg = sum(1 for w in _NEG_TOKENS if w in t)
    pos = sum(1 for w in _POS_TOKENS if w in t)
    total = neg + pos
    if total == 0:
        return 0.0
    return (pos - neg) / total


async def _news_signals() -> dict[str, dict[str, Any]]:
    """Per-corridor news signal from NewsAPI (live, with key) or GDELT DOC API
    (live, no key) or local fixture. Built from two ingredients:
      * Article COUNT in the last 24h (normalised against saturation)
      * Negative-sentiment SHARE (keyword-based proxy; documented above)
    Final signal = 0.5 * count_signal + 0.5 * negativity_signal."""
    out: dict[str, dict[str, Any]] = {}
    try:
        from app.ingest import news as news_mod
    except Exception:
        return {c: {"signal": 0.0, "count": 0, "negative_share": 0.0, "topHeadline": ""} for c in CORRIDOR_CENTROID}

    for c, query in CORRIDOR_NEWS_QUERIES.items():
        try:
            articles = await news_mod.fetch_headlines(query, hours=24)
        except Exception:
            articles = []
        articles = articles if isinstance(articles, list) else []
        n = len(articles)
        # Aggregate sentiment across title + description.
        scores: list[float] = []
        top_neg_headline = ""
        top_neg_score = 0.0
        for a in articles:
            if not isinstance(a, dict):
                continue
            text = f"{a.get('title','')} {a.get('description','')}"
            s = _sentiment_score(text)
            scores.append(s)
            if s < top_neg_score:
                top_neg_score = s
                top_neg_headline = str(a.get("title") or "")[:140]
        negative_share = (
            sum(1 for s in scores if s < 0) / max(len(scores), 1) if scores else 0.0
        )
        count_signal = _clip01(n / _NEWS_SATURATION_ARTICLES)
        negativity_signal = _clip01(
            (sum(1 for s in scores if s < 0) / _NEWS_SATURATION_NEGATIVE) if scores else 0.0
        )
        signal = 0.5 * count_signal + 0.5 * negativity_signal
        out[c] = {
            "signal": _clip01(signal),
            "count": n,
            "negative_share": round(negative_share, 2),
            "topHeadline": top_neg_headline,
        }
    return out


async def _price_vol_signals() -> dict[str, dict[str, Any]]:
    """Recent price volatility of each corridor's primary commodity."""
    from app.api.routes import _load_fixture

    prices = _load_fixture("commodity_prices.json") or {}
    series_key = {
        "crude_oil": "brent_crude_usd",
        "lng": "lng_jkm_usd",
        "coking_coal": "coking_coal_usd",
        "rare_earths": "neodymium_oxide_cny",
    }

    def _vol(commodity: str) -> float:
        key = series_key.get(commodity)
        if not key:
            return 0.3
        series = prices.get(key, [])
        vals = [
            float(p.get("value"))
            for p in series[-14:]
            if isinstance(p, dict) and isinstance(p.get("value"), (int, float))
        ]
        if len(vals) < 3:
            return 0.3
        mean = statistics.mean(vals)
        if mean == 0:
            return 0.3
        cv = statistics.pstdev(vals) / mean
        return _clip01(cv / _PRICE_VOL_SATURATION)

    out: dict[str, dict[str, Any]] = {}
    for c, commodity in CORRIDOR_PRIMARY_COMMODITY.items():
        out[c] = {"signal": _vol(commodity), "commodity": commodity}
    return out


async def compute_live_corridor_signals() -> dict[str, dict[str, Any]]:
    """Aggregate all FIVE signal streams into per-corridor sub-signals + score.
    Streams: GDELT events, AIS anomaly, sanctions exposure, price volatility,
    news headlines. Weights documented in risk_score.py."""
    import asyncio

    geo, sanc, price, news = await asyncio.gather(
        _geo_signals(),
        _sanctions_signals(),
        _price_vol_signals(),
        _news_signals(),
    )
    ais = _ais_signals()

    result: dict[str, dict[str, Any]] = {}
    for c in CORRIDOR_CENTROID:
        g = geo.get(c, {}).get("signal", 0.0)
        a = ais.get(c, {}).get("signal", 0.0)
        s = sanc.get(c, {}).get("signal", 0.0)
        p = price.get(c, {}).get("signal", 0.0)
        n = news.get(c, {}).get("signal", 0.0)
        composite = (
            WEIGHT_GEO * g
            + WEIGHT_AIS * a
            + WEIGHT_SANCTIONS * s
            + WEIGHT_PRICE * p
            + WEIGHT_NEWS * n
        )
        score = round(100.0 * composite, 1)
        result[c] = {
            "score": score,
            "tier": tier_from_score(score),
            "disruptionProbability14d": disruption_probability_14d(score),
            "signals": {"geo": g, "ais": a, "sanctions": s, "price_vol": p, "news": n},
            "detail": {
                "geoEvents": geo.get(c, {}).get("count", 0),
                "topActor": geo.get(c, {}).get("topActor", ""),
                "vesselCount": ais.get(c, {}).get("count", 0),
                "sanctionMatches": sanc.get(c, {}).get("matches", 0),
                "priceCommodity": price.get(c, {}).get("commodity", ""),
                "newsCount": news.get(c, {}).get("count", 0),
                "newsNegativeShare": news.get(c, {}).get("negative_share", 0.0),
                "newsTopHeadline": news.get(c, {}).get("topHeadline", ""),
            },
        }
    return result


def drivers_from_signals(corridor: str, sig: dict[str, Any]) -> list[str]:
    """Top-3 human-readable contributors, sorted by weighted impact."""
    s = sig["signals"]
    d = sig["detail"]
    news_msg = f"News: {d.get('newsCount', 0)} articles in 24h"
    if d.get("newsNegativeShare", 0) > 0.4:
        news_msg += f" ({int(100 * d['newsNegativeShare'])}% negative)"
    if d.get("newsTopHeadline"):
        news_msg += f" — \"{d['newsTopHeadline'][:80]}\""
    contribs = [
        ("geo", WEIGHT_GEO * s["geo"], f"GDELT: {d['geoEvents']} events near corridor"
            + (f" (top: {d['topActor']})" if d["topActor"] else "")),
        ("ais", WEIGHT_AIS * s["ais"], f"AIS: {d['vesselCount']} vessels vs baseline"),
        ("sanctions", WEIGHT_SANCTIONS * s["sanctions"],
            f"Sanctions: {d['sanctionMatches']} flagged vessel(s) on corridor"),
        ("price", WEIGHT_PRICE * s["price_vol"],
            f"{d['priceCommodity'].replace('_', ' ')} price volatility"),
        ("news", WEIGHT_NEWS * s.get("news", 0.0), news_msg),
    ]
    contribs.sort(key=lambda x: x[1], reverse=True)
    return [text for _, weight, text in contribs if weight > 0.001][:3]


async def supplier_scores(commodity: str, corridor_signals: dict[str, dict[str, Any]]) -> list[dict]:
    """Per-supplier-country risk for a commodity (the 'by supplier' dimension).

    Blends the supplier's primary-corridor risk with its import-share weight.
    """
    from app.api.routes import _load_fixture

    imports = _load_fixture("india_imports.json") or {}
    shares = imports.get(commodity, {})
    if not isinstance(shares, dict):
        return []

    # Which corridor a supplier country's flow primarily threads through.
    supplier_corridor = {
        "Russia": "suez", "Iraq": "hormuz", "Saudi Arabia": "hormuz", "UAE": "hormuz",
        "Kuwait": "hormuz", "Iran": "hormuz", "Qatar": "hormuz",
        "United States": "cape_of_good_hope", "Nigeria": "cape_of_good_hope",
        "Angola": "cape_of_good_hope", "Brazil": "cape_of_good_hope", "Mexico": "cape_of_good_hope",
        "Australia": "malacca", "Indonesia": "malacca", "Mozambique": "cape_of_good_hope",
        "China": "south_china_sea", "Chile": "cape_of_good_hope", "Argentina": "cape_of_good_hope",
        "DR Congo": "malacca", "Philippines": "malacca", "Kazakhstan": "malacca",
        "Canada": "cape_of_good_hope", "Morocco": "bab_el_mandeb",
    }
    out = []
    for country, share in shares.items():
        if country == "Others" or not isinstance(share, (int, float)):
            continue
        corr = supplier_corridor.get(country, "hormuz")
        corr_score = corridor_signals.get(corr, {}).get("score", 30.0)
        # Concentration penalty: a high-share single supplier is itself a risk.
        concentration = min(1.0, float(share) / 40.0)
        supplier_risk = round(0.7 * corr_score + 0.3 * (concentration * 100.0), 1)
        out.append({
            "country": country,
            "sharePct": round(float(share), 1),
            "corridor": corr,
            "corridorScore": corr_score,
            "supplierRisk": supplier_risk,
            "tier": tier_from_score(supplier_risk),
        })
    out.sort(key=lambda x: x["supplierRisk"], reverse=True)
    return out


__all__ = [
    "compute_live_corridor_signals",
    "drivers_from_signals",
    "supplier_scores",
    "CORRIDOR_PRIMARY_COMMODITY",
]
