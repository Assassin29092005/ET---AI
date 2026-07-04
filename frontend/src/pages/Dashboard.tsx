import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getExecutiveBrief,
  getFeed,
  getScenarios,
  getScores,
  getTwinStateWithAlerts,
  postSlack,
  getSupplierScores,
  getSourcing,
  type ScenarioMeta,
  type SupplierScore,
  type TwinStateWithAlerts,
} from "@/lib/api";
import { connectFeedWebSocket } from "@/lib/ws";
import { fmtIstTime } from "@/lib/fmt";
import { useAppStore } from "@/lib/store";
import {
  COMMODITY_LABEL,
  CORRIDOR_LABEL,
  scoreToTier,
  type Corridor,
  type ExecutiveBrief,
  type FeedItem,
  type RiskScore,
  type RiskTier,
  type Commodity,
  type SourcingOption,
} from "@/lib/types";
import { RiskTicker } from "@/components/RiskTicker";
import { SanctionAlertBanner } from "@/components/SanctionAlert";
import { VesselMap } from "@/components/VesselMap";

const REFRESH_MS = 60_000;
const fmtTimeUtc = fmtIstTime;

const CORRIDOR_PATHS: Record<Corridor, Array<{ lat: number; lon: number }>> = {
  hormuz: [{ lat: 26.0, lon: 55.5 }, { lat: 26.5, lon: 56.2 }, { lat: 27.0, lon: 56.8 }],
  bab_el_mandeb: [{ lat: 12.0, lon: 43.0 }, { lat: 12.6, lon: 43.4 }, { lat: 13.2, lon: 43.8 }],
  malacca: [{ lat: 1.5, lon: 100.5 }, { lat: 2.5, lon: 101.5 }, { lat: 3.5, lon: 102.5 }],
  south_china_sea: [{ lat: 10.0, lon: 113.0 }, { lat: 12.0, lon: 115.0 }, { lat: 14.0, lon: 117.0 }],
  cape_of_good_hope: [{ lat: -34.0, lon: 17.5 }, { lat: -34.3, lon: 18.4 }, { lat: -34.6, lon: 19.3 }],
  suez: [{ lat: 29.5, lon: 32.3 }, { lat: 30.0, lon: 32.5 }, { lat: 30.5, lon: 32.7 }],
};

const COMMODITIES: Commodity[] = [
  "crude_oil",
  "lng",
  "coking_coal",
  "lithium",
  "cobalt",
  "nickel",
  "rare_earths",
  "solar_pv",
  "uranium",
];

const TIER_TEXT_COLOR: Record<RiskTier, string> = {
  low: "text-emerald-600",
  elevated: "text-amber-600",
  high: "text-orange-600",
  critical: "text-red-600",
};

const TIER_BG_BAR: Record<RiskTier, string> = {
  low: "bg-emerald-500",
  elevated: "bg-amber-500",
  high: "bg-orange-500",
  critical: "bg-red-500",
};

function ExecutiveBriefPanel({ brief, onShare, shareStatus }: { brief: ExecutiveBrief | null; onShare: () => void; shareStatus: string | null }) {
  if (!brief) {
    return (
      <div className="card p-6 text-sm text-slate-400">
        Executive brief loading...
      </div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 bg-slate-50">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Executive Brief</div>
          <h3 className="mt-0.5 text-base font-bold text-slate-800">{brief.headline}</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate-400">
            {fmtTimeUtc(brief.generatedAt)}
          </span>
          <button type="button" className="btn-ghost text-xs" onClick={onShare} disabled={shareStatus === "Sending..."}>
            {shareStatus || "Send to Slack"}
          </button>
        </div>
      </div>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <p className="text-sm leading-relaxed text-slate-600 font-medium">{brief.summary}</p>
          {brief.actions && brief.actions.length > 0 && (
            <div className="mt-6">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                Recommended Actions
              </div>
              <ul className="space-y-2 text-sm text-slate-700 font-medium">
                {brief.actions.slice(0, 5).map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-blue-600 font-bold">›</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="border-l border-slate-100 pl-6">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-3">
            Market Snapshot
          </div>
          <dl className="space-y-3 text-sm">
            {[
              { k: "Brent Crude", v: brief.marketSnapshot?.brentUsd, unit: "USD/bbl" },
              { k: "LNG (TTF)", v: brief.marketSnapshot?.ttfEurMwh, unit: "EUR/MWh" },
              { k: "INR / USD", v: brief.marketSnapshot?.inrUsd, unit: "" },
              { k: "Coking Coal", v: brief.marketSnapshot?.coalAud, unit: "AUD/t" },
            ].map((row) => (
              <div
                key={row.k}
                className="flex items-baseline justify-between border-b border-slate-100 pb-2"
              >
                <dt className="text-slate-500 font-medium">{row.k}</dt>
                <dd className="font-mono font-bold text-slate-800">
                  {(row.v ?? 0).toFixed(2)}
                  {row.unit && <span className="ml-1 text-[10px] text-slate-400 font-normal">{row.unit}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      {brief.citations && brief.citations.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-3.5 bg-slate-50/50">
          {brief.citations.map((c, i) => (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-blue-600 hover:border-blue-500 font-semibold"
            >
              {c.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [scores, setScores] = useState<RiskScore[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [brief, setBrief] = useState<ExecutiveBrief | null>(null);
  const [twinState, setTwinState] = useState<TwinStateWithAlerts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const pushFeedItem = useAppStore((s) => s.pushFeedItem);

  // Selector state matching reference UI
  const [selectedCommodity, setSelectedCommodity] = useState<Commodity>("crude_oil");
  const [selectedCountry, setSelectedCountry] = useState<string>("");
  const [suppliers, setSuppliers] = useState<SupplierScore[]>([]);
  const [sourcingOptions, setSourcingOptions] = useState<SourcingOption[]>([]);
  
  // Trigger variables for search
  const [activeCommodity, setActiveCommodity] = useState<Commodity>("crude_oil");
  const [activeCountry, setActiveCountry] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [s, f, c, b, t] = await Promise.all([
          getScores(),
          getFeed(),
          getScenarios(),
          getExecutiveBrief(),
          getTwinStateWithAlerts(),
        ]);
        if (cancelled) return;
        setScores(s);
        setFeed(f);
        setScenarios(c);
        setBrief(b);
        setTwinState(t);
        setLoadedAt(new Date().toISOString());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      }
    }

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Sync suppliers & sourcing when category changes
  useEffect(() => {
    let cancelled = false;
    async function loadCategoryDetails() {
      try {
        const [supplierRes, sourcingRes] = await Promise.all([
          getSupplierScores(selectedCommodity),
          getSourcing(selectedCommodity, 100),
        ]);
        if (cancelled) return;
        setSuppliers(supplierRes.suppliers || []);
        setSourcingOptions(sourcingRes || []);
        
        // Auto-select first country if none is selected
        if (supplierRes.suppliers && supplierRes.suppliers.length > 0) {
          const firstCountry = supplierRes.suppliers[0].country;
          setSelectedCountry(firstCountry);
          
          // Initial trigger match
          if (!activeCountry) {
            setActiveCountry(firstCountry);
            setActiveCommodity(selectedCommodity);
          }
        }
      } catch {
        // silent
      }
    }
    loadCategoryDetails();
    return () => {
      cancelled = true;
    };
  }, [selectedCommodity]);

  useEffect(() => {
    const conn = connectFeedWebSocket((item) => {
      setFeed((cur) => [item, ...cur.filter((x) => x.id !== item.id)].slice(0, 50));
      pushFeedItem(item);
    });
    return () => conn.disconnect();
  }, [pushFeedItem]);

  // Handle issues query click
  const handleCheckForIssues = () => {
    setActiveCommodity(selectedCommodity);
    setActiveCountry(selectedCountry);
  };

  // Find active supplier information based on queries
  const activeSupplier = useMemo(() => {
    return suppliers.find((s) => s.country === activeCountry) || suppliers[0] || null;
  }, [suppliers, activeCountry]);

  // Map sub-risks from selected supplier's corridor score components
  const subRiskMetrics = useMemo(() => {
    if (!activeSupplier) {
      return { geo: "0.0", trade: "0.0", logistics: "0.0", econ: "0.0" };
    }
    
    // Find active corridor score in the system to fetch components
    const scoreObj = scores.find(
      (s) => s.corridor === activeSupplier.corridor && s.commodity === activeCommodity
    );

    if (scoreObj && scoreObj.components) {
      return {
        geo: ((scoreObj.components.geopolitical || 40) / 10).toFixed(1),
        trade: ((scoreObj.components.sanctions || 30) / 10).toFixed(1),
        logistics: (((scoreObj.components.chokepoint || 35) + (scoreObj.components.weather || 20)) / 20).toFixed(1),
        econ: ((scoreObj.components.market || 25) / 10).toFixed(1),
      };
    }

    // Dynamic defaults scaled by risk score
    const base = activeSupplier.supplierRisk || 40;
    return {
      geo: ((base * 1.1) / 10).toFixed(1),
      trade: ((base * 0.9) / 10).toFixed(1),
      logistics: ((base * 1.0) / 10).toFixed(1),
      econ: ((base * 0.8) / 10).toFixed(1),
    };
  }, [activeSupplier, scores, activeCommodity]);

  // Leaflet mapping parameters
  const mappedVessels = useMemo(() => {
    return (twinState?.vesselPositions || []).map((v) => ({
      mmsi: v.mmsi,
      name: v.name,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      course: v.course,
      cargo: (v.cargo === "crude" ? "crude_oil" : v.cargo) as Commodity,
      origin: "",
      destination: "",
      eta: "",
      corridor: v.corridor,
      timestamp: v.lastSeen,
    }));
  }, [twinState]);

  const mappedCorridors = useMemo(() => {
    const uniqueCorridors = Array.from(new Set(scores.map((s) => s.corridor)));
    return uniqueCorridors.map((c) => {
      const scoreObj = scores.find((s) => s.corridor === c && s.commodity === activeCommodity) || scores.find((s) => s.corridor === c);
      return {
        id: c,
        name: CORRIDOR_LABEL[c] || c,
        tier: scoreObj?.tier || "low",
        risk_score: scoreObj?.score || 0,
        polyline: CORRIDOR_PATHS[c] || [],
      };
    });
  }, [scores, activeCommodity]);

  async function shareToSlack() {
    if (!brief) return;
    setShareStatus("Sending...");
    try {
      const res = await postSlack({
        title: brief.headline,
        body: brief.summary,
        severity: "warn",
      });
      setShareStatus(res.sent ? "Sent to Slack ✓" : `Dry-run (${res.reason ?? "no webhook"})`);
    } catch (e) {
      setShareStatus(e instanceof Error ? e.message : "Failed");
    } finally {
      setTimeout(() => setShareStatus(null), 4000);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header Section */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl text-white leading-tight">
            Global Import Analysis & Risk Assessment
          </h1>
          <p className="mt-1 text-xs text-slate-400 font-medium">
            Composite risk across supply channels and maritime corridors. Real-time updates with WebSocket push.
          </p>
        </div>
        <div className="text-right font-mono text-[10px] uppercase tracking-wider text-slate-400">
          {loadedAt ? `As of ${fmtTimeUtc(loadedAt)}` : "loading..."}
          {error && <div className="mt-1 text-red-400 normal-case">{error}</div>}
        </div>
      </header>

      {/* Sanctions Banner */}
      {twinState?.sanctionAlerts && twinState.sanctionAlerts.length > 0 && (
        <SanctionAlertBanner alerts={twinState.sanctionAlerts} maxVisible={1} />
      )}

      {/* Grid: 1. Analyze Current Import Source Selector */}
      <section className="grid grid-cols-1 gap-6">
        <div className="card p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            {/* Input Selects */}
            <div className="flex-1">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                Analyze Current Import Source
              </h2>
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex flex-col gap-1.5 min-w-[200px]">
                  <label className="text-[10px] font-semibold text-slate-400">Product Category</label>
                  <select
                    value={selectedCommodity}
                    onChange={(e) => setSelectedCommodity(e.target.value as Commodity)}
                    className="input-op font-medium"
                  >
                    {COMMODITIES.map((c) => (
                      <option key={c} value={c}>
                        {COMMODITY_LABEL[c] || c}
                      </option>
                    ))}
                  </select>
                </div>
                
                <div className="flex flex-col gap-1.5 min-w-[200px]">
                  <label className="text-[10px] font-semibold text-slate-400">Select Country</label>
                  <select
                    value={selectedCountry}
                    onChange={(e) => setSelectedCountry(e.target.value)}
                    className="input-op font-medium"
                  >
                    {suppliers.map((s) => (
                      <option key={s.country} value={s.country}>
                        {s.country}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleCheckForIssues}
                  className="btn-accent px-5 py-2 font-semibold h-[38px] mt-5 flex items-center justify-center bg-blue-600 border-blue-600 text-white hover:bg-blue-700 hover:border-blue-700"
                >
                  Check for Issues
                </button>
              </div>
            </div>

            {/* Current Status Result Panel */}
            <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-slate-100 pt-6 md:pt-0 md:pl-8 flex flex-col justify-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Current Status</div>
              {activeSupplier ? (
                <div className="mt-2.5">
                  <div className="text-sm font-bold text-slate-800">
                    {activeCountry} - Risk Level:{" "}
                    <span className={TIER_TEXT_COLOR[activeSupplier.tier || "low"]}>
                      {activeSupplier.tier?.toUpperCase()} ({(activeSupplier.supplierRisk / 10).toFixed(1)}/10)
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="progress-bar-container mt-3">
                    <div
                      className={`progress-bar-fill ${TIER_BG_BAR[activeSupplier.tier || "low"]}`}
                      style={{ width: `${activeSupplier.supplierRisk}%` }}
                    />
                  </div>
                  <div className="mt-2 font-mono text-[9px] text-slate-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Low Risk</span>
                    <span>Critical</span>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-400 mt-2">No category analyzed. Select variables.</div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Grid: 2. Sub-risks details + Map panel */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr,1.3fr]">
        {/* Sub-risks breakdown */}
        <div className="card p-6 flex flex-col justify-between">
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-4 border-b border-slate-100 pb-2">
              Identify Key Issues in Source Country ({activeCountry || "Selected Country"})
            </h2>
            <div className="space-y-4">
              {/* Geopolitical */}
              <div>
                <div className="flex items-center justify-between text-xs mb-1 font-semibold">
                  <span className="text-slate-700">Geopolitical Stability</span>
                  <span className="font-mono text-slate-800">{subRiskMetrics.geo}</span>
                </div>
                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill bg-orange-500"
                    style={{ width: `${parseFloat(subRiskMetrics.geo) * 10}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">⚡ Tariffs</span>
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">🏴 Unrest</span>
                </div>
              </div>

              {/* Trade Policies */}
              <div>
                <div className="flex items-center justify-between text-xs mb-1 font-semibold">
                  <span className="text-slate-700">Trade Policies</span>
                  <span className="font-mono text-slate-800">{subRiskMetrics.trade}</span>
                </div>
                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill bg-amber-500"
                    style={{ width: `${parseFloat(subRiskMetrics.trade) * 10}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">⚖️ Sanctions</span>
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">🚫 Embargo</span>
                </div>
              </div>

              {/* Logistics */}
              <div>
                <div className="flex items-center justify-between text-xs mb-1 font-semibold">
                  <span className="text-slate-700">Logistics & Supply Chain</span>
                  <span className="font-mono text-slate-800">{subRiskMetrics.logistics}</span>
                </div>
                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill bg-red-500"
                    style={{ width: `${parseFloat(subRiskMetrics.logistics) * 10}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">🚢 Port Congestion</span>
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">⌛ Delays</span>
                </div>
              </div>

              {/* Economic */}
              <div>
                <div className="flex items-center justify-between text-xs mb-1 font-semibold">
                  <span className="text-slate-700">Economic Factors</span>
                  <span className="font-mono text-slate-800">{subRiskMetrics.econ}</span>
                </div>
                <div className="progress-bar-container">
                  <div
                    className="progress-bar-fill bg-emerald-500"
                    style={{ width: `${parseFloat(subRiskMetrics.econ) * 10}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">💰 FX Volatility</span>
                  <span className="badge bg-slate-100 text-slate-600 border-slate-200">📈 Inflation</span>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-6 text-[10px] text-slate-400 font-medium border-t border-slate-100 pt-3">
            Corridor of exposure: <span className="font-mono font-bold text-slate-600">{activeSupplier ? CORRIDOR_LABEL[activeSupplier.corridor] : "--"}</span>
          </div>
        </div>

        {/* Map visualization */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Geopolitical Transit Visual</span>
            <Link to="/twin" className="text-[10px] uppercase font-bold text-blue-600 hover:underline">Launch Twin →</Link>
          </div>
          <VesselMap
            vessels={mappedVessels}
            corridors={mappedCorridors}
            height="21.5rem"
          />
        </div>
      </section>

      {/* Grid: 3. Suggested Alternative Sourcing Cards */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          Suggested Alternative Sourcing (Category: {COMMODITY_LABEL[activeCommodity] || activeCommodity})
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {sourcingOptions.slice(0, 3).map((option, idx) => {
            const riskTier = scoreToTier(option.routeRiskScore);
            return (
              <div key={option.supplier} className="card p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-800">{idx + 1}. {option.supplier}</span>
                    <span
                      className={`h-2 w-2 rounded-full ${
                        riskTier === "low"
                          ? "bg-emerald-500"
                          : riskTier === "elevated"
                            ? "bg-amber-500"
                            : riskTier === "high"
                              ? "bg-orange-500"
                              : "bg-red-500"
                      }`}
                    />
                  </div>
                  
                  <div className="mt-2.5 flex items-baseline gap-1">
                    <span className="text-xs font-semibold text-slate-500">Risk Score:</span>
                    <span className={`text-xs font-bold ${TIER_TEXT_COLOR[riskTier]}`}>
                      {(option.routeRiskScore / 10).toFixed(1)} ({riskTier})
                    </span>
                  </div>

                  <div className="mt-4">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Key Advantages</span>
                    <ul className="mt-1.5 space-y-1 text-xs text-slate-600 font-semibold list-disc list-inside">
                      {option.gradeNote ? (
                        <li>{option.gradeNote}</li>
                      ) : (
                        <li>Flexible routing via {CORRIDOR_LABEL[option.routeCorridor as Corridor] || option.routeCorridor}</li>
                      )}
                      <li>Carbon intensity: {option.carbonIntensity} kg CO₂</li>
                    </ul>
                  </div>
                </div>

                <div className="mt-6 border-t border-slate-100 pt-4 flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate-400 text-[10px] font-semibold uppercase">Tariffs</span>
                      <div className="text-slate-700 font-bold mt-0.5 capitalize">{option.sanctionsCheck === "clear" ? "Low" : option.sanctionsCheck}</div>
                    </div>
                    <div>
                      <span className="text-slate-400 text-[10px] font-semibold uppercase">Transit Time</span>
                      <div className="text-slate-700 font-bold mt-0.5 font-mono">{option.leadTimeDays} days</div>
                    </div>
                  </div>

                  <Link
                    to="/sourcing"
                    className="w-full text-center py-2 bg-blue-50 text-blue-600 font-bold rounded-lg text-xs hover:bg-blue-100 hover:text-blue-700 transition-all duration-150"
                  >
                    View Details
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Grid: 4. Narrated Risk Feed + Stress Scenarios list */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr,1fr]">
        <div>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Narrated Risk alerts</h2>
            <span className="font-mono text-xs font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">{feed.length} items</span>
          </div>
          <RiskTicker items={feed} />
        </div>
        
        <div>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Disruption Scenarios</h2>
            <Link
              to="/scenarios"
              className="text-[10px] uppercase font-bold text-blue-600 hover:underline"
            >
              Configure all scenarios →
            </Link>
          </div>
          <div className="flex flex-col gap-3">
            {scenarios.slice(0, 4).map((s) => (
              <Link
                key={s.name}
                to={`/scenarios/${s.name}`}
                className="group flex items-center justify-between card p-4 hover:border-blue-400"
              >
                <div>
                  <div className="text-sm font-bold text-slate-800 leading-tight group-hover:text-blue-600">{s.label}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] font-bold text-slate-400 uppercase font-mono">
                      {COMMODITY_LABEL[s.primary_commodity] ?? s.primary_commodity}
                    </span>
                    <span className="text-slate-300">•</span>
                    <span className="text-[10px] font-bold text-slate-400 uppercase font-mono">
                      {CORRIDOR_LABEL[s.primary_corridor] ?? s.primary_corridor}
                    </span>
                  </div>
                </div>
                <span className="text-slate-300 group-hover:text-blue-500 font-bold text-sm transition-all duration-150 pr-1 group-hover:translate-x-1">→</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Grid: 5. Executive Brief */}
      <section>
        <ExecutiveBriefPanel brief={brief} onShare={shareToSlack} shareStatus={shareStatus} />
      </section>
    </div>
  );
}
