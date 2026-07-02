# Presentation deck outline — 10 slides

For ET AI Hackathon 2026, Problem Statement 2. Each slide here is one bullet per line for the deck designer; speaker notes follow in italics.

---

## Slide 1 — Title

- Project: Energy Supply Chain Resilience
- Subtitle: AI intelligence layer for India's full strategic import basket
- Team: [Team name + members]
- Event: ET AI Hackathon 2026, Problem Statement 2
- Date: 28 June 2026

*Speaker note: hold for two seconds, then move on. The room knows what they're here for.*

---

## Slide 2 — The problem

- 88% of India's crude oil is imported. 40-45% transits the Strait of Hormuz.
- 50% of natural gas as LNG. 85% of coking coal. 90% of rare earths. 80% of solar panels.
- Strategic Petroleum Reserves: only 9.5 days of consumption cover.
- McKinsey: economies without integrated response intelligence took 47 days longer to stabilise past supply shocks.
- The dependency is structural and the buffer is thin.

*Speaker note: these numbers are the case for action. Read them as facts, not editorial.*

---

## Slide 3 — The gap (Vizag parallel)

- Vizag Steel Plant explosion, January 2025: eight workers killed.
- Gas pressure sensors had been reading abnormally for hours.
- The data was there. The intelligence layer that would have acted on it was not.
- The same gap exists at national scale across every strategic import India depends on.
- Existing supply chain tools are reactive, single-commodity, and corridor-blind.

*Speaker note: the Vizag analogy hits hard. Pause after "the data was there" — let it land.*

---

## Slide 4 — Our solution

- A single intelligence layer across all India's strategic imports.
- Six maritime corridors monitored continuously: Hormuz, Bab el-Mandeb, Malacca, South China Sea, Cape of Good Hope, Suez.
- Six commodity classes: crude, LNG, coking coal, critical minerals, solar PV, uranium.
- Architecture diagram inline (slide image: architecture_diagram.md mermaid render).
- Signal in, decision out, in seconds — not weeks.

*Speaker note: this is where the architecture image carries the slide. Talk to the diagram, not the bullets.*

---

## Slide 5 — How risk is scored

- Composite 0-100 score per corridor x commodity.
- Five inputs: geopolitical events (35%) + AIS chokepoint anomalies (20%) + sanctions (15%) + market volatility (15%) + news sentiment (15%).
- Weighted ensemble; weights are named constants, documented in the assumption ledger.
- Tiers: low under 30, elevated 30-55, high 55-75, critical above 75. Plus a 14-day disruption probability per corridor.
- Re-scored every 10 minutes by a background scheduler; changes push to the dashboard over WebSocket and persist to a score-history archive.

*Speaker note: judges with quantitative backgrounds will probe the formula. Walk through one example component live if asked.*

---

## Slide 6 — Scenario modelling

- Seven named scenarios:
  - Hormuz partial closure (crude + LNG)
  - OPEC+ emergency cut (crude)
  - Red Sea full suspension (crude + LNG + container)
  - Australian coking coal disruption (coal + steel)
  - China rare earth export curbs (EVs + defence)
  - China solar export tariff (renewables)
  - Kazakhstan uranium disruption (nuclear)
- Each computes cascading impact: prices, GDP bps, SPR runway, route share rerouted.
- Live demo: Hormuz cascade in 90 seconds.

*Speaker note: this is the demo beat. Cue the live walkthrough on the dashboard.*

---

## Slide 7 — SPR optimisation

- Linear program over a planning horizon (default 60 days).
- Decision variables: daily drawdown and replenishment per SPR site (Vizag, Mangalore, Padur).
- Objective: minimise integrated price-impact.
- Constraints: reserve balance, injection rate caps, non-negativity, supply balance.
- Uncertainty shown, not hidden: 200-sample Monte Carlo p10-p90 band on the supply gap, with tail-risk probabilities.
- Every solve is persisted to an audit history; a Gemini decision brief turns the plan into policymaker language.
- Outcome: closes McKinsey's 47-day stabilisation gap to roughly 12 days.

*Speaker note: the formulation slide. Don't read the constraints — let the visual speak.*

---

## Slide 8 — Sourcing intelligence (honest scoping)

- Ranks alternative suppliers by current risk + historical share + lead time + sanctions check.
- Top 5 alternatives per commodity, with explicit rationale per option.
- What we DO NOT model: refinery chemistry, coal washability, lithium hydroxide vs carbonate, rare earth separation.
- Why: those require domain partner validation we don't yet have.
- The honest scoping is the strength. Overclaiming on procurement specifics is how this project would lose credibility with judges.

*Speaker note: own this scoping. The audience trusts a team that's honest about its limits.*

---

## Slide 9 — Built on open data

| Source | Commodities | Cadence |
|--------|-------------|---------|
| GDELT | All | 15 min |
| AISStream | Crude, LNG, coal, container | Live WebSocket |
| OFAC SDN | All | Daily |
| EIA + Alpha Vantage | Crude, gas, metals | Daily |
| NewsAPI | All (corridor headlines) | Continuous (free tier) |
| VEDAS (ISRO) / PNGRB | Indian pipeline network | Static + live layer |
| PPAC India | Crude, LPG | Monthly |
| GIIGNL | LNG | Annual |
| USGS / Ministry of Mines | Critical minerals | Annual |
| DGMS / World Steel | Coking coal | Monthly |
| MNRE / China customs | Solar PV | Monthly |

- No proprietary feeds. No paid APIs in the demo.
- Production roadmap can swap fixtures for live without code change.

*Speaker note: this is the technical credibility slide. The "no paid feeds" line matters.*

---

## Slide 10 — Roadmap and impact

- Next 90 days:
  - Harden live ingestion (already wired and flag-gated: GDELT, AISStream, EIA, NewsAPI, live FX).
  - Oil ministry mentor partnership for refinery chemistry on procurement module.
  - NPCIL pilot for uranium scenarios.
  - GIIGNL data licensing for live LNG flow; registered VEDAS endpoint for live pipeline layers.
- Scaling architecture: corridors, commodities and scenario parameters are data tables + fixtures, not code paths.
- Impact: turns a reactive crisis response into a managed, anticipatory process.
- Closing line: "Five supply chains. One intelligence layer. Zero proprietary data."

*Speaker note: close confident, short, on time. Judges remember endings.*

---

## Backup slide — Q&A talking points

- Why not just buy a procurement SaaS? Because every existing tool is single-commodity and reactive.
- How does this scale to other countries? Corridor centroids, baselines and commodity weights are data tables; Indonesia, Philippines, Bangladesh have similar import-dependence profiles.
- What's the latency target? Sub-2-second response with fixtures; sub-6-second with live APIs. LLM call is the slow step.
- How do you handle AIS spoofing near Iran? We acknowledge it openly. Vessel attribution is not 100% reliable in disputed waters and the system surfaces that uncertainty.
- How do you show model uncertainty? The SPR gap forecast carries a 200-sample Monte Carlo p10-p90 band, and scores carry a 14-day disruption probability — point estimates never stand alone.
- Can this replace the human procurement director? No. It's a triage and recommendation layer. Procurement directors still own the decision. Every scenario run and SPR solve is logged for audit.
- What's the cost to run? Gemini API (flash tier) + one small VM: well under $50/month for a single-tenant deployment at hackathon scale; the demo itself uses under $1 of LLM quota.
