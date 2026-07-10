"""Prompt builders for the LLM narrative layer.

Each builder returns a ready-to-send prompt string suitable for Gemini. The
system instruction is exposed separately as SYSTEM_ANALYST so callers can
prepend it or pass it as the model's system instruction.

The builders are intentionally pure functions over plain inputs. They accept
domain objects (RiskScore, ScenarioResult, Commodity, SourcingOption) by
duck-typing through a small set of attributes documented in each function. This
keeps the prompt layer decoupled from the engines package so it can be
imported in isolation for tests and notebook exploration.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.engines.models import (
        Commodity,
        RiskScore,
        ScenarioResult,
        SourcingOption,
    )


SYSTEM_ANALYST: str = (
    "You are an India energy supply chain risk analyst. Be precise, cite "
    "signals, avoid hedging. Format your output as plain text without "
    "markdown headers."
)


def _compact_json(obj: Any) -> str:
    """Serialise an object to compact JSON suitable for prompt embedding.

    Pydantic models are unwrapped via model_dump when available so the LLM
    sees plain dicts rather than class repr strings.
    """
    def default(value: Any) -> Any:
        if hasattr(value, "model_dump"):
            return value.model_dump()
        if hasattr(value, "__dict__"):
            return value.__dict__
        return str(value)

    return json.dumps(obj, default=default, ensure_ascii=False, separators=(",", ":"))


def build_risk_summary_prompt(
    scores: list["RiskScore"],
    events: list[dict[str, Any]],
) -> str:
    """Prompt for a short situational summary across one or more risk scores.

    Inputs:
      scores: list of RiskScore records with fields corridor, commodity,
              composite, geopolitical, logistics, price, updated_at.
      events: recent geopolitical or logistics events as plain dicts with at
              least id, timestamp, headline, severity, source.

    The model is asked to produce a four-paragraph briefing with explicit
    corridor and commodity labels. Total length target: 180 to 240 words.
    """
    return (
        f"{SYSTEM_ANALYST}\n\n"
        "Produce a current-state risk summary for India's energy and "
        "strategic-commodity imports using the signals below.\n\n"
        "RISK SCORES:\n"
        f"{_compact_json(scores)}\n\n"
        "RECENT EVENTS:\n"
        f"{_compact_json(events)}\n\n"
        "Structure the response as exactly four short paragraphs in plain "
        "text. Do not use markdown headers, bullets, or bold markers.\n"
        "1. Headline assessment. State the single most material risk right "
        "now and the composite score that supports it.\n"
        "2. Corridor view. Walk through the corridors that appear in the "
        "scores. Mention Hormuz, Bab el-Mandeb or Malacca by name only "
        "when a score or event references them.\n"
        "3. Commodity view. Identify which commodities (crude, LNG, coking "
        "coal, lithium, cobalt, nickel, rare earths, solar PV, uranium) "
        "are most exposed given the inputs.\n"
        "4. What to watch in the next 24 to 72 hours. Two or three "
        "specific signals, each tied to an event_id when one exists.\n\n"
        "Do not include a preface or sign-off. Begin directly with "
        "paragraph one. Cite specific numbers from the inputs. If a figure "
        "is not in the input, say the signal is unavailable rather than "
        "estimating."
    )


def build_scenario_narrative_prompt(
    result: "ScenarioResult",
    context: dict[str, Any],
) -> str:
    """Prompt for a narrative explanation of a scenario simulation result.

    Inputs:
      result: ScenarioResult with fields scenario_id, name, baseline_supply,
              shocked_supply, shortfall_pct, days_of_cover, mitigations,
              cost_delta_usd_bn, affected_commodities, affected_corridors.
      context: free-form dict that may include SPR drawdown plan, alternative
               supplier capacity, freight reroute estimates, and any policy
               levers under consideration.

    Output target: an executive narrative of roughly 350 to 500 words covering
    cause, impact, mitigation and residual risk.
    """
    return (
        f"{SYSTEM_ANALYST}\n\n"
        "Write an executive narrative for the following scenario "
        "simulation. The reader will use this to brief a Joint Secretary "
        "within 30 minutes.\n\n"
        "SCENARIO RESULT:\n"
        f"{_compact_json(result)}\n\n"
        "ADDITIONAL CONTEXT:\n"
        f"{_compact_json(context)}\n\n"
        "Cover the following sections, each as a labelled paragraph in "
        "plain text. Begin each section with its label followed by a "
        "colon on the same line as the paragraph. Do not use markdown "
        "headers or bullet markers.\n\n"
        "Cause: what triggers the scenario and which corridors or "
        "supplier countries are implicated. Reference the affected "
        "corridors list verbatim.\n\n"
        "Impact: physical shortfall in mb/d for crude, mtpa for LNG and "
        "coking coal, tonnes for minerals, GW of solar capacity at risk, "
        "and the days_of_cover figure from the result. Cite the "
        "shortfall_pct.\n\n"
        "Mitigation: walk through the mitigations list in the result. For "
        "each, state the lever (SPR release from Vizag, Mangalore or "
        "Padur, alternate sourcing, Cape of Good Hope rerouting, demand "
        "rationing, strategic inventory of minerals) and the volume or "
        "duration it covers.\n\n"
        "Residual risk: what remains uncovered and the cost_delta_usd_bn "
        "implication. End with a single sentence on the most useful next "
        "signal to monitor.\n\n"
        "Tone: declarative, numeric, no hedging unless a figure is "
        "explicitly marked uncertain in the inputs."
    )


def build_recommendation_prompt(
    commodity: "Commodity",
    options: list["SourcingOption"],
    risk: "RiskScore",
) -> str:
    """Prompt for a procurement recommendation across sourcing options.

    Inputs:
      commodity: Commodity record with code (CRUDE, LNG, COKING_COAL, LI, CO,
                 NI, REE, SOLAR_PV, U3O8, LPG, ATF), unit, baseline_demand.
      options:   list of SourcingOption with supplier_country, port_of_origin,
                 indian_port, corridor, lead_time_days, landed_cost_usd_per_unit,
                 sanctions_flag, esg_flag, capacity_available.
      risk:      RiskScore for the current corridor and commodity.

    The model is asked to rank options and justify a recommendation that
    balances cost, lead time, corridor risk and sanctions exposure.
    """
    return (
        f"{SYSTEM_ANALYST}\n\n"
        "Recommend a procurement plan for the commodity below given the "
        "available sourcing options and the current risk picture.\n\n"
        "COMMODITY:\n"
        f"{_compact_json(commodity)}\n\n"
        "SOURCING OPTIONS:\n"
        f"{_compact_json(options)}\n\n"
        "CURRENT RISK:\n"
        f"{_compact_json(risk)}\n\n"
        "Deliver the response in three parts, written in plain text. Do "
        "not use markdown headers.\n\n"
        "Part 1 - Ranked list. List every option in priority order, one "
        "per line. For each entry include supplier_country, indian_port, "
        "corridor, lead_time_days, landed_cost_usd_per_unit, and a "
        "one-line reason.\n\n"
        "Part 2 - Primary recommendation. Name the supplier and port pair "
        "you recommend procure from first, the volume to lift, and the "
        "expected landed cost. Explain why this option beats the second-"
        "ranked one in concrete terms (cost delta, lead-time delta, "
        "corridor risk delta).\n\n"
        "Part 3 - Guardrails. List any sourcing_options that must be "
        "excluded because of sanctions_flag or because their corridor "
        "carries a composite risk above 70. Name the specific sanctions "
        "regime (OFAC SDN, UN, EU) when the flag indicates one.\n\n"
        "Do not recommend volumes that exceed capacity_available on any "
        "option."
    )


def build_executive_brief_prompt(snapshot: dict[str, Any]) -> str:
    """Prompt for an all-in-one daily executive brief.

    Input snapshot is a dict assembled by the API layer that may include:
      - risk_scores: list of RiskScore for the corridors of interest
      - events: latest geopolitical events (GDELT, news)
      - vessels: recent AIS observations in tracked corridors
      - prices: latest Brent, Dutch TTF, JKM, Newcastle coking coal,
                lithium carbonate, cobalt, nickel, rare-earth basket,
                solar module spot, uranium U3O8
      - spr_status: India SPR fill levels at Vizag, Mangalore, Padur
      - sanctions: changes in OFAC SDN, UN, EU lists relevant to suppliers
      - scenarios: any active simulations the user has pinned

    Output target: a one-page daily brief, roughly 450 to 600 words, that a
    Secretary-level reader can absorb in under three minutes.
    """
    return (
        f"{SYSTEM_ANALYST}\n\n"
        "Compose the India Energy Supply Chain Daily Brief for today.\n\n"
        "SNAPSHOT:\n"
        f"{_compact_json(snapshot)}\n\n"
        "Use this exact structure in plain text. Each label is followed "
        "by a colon and then the content. Do not use markdown headers, "
        "bold markers, or bullet glyphs.\n\n"
        "TOP LINE. One sentence that captures the day's most material "
        "shift in import resilience.\n\n"
        "PRICE DESK. Brent, Dutch TTF, JKM, Newcastle coking coal, "
        "lithium carbonate, cobalt, nickel, rare-earth basket, solar "
        "module spot, U3O8. Give the level and the day change for each. "
        "Skip a line item only if the snapshot lacks that price.\n\n"
        "CORRIDOR WATCH. Hormuz, Bab el-Mandeb and Red Sea, Malacca, "
        "South China Sea, Cape of Good Hope. One line each, anchored to "
        "the highest-severity event or AIS observation in that corridor.\n\n"
        "PHYSICAL FLOWS. Crude imports vs baseline, LNG send-out from "
        "Dahej, Hazira, Kochi, Dabhol and Ennore, coking coal arrivals at "
        "Paradip, Visakhapatnam and Dhamra, solar module shipments from "
        "China east-coast ports.\n\n"
        "STRATEGIC RESERVES. SPR fill at Vizag, Mangalore and Padur in "
        "million barrels and as a percentage of capacity. Note any "
        "drawdown or refill scheduled.\n\n"
        "SANCTIONS AND POLICY. New or removed entries on OFAC SDN, UN "
        "and EU lists that touch India's supplier base, plus any MEA, "
        "MoPNG, Ministry of Steel, Ministry of Mines, MNRE or DAE "
        "announcement in the snapshot.\n\n"
        "ACTION ITEMS. Three numbered actions for the next 24 hours, "
        "each tied to a named owner role (Joint Secretary Refineries, "
        "Petronet LNG operations, SAIL procurement, etc.).\n\n"
        "End with a single line dated for today's date as given in the "
        "snapshot, prefixed with 'Brief closes'."
    )


def build_chat_prompt(question: str, context: dict[str, Any], retrieved_knowledge: list[dict[str, str]] | None = None) -> str:
    """Prompt for an interactive chat answer grounded in supplied context.

    Inputs:
      question: the user's free-form question, typically asked from the
                dashboard chat surface.
      context:  dict that bundles the live state the answer must be grounded
                in. Expected keys (any may be missing or empty):
                  current_scores:    list of RiskScore-like dicts with at
                                     least corridor, commodity, score, tier,
                                     components, drivers, asOf.
                  recent_events:     list of feed-like dicts with at least
                                     id, source, headline, summary,
                                     publishedAt, corridor, commodity,
                                     importance.
                  top_scenarios:     list of scenario meta dicts with at
                                     least scenarioId, name, corridors,
                                     commodities, summary.
                  commodities_basket: the six-commodity slice currently
                                     tracked on screen, as a list of
                                     commodity codes or labels.
      retrieved_knowledge: optional list of RAG-retrieved chunks, each with
                           keys: text, source, section, score.

    The model is constrained to answer from the supplied live context AND
    the retrieved reference knowledge. When neither source contains enough
    information it must say so explicitly with the exact phrase
    'Not enough data to answer confidently'.
    """
    current_scores = context.get("current_scores") or []
    recent_events = context.get("recent_events") or []
    top_scenarios = context.get("top_scenarios") or []
    commodities_basket = context.get("commodities_basket") or []

    # Build the retrieved knowledge section
    rag_section = ""
    if retrieved_knowledge:
        rag_entries = []
        for chunk in retrieved_knowledge:
            source = chunk.get("source", "unknown")
            section = chunk.get("section", "")
            text = chunk.get("text", "")
            rag_entries.append(f"[{source} > {section}]\n{text}")
        rag_section = (
            "\n--- RETRIEVED REFERENCE KNOWLEDGE ---\n"
            "The following excerpts were retrieved from internal project "
            "documentation, assumption ledgers, and fixture databases. Use "
            "them to answer methodology, parameter, and configuration "
            "questions accurately.\n\n"
            + "\n\n".join(rag_entries)
            + "\n\n"
        )

    return (
        f"{SYSTEM_ANALYST}\n\n"
        "You are answering an interactive question from a procurement or "
        "policy user looking at the live India energy supply chain "
        "dashboard. You have TWO sources of ground truth:\n\n"
        "1. LIVE OPERATIONAL STATE — real-time scores, events, scenarios, "
        "and market data currently in the system.\n"
        "2. REFERENCE KNOWLEDGE — retrieved excerpts from internal "
        "documentation, assumptions, and databases.\n\n"
        "Use BOTH sources when relevant. Do not invent figures, suppliers, "
        "corridors, scenarios, or events that are not present in either "
        "source. Do not draw on general knowledge beyond labelling and "
        "definitions.\n\n"
        "--- LIVE OPERATIONAL STATE ---\n"
        "current_scores:\n"
        f"{_compact_json(current_scores)}\n"
        "recent_events:\n"
        f"{_compact_json(recent_events)}\n"
        "top_scenarios:\n"
        f"{_compact_json(top_scenarios)}\n"
        "commodities_basket:\n"
        f"{_compact_json(commodities_basket)}\n"
        f"{rag_section}"
        "--- USER QUESTION ---\n"
        f"{question}\n\n"
        "Answer rules:\n"
        "- For greetings, pleasantries, or questions under 6 words that "
        "are not specific data asks (e.g. 'hello', 'hi', 'what can you "
        "do', 'help'): reply in ONE short friendly sentence inviting the "
        "user to ask about a specific corridor, commodity, scenario, or "
        "sourcing decision. Do NOT produce a situation report.\n"
        "- For genuine questions about live state: cite specific figures "
        "from current_scores. When you reference a corridor, include its "
        "composite score and tier. When you reference a commodity, name "
        "it as it appears in commodities_basket.\n"
        "- For questions about methodology, parameters, assumptions, or "
        "system configuration: cite the relevant excerpt from REFERENCE "
        "KNOWLEDGE, including the source file and section.\n"
        "- When you cite an event, include its id or headline from "
        "recent_events. When you cite a scenario, include its "
        "scenarioId from top_scenarios.\n"
        "- Keep the answer focused on the question. Do not produce a "
        "general situation report unless the question asks for one.\n"
        "- Plain text only. No markdown headers, no bullets, no bold "
        "markers. Short paragraphs.\n"
        "- If neither the live state nor the reference knowledge contains "
        "enough information to answer the question accurately, respond "
        "with exactly the sentence: Not enough data to answer "
        "confidently. You may then add one short sentence naming which "
        "specific signal would be needed."
    )


def build_cascade_prompt(
    commodity: Any,
    disrupted_corridor: str | None,
    options: list[Any],
    risk_snapshot: dict[str, Any],
    substitutes: dict[str, Any] | None,
) -> str:
    """Reasoning prompt for the cascade analysis of a sourcing disruption.

    Asks the model to trace the chain reaction through downstream sectors
    (refinery, logistics, pricing, secondary sectors, FX impact, GDP),
    then justify the top 3 alternative suppliers in light of those
    cascade effects — NOT a formula-driven ranking.
    """
    return (
        f"{SYSTEM_ANALYST}\n\n"
        "A cutoff has occurred (or is being simulated) for the commodity and "
        "corridor below. Walk the user through the resulting CHAIN REACTION "
        "and recommend the top 3 alternative suppliers, justified by how "
        "they mitigate the cascade — not by a fixed ranking formula.\n\n"
        "COMMODITY:\n"
        f"{_compact_json(commodity)}\n\n"
        "DISRUPTED CORRIDOR (if any):\n"
        f"{_compact_json(disrupted_corridor)}\n\n"
        "CURRENT SOURCING OPTIONS (ranked by the dashboard's formula):\n"
        f"{_compact_json(options)}\n\n"
        "LIVE RISK SNAPSHOT (per-corridor composite scores, drivers):\n"
        f"{_compact_json(risk_snapshot)}\n\n"
        "DEMAND-SIDE SUBSTITUTES (alternate end-uses or chemistries):\n"
        f"{_compact_json(substitutes)}\n\n"
        "Deliver the response in five labelled sections, plain text, no "
        "markdown headers, no bullet markers:\n\n"
        "Section 1 - Immediate impact (first 7 days). Describe what fails "
        "first when this corridor closes: which Indian refineries / steel "
        "mills / EV cell makers / solar fabs lose feedstock, which terminals "
        "back up, which sectoral prices spike first.\n\n"
        "Section 2 - Secondary cascade (days 7-30). Trace the effects on "
        "downstream sectors: power-sector fuel mix, fertilizer / petchem "
        "input cost, steel margin compression, EV cell cost passthrough, "
        "solar IRR. Reference specific Indian assets when relevant.\n\n"
        "Section 3 - Macro effects (30+ days). Brent uplift, JKM uplift, "
        "INR/USD impact, GDP basis-point drag, inflation pass-through, fiscal "
        "burden if SPR is drawn.\n\n"
        "Section 4 - Top 3 recommended alternatives. For each, name the "
        "supplier_country and Indian port pair, the volume to lift, the lead "
        "time, and a one-paragraph justification grounded in the cascade "
        "above. Explain WHY this option mitigates the most damaging cascade "
        "step, not just why its composite score is high.\n\n"
        "Section 5 - Guardrails and what's NOT solved. Sanctions exposure on "
        "any alternative. Sectoral cascade steps the alternatives do NOT "
        "fully address. Demand-side levers (efficiency, substitution, "
        "rationing) that should run in parallel.\n\n"
        "Be specific about Indian assets (Vadinar, Jamnagar, Mangalore, "
        "Paradip, Dhamra, Dahej, Hazira, Kochi, Ennore, Dabhol, Mundra) "
        "when they materially affect the cascade."
    )


def build_impact_cascade_prompt(
    cause_label: str,
    cascade: dict[str, Any],
) -> str:
    """Narrative prompt for the 'any cause -> everything affected in India' engine.

    The cascade dict is the structured output of the dependency-graph BFS:
    affectedCommodities, sectorImpacts (with transmission paths), macroImpacts.
    The model must JUSTIFY the chain reaction, not restate the numbers.
    """
    return (
        f"{SYSTEM_ANALYST}\n\n"
        "A disruption has occurred. The dependency-graph engine has already "
        "computed WHICH India-side nodes are affected and by how much. Your "
        "job is to explain the CHAIN REACTION in clear, causal prose so a "
        "policymaker understands not just what is hit, but why, in what order, "
        "and which effect is the non-obvious one to watch.\n\n"
        f"CAUSE: {cause_label}\n\n"
        "COMPUTED CASCADE (severity 0-1, lagDays = time for the effect to land):\n"
        f"{_compact_json(cascade)}\n\n"
        "Write five short labelled sections, plain text, no markdown headers, "
        "no bullet markers:\n\n"
        "Section 1 - What this hits first. The directly affected commodities "
        "and why this cause reaches them. Name the import-dependence where it "
        "matters.\n\n"
        "Section 2 - The chain into Indian sectors. Walk the transmission paths "
        "in the cascade. Follow the highest-severity sector chains and explain "
        "the mechanism at each hop (e.g. LNG starves urea plants, urea shortage "
        "hits the kharif crop, crop shortfall feeds food inflation).\n\n"
        "Section 3 - The hidden effect. Identify the ONE non-obvious downstream "
        "consequence a procurement-only view would miss (often a second-order "
        "sector or a fertilizer/food/FX loop), and explain why it matters.\n\n"
        "Section 4 - Macro and timing. Summarise the CPI/WPI/INR/GDP/fiscal "
        "effects with the approximate lag from the cascade. State which effects "
        "land in week one versus month two-plus.\n\n"
        "Section 5 - What to do now. Concrete mitigations matched to the most "
        "damaging chains: sourcing moves, strategic-reserve / stockpile draws, "
        "demand-side levers, and any policy trigger (duty relaxation, subsidy "
        "buffer). Be specific about Indian assets where relevant.\n\n"
        "Ground every claim in the computed cascade. Do not invent affected "
        "sectors that are not in the cascade data."
    )


def build_spr_brief_prompt(plan: dict[str, Any]) -> str:
    """Prompt for a Strategic Petroleum Reserve decision-support brief.

    Input is the solved SPR plan dict (cover days, projected/trough cover,
    gap-closed %, peak shortfall, uncovered Mbbl, refinery exposure,
    replenishment windows, rationale). The model turns the optimiser output into
    a short policymaker brief actionable under time pressure.
    """
    return (
        f"{SYSTEM_ANALYST}\n\n"
        "You are briefing a policymaker on a Strategic Petroleum Reserve drawdown "
        "plan produced by a linear-program optimiser. Turn the numbers into a "
        "concise, decisive brief they can act on in minutes.\n\n"
        "SPR PLAN:\n"
        f"{_compact_json(plan)}\n\n"
        "Write four short plain-text paragraphs, no markdown headers or bullets:\n"
        "1. Situation: the shock, the peak shortfall in kbpd, and the most "
        "exposed refineries from refineryDemand.\n"
        "2. Recommendation: the drawdown posture, the uncovered shortfall, and "
        "which alternate crude to pre-position.\n"
        "3. Trade-off: covering more of the shock now versus preserving cover, "
        "citing the trough and projected cover days.\n"
        "4. Replenishment: when to refill (the window) and the residual risk.\n\n"
        "Cite the plan's own figures. Be declarative. Volumes are in million "
        "barrels (Mbbl)."
    )


__all__ = [
    "SYSTEM_ANALYST",
    "build_cascade_prompt",
    "build_chat_prompt",
    "build_executive_brief_prompt",
    "build_impact_cascade_prompt",
    "build_recommendation_prompt",
    "build_risk_summary_prompt",
    "build_scenario_narrative_prompt",
    "build_spr_brief_prompt",
]
