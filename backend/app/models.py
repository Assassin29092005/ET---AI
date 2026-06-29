"""Pydantic v2 domain models exchanged across the API boundary.

These models are the canonical wire format for the dashboard. Internal
analytics objects may carry richer fields; anything that crosses the HTTP
boundary is shaped by what's defined here.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class Commodity(str, Enum):
    """Strategic imports tracked by the platform."""

    CRUDE_OIL = "CRUDE_OIL"
    LNG = "LNG"
    COKING_COAL = "COKING_COAL"
    LITHIUM = "LITHIUM"
    COBALT = "COBALT"
    NICKEL = "NICKEL"
    RARE_EARTH = "RARE_EARTH"
    SOLAR_PV = "SOLAR_PV"
    URANIUM = "URANIUM"
    LPG = "LPG"
    COPPER = "COPPER"
    GRAPHITE = "GRAPHITE"
    MANGANESE = "MANGANESE"
    POLYSILICON = "POLYSILICON"
    SILVER = "SILVER"
    THERMAL_COAL = "THERMAL_COAL"
    PGM = "PGM"
    ROCK_PHOSPHATE = "ROCK_PHOSPHATE"
    POTASH = "POTASH"


class Corridor(str, Enum):
    """Maritime corridors monitored for chokepoint risk."""

    HORMUZ = "HORMUZ"
    BAB_EL_MANDEB = "BAB_EL_MANDEB"
    MALACCA = "MALACCA"
    SOUTH_CHINA_SEA = "SOUTH_CHINA_SEA"
    CAPE = "CAPE"


class RiskTier(str, Enum):
    LOW = "low"
    ELEVATED = "elevated"
    HIGH = "high"
    CRITICAL = "critical"


class RiskScore(BaseModel):
    """Composite corridor-by-commodity risk score with provenance."""

    model_config = ConfigDict(use_enum_values=True)

    corridor: Corridor
    commodity: Commodity
    score: float = Field(ge=0.0, le=100.0)
    tier: RiskTier
    narrative: str
    updated_at: datetime
    top_signals: list[str] = Field(default_factory=list)


class VesselPing(BaseModel):
    """Single AIS observation for a tanker or bulker."""

    mmsi: int
    name: str
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    course: float = Field(ge=0.0, le=360.0)
    speed: float = Field(ge=0.0)
    vessel_type: str
    last_seen: datetime


class ScenarioRequest(BaseModel):
    """User-driven what-if input for the disruption simulator."""

    name: str = Field(min_length=1, max_length=120)
    intensity: float = Field(ge=0.0, le=1.0)
    duration_days: int = Field(ge=1, le=365)


class ScenarioResult(BaseModel):
    """Output of the impact engine for a single scenario run."""

    model_config = ConfigDict(use_enum_values=True)

    name: str
    primary_commodity: Commodity
    primary_corridor: Corridor
    brent_uplift_pct: float
    lng_uplift_pct: float
    coal_uplift_pct: float
    gdp_impact_bps: float
    spr_runway_days: float
    narrative: str


class SourcingOption(BaseModel):
    """Diversification candidate for a single commodity."""

    source_country: str
    share_pct: float = Field(ge=0.0, le=100.0)
    current_risk: float = Field(ge=0.0, le=100.0)
    alternative_rank: int = Field(ge=1)
    lead_time_days: int = Field(ge=0)
    rationale: str


class SPRPlan(BaseModel):
    """Strategic Petroleum Reserve drawdown / replenishment trajectory."""

    dates: list[date]
    drawdown_kbpd: list[float]
    replenish_kbpd: list[float]
    reserve_mmb: list[float]
    total_impact_score: float
