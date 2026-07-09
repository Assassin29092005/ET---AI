"""Google Gemini client wrappers for the narrative layer.

The LLMClient is an async wrapper around the google-generativeai SDK with two
demo-friendly properties:

1. A small in-memory LRU cache keyed on the prompt hash. Repeated runs during a
   pitch demo return instantly without a second network round-trip.

2. A fixture fallback path. When settings.allow_live_ingest is False OR no
   GEMINI_API_KEY is configured, the client never calls Gemini and instead
   returns pre-canned strings loaded from data/fixtures/llm_responses.json.

Model selection:
  - settings.gemini_model (default gemini-2.5-flash) for synthesis (scenario
    narratives, recommendations, brief, chat)
  - settings.gemini_model_fast (default gemini-2.5-flash-lite) for
    high-frequency classification and short summarisation
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.llm.prompts import (
    SYSTEM_ANALYST,
    build_cascade_prompt,
    build_chat_prompt,
    build_executive_brief_prompt,
    build_impact_cascade_prompt,
    build_recommendation_prompt,
    build_risk_summary_prompt,
    build_scenario_narrative_prompt,
    build_spr_brief_prompt,
)

if TYPE_CHECKING:
    from app.models import Commodity, RiskScore, ScenarioResult, SourcingOption

logger = logging.getLogger(__name__)

_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "llm_responses.json"
_CACHE_MAXSIZE = 64
_DEFAULT_MAX_TOKENS = 1024
_BRIEF_MAX_TOKENS = 2048


@lru_cache(maxsize=1)
def _load_fixture_responses() -> dict[str, str]:
    """Load the canned LLM responses bundle. Result is cached for the process."""
    try:
        with _FIXTURE_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError(f"fixture file {_FIXTURE_PATH} is not a JSON object")
        return {str(k): str(v) for k, v in data.items()}
    except FileNotFoundError:
        logger.warning("LLM fixture file missing at %s; returning empty bundle", _FIXTURE_PATH)
        return {}


def _hash_prompt(model: str, system: str, user: str, max_tokens: int) -> str:
    h = hashlib.blake2b(digest_size=16)
    h.update(model.encode("utf-8"))
    h.update(b"\x00")
    h.update(system.encode("utf-8"))
    h.update(b"\x00")
    h.update(user.encode("utf-8"))
    h.update(b"\x00")
    h.update(str(max_tokens).encode("ascii"))
    return h.hexdigest()


class LLMClient:
    """Async Gemini client with caching and a fixture fallback.

    The google-generativeai SDK is synchronous; we wrap its calls in
    asyncio.to_thread so the FastAPI event loop is not blocked.
    """

    DEFAULT_SYNTHESIS_MODEL = "gemini-2.5-flash"
    DEFAULT_CLASSIFIER_MODEL = "gemini-2.5-flash-lite-preview-06-17"

    def __init__(self, settings: Any | None = None) -> None:
        if settings is None:
            from app.config import get_settings

            settings = get_settings()
        self._settings = settings
        self._api_key: str | None = getattr(settings, "gemini_api_key", None)
        self._synthesis_model: str = getattr(
            settings, "gemini_model", self.DEFAULT_SYNTHESIS_MODEL
        )
        self._classifier_model: str = getattr(
            settings, "gemini_model_fast", self.DEFAULT_CLASSIFIER_MODEL
        )
        self._allow_live: bool = bool(getattr(settings, "allow_live_ingest", False))
        self._cache: OrderedDict[str, str] = OrderedDict()
        self._cache_lock = asyncio.Lock()
        self._configured = False

    def _ensure_configured(self) -> Any:
        """Lazy import + configure of google-generativeai. Returns the genai module."""
        try:
            import google.generativeai as genai
        except ImportError as exc:
            raise RuntimeError(
                "google-generativeai is not installed but live mode is enabled; "
                "either set ALLOW_LIVE_INGEST=false or install google-generativeai"
            ) from exc
        if not self._api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is unset but live mode is enabled; "
                "either configure the key or set ALLOW_LIVE_INGEST=false"
            )
        if not self._configured:
            genai.configure(api_key=self._api_key)
            self._configured = True
        return genai

    async def _cache_get(self, key: str) -> str | None:
        async with self._cache_lock:
            value = self._cache.get(key)
            if value is not None:
                self._cache.move_to_end(key)
            return value

    async def _cache_put(self, key: str, value: str) -> None:
        async with self._cache_lock:
            self._cache[key] = value
            self._cache.move_to_end(key)
            while len(self._cache) > _CACHE_MAXSIZE:
                self._cache.popitem(last=False)

    def _is_fixture_mode(self) -> bool:
        return (not self._allow_live) or (not self._api_key)

    async def _complete(
        self,
        *,
        model: str,
        user_prompt: str,
        fixture_key: str,
        max_tokens: int = _DEFAULT_MAX_TOKENS,
        system: str = SYSTEM_ANALYST,
    ) -> str:
        """Resolution order: fixture mode → cache → live Gemini call."""
        if self._is_fixture_mode():
            fixtures = _load_fixture_responses()
            canned = fixtures.get(fixture_key)
            if canned is None:
                logger.warning("no fixture entry for key %s", fixture_key)
                return (
                    f"[fixture {fixture_key} unavailable] live LLM calls are "
                    "disabled in this environment."
                )
            return canned

        cache_key = _hash_prompt(model, system, user_prompt, max_tokens)
        cached = await self._cache_get(cache_key)
        if cached is not None:
            return cached

        try:
            genai = self._ensure_configured()

            def _sync_call() -> str:
                gen_model = genai.GenerativeModel(
                    model_name=model,
                    system_instruction=system,
                )
                response = gen_model.generate_content(
                    user_prompt,
                    generation_config={
                        "max_output_tokens": max_tokens,
                        "temperature": 0.4,
                    },
                )
                return _extract_text(response)

            text = await asyncio.to_thread(_sync_call)
            if not text.strip():
                raise RuntimeError("empty completion from Gemini")
            await self._cache_put(cache_key, text)
            return text
        except Exception as exc:
            logger.exception("Gemini call failed (key=%s): %s", fixture_key, exc)
            fixtures = _load_fixture_responses()
            canned = fixtures.get(fixture_key, "")
            if canned:
                return canned
            return f"[LLM error] {exc}"

    async def summarise_risk(
        self,
        scores: list["RiskScore"],
        events: list[dict[str, Any]],
    ) -> str:
        prompt = build_risk_summary_prompt(scores, events)
        return await self._complete(
            model=self._classifier_model,
            user_prompt=prompt,
            fixture_key="risk_summary",
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    async def narrate_scenario(
        self,
        result: "ScenarioResult",
        context: dict[str, Any],
    ) -> str:
        prompt = build_scenario_narrative_prompt(result, context)
        return await self._complete(
            model=self._synthesis_model,
            user_prompt=prompt,
            fixture_key="scenario_hormuz",
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    async def draft_recommendation(
        self,
        commodity: "Commodity",
        options: list["SourcingOption"],
        risk: "RiskScore",
    ) -> str:
        prompt = build_recommendation_prompt(commodity, options, risk)
        return await self._complete(
            model=self._synthesis_model,
            user_prompt=prompt,
            fixture_key="recommendation_crude",
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    async def executive_brief(self, snapshot: dict[str, Any]) -> str:
        prompt = build_executive_brief_prompt(snapshot)
        return await self._complete(
            model=self._synthesis_model,
            user_prompt=prompt,
            fixture_key="executive_brief",
            max_tokens=_BRIEF_MAX_TOKENS,
        )

    async def chat(self, question: str, context: dict[str, Any], retrieved_knowledge: list[dict[str, str]] | None = None) -> str:
        """Conversational endpoint for the ask-the-analyst chat drawer."""
        prompt = build_chat_prompt(question, context, retrieved_knowledge=retrieved_knowledge)
        return await self._complete(
            model=self._synthesis_model,
            user_prompt=prompt,
            fixture_key="chat_default",
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    async def spr_brief(self, plan: dict[str, Any]) -> str:
        """Decision-support narrative over a solved SPR drawdown plan."""
        prompt = build_spr_brief_prompt(plan)
        return await self._complete(
            model=self._synthesis_model,
            user_prompt=prompt,
            fixture_key="spr_brief",
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    async def cascade_analysis(
        self,
        commodity: Any,
        disrupted_corridor: str | None,
        options: list[Any],
        risk_snapshot: dict[str, Any],
        substitutes: dict[str, Any] | None = None,
    ) -> str:
        """Cascade-reasoning sourcing analysis used by the Sourcing page."""
        prompt = build_cascade_prompt(
            commodity, disrupted_corridor, options, risk_snapshot, substitutes
        )
        return await self._complete(
            model=self._synthesis_model,
            user_prompt=prompt,
            fixture_key="cascade_default",
            max_tokens=_BRIEF_MAX_TOKENS,
        )

    async def impact_cascade(self, cause_label: str, cascade: dict[str, Any]) -> str:
        """Narrative for the impact-cascade engine (any cause -> India effects)."""
        prompt = build_impact_cascade_prompt(cause_label, cascade)
        return await self._complete(
            model=self._synthesis_model,
            user_prompt=prompt,
            fixture_key="impact_cascade_default",
            max_tokens=_BRIEF_MAX_TOKENS,
        )


def _extract_text(response: Any) -> str:
    """Pull plain text out of a google-generativeai GenerateContentResponse."""
    text = getattr(response, "text", None)
    if isinstance(text, str) and text:
        return text.strip()
    candidates = getattr(response, "candidates", None) or []
    parts_out: list[str] = []
    for c in candidates:
        content = getattr(c, "content", None)
        if not content:
            continue
        for part in getattr(content, "parts", []) or []:
            t = getattr(part, "text", None)
            if isinstance(t, str) and t:
                parts_out.append(t)
    return "".join(parts_out).strip()


__all__ = ["LLMClient"]
