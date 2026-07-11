"""Application configuration loaded from environment variables.

All runtime knobs live here. The frontend, ingest workers and API handlers
read settings through ``get_settings()`` which is memoised for the process.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


# Resolve .env files relative to this file's location, not the working dir, so
# `uvicorn` picks up the right config whether launched from the repo root or
# from backend/. Project-root .env is the canonical one (matches the populated
# file in the repo); backend/.env (if present) overrides for backend-only knobs.
_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_DIR.parent


class Settings(BaseSettings):
    """Process-wide configuration."""

    model_config = SettingsConfigDict(
        env_file=(_REPO_ROOT / ".env", _BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: str = Field(default="dev")
    log_level: str = Field(default="INFO")

    api_host: str = Field(default="0.0.0.0")
    api_port: int = Field(default=8000)

    # Resolved relative to the backend package (NOT cwd) so fixtures always
    # load whether uvicorn is launched from the repo root or backend/.
    data_root: str = Field(default=str(_BACKEND_DIR / "data"))

    allow_live_ingest: bool = Field(default=False)

    # LLM (Gemini) live calls are gated separately from data ingestion so the
    # analyst chat and narratives can be live off a GEMINI_API_KEY alone, while
    # signals still run from fixtures. Live whenever a key is present; set this
    # false to force canned replies even when a key is configured.
    allow_live_llm: bool = Field(default=True)

    gemini_api_key: str | None = Field(default=None)
    # Auto-updating aliases so a retired point-version never 404s the demo.
    gemini_model: str = Field(default="gemini-flash-latest")
    gemini_model_fast: str = Field(default="gemini-flash-lite-latest")

    slack_webhook_url: str | None = Field(default=None)

    # Accept both AISSTREAM_API_KEY (canonical) and AIS_STREAM_API_KEY.
    ais_stream_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("AISSTREAM_API_KEY", "AIS_STREAM_API_KEY"),
    )
    ais_stream_url: str = Field(default="wss://stream.aisstream.io/v0/stream")

    # NewsAPI.org key (separate field declared here so the alias doesn't clash).
    newsapi_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("NEWSAPI_KEY", "NEWS_API_KEY"),
    )

    gdelt_enabled: bool = Field(default=True)
    gdelt_base_url: str = Field(default="https://api.gdeltproject.org/api/v2")

    ppac_base_url: str = Field(default="https://www.ppac.gov.in")
    eia_api_key: str | None = Field(default=None)
    # Accept both ALPHA_VANTAGE_API_KEY and the shorter ALPHA_VANTAGE_KEY.
    alpha_vantage_api_key: str | None = Field(
        default=None, validation_alias=AliasChoices("ALPHA_VANTAGE_API_KEY", "ALPHA_VANTAGE_KEY")
    )
    world_bank_base_url: str = Field(default="https://api.worldbank.org/v2")

    ofac_sdn_url: str = Field(
        default="https://www.treasury.gov/ofac/downloads/sdn.xml"
    )
    un_sanctions_url: str = Field(
        default="https://scsanctions.un.org/resources/xml/en/consolidated.xml"
    )

    # VEDAS (ISRO Space Applications Centre) — geospatial energy infrastructure.
    # Used to refresh refineries + crude/product/gas pipeline polylines on the
    # digital twin. See ingest/vedas.py for the request shape.
    vedas_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("VEDAS_API_KEY", "VEDAS_KEY"),
    )
    vedas_base_url: str = Field(default="https://vedas.sac.gov.in")

    # Temporal RGB date windows. Defaults match the API Centre sample cURL
    # (known-good Sep 2025 imagery). Override via env to roll forward as VEDAS
    # publishes newer datasets. Format: YYYYMMDD (no dashes).
    vedas_rgb_r_from: str = Field(default="20250910")
    vedas_rgb_r_to:   str = Field(default="20250920")
    vedas_rgb_g_from: str = Field(default="20250810")
    vedas_rgb_g_to:   str = Field(default="20250820")
    vedas_rgb_b_from: str = Field(default="20250710")
    vedas_rgb_b_to:   str = Field(default="20250720")
    # NDVI single-window mosaic — Sep 2025 default.
    vedas_ndvi_from: str = Field(default="20250918")
    vedas_ndvi_to:   str = Field(default="20250928")

    cache_ttl_seconds: int = Field(default=300)
    http_timeout_seconds: float = Field(default=20.0)

    @property
    def fixtures_path(self) -> Path:
        """Directory containing offline fixture JSON used when live ingest is off."""
        return (Path(self.data_root) / "fixtures").resolve()

    @property
    def snapshots_path(self) -> Path:
        """Directory for serialised snapshots produced by ingest workers."""
        return (Path(self.data_root) / "snapshots").resolve()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the cached process-wide settings instance."""
    return Settings()
