# Assumption Ledger

## 1. Why this document exists

Hackathon judges will probe modeling assumptions before accepting any decision-support output. This ledger makes every numeric input, weight, and exclusion explicit, attributable to a public source, and revisable through configuration. Nothing in the platform is meant to be opaque: if a number drives a recommendation, it is listed here with the source and a path to override it.

---

## 2. Commodity baselines

All baselines reflect FY24-FY25 reporting unless noted. Calibration values live in the `BASELINE` dict in `backend/app/engines/scenarios.py`. At startup, `ingest/baselines.py` refreshes the *data* anchors (Brent, Henry Hub, copper, USD/INR, retail fuel) from live feeds when reachable; model elasticities are never touched. Operators can inspect and override key baselines on the Baselines page (`/baselines`), and overrides persist in SQLite across restarts.

### 2.1 Crude oil

| Field | Value | Source |
|---|---|---|
| Total imports | ~4.8 MMb/d | PPAC monthly bulletin, FY25 |
| Hormuz transit share | 40-45% | PPAC origin tables, IEA Oil Market Report |
| Top suppliers | Iraq, Saudi Arabia, Russia, UAE, US | PPAC |
| SPR total capacity | 39.0 MMb (5.33 MMt) | ISPRL public disclosures |
| Vizag SPR | 1.33 MMt | ISPRL |
| Mangalore SPR | 1.50 MMt | ISPRL |
| Padur SPR | 2.50 MMt | ISPRL |
| Consumption cover | ~9.5 days at current run rate | Derived: SPR / refinery throughput |

### 2.2 LNG / natural gas

| Field | Value | Source |
|---|---|---|
| Total LNG imports | ~30 MTPA | PPAC, GIIGNL Annual Report |
| Qatar share | ~40% | GIIGNL, PPAC |
| US share | ~15% | GIIGNL |
| UAE share | ~10% | GIIGNL |
| Russia share | ~5% | GIIGNL |
| Dahej regas capacity | 17.5 MTPA | Petronet LNG |
| Hazira | 5.0 MTPA | Shell India |
| Kochi | 5.0 MTPA | Petronet LNG |
| Dabhol | 5.0 MTPA | Konkan LNG |
| Ennore | 5.0 MTPA | IOCL |

### 2.3 Coking coal

| Field | Value | Source |
|---|---|---|
| Total imports | ~70 MTPA | Ministry of Steel, DGMS |
| Australia (Queensland) | ~70% | Ministry of Steel |
| Other origins | US, Indonesia, Mozambique | Ministry of Steel |
| Dependent steel capacity | ~120 MTPA crude steel | Ministry of Steel |
| Receiving ports | Paradip, Visakhapatnam, Dhamra | Major Ports Authority |

### 2.4 Critical minerals

| Mineral | Import dependence | Refining concentration | Source |
|---|---|---|---|
| Lithium | ~100% | China ~60% of global refining | USGS MCS, IEA Critical Minerals Outlook |
| Cobalt | ~70% | China ~70% of refining; DRC ~70% of mining | USGS MCS |
| Nickel | ~80% | Indonesia/Philippines for mine output | USGS MCS |
| Rare earths | ~85% | China ~90% of separation | USGS MCS, IEA |

### 2.5 Solar PV

| Field | Value | Source |
|---|---|---|
| Module import share | ~80% from China | MNRE, DGCIS |
| Cell import share | ~60% from China | MNRE |
| FY24 capacity addition | ~13 GW | MNRE annual report |
| Imported value share | ~80% of installed value | MNRE, industry estimates |

### 2.6 Uranium

| Field | Value | Source |
|---|---|---|
| Domestic source | Jaduguda (limited) | DAE annual report |
| Kazakhstan share of imports | ~30% | DAE, IAEA |
| Other origins | Russia, France | DAE, IAEA |

---

## 3. Risk score formula

Per corridor x commodity pair, the composite score is:

```
risk = w_geo * geo_signal
     + w_ais * ais_anomaly
     + w_sanctions * sanctions_signal
     + w_price * price_vol
     + w_news * news_signal
```

Default weights (defined as constants in `backend/app/engines/risk_score.py`; the live path in `live_scores.py` scores six corridors — Hormuz, Bab el-Mandeb, Malacca, South China Sea, Cape of Good Hope, Suez):

| Component | Weight | Driver |
|---|---|---|
| `geo_signal` | 0.35 | GDELT event tone + count for corridor geography |
| `ais_anomaly` | 0.20 | Vessel-count deviation vs corridor baseline (AISStream live or fixture) |
| `sanctions_signal` | 0.15 | OFAC SDN listings touching counterparties on the route |
| `price_vol` | 0.15 | Recent realized vol of the corridor's primary benchmark |
| `news_signal` | 0.15 | Negative share of last-24h corridor headlines (NewsAPI → GDELT DOC fallback) |

Each component is clipped to [0, 1] before the weighted sum, so the composite is bounded in [0, 100] after multiplying by 100.

Threshold bands:

| Band | Range | Color |
|---|---|---|
| Low | < 30 | green |
| Elevated | 30 - 55 | amber |
| High | 55 - 75 | orange |
| Critical | > 75 | red |

---

## 4. Scenario parameters

Each scenario is defined in the `SCENARIOS` dict in `backend/app/engines/scenarios.py` (price/GDP/SPR elasticities). The served projection is computed by `project_scenario()` in the same module — the API route's `_project_impact()` is a thin wrapper over it — so the app and this ledger read the same documented elasticities. Parameters listed here are the defaults; users can override intensity and duration before running.

Price elasticities below are the shock at **full intensity** (i = 1.0); the served uplift scales with the intensity slider (e.g. Hormuz at i = 0.5 → Brent +11.6%).

### 4.1 Hormuz partial closure (`hormuz_partial_closure`)

| Parameter | Default |
|---|---|
| Default intensity / duration | 0.40 / 21 days |
| Crude price elasticity (at full closure) | 0.55, on Hormuz volume share 0.42 → Brent ≈ +23% |
| LNG price elasticity | 0.40, on Qatar-route share 0.48 |
| GDP transmission | 18 bps per +$10 Brent |
| SPR drawdown share of gap | 0.65 |

### 4.2 OPEC+ emergency cut (`opec_emergency_cut`)

| Parameter | Default |
|---|---|
| Default intensity / duration | 0.50 / 60 days |
| Global supply removed at full intensity | 3.0 MMb/d |
| Crude price elasticity | 0.30 |
| SPR drawdown share | 0.50 |

### 4.3 Red Sea full suspension (`red_sea_suspension`)

| Parameter | Default |
|---|---|
| Default intensity / duration | 0.70 / 45 days |
| Reroute | Cape of Good Hope, +14 days transit |
| Container freight at full intensity | +145% |
| Crude / LNG price elasticity | 0.18 / 0.22 |
| SPR drawdown share | 0.20 |

### 4.4 Australian coking coal disruption (`australia_coking_coal`)

| Parameter | Default |
|---|---|
| Default intensity / duration | 0.55 / 30 days |
| Trigger | Cyclone, rail outage or export curb, Queensland |
| Coking coal price elasticity | 0.65, on Australia share 0.70 |
| Steel output drag | 4.5 bps per +10% coal price |
| Mill stockpile buffer | 22 days |

### 4.5 China rare earth export curbs (`china_rare_earth_curbs`)

| Parameter | Default |
|---|---|
| Default intensity / duration | 0.60 / 120 days |
| REE price elasticity | 1.10, on China share 0.90 |
| EV battery pass-through | 6% |
| GDP transmission | 1.2 bps per pp of EV-capex drag |
| Stockpile buffer | 35 days |
| Affected sectors | EV traction motors, wind turbines, defence |

### 4.6 China solar module export tariff (`china_solar_export_tariff`)

| Parameter | Default |
|---|---|
| Default intensity / duration | 0.45 / 180 days |
| Module price elasticity | 0.35, on China module share 0.80 |
| LCOE uplift | 3.8% per +10% module price |
| Renewable capex drag | 2.5 bps |
| Stockpile buffer | 60 days |

### 4.7 Kazakhstan uranium disruption (`kazakhstan_uranium_disruption`)

| Parameter | Default |
|---|---|
| Default intensity / duration | 0.50 / 90 days |
| Uranium price elasticity | 0.45, on Kazakhstan share 0.40 |
| Fuel-cycle buffer | 540 days (~18 months) — impacts are small and slow by design |
| NPP capex drag | 0.8 bps |

### 4.8 Sector transmission (refinery run-rate & power-sector stress)

The PS requires each scenario to project **refinery run rates** and **power-sector stress** alongside price and GDP. These are *mechanism-driven*, not a function of the intensity slider alone — `SCENARIO_SECTOR_TRANSMISSION` in `routes.py` sets the maximum deflection at full intensity, scaled by intensity × duration × within-window ramp. Key modelling choices:

- **Only crude/LNG (refinery feedstock) shocks cut refinery run rates.** Coking coal feeds *steel*, not refineries; rare earth / solar / uranium do not touch refineries → run-rate stays at 100%.
- **Power stress is driven by gas-for-power (LNG) and grid-fuel shortfalls.** Coking coal is *metallurgical, not thermal* → negligible power impact. Uranium feeds nuclear (~3% of generation) behind an ~18-month fuel buffer → small and slow.

| Scenario | Refinery run-rate drop (pp, at full) | Power-stress rise (index pts, at full) |
|---|---|---|
| Hormuz partial closure | 22 | 28 |
| OPEC+ emergency cut | 8 | 6 |
| Red Sea suspension | 5 | 8 |
| Australian coking coal | 0 | 2 |
| China rare earth curbs | 0 | 3 |
| China solar tariff | 0 | 4 |
| Kazakhstan uranium | 0 | 6 |

GDP drag is likewise routed through each scenario's **own** channel (Brent→import-bill for oil scenarios; steel-margin for coking coal; EV/wind capex for rare earth; renewable capex for solar; NPP capex for uranium) rather than a single oil-price proxy, so non-oil scenarios register a non-zero, defensible GDP impact. Baselines: refinery run rate 100%, power-stress index 20, diesel ₹92/L, GDP trend 6.5%.

---

## 5. SPR linear program

Decision variables, per day `t` in horizon `T`:

- `drawdown_t` >= 0, barrels released from SPR
- `replenish_t` >= 0, barrels injected into SPR

Objective:

```
minimize  sum_{t=1..T}  price_impact( deficit_t )
```

Subject to:

```
SPR_t            = SPR_{t-1} - drawdown_t + replenish_t
consumption_t    - imports_t = drawdown_t - inventory_change_t
SPR_t            >= 0
drawdown_t       <= max_injection_rate
replenish_t      <= max_injection_rate
```

Solved with PuLP CBC. `price_impact` is a piecewise-linear function of `deficit_t` calibrated from historical Brent moves during the 2019 Abqaiq strike and the 2022 Russia diversion. The calibration constants live in `backend/app/engines/spr_lp.py`.

### 5.1 Monte Carlo uncertainty band

`backend/app/engines/spr_uncertainty.py` wraps the supply-gap forecast in a true percentile band computed from 200 perturbed trajectories (deterministic under a seed). Perturbations and their rationale:

| Input | Distribution | Why |
|---|---|---|
| Intensity | Normal(input, sd 0.10), clipped [0.05, 1.0] | Analyst may misjudge shock severity |
| Crude price elasticity | Normal(doc, sd 10% of doc) | Priced-in uncertainty in the documented elasticity |
| Crude volume share | Normal(doc, sd 5%), clipped | Refinery-import share ambiguity |
| Exposure (kbpd) | Lognormal(input, sd 0.15 log-scale) | Slate/grade substitution; strictly positive with upside tails |
| Shock timing | Uniform ±3 days | Peak/end timing uncertainty |

Output per day: `central` = p50, `low` = p10, `high` = p90, plus aggregates (peak p50, P(gap > 500 kbpd), P(gap > 1000 kbpd)). Non-crude scenarios (rare earths, solar, uranium, coking coal) return a flat zero band — SPR is a crude-only instrument and the UI says so.

---

## 6. Sourcing module — exclusions

The sourcing optimizer is intentionally narrow. It does NOT model:

- Refinery configuration or crude grade chemistry (no slate optimization)
- Pipeline hydraulics (line-fill, batching, drag-reducing agents)
- Live tanker spot rates (we ingest Baltic Exchange BDTI headlines only)
- Long-term contract terms (all supply is treated as spot for tractability)
- Port-specific draft restrictions or berth queueing

These omissions are deliberate. Judges should treat sourcing output as a shortlist for procurement review, not a final allocation.

---

## 7. Data freshness

| Feed | Cadence | Lag |
|---|---|---|
| GDELT events | 15 min | < 30 min |
| AIS vessel positions (AISStream WebSocket) | live | seconds |
| NewsAPI headlines | per scheduler tick (free tier: 100 req/day) | minutes |
| OFAC SDN | daily refresh | 24 h |
| Commodity prices (Brent, Henry Hub via EIA; metals via Alpha Vantage) | daily close | end of day |
| Composite score refresh (scheduler) | 10 min | — |
| PPAC monthly bulletin | monthly | 30-45 day lag |
| GIIGNL World LNG Report | annual | up to 12 months |
| USGS Mineral Commodity Summaries | annual | up to 12 months |

Freshness is surfaced in the UI via `asOf` timestamps on every panel and live/override provenance on the Baselines page, so users see which inputs are stale before relying on them.

---

## 8. AIS spoofing acknowledgement

Vessels operating near Iran, sanctioned Russian terminals, and parts of the Red Sea routinely broadcast false GNSS positions, switch transponders off ("dark gaps"), or borrow another vessel's MMSI. We:

- Flag dark gaps over 6 hours as anomalies but do NOT auto-conclude sanctions evasion.
- Do NOT claim 100% attribution of any vessel to any cargo or owner.
- Cross-check positions against scheduled port calls where data exists.

---

## 9. Score interpretation guide

For both users and judges:

- The composite score is a triage signal, not a forecast. It says "look here today," not "this will close."
- An "elevated" reading does not predict a closure. It tells procurement and logistics teams to review the alternative options the system has surfaced.
- "Critical" should trigger a human decision review, not an automated action.
- Backtest events (June 2025 Hormuz escalation, Dec 2024 Red Sea, Q4 2024 Queensland coal) are defined in `backend/app/api/routes.py` and replayable day-by-day at `GET /api/backtest/{event_id}/replay` and on the Backtest page, so reviewers can judge calibration on their own.
