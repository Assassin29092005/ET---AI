# Architecture

## 1. System Overview

This system is a multi-commodity, signal-to-decision pipeline for India's strategic
energy and critical-materials supply chain. It ingests heterogeneous public signals
(geopolitical events, vessel movements, sanctions lists, commodity prices, news
headlines), normalizes them through per-source adapters, and computes a per-corridor
by per-commodity risk matrix that is re-scored continuously by a background scheduler.
Scenario simulations (single and compound), a strategic-reserve linear program with
Monte Carlo uncertainty, an impact-cascade dependency graph, and alternate-sourcing
rankings are layered on top. A Gemini narrative engine translates quantitative output
into briefings, scenario explanations, and recommendation drafts surfaced through a
digital-twin dashboard. Operator overrides and every scenario/SPR run are persisted
to SQLite for audit and replay.

## 2. High-Level Diagram

```
+------------------------------------------------------------------------------+
|                              SIGNAL LAYER                                     |
|  GDELT   AISStream   OFAC SDN   EIA/AlphaVantage   NewsAPI   VEDAS(ISRO)      |
|  Frankfurter FX   goodreturns pump prices   PPAC   GIIGNL   USGS   MNRE       |
+------+--------+---------+-----------+--------+--------+--------+-------------+
       |        |         |           |        |        |        |
       v        v         v           v        v        v        v
+------------------------------------------------------------------------------+
|              INGESTION ADAPTERS  (backend/app/ingest, 13 modules)             |
|  gdelt  ais  ais_stream  sanctions  commodity_prices  news  baselines         |
|  pump_prices  vedas  lng  coal  minerals  solar     [fixture fallback each]   |
+------+-------------------+-------------------+--------------+----------------+
       |                   |                   |              |
       v                   v                   v              v
+------------------------------------------------------------------------------+
|                    RISK SCORING (engines/risk_score + live_scores)            |
|   6 corridors x 5 signals -> composite 0-100 + tier + P(disruption, 14d)      |
|   scheduler.py re-scores every 10 min -> SQLite history -> WS push            |
+------+-------------------+-------------------+--------------+----------------+
       |                   |                   |              |
       v                   v                   v              v
+----------------+  +------------------+  +----------------+  +----------------+
| Scenario       |  | SPR LP (PuLP CBC)|  | Sourcing intel |  | Impact cascade |
| modeller (7,   |  | + Monte Carlo    |  | (alternates +  |  | (dependency-   |
| single or      |  | uncertainty band |  | substitution)  |  | graph BFS)     |
| compound)      |  +---------+--------+  +-------+--------+  +-------+--------+
+-------+--------+            |                   |                   |
        +----------+----------+---------+---------+---------+---------+
                   |                    |
                   v                    v
        +----------------------+  +---------------------------+
        | LLM Narrative Layer  |  | API Layer (FastAPI)       |
        | Gemini 2.5 flash /   |  | 34 REST routes + /ws/feed |
        | flash-lite, cached,  |  | persistence.py (SQLite)   |
        | fixture fallback     |  | scheduler.py (10-min loop)|
        +----------+-----------+  +-------------+-------------+
                   |                            |
                   +-------------+--------------+
                                 v
                 +-----------------------------------+
                 |        DECISION DASHBOARD         |
                 |  12 pages: twin map | scenarios   |
                 |  compound | cascade | SPR | ...   |
                 +-----------------------------------+
```

## 3. Component Responsibilities

### 3.1 Signal Ingestion (`backend/app/ingest/`)

Every adapter checks `settings.allow_live_ingest`; when false it serves pinned JSON
from `data/fixtures/`, so the whole product demos offline. Live failures degrade to
the fixture path — a dead third-party API never breaks a request.

- `gdelt.py` — GDELT 2.x event pulls, filtered to conflict/shipping themes and
  geocoded against corridor centroids; event density + tone become the geo signal.
- `ais.py` — fixture-backed vessel snapshot + anomaly math (count deviation vs a
  per-corridor baseline).
- `ais_stream.py` — long-lived AISStream.io WebSocket consumer: a single socket
  subscribed with 6 corridor bounding boxes, one rolling `deque(maxlen=200)` per
  corridor, exponential backoff, auth-failure detection. Feeds live scoring and the
  vessel dots on the digital twin.
- `sanctions.py` — OFAC SDN list pull, entity matching against corridor traffic.
- `commodity_prices.py` — price series with a three-step chain: EIA (crude, gas)
  → Alpha Vantage (Brent/copper/natural gas) → fixture.
- `news.py` — per-corridor headline pulls: NewsAPI → GDELT DOC API → fixture; a
  keyword sentiment scan produces the news signal.
- `baselines.py` — on startup, refreshes the *data* anchors the scenario model
  projects from (Brent, Henry Hub, copper, USD/INR via Frankfurter/ECB, daily
  import bill) and patches module globals in `routes.py` / `engines/scenarios.py`.
  Model elasticities are deliberately never touched.
- `pump_prices.py` — best-effort scrape of Indian retail petrol/diesel/LPG/CNG
  (there is no free machine-readable official source).
- `vedas.py` — Indian oil/gas trunk pipelines for the twin. Serves the
  `pipelines.json` fixture (compiled from PNGRB/MoPNG/GAIL public maps) until a
  registered VEDAS (ISRO SAC) endpoint is configured; the API also proxies VEDAS
  WMS imagery tiles at `/api/vedas/tile/{product}`.
- `lng.py`, `coal.py`, `minerals.py`, `solar.py` — fixture-backed baseline mixes
  (GIIGNL, Ministry of Steel, USGS, MNRE) with live stubs.

### 3.2 Risk Scoring Engine

`engines/risk_score.py` holds the weights and tier math; `engines/live_scores.py`
aggregates the five live signal streams per corridor:

```
geo        = GDELT event density + tone near the corridor (24h)
ais        = vessel-count deviation from the corridor baseline
sanctions  = sanctioned-entity exposure on corridor traffic
price_vol  = recent volatility of the corridor's primary commodity
news       = negative-share of last-24h headlines matching corridor queries

composite = 0.35*geo + 0.20*ais + 0.15*sanctions + 0.15*price_vol + 0.15*news
score     = 100 * composite          # each component clipped to [0, 1]
```

Six corridors are scored: Hormuz, Bab el-Mandeb, Malacca, South China Sea,
Cape of Good Hope, Suez. Tiers: low <30, elevated 30-55, high 55-75, critical >75.
A logistic mapping also emits `disruptionProbability14d` per corridor. Per-commodity
scores scale the corridor composite by corridor-commodity relevance; per-supplier
scores blend the supplier's primary-corridor risk with import-share concentration.

`scheduler.py` re-runs this every `SCORE_REFRESH_SECONDS = 600`, appends each
snapshot to the SQLite `score_history` table (pruned to 500 rows/corridor), and
pushes `{kind: "score_update"}` frames to WebSocket subscribers whenever a corridor
moves ≥ 2.0 points or changes tier.

### 3.3 Scenario Modeller

`engines/scenarios.py` is the single source of truth. The one public entry point is
`project_scenario(name, intensity, duration_days)` — the API route's
`_project_impact()` is a thin wrapper. (An earlier `run_scenario()` Pydantic flow
diverged from what the API served and has been deleted.) Each scenario translates
intensity ∈ [0,1] and duration into price uplifts, GDP bps (routed through the
scenario's own mechanism — import bill, steel margin, EV capex, renewable capex,
nuclear capex), SPR runway, and per-day sector trajectories (refinery run rate,
diesel price, power stress, GDP growth) via the `SCENARIO_SECTOR_TRANSMISSION`
matrix. All elasticities are documented in `docs/assumptions.md`.

| ID | Scenario | Primary commodity | Corridor |
|----|----------|-------------------|----------|
| hormuz_partial_closure | Hormuz partial closure | Crude (+ Qatar LNG) | Hormuz |
| opec_emergency_cut | OPEC+ emergency cut | Crude | Hormuz |
| red_sea_suspension | Red Sea full suspension | Crude + LNG + container | Bab el-Mandeb |
| australia_coking_coal | Australian coking coal disruption | Coking coal | Malacca |
| china_rare_earth_curbs | China rare-earth export curbs | Rare earths | South China Sea |
| china_solar_export_tariff | China solar export tariff | Solar PV | South China Sea |
| kazakhstan_uranium_disruption | Kazakhstan uranium disruption | Uranium | Malacca |

`POST /api/scenarios/compound` runs 2-4 scenarios simultaneously and combines their
timelines; every run (single or compound) is persisted to `scenario_runs` for replay.

### 3.4 SPR Linear Program + Uncertainty

`engines/spr_lp.py` (PuLP CBC): decision variables are daily `drawdown_t` and
`replenish_t`; the objective minimises integrated price impact of the residual
supply gap subject to reserve balance, injection-rate caps, and non-negativity.
Inputs are scenario-driven (the projected gap from `project_scenario`).

`engines/spr_uncertainty.py` replaces a stylized band with a true Monte Carlo
percentile band: 200 perturbed trajectories — intensity ~ N(input, 0.10), elasticity
~ N(doc, 10%), volume share ~ N(doc, 5%), exposure ~ lognormal(0.15), shock timing
± 3 days — reported as p10/p50/p90 per day plus aggregates (`peakP50`,
`probAbove500Kbpd`, `probAbove1000Kbpd`). Non-crude scenarios return a flat zero
band: SPR is a crude-only instrument and the code says so.

`POST /api/spr/brief` layers a structured policymaker brief (situation, actions,
trade-offs, risks, watch-items) over the solved plan — Gemini-narrated when live,
deterministic local text otherwise. Every solve is persisted and listable at
`/api/spr/runs`.

### 3.5 Sourcing Intelligence

`engines/sourcing.py` ranks alternate suppliers per commodity by composite =
0.5 × (1 − current corridor risk) + 0.3 × historical share + 0.2 × lead-time score,
with sanctions flags. `/api/sourcing/{commodity}/substitutes` adds demand-side
substitution options; `POST /api/sourcing/{commodity}/analyse` produces an
LLM-narrated diversification analysis. Explicitly does NOT validate refinery /
smelter chemistry — see §6 of `assumptions.md`.

### 3.6 Impact Cascade

`engines/cascade.py` walks the India dependency graph
(`data/fixtures/dependency_graph.json`) from any cause node — corridor closure,
country event, commodity shock — via BFS with per-hop decay 0.85, reporting every
downstream commodity, sector, and macro variable with severity and transmission
path. Deterministic and explainable; the LLM layer narrates the structured output.

### 3.7 Digital Twin

Leaflet map with composable layers: maritime supply routes, refineries, LNG
terminals, ports, foreign supply sources, domestic demand centres + distribution
links, oil and gas trunk pipelines (VEDAS/PNGRB), live AIS vessels colored by cargo
class, corridor status markers, an optional ISRO Resourcesat imagery overlay, and a
what-if scenario toggle that recolors the network under a selected disruption.
Tiles: Mapbox dark when `VITE_MAPBOX_PUBLIC_TOKEN` is set, else free CartoDB dark.

### 3.8 LLM Narrative Layer

`llm/summarise.py` (`LLMClient`) wraps the `google-generativeai` SDK:
`gemini-2.5-flash` for synthesis (scenario narratives, executive brief,
recommendations) and `gemini-2.5-flash-lite` for high-frequency classification.
Async, in-memory LRU cache keyed on prompt hash, and a fixture fallback
(`llm_responses.json`) whenever `GEMINI_API_KEY` is unset or live ingest is off —
so the demo never blocks on an LLM call.

### 3.9 API Layer

34 REST routes under `/api` (camelCase JSON, matching the frontend TS contract) plus
`/ws/feed`. The notable groups:

| Group | Routes |
|-------|--------|
| Health / meta | `GET /api/healthz` |
| Baselines | `GET /api/baselines`, `POST /api/baselines/override` |
| Scores | `GET /api/scores`, `/scores/{corridor}`, `/scores/history`, `/scores/latest-snapshot`, `/scores/suppliers/{commodity}`, `GET /api/ais/status` |
| Scenarios | `GET /api/scenarios`, `POST /api/scenarios/{name}/run`, `POST /api/scenarios/compound`, `GET /api/scenario-runs`, `GET /api/scenario-runs/{run_id}` |
| Twin | `GET /api/digital-twin/state`, `GET /api/vedas/tile/{product}` |
| Sourcing | `GET /api/sourcing/{commodity}`, `POST /api/sourcing/{commodity}/analyse`, `GET /api/sourcing/{commodity}/substitutes` |
| Cascade | `GET /api/impact-cascade/causes`, `POST /api/impact-cascade` |
| SPR | `GET/POST /api/spr/plan`, `GET /api/spr/runs`, `POST /api/spr/brief` |
| Analysis | `GET /api/stress-test`, `GET /api/backtest/events`, `GET /api/backtest/{event_id}/replay`, `GET /api/cost-of-inaction` |
| Narrative | `GET /api/feed`, `GET /api/executive-brief`, `POST /api/chat` |
| Misc | `GET /api/commodities`, `POST /api/integrations/slack` |
| WebSocket | `/ws/feed` — headline back-fill, score snapshot on connect, score-update pushes, live GDELT polling (live) / synthetic frames (fixture) |

Persistence (`app/persistence.py`) is stdlib sqlite3 at `backend/data/state.db`
(gitignored): `baseline_overrides` (re-applied on startup), `scenario_runs`,
SPR runs, `score_history`. Connection-per-call; writes are best-effort and logged,
never fatal to the request path.

## 4. Data Flow

```
GDELT ------------> geo signal ----+
AISStream WS -----> ais anomaly ---+
OFAC SDN ---------> sanctions -----+--> live_scores (6 corridors x 5 signals)
EIA/AlphaVantage -> price vol -----+         |
NewsAPI/GDELT ----> news sentiment-+         +--> scheduler (600s tick)
                                             |      |--> SQLite score_history
                                             |      +--> /ws/feed score_update
                                             v
                    +------------------------+--------------------+
                    |                        |                    |
                    v                        v                    v
        scenarios.project_scenario   cascade.resolve       sourcing.rank
                    |                        |                    |
                    v                        |                    |
        spr_lp.solve + spr_uncertainty       |                    |
                    |                        |                    |
                    +-----------+------------+--------------------+
                                v
                     llm.LLMClient (Gemini, cached, fixture fallback)
                                |
                                v
                 routes.py (camelCase JSON) --> React pages
```

The lifespan hook in `main.py` boots the stack in order: persistence init →
baselines refresh → scheduler start → AIS stream start; each step is wrapped so a
failed external dependency degrades to fixtures instead of blocking startup.

## 5. Multi-Commodity Coverage Matrix

| Commodity | Primary Source(s) | Primary Corridor | Data anchors | Live API note |
|-----------|-------------------|------------------|--------------|---------------|
| Crude oil | Iraq, Saudi, Russia, UAE, US | Hormuz, Bab el-Mandeb | india_imports.json, commodity_prices.json | EIA Brent live; PPAC monthly (30-45d lag) |
| LNG | Qatar, US, UAE, Australia | Hormuz, Suez | lng_terminals.json | EIA Henry Hub live; GIIGNL annual |
| Coking coal | Australia (QLD) | Malacca | india_imports.json | Ministry of Steel monthly |
| Lithium | Chile, Argentina, China | South China Sea | critical_minerals.json | USGS annual snapshot |
| Cobalt | DRC via CN refiners | Malacca | critical_minerals.json | USGS + OFAC overlays |
| Nickel | Indonesia, Philippines | Malacca | critical_minerals.json | USGS annual |
| Rare earths | China (~90% refining) | South China Sea | critical_minerals.json | USGS; no reliable live spot |
| Solar PV | China | South China Sea | solar_imports.json | MNRE monthly |
| Uranium | Kazakhstan, Russia, France | Malacca | critical_minerals.json | DAE annual; no public spot |

Default runtime mode is fixture-backed; adapters go live per-source when the
matching key is present and `ALLOW_LIVE_INGEST=true`.

## 6. Tech Choices and Rationale

- FastAPI for async-first ingestion, lifespan-managed background tasks, and
  WebSocket fan-out.
- PuLP + CBC for the LP: open-source, in-process, ~1s solves at demo horizon.
- stdlib sqlite3 for persistence — zero new dependencies, connection-per-call,
  perfectly adequate for overrides + run history at this scale.
- httpx everywhere for HTTP (async, timeouts per call); structlog for JSON logs.
- Gemini (`google-generativeai`) for the narrative layer: `gemini-2.5-flash` for
  synthesis where reasoning depth matters, flash-lite for high-frequency
  classification where latency dominates. Fixture fallback keeps the demo offline.
- React + Vite + TypeScript for fast HMR and typed props at the component boundary;
  `lib/types.ts` is the single shape contract with the backend.
- Leaflet over a Mapbox GL dependency so the demo needs no token (Mapbox tiles are
  an optional upgrade via `VITE_MAPBOX_PUBLIC_TOKEN`).
- Recharts for time series; zustand for the small global UI state.
- Tailwind with the `op-*` token namespace (dark slate base, `#00d4aa` accent);
  numbers in IBM Plex Mono with `tabular-nums`.

## 7. Scalability

Corridors, commodities, and scenario parameters are data: corridor centroids /
baselines / news queries are dicts in `live_scores.py`, scenario elasticities live
in `scenarios.py` + `docs/assumptions.md`, and infrastructure layers are fixture
JSON. Adding a commodity or corridor is an entry in those tables plus a fixture —
the scoring loop, scheduler, twin layers, and scenario plumbing extend without
structural change. Signal fetches fan out with `asyncio.gather`; the AIS consumer
is a single socket that scales by bounding box, not by connection count.

## 8. Security

- All third-party keys come from environment variables; never checked in.
- No PII. Vessel data is public AIS; sanctions data is public OFAC.
- Default mode is fixture-backed so the system runs offline at a demo table.
- User free-text (chat) is wrapped in a structured prompt with app-supplied
  context; LLM output is rendered as text, never executed.
- CORS is locked to the local dev origins (5173/3000) in `main.py`.
- The VEDAS tile proxy keeps the ISRO key server-side.

## 9. Local-Dev Topology

```
+--------------------+         +----------------------------+
| React (Vite :5173) | <-----> | FastAPI (:8000)            |
+--------------------+  REST   |  lifespan: persistence ->  |
        ^                      |  baselines -> scheduler -> |
        |  WS /ws/feed         |  ais_stream                |
        +----------------------+------------+---------------+
                                            |
                              +-------------+--------------+
                              v                            v
                    +--------------------+       +--------------------+
                    | data/state.db      |       | data/fixtures/*.json|
                    | (SQLite, runtime)  |       | (12 pinned snapshots)|
                    +--------------------+       +--------------------+
```

Start order in development: `uvicorn app.main:app --reload --port 8000` from
`backend/`, then `npm run dev` in `frontend/`. The Vite dev server proxies `/api`
and `/ws` to :8000 (proxy config is only re-read on a full dev-server restart).

## 10. Production Notes

For a real deployment the following would change:

- Replace SQLite with Postgres for relational data (events, sanctions, scenario
  runs, score history) and Redis for pub/sub fan-out that today is in-process.
- Move fixture JSON to S3 with versioned object keys; adapters point at S3 by env.
- Add an authn layer (OIDC against a government SSO) and per-role RBAC, so an
  analyst can run scenarios but only an authorized officer can mark a
  recommendation as adopted.
- Move the LP + Monte Carlo behind a queue (Celery + Redis) for 90-day stochastic
  horizons that would dominate request latency.
- Promote the AIS consumer to a dedicated worker with backpressure and replay from
  Kafka; the dashboard subscribes via a thin WebSocket gateway. The scheduler's
  single-task re-entrancy guard becomes a distributed lock.
- Add observability: OpenTelemetry traces across adapters, scoring, and LLM calls;
  per-prompt token accounting; cost dashboards for Gemini usage.
- Audit logging already exists for scenario runs, SPR solves, and baseline
  overrides (SQLite); production would ship these to an append-only store.
