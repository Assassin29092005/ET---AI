# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PS2 of the ET AI Hackathon 2026 — "AI-Driven Energy Supply Chain Resilience for Import-Dependent Economies". A signal-to-decision platform fusing geopolitical events (GDELT), vessel AIS, OFAC sanctions, commodity prices, and news sentiment into composite risk scores for India's strategic imports: crude oil, LNG, coking coal, lithium, cobalt, nickel, rare earths, solar PV, uranium. Includes a digital-twin map (with ISRO/VEDAS pipeline layers and live AIS vessels), 7 named disruption scenarios with elasticity-based projections, compound multi-scenario runs, an impact-cascade dependency graph, a PuLP-based SPR LP solver with Monte Carlo uncertainty bands, SQLite-backed run history, a continuous score-refresh scheduler with WebSocket push, and a Gemini-powered narrative layer.

Multi-commodity, multi-corridor coverage is the deliberate differentiator. Most PS2 entries will scope to crude oil only.

## Common commands

Backend (Python 3.11 + FastAPI):
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .[dev]
copy ..\.env.example .env       # then edit .env (see "Environment" below)
uvicorn app.main:app --reload --port 8000
```

Frontend (Vite + React 18 + TS):
```powershell
cd frontend
npm install
npm run dev                      # http://localhost:5173, proxies /api and /ws to :8000
npx tsc --noEmit                 # type-check only, no emit — fastest sanity check
npm run build                    # production build
```

Endpoint smoke test (catches contract breaks early):
```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -c "from fastapi.testclient import TestClient; from app.main import app; c = TestClient(app); print(c.get('/api/healthz').json())"
```

Re-install after editing `pyproject.toml`: `pip install -e .` again. New deps don't auto-install on uvicorn reload.

Vite proxy is only re-read on **full restart** (Ctrl+C → `npm run dev`), not HMR. If WebSocket frames aren't arriving on the dashboard, the proxy didn't reload.

Note: with `ALLOW_LIVE_INGEST=true` the TestClient smoke test makes real API calls during startup (baselines refresh + scheduler's first tick) and can take ~2 minutes. Set it `false` for fast smoke tests.

## Architecture in five layers

**Signal ingestion** — `backend/app/ingest/*.py`, 13 modules. Each async function checks `settings.allow_live_ingest`; when false (default) it returns fixtures from `backend/data/fixtures/*.json`. This is the demo's safety net — the whole product runs end-to-end without any API key.
- Per-source: `gdelt` (event density + tone), `ais` (fixture-based vessel anomaly), `sanctions` (OFAC SDN), `commodity_prices` (EIA → Alpha Vantage → fixture chain), `lng`, `coal`, `minerals`, `solar`, `news` (NewsAPI → GDELT DOC → fixture).
- `ais_stream.py` — long-lived AISStream.io WebSocket consumer: one socket, 6 corridor bounding boxes, rolling `deque(maxlen=200)` per corridor, exponential backoff, auth-fail detection. Feeds both live scoring and vessel dots on the twin.
- `baselines.py` — startup refresh of live spot anchors (Brent, Henry Hub, copper, USD/INR via Frankfurter, import bill). Mutates module globals in `routes.py`/`scenarios.py` so projections anchor to live spot, not FY26 calibration. Model elasticities are never touched.
- `pump_prices.py` — best-effort scraper for Indian retail petrol/diesel/LPG/CNG (goodreturns.in sidebar; no free official API exists).
- `vedas.py` — ISRO/VEDAS Indian pipeline layers. Serves `pipelines.json` fixture (PNGRB/MoPNG/GAIL trunk lines) until the user's VEDAS endpoint is wired via `_LAYER_PATHS`.

**Engines** — `backend/app/engines/`, 7 modules, function-based:
- `risk_score.py` — weight constants and scoring math. **Five signal streams: `WEIGHT_GEO=0.35`, `WEIGHT_AIS=0.20`, `WEIGHT_SANCTIONS=0.15`, `WEIGHT_PRICE=0.15`, `WEIGHT_NEWS=0.15`** (the legacy 4-stream `compute_corridor_score()` still exists but the live path uses all five). Tiers: low <30, elevated 30-55, high 55-75, critical >75.
- `live_scores.py` — the "is live, not looks live" engine. Aggregates the five streams over **6 corridors** (hormuz, bab_el_mandeb, malacca, south_china_sea, cape_of_good_hope, suez), emits per-corridor score + tier + `disruptionProbability14d` + signal detail. Also per-commodity scores (corridor relevance) and per-supplier scores (corridor risk + import-share concentration).
- `scenarios.py` — single source of truth for the 7 scenarios. **The only public entry point is `project_scenario(name, intensity, duration_days)`** — the old broken `run_scenario()` dead code has been deleted. `routes.py::_project_impact()` is a thin wrapper over it. `BASELINE` dict holds calibration anchors (patched live at startup by `ingest/baselines.py`). `SCENARIO_SECTOR_TRANSMISSION` drives refinery run-rate / power-stress deflections.
- `spr_lp.py` — PuLP CBC linear program over daily drawdown/replenish. `SPRPlan` shape: `{days, drawdown_kbpd, replenish_kbpd, reserve_mmb, status, ...}`.
- `spr_uncertainty.py` — Monte Carlo confidence band for the SPR supply-gap forecast: N=200 perturbed trajectories (intensity ±0.10 Normal, elasticity ±10%, volume share ±5%, exposure lognormal ±0.15, timing ±3 days), returns p10/p50/p90 per day plus aggregate stats (`peakP50`, `probAbove500Kbpd`, ...). Non-crude scenarios return a flat zero band — SPR is a crude-only tool.
- `sourcing.py` — composite-score alternative-supplier ranking by risk + historical share + lead time. Returns dataclasses (not Pydantic); has its own `Commodity` enum separate from `app.models.Commodity`.
- `cascade.py` — dependency-graph BFS from any cause (corridor/country/commodity) to every downstream Indian sector and macro variable, hop-decay 0.85. Graph lives in `data/fixtures/dependency_graph.json`.

**App services** — module level, wired in `main.py`'s lifespan hook (order: persistence init → baselines refresh → scheduler start → ais_stream start; every step is try/except so a dead third-party API never blocks startup):
- `persistence.py` — stdlib-sqlite3 DB at `backend/data/state.db` (gitignored). Tables: `baseline_overrides` (operator overrides, re-applied on restart), `scenario_runs` (full payload for replay/audit), SPR plan runs, `score_history`. Connection-per-call, best-effort writes that never break the API path.
- `scheduler.py` — background asyncio task recomputing live corridor signals every `SCORE_REFRESH_SECONDS=600`, appending to `score_history` (pruned to 500/corridor), and fanning out to WebSocket subscribers when a score moves ≥ `SCORE_CHANGE_THRESHOLD=2.0` points or changes tier.

**HTTP surface** — `backend/app/api/routes.py` (~3200 lines) mounted at `/api`. Returns JSON dicts in **camelCase to match the frontend TS contract**, not the Pydantic snake_case models. WebSocket `/ws/feed` is in `backend/app/api/websocket.py`, registered separately via `app.add_api_websocket_route("/ws/feed", ws_feed)` (no `/api` prefix). The WS pushes: 5-item back-fill, an immediate `{kind: "score_snapshot"}`, `{kind: "score_update"}` events from the scheduler queue, and headlines (live mode: GDELT polled every 60s; fixture mode: synthetic every 8s).

**LLM layer** — `backend/app/llm/{summarise.py, prompts.py}`. Uses `google-generativeai` SDK (Gemini). Fixture fallback kicks in when `GEMINI_API_KEY` is unset OR `ALLOW_LIVE_INGEST=false`. Cache is in-memory LRU keyed on prompt hash. Class is `LLMClient`; methods: `summarise_risk`, `narrate_scenario`, `draft_recommendation`, `executive_brief`, `chat`.

## Endpoint inventory (34 REST routes + WS)

```
GET  /api/healthz                          GET  /api/scenarios
GET  /api/baselines                        POST /api/scenarios/{name}/run
POST /api/baselines/override               POST /api/scenarios/compound
GET  /api/vedas/tile/{product}             GET  /api/scenario-runs
GET  /api/scores                           GET  /api/scenario-runs/{run_id}
GET  /api/ais/status                       GET  /api/digital-twin/state  [sanctionAlerts, vessels, pipelines]
GET  /api/scores/history                   GET  /api/feed
GET  /api/scores/latest-snapshot           GET  /api/executive-brief
GET  /api/scores/suppliers/{commodity}     GET  /api/commodities
GET  /api/scores/{corridor}                GET  /api/backtest/events
GET  /api/sourcing/{commodity}             GET  /api/backtest/{event_id}/replay
POST /api/sourcing/{commodity}/analyse     GET  /api/stress-test
GET  /api/sourcing/{commodity}/substitutes GET  /api/cost-of-inaction  [requires ?scenario=]
GET  /api/impact-cascade/causes            POST /api/chat
POST /api/impact-cascade                   POST /api/integrations/slack
GET  /api/spr/plan                         GET  /api/spr/runs
POST /api/spr/plan                         POST /api/spr/brief
WS   /ws/feed
```

Route ordering matters: `GET /api/scores/history`, `/api/scores/latest-snapshot`, and `/api/scores/suppliers/{commodity}` are all declared **before** `GET /api/scores/{corridor}` in `routes.py` so literal segments aren't swallowed by the `{corridor}` path param. When adding a literal-segment route that shares a prefix with an existing `{param}` route at the same depth, declare it first.

`/stress-test` and `/backtest/{id}/replay` return wrapped objects (`{cells: [...]}` and `{timeline: [...]}` respectively); `/scenario-runs`, `/spr/runs`, `/scores/history` wrap in `{runs|rows: [...], asOf}`. The frontend api.ts functions unwrap them — keep that convention if you add similar endpoints.

`/api/vedas/tile/{product}` proxies VEDAS WMS imagery tiles (e.g. Resourcesat AWiFS `rgb`) for the map's ISRO overlay so the browser never needs the VEDAS key.

## Frontend conventions

`frontend/src/lib/types.ts` is the single source of truth for shapes. Pages and components reference its interfaces and label dictionaries (`CORRIDOR_LABEL`, `COMMODITY_LABEL`, `TIER_COLOR`). When you add a backend field, add it to `types.ts` and the matching function in `lib/api.ts` in the same commit.

12 pages (routes in `App.tsx`): Dashboard `/`, DigitalTwin `/twin`, ImpactCascade `/cascade`, Scenarios `/scenarios`, ScenarioRun `/scenarios/:name`, ScenarioCompare `/compare`, CompoundScenarios `/compound`, StressTest `/stress-test`, Backtest `/backtest`, Sourcing `/sourcing`, SPR `/spr`, Baselines `/baselines`.

Digital-twin layer toggles: routes, refineries, LNG, ports, distribution (demand centres), foreign sources, corridors, oil pipelines, gas pipelines, AIS vessels (colored by cargo class), VEDAS overlay (ISRO WMS imagery). Map tiles: Mapbox dark if `VITE_MAPBOX_PUBLIC_TOKEN` is set in `frontend/.env`, else free CartoDB dark.

Design tokens live on the `op` Tailwind namespace (`op-bg`, `op-panel`, `op-panel2`, `op-border`, `op-ink`, `op-accent #00d4aa`, etc.). Fonts: Inter (UI), IBM Plex Mono (numbers, `font-mono`), Newsreader (editorial italic, `font-serif`). All data numbers must be `tabular-nums`. No `animate-pulse`/`animate-ping` — liveness is shown via timestamps, not animated dots.

ChatDrawer is mounted globally in `App.tsx` and toggled via the zustand `useAppStore.toggleChat()`. WebSocket connection is established in `Dashboard.tsx::useEffect` via `connectFeedWebSocket()` from `lib/ws.ts`; it receives both feed items and `score_snapshot`/`score_update` frames.

## Environment

`.env.example` is the canonical list. Required for live mode:
- `GEMINI_API_KEY` — Google AI Studio key (https://aistudio.google.com/apikey)
- `GEMINI_MODEL=gemini-2.5-flash` (default), `GEMINI_MODEL_FAST=gemini-2.5-flash-lite-preview-06-17`
- `ALLOW_LIVE_INGEST=true` to enable real API calls. Default `false` runs the demo from fixtures.

Optional:
- `AISSTREAM_API_KEY` (live vessel dots + AIS signal), `EIA_API_KEY`, `ALPHA_VANTAGE_KEY` (also accepts `ALPHA_VANTAGE_API_KEY`), `NEWSAPI_KEY` (free tier is 100 req/day — the scheduler's 600s cadence budgets ≤6 calls/cycle; expect graceful 429 fallbacks when exhausted)
- `VEDAS_API_KEY`, `VEDAS_BASE_URL` — ISRO VEDAS pipeline layers; fixture until wired
- `VITE_MAPBOX_PUBLIC_TOKEN` in `frontend/.env` (Vite only exposes `VITE_`-prefixed vars) for Mapbox dark tiles
- `SLACK_WEBHOOK_URL` — if unset, `/api/integrations/slack` returns `{sent: false, reason: ..., dryRun: ...}` so the UI can show a graceful fallback.

Note: `google-generativeai` SDK emits a deprecation warning in favor of `google-genai`. The old SDK still functions; swap is non-urgent.

## Honest scoping (do not overclaim)

`docs/assumptions.md` is the single source of truth for what we model and what we do NOT. The procurement / sourcing module ranks alternatives by composite risk + historical share + lead time. It deliberately does **NOT** model:
- Refinery configuration or crude grade chemistry (API gravity, sulfur, NMR)
- Coking coal grade differentiation (hard/semi-soft/PCI, washability, CSR)
- Lithium chemistry (carbonate vs hydroxide), NMC vs LFP implications
- Rare earth separation (China controls ~90% of refining — acknowledged on screen)
- Solar module efficiency / TOPCon vs HJT premium
- Tanker rate spot data (Baltic Exchange BDTI is paid; use headline numbers only)

Industry judges will probe these. The fix is honest scoping, not pretending to know more.

## Fixtures vs live

`backend/data/fixtures/*.json` (12 files): gdelt_events, vessels, sanctions, commodity_prices, india_imports, refineries, lng_terminals, critical_minerals, solar_imports, llm_responses, dependency_graph, pipelines. These are the demo's safety net. When adding a new endpoint that depends on a source, write a fixture in the same PR. (Backtest events are defined inline in `routes.py`, not a fixture file. `dependency_graph.json` feeds the impact-cascade engine. `pipelines.json` feeds the VEDAS/pipeline layers.)

AIS spoofing near Iran is real. Do not claim 100% vessel attribution. PPAC, DGMS, MNRE data has a 30-45 day lag — flag scenario projections as such, not "today's" import figures.

## Verified state (reviewed 2 Jul 2026)

- `npx tsc --noEmit` passes clean; `npm run build` succeeds.
- Backend smoke test: 19 endpoints return 200 (`/api/cost-of-inaction` correctly 422s without its required `?scenario=` param).
- Working tree clean; everything below is committed.

### Known issues (small, live-mode only)
1. **OFAC live fetch never succeeds** — `ingest/sanctions.py` hits the SDN URL which now 302-redirects to S3, and its `httpx.AsyncClient` doesn't set `follow_redirects=True`, so live sanctions always fall back to the fixture. One-line fix.
2. **`news.json` fixture is missing** — `ingest/news.py` references `data/fixtures/news.json` which doesn't exist, so the news signal is empty in fixture mode (logged as `news.fixture_missing` on every scheduler tick). Write the fixture.
3. NewsAPI free tier 429s once the daily 100-call quota is exhausted — handled gracefully, but during a long live demo the news component decays to GDELT DOC fallback.

## What's done (committed)

### Signal ingestion (13 modules)
- **GDELT** — geopolitical event density + tone near each corridor.
- **AIS** (`ais.py` fixture path + `ais_stream.py` live WebSocket consumer with 6 corridor bboxes and rolling deques).
- **OFAC sanctions** — sanctioned-entity matching on corridor traffic (live path currently falls back; see Known issues).
- **Commodity prices** — EIA → Alpha Vantage → fixture chain.
- **News** — NewsAPI → GDELT DOC → fixture chain, feeding the fifth scoring signal.
- **Baselines** — live spot anchors (Brent, Henry Hub, copper, USD/INR, import bill) refreshed at startup.
- **Pump prices** — Indian retail petrol/diesel/LPG/CNG scraper.
- **VEDAS** — ISRO pipeline layers with `pipelines.json` fixture fallback.
- **LNG, coal, minerals, solar** — fixture-backed modules with live stubs.

### Engines (7)
- **Risk score** — five-signal composite: 35% geo + 20% AIS + 15% sanctions + 15% price vol + 15% news.
- **Live scores** — real per-signal scoring over 6 corridors, per-commodity and per-supplier scoring, 14-day disruption probability.
- **Scenarios** — 7 named scenarios; `project_scenario()` is the single entry point (dead `run_scenario()` removed); sector-transmission matrix for refinery/power/diesel/GDP trajectories.
- **SPR LP** — PuLP CBC drawdown/replenish plan with scenario-driven gap inputs.
- **SPR uncertainty** — Monte Carlo p10/p50/p90 band + tail-risk probabilities over the supply-gap forecast.
- **Sourcing** — alternative-supplier ranking + demand substitution.
- **Impact cascade** — dependency-graph BFS with hop-decay severity.

### App services
- **SQLite persistence** — baseline overrides (survive restart), scenario-run history, SPR-run history, score history.
- **Scheduler** — continuous 10-min score refresh, history append, WS change notifications.
- **WebSocket** — feed back-fill, score snapshot on connect, live score-update push, live GDELT polling (live mode) / synthetic headlines (fixture mode).

### Frontend (12 pages)
- **Dashboard** — corridor risk cards, commodity ticker, live WS feed, Gemini chat drawer.
- **Digital Twin** — Leaflet map: refineries, LNG terminals, ports, foreign sources, maritime routes, demand centres + distribution links, oil/gas pipelines (VEDAS/PNGRB), live AIS vessels colored by cargo, ISRO imagery overlay, corridor status, what-if toggle.
- **Scenarios / ScenarioRun** — catalogue + run page with intensity/duration sliders, impact bars, market timeline, sector trajectory chart (refinery run rate, diesel price, power stress, GDP growth).
- **ScenarioCompare** — side-by-side deltas. **CompoundScenarios** — run 2-4 scenarios simultaneously with combined timeline.
- **SPR** — LP schedule, cover-days gauge, gap-closed metrics, Monte Carlo band, p10/p90 + tail-risk readouts, decision brief, run history.
- **Sourcing** — ranked alternatives with risk breakdown + demand substitution options.
- **Impact Cascade** — any cause → downstream sectors/macro cascade.
- **Stress Test** — multi-corridor shock matrix. **Backtest** — historical replays. **Baselines** — live/override baseline editor with provenance badges.

### Other
- Gemini LLM layer (5 methods) with fixture fallback; SPR decision brief endpoint; Slack integration (dry-run without webhook); assumption ledger; 12 fixture files.

## What we can still do (potential improvements)

### High impact for judges
- **Executive brief page** — `/api/executive-brief` exists but has no dedicated frontend page. A printable single-page brief would be a strong demo closer.
- **Cost-of-inaction page** — endpoint + CostStrip exist inside ScenarioRun; a dedicated cumulative-loss dashboard would sharpen "why act now".
- **Live demo toggle** — a UI switch flipping `ALLOW_LIVE_INGEST` so judges watch scores change between fixture and live.

### Medium
- **Sanction alert drill-down** — twin state already carries `sanctionAlerts`; a panel with OFAC SDN match detail would show compliance capability.
- **Fix the two Known issues** — OFAC redirect + news.json fixture (both small).

### Polish
- Dark/light theme toggle (`op-*` tokens make this mostly CSS-variable swaps), mobile-responsive breakpoints, loading skeletons, CSV/PDF export buttons, unit tests for the pure engines (`risk_score`, `cascade`, `spr_lp`, `spr_uncertainty`).

### Done since last review (kept here so nobody re-plans them)
- ~~WebSocket live-score push~~ — scheduler + `score_update` frames.
- ~~Multi-scenario overlay~~ — CompoundScenarios page + `/api/scenarios/compound`.
- ~~Backtest replay visualisation~~ — Backtest page replays event timelines.
- ~~Fix `scenarios.run_scenario()`~~ — dead code removed; `project_scenario()` is canonical.

### Not in scope (honest limits)
See "Honest scoping" above and `docs/assumptions.md`. We do not model refinery chemistry, coal grades, lithium cell chemistry, rare earth separation, solar cell technology, or spot tanker rates.

## Reference docs

- `docs/architecture.md` — full system diagram, data-flow trace, scaling considerations
- `docs/architecture_diagram.md` — Mermaid + ASCII versions for the deck
- `docs/assumptions.md` — assumption ledger (numeric baselines, scenario parameters, what we don't model)
- `docs/demo_script.md` — 5-minute walkthrough with timing
- `docs/presentation_outline.md` — 10-slide deck outline
- `6a38ce305640d_ET_AI_Hackathon_2026_Problem_Statements.pdf` — PS2 is page 4-5
