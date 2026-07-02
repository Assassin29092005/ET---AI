# Resilience Grid

**An operational intelligence layer for India's strategic import basket.** Fuses geopolitical events, vessel AIS, sanctions registries, commodity prices and news sentiment into composite corridor-level risk scores — refreshed continuously and pushed over WebSocket. Models named disruption scenarios (alone or compounded). Walks an impact-cascade dependency graph from any cause to every affected Indian sector. Solves a linear program for Strategic Petroleum Reserve drawdown with Monte Carlo uncertainty bands. Drafts an analyst-grade narrative via Gemini.

Built for the ET AI Hackathon 2026 (Problem Statement 2).

---

## Why this matters

India imports roughly 88% of its crude oil, with 40-45% of those barrels transiting the Strait of Hormuz. Around 50% of natural gas arrives as LNG, primarily from Qatar, the US, the UAE and Australia. Coking coal — the feedstock for primary steel — is about 85% imported, with ~70% from Queensland through the Strait of Malacca. About 80% of solar PV modules and 60% of cells come from China, and over 90% of refined rare earths pass through Chinese processors. A single corridor incident or sanctions action ripples across power, mobility, steel and the clean-energy transition.

Strategic Petroleum Reserves cover only ~9.5 days of consumption. McKinsey's analysis of past energy supply shocks found that economies without integrated response intelligence took an average of 47 days longer to stabilise supply. **That intelligence layer is what this platform builds.**

## What it does, today

| Capability | Where it lives |
|---|---|
| Live composite risk scores per corridor × commodity (0-100, four tiers, five signal streams) | Dashboard / `/api/scores` |
| Continuous re-scoring every 10 min with SQLite history + WebSocket push on change | `/api/scores/history`, `/ws/feed` |
| Per-supplier-country risk (corridor risk × import-share concentration) | `/api/scores/suppliers/{commodity}` |
| Geospatial digital twin — 6 corridors, live AIS vessels, refineries, LNG terminals, ports, demand centres, oil/gas pipelines (ISRO VEDAS / PNGRB), satellite imagery overlay | `/twin` / `/api/digital-twin/state` |
| 7 named disruption scenarios with elasticity-based projections + sector trajectories (refinery run rate, diesel price, power stress, GDP) | `/scenarios/:name` / `POST /api/scenarios/{name}/run` |
| Compound scenarios — 2-4 shocks running simultaneously with combined timeline | `/compound` / `POST /api/scenarios/compound` |
| Side-by-side scenario comparison with deltas | `/compare` |
| Impact cascade — any cause (corridor / country / commodity) → every downstream Indian sector and macro variable | `/cascade` / `POST /api/impact-cascade` |
| 63-cell stress-test matrix (7 scenarios × 3 intensities × 3 durations) | `/stress-test` |
| Historical backtest with day-by-day playback (June 2025 Hormuz, Dec 2024 Red Sea, Q4 2024 Queensland coal) | `/backtest` |
| SPR drawdown linear program (PuLP CBC) with Monte Carlo p10/p50/p90 supply-gap band and tail-risk probabilities | `/spr` / `POST /api/spr/plan`, `POST /api/spr/brief` |
| Scenario-run and SPR-run audit history (SQLite, survives restart) | `/api/scenario-runs`, `/api/spr/runs` |
| Live baseline anchors (Brent, Henry Hub, USD/INR, retail fuel) with operator overrides | `/baselines` / `/api/baselines` |
| Alternative-supplier ranking by risk + share + lead-time, plus demand substitution | `/sourcing` / `/api/sourcing/{commodity}` |
| Cost-of-inaction calculator (Rs crore/day, GDP-bps-driven) | `/api/cost-of-inaction` |
| OFAC sanctions alerts cross-referenced with vessels | Banner on dashboard |
| WebSocket live feed — headlines + score-change pushes | `/ws/feed` |
| Ask-the-analyst chat panel (Gemini-backed) | floating bottom-right on every page |
| Slack alert webhook | `POST /api/integrations/slack` |

## Repository layout

```
backend/        FastAPI service
  app/api/      routes.py (34 endpoints, all camelCase JSON), websocket.py
  app/engines/  risk_score, live_scores, scenarios (7), spr_lp (PuLP CBC),
                spr_uncertainty (Monte Carlo), sourcing, cascade
  app/ingest/   13 source adapters: gdelt, ais, ais_stream, sanctions, prices,
                news, baselines, pump_prices, vedas, lng, coal, minerals, solar
  app/          persistence.py (SQLite state), scheduler.py (10-min re-score loop)
  app/llm/      Gemini client (summarise, prompts) with offline fixture fallback
  data/fixtures/ 12 JSON snapshots — demo runs without any API key
frontend/       React 18 + Vite + TypeScript + Tailwind
  src/pages/    12 pages: Dashboard, DigitalTwin, ImpactCascade, Scenarios,
                ScenarioRun, ScenarioCompare, CompoundScenarios, StressTest,
                Backtest, Sourcing, SPR, Baselines
  src/components/  including ChatDrawer, SanctionAlert, CostStrip,
                   CommodityTicker, MetricCard, RiskTicker, ImpactBar, SPRChart
  src/lib/      api.ts (typed client), types.ts (shape contract), ws.ts, store.ts, fmt.ts
docs/           architecture.md, architecture_diagram.md, assumptions.md,
                demo_script.md, presentation_outline.md
```

## Quickstart

**Prerequisites:** Python 3.11+, Node 20+, ~1 GB free disk.

Backend (Windows PowerShell):

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .[dev]
Copy-Item ..\.env.example .\.env       # then edit .env if you want live LLM calls
uvicorn app.main:app --reload --port 8000
```

Frontend (in a second terminal):

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. OpenAPI docs at `http://localhost:8000/docs`.

**The demo runs offline.** With `ALLOW_LIVE_INGEST=false` (default) it uses pinned JSON fixtures and pre-canned Gemini outputs — every page works without any API key.

## Live mode

To enable real LLM calls and live ingestion, set in `backend/.env`:

```
GEMINI_API_KEY=<your key from https://aistudio.google.com/apikey>
ALLOW_LIVE_INGEST=true
```

The narrative layer uses `gemini-2.5-flash` for synthesis and the lite variant for high-frequency classification. The whole hackathon scope costs well under USD 1 of Gemini quota.

Optional live-signal keys (each falls back gracefully when absent):

```
AISSTREAM_API_KEY=...      # live vessel positions on the twin + AIS scoring signal
EIA_API_KEY=...            # Brent / Henry Hub spot
ALPHA_VANTAGE_KEY=...      # metals prices fallback
NEWSAPI_KEY=...            # news-sentiment scoring signal (free tier: 100 req/day)
VEDAS_API_KEY=...          # ISRO VEDAS pipeline layers (fixture until wired)
SLACK_WEBHOOK_URL=...      # alert push; dry-run payload without it
```

For Mapbox dark tiles on the Digital Twin, set `VITE_MAPBOX_PUBLIC_TOKEN` in `frontend/.env` (falls back to free CartoDB dark tiles).

## Where the intelligence lives

- `backend/app/engines/risk_score.py` — composite 0-100 corridor score from five signal streams: 35% geopolitical + 20% AIS anomaly + 15% sanctions + 15% price volatility + 15% news sentiment
- `backend/app/engines/live_scores.py` — runs that math over live-or-fixture signals for 6 corridors; per-commodity and per-supplier scoring; 14-day disruption probability
- `backend/app/engines/scenarios.py` — `SCENARIOS` dict + `project_scenario(name, intensity, duration)`, the single scenario entry point; sector-transmission matrix for refinery / power / diesel / GDP trajectories
- `backend/app/engines/spr_lp.py` — PuLP CBC LP: minimise integrated price-impact subject to reserve, injection-rate and consumption constraints
- `backend/app/engines/spr_uncertainty.py` — 200-sample Monte Carlo band (p10/p50/p90) over the supply-gap forecast with documented perturbation model
- `backend/app/engines/cascade.py` — dependency-graph BFS with hop-decay, from any cause to every downstream sector
- `backend/app/engines/sourcing.py` — ranks alternatives by `0.5 × (1 - current_risk) + 0.3 × historical_share + 0.2 × lead_time_score`
- `backend/app/scheduler.py` — 10-minute re-score loop, history persistence, WebSocket change fan-out
- `backend/app/llm/summarise.py` — Gemini wrapper, async, LRU-cached, fixture fallback

## Demo flow (5 minutes)

1. **Dashboard** — live corridor risk scores (six corridors, five signals). The sanctions banner shows an OFAC-flagged tanker. The narrated feed and score updates arrive over WebSocket.
2. **Digital twin** — pan over the Arabian Sea: live AIS vessels, Indian refineries, pipelines from ISRO/PNGRB data. Click the Hormuz corridor to trigger the closure scenario.
3. **Scenario run** — at 50% intensity: Brent $82 → $91.5, SPR runway 9.5 → 8.3 days, GDP ≈ -23 bps, plus refinery run-rate / diesel / power-stress / GDP trajectories. Cost-of-inaction shows ₹ crore/day. Analyst narrative cites the input signals.
4. **Compound scenarios** — run Hormuz closure + Queensland coal ban simultaneously; the combined timeline shows compounding stress. Then **Impact cascade** — one click from "Strait of Hormuz" to steel, fertiliser, aviation and GDP.
5. **SPR optimiser** — solve the LP, see drawdown vs flat baseline with the Monte Carlo band, then the decision brief. Close on the run-history panel: every solve is audited.

Full narrated script: [docs/demo_script.md](docs/demo_script.md).

## Tech stack

Python 3.11, FastAPI, Pydantic v2, PuLP, google-generativeai, structlog, httpx, websockets, stdlib sqlite3
React 18, Vite, TypeScript, Tailwind, react-router-dom, axios, zustand, Recharts, Leaflet, react-leaflet, lucide-react, clsx, date-fns

## Honest scope

The procurement / sourcing module ranks alternatives. It does **not** validate refinery configuration, coal washability, lithium chemistry or rare-earth separation. Those require a domain partner; we say so on screen. AIS spoofing near Iran is real — we acknowledge that vessel attribution is not 100% reliable in disputed waters.

See [docs/assumptions.md](docs/assumptions.md) for every numeric baseline and modelling assumption.

## License

MIT for the source. Third-party data — GDELT, OFAC SDN, EIA, AISStream, OpenStreetMap, VEDAS/ISRO, PPAC, GIIGNL, USGS, MNRE, World Bank, NewsAPI — remains under the licenses of their respective providers. Used here for non-commercial research and demonstration.
