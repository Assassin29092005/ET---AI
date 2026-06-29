"""Sourcing intelligence — alternative supplier ranking.

Given a commodity and an optionally disrupted source country, produce a
ranked list of alternative source countries based on:
  - current geopolitical risk along the supplier's primary maritime corridor
  - historical import share (a proxy for established commercial relationships,
    payment rails, vessel availability)
  - a coarse lead-time score derived from corridor and origin

This module is deliberately scoped. It does NOT validate refinery
compatibility (API gravity, sulfur content), port draft constraints,
contract take-or-pay terms, OFAC SDN exposure on specific counterparties,
or freight rate elasticity. Those checks happen downstream of this ranking,
and we surface that caveat in every response.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


class Commodity(str, Enum):
    CRUDE_OIL = "crude_oil"
    LNG = "lng"
    COKING_COAL = "coking_coal"
    LITHIUM = "lithium"
    COBALT = "cobalt"
    NICKEL = "nickel"
    RARE_EARTHS = "rare_earths"
    SOLAR_PV = "solar_pv"
    URANIUM = "uranium"
    COPPER = "copper"
    GRAPHITE = "graphite"
    MANGANESE = "manganese"
    POLYSILICON = "polysilicon"
    SILVER = "silver"
    THERMAL_COAL = "thermal_coal"
    PGM = "pgm"
    ROCK_PHOSPHATE = "rock_phosphate"
    POTASH = "potash"


@dataclass
class SourcingOption:
    """A ranked alternative source country with explanatory metadata."""

    country: str
    composite_score: float
    current_risk: float
    historical_share: float
    lead_time_score: float
    primary_corridor: str
    rationale: str
    caveats: List[str] = field(default_factory=list)


# Country -> primary maritime corridor used to reach Indian ports.
# This is a planning-level mapping; vessels can and do reroute (e.g.
# Red Sea closures push Qatari LNG longer via Cape of Good Hope).
_COUNTRY_TO_CORRIDOR: Dict[str, str] = {
    "Saudi Arabia": "Strait of Hormuz",
    "Iraq": "Strait of Hormuz",
    "UAE": "Strait of Hormuz",
    "Kuwait": "Strait of Hormuz",
    "Iran": "Strait of Hormuz",
    "Qatar": "Strait of Hormuz",
    "Oman": "Strait of Hormuz",
    "Russia": "Suez or Cape",
    "Nigeria": "Cape of Good Hope",
    "Angola": "Cape of Good Hope",
    "USA": "Suez or Cape",
    "Brazil": "Cape of Good Hope",
    "Venezuela": "Cape of Good Hope",
    "Mexico": "Cape of Good Hope",
    "Australia": "Strait of Malacca",
    "Indonesia": "Strait of Malacca",
    "Mozambique": "Cape of Good Hope",
    "China": "South China Sea",
    "Chile": "Cape of Good Hope",
    "Argentina": "Cape of Good Hope",
    "DRC": "Cape of Good Hope",
    "Philippines": "Strait of Malacca",
    "Kazakhstan": "Land",
    "France": "Suez or Cape",
    "Vietnam": "South China Sea",
    "Malaysia": "Strait of Malacca",
    "Peru": "Cape of Good Hope",
    "Madagascar": "Cape of Good Hope",
    "Tanzania": "Cape of Good Hope",
    "South Africa": "Cape of Good Hope",
    "Gabon": "Cape of Good Hope",
    "Ghana": "Cape of Good Hope",
    "Zimbabwe": "Cape of Good Hope",
    "Togo": "Cape of Good Hope",
    "Canada": "Cape of Good Hope",
    "Morocco": "Suez or Cape",
    "UK": "Suez or Cape",
    "Switzerland": "Suez or Cape",
    "Jordan": "Bab el-Mandeb",
    "Egypt": "Bab el-Mandeb",
    "Israel": "Bab el-Mandeb",
    "Belarus": "Land",
}


# Historical import share by commodity, sourced from PPAC, GIIGNL, Ministry
# of Steel, and USGS bulletins. Loaded as fixtures at scaffold time;
# real deployment swaps these for ingest module reads.
_HISTORICAL_SHARES: Dict[Commodity, Dict[str, float]] = {
    Commodity.CRUDE_OIL: {
        "Saudi Arabia": 0.17,
        "Iraq": 0.22,
        "UAE": 0.09,
        "Russia": 0.21,
        "USA": 0.06,
        "Nigeria": 0.05,
        "Kuwait": 0.04,
        "Angola": 0.03,
        "Brazil": 0.03,
        "Mexico": 0.02,
    },
    Commodity.LNG: {
        "Qatar": 0.40,
        "USA": 0.18,
        "UAE": 0.11,
        "Australia": 0.08,
        "Russia": 0.06,
        "Nigeria": 0.05,
        "Oman": 0.04,
        "Mozambique": 0.02,
    },
    Commodity.COKING_COAL: {
        "Australia": 0.70,
        "USA": 0.10,
        "Russia": 0.08,
        "Indonesia": 0.05,
        "Mozambique": 0.04,
    },
    Commodity.LITHIUM: {
        "Chile": 0.40,
        "Argentina": 0.20,
        "China": 0.30,
        "Australia": 0.08,
    },
    Commodity.COBALT: {
        "DRC": 0.65,
        "China": 0.20,
        "Indonesia": 0.08,
        "Philippines": 0.04,
    },
    Commodity.NICKEL: {
        "Indonesia": 0.55,
        "Philippines": 0.18,
        "Russia": 0.10,
        "Australia": 0.08,
    },
    Commodity.RARE_EARTHS: {
        "China": 0.90,
        "Malaysia": 0.04,
        "USA": 0.03,
        "Vietnam": 0.02,
    },
    Commodity.SOLAR_PV: {
        "China": 0.80,
        "Vietnam": 0.08,
        "Malaysia": 0.05,
        "USA": 0.03,
    },
    Commodity.URANIUM: {
        "Kazakhstan": 0.45,
        "Russia": 0.20,
        "France": 0.15,
        "Australia": 0.10,
    },
    Commodity.COPPER: {
        "Chile": 0.28,
        "Peru": 0.20,
        "Indonesia": 0.14,
        "Australia": 0.12,
        "Brazil": 0.08,
        "USA": 0.05,
    },
    Commodity.GRAPHITE: {
        "China": 0.50,
        "Madagascar": 0.16,
        "Mozambique": 0.12,
        "Tanzania": 0.08,
        "Vietnam": 0.06,
        "USA": 0.03,
    },
    Commodity.MANGANESE: {
        "South Africa": 0.42,
        "Gabon": 0.20,
        "Australia": 0.15,
        "Ghana": 0.08,
        "Brazil": 0.06,
        "Indonesia": 0.04,
    },
    Commodity.POLYSILICON: {
        "China": 0.85,
        "Malaysia": 0.05,
        "Germany": 0.04,
        "USA": 0.03,
        "Vietnam": 0.02,
    },
    Commodity.SILVER: {
        "UAE": 0.30,
        "UK": 0.18,
        "China": 0.14,
        "Switzerland": 0.12,
        "Australia": 0.10,
        "Peru": 0.06,
    },
    Commodity.THERMAL_COAL: {
        "Indonesia": 0.52,
        "Australia": 0.22,
        "South Africa": 0.12,
        "Russia": 0.08,
        "USA": 0.04,
    },
    Commodity.PGM: {
        "South Africa": 0.68,
        "Russia": 0.16,
        "Zimbabwe": 0.08,
        "USA": 0.04,
    },
    Commodity.ROCK_PHOSPHATE: {
        "Morocco": 0.40,
        "Jordan": 0.18,
        "Saudi Arabia": 0.14,
        "Egypt": 0.10,
        "Togo": 0.08,
        "UAE": 0.05,
    },
    Commodity.POTASH: {
        "Canada": 0.34,
        "Russia": 0.20,
        "Belarus": 0.18,
        "Israel": 0.12,
        "Jordan": 0.10,
        "Germany": 0.04,
    },
}


# Lead-time score in [0, 1] where 1 is fastest. Captures voyage distance,
# typical port turnaround, and overland alternatives.
_LEAD_TIME_SCORE: Dict[str, float] = {
    "Strait of Hormuz": 0.90,
    "Strait of Malacca": 0.70,
    "South China Sea": 0.65,
    "Suez or Cape": 0.55,
    "Cape of Good Hope": 0.45,
    "Land": 0.80,
}


_DEFAULT_CORRIDOR_RISK: Dict[str, float] = {
    "Strait of Hormuz": 0.55,
    "Bab el-Mandeb": 0.70,
    "Strait of Malacca": 0.30,
    "South China Sea": 0.45,
    "Cape of Good Hope": 0.20,
    "Suez or Cape": 0.50,
    "Land": 0.35,
}


def country_risk_by_corridor(country: str) -> float:
    """Return the current corridor risk for a source country.

    Risk is in [0, 1] where higher is worse. Sourced from the corridor risk
    engine that fuses GDELT geopolitical signals, AISStream traffic
    anomalies, and active sanctions snapshots. Falls back to a default
    table when live signals are unavailable.
    """
    corridor = _COUNTRY_TO_CORRIDOR.get(country, "Cape of Good Hope")
    try:
        from app.engines.corridor_risk import current_corridor_risk

        live = current_corridor_risk(corridor)
        if live is not None:
            return float(live)
    except Exception:
        # Corridor risk engine may not be wired in scaffold; fall through.
        pass
    return _DEFAULT_CORRIDOR_RISK.get(corridor, 0.5)


def _rationale_text(
    country: str,
    corridor: str,
    risk: float,
    share: float,
    disrupted_source: Optional[str],
) -> str:
    parts = []
    if disrupted_source:
        parts.append(
            f"Substitutes for {disrupted_source} with {share * 100:.1f} percent "
            f"of recent imports already sourced from {country}."
        )
    else:
        parts.append(
            f"Established supplier carrying {share * 100:.1f} percent of recent imports."
        )

    if risk < 0.25:
        parts.append(f"Routes via {corridor} where current corridor risk is low.")
    elif risk < 0.5:
        parts.append(f"Routes via {corridor} with moderate corridor risk.")
    else:
        parts.append(
            f"Routes via {corridor} where corridor risk is elevated — "
            "freight and insurance premia will be priced in."
        )
    return " ".join(parts)


async def rank_alternatives(
    commodity: Commodity,
    disrupted_source: Optional[str] = None,
    risk_overrides: Optional[Dict[str, float]] = None,
) -> List[SourcingOption]:
    """Rank alternative source countries for a commodity.

    Composite score = 0.5 * (1 - current_risk)
                    + 0.3 * historical_share
                    + 0.2 * lead_time_score

    The disrupted source, if provided, is excluded from the result so the
    caller sees only substitutes.

    ``risk_overrides`` maps a corridor label (e.g. "Strait of Hormuz") to a
    current risk in [0, 1] and supersedes the static default table. The API
    layer populates it from the live corridor scores and from any active
    disruption (a full chokepoint cutoff drives the affected corridor to ~1.0),
    so the ranking re-orders as risk moves rather than staying fixed.
    """
    shares = _HISTORICAL_SHARES.get(commodity, {})
    if not shares:
        return []

    options: List[SourcingOption] = []
    for country, share in shares.items():
        if disrupted_source and country.lower() == disrupted_source.lower():
            continue

        corridor = _COUNTRY_TO_CORRIDOR.get(country, "Cape of Good Hope")
        if risk_overrides and corridor in risk_overrides:
            risk = max(0.0, min(1.0, float(risk_overrides[corridor])))
        else:
            risk = country_risk_by_corridor(country)
        lead_time = _LEAD_TIME_SCORE.get(corridor, 0.5)

        score = 0.5 * (1.0 - risk) + 0.3 * share + 0.2 * lead_time

        caveats = [
            "Ranking does not validate refinery compatibility, port draft "
            "constraints, or contract terms.",
        ]
        if commodity == Commodity.CRUDE_OIL:
            caveats.append(
                "Crude grade match (API gravity, sulfur) must be confirmed "
                "with the receiving refinery before nomination."
            )
        if commodity == Commodity.LNG:
            caveats.append(
                "Regas terminal slot availability and send-out capacity "
                "must be confirmed at Dahej, Hazira, Kochi, Dabhol, or Ennore."
            )
        if commodity == Commodity.COKING_COAL:
            caveats.append(
                "Coke quality parameters (CSR, ash, VM) vary by mine — "
                "verify with steel plant metallurgy team."
            )

        options.append(
            SourcingOption(
                country=country,
                composite_score=round(score, 4),
                current_risk=round(risk, 4),
                historical_share=round(share, 4),
                lead_time_score=round(lead_time, 4),
                primary_corridor=corridor,
                rationale=_rationale_text(
                    country, corridor, risk, share, disrupted_source
                ),
                caveats=caveats,
            )
        )

    options.sort(key=lambda o: o.composite_score, reverse=True)
    return options[:8]
