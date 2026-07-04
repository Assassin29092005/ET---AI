import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getCostOfInaction,
  getScenarios,
  getSourcing,
  runScenarioByName,
  type CostOfInaction,
  type ScenarioMeta,
} from '@/lib/api';
import {
  CORRIDOR_LABEL,
  COMMODITY_LABEL,
  type ScenarioResult,
  type SourcingOption,
} from '@/lib/types';
import { commodityUnitShort, fmtNumber } from '@/lib/fmt';
import CommodityBadge from '@/components/CommodityBadge';
import NarrativeFeed from '@/components/NarrativeFeed';
import CostStrip from '@/components/CostStrip';

function delta(projected: number, baseline: number): number {
  if (!baseline) return 0;
  return ((projected - baseline) / baseline) * 100;
}

export default function ScenarioRun() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [meta, setMeta] = useState<ScenarioMeta | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [sourcing, setSourcing] = useState<SourcingOption[]>([]);
  const [cost, setCost] = useState<CostOfInaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Live IST Clock
  const [timeStr, setTimeStr] = useState('');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST');
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const list = await getScenarios();
        const match = list.find((s) => s.name === name);
        if (cancelled) return;
        if (!match) {
          setError(`Unknown scenario: ${name}`);
          setLoading(false);
          return;
        }
        setMeta(match);
        const res = await runScenarioByName(name as string);
        if (cancelled) return;
        setResult(res);
        try {
          const [src, c] = await Promise.all([
            getSourcing(match.primary_commodity, 100),
            getCostOfInaction(name as string, 14, 0.5),
          ]);
          if (!cancelled) {
            setSourcing(src);
            setCost(c);
          }
        } catch {
          // supplementary calls non-fatal
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to run scenario');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [name]);

  const chartData = useMemo(() => {
    if (!result) return [];
    return result.timeline.map((t) => ({
      day: t.day,
      brent: Number(t.brentUsd.toFixed(2)),
      sprDraw: Number(t.sprDrawDownMb.toFixed(2)),
      capeRoute: Number((t.routeShareCape * 100).toFixed(1)),
    }));
  }, [result]);

  const trajectoryData = useMemo(() => {
    if (!result) return [];
    return result.timeline.map((t) => ({
      day: t.day,
      refinery: t.refineryRunRatePct ?? null,
      diesel: t.dieselPriceInr ?? null,
      power: t.powerStressIndex ?? null,
      gdp: t.gdpGrowthPct ?? null,
    }));
  }, [result]);

  const brentUplift = result ? delta(result.projected.brentUsd, result.baseline.brentUsd) : 0;
  const sprDelta = result
    ? result.baseline.sprCoverDays - result.projected.sprCoverDays
    : 0;

  const runDateStr = useMemo(() => {
    if (!result) return '';
    const date = new Date(result.generatedAt);
    return `RUN ${date.getDate()} ${date.toLocaleString('en-US', { month: 'short' }).toUpperCase()} ${date.getFullYear()}, ${date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })} IST`;
  }, [result]);

  return (
    <div className="flex flex-col gap-6">
      {/* Back button and navigation */}
      <div className="flex justify-between items-center -mb-2">
        <button
          type="button"
          className="text-xs font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1.5"
          onClick={() => navigate('/scenarios')}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Scenarios
        </button>
      </div>

      {/* Header section matching image */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Scenario Overview</p>
          <h1 className="mt-1 text-2xl font-bold text-white leading-tight">
            Scenario: {meta?.label ?? name}
          </h1>
          {meta && (
            <p className="mt-1.5 text-xs text-slate-400 font-medium leading-relaxed max-w-3xl">
              {meta.description}
            </p>
          )}
          {meta && (
            <div className="mt-3 flex items-center gap-2">
              <CommodityBadge commodity={meta.primary_commodity} size="md" />
              <span className="rounded border border-slate-200 bg-white px-2.5 py-0.5 text-[10px] font-semibold text-slate-500 shadow-sm">
                {CORRIDOR_LABEL[meta.primary_corridor] ?? meta.primary_corridor}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end text-right">
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-[11px] font-mono font-bold text-slate-800 shadow-sm">
            IST {timeStr}
          </div>
          {result && (
            <div className="mt-2 font-mono text-[9px] uppercase tracking-wider text-slate-400 font-semibold">
              {runDateStr}
            </div>
          )}
        </div>
      </header>

      {loading && !result && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-400 font-medium shadow-sm">
          Running scenario...
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">
          {error}
        </div>
      )}

      {result && (
        <>
          {/* Custom Metric Cards Row with Sparkline */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Card 1: Brent Uplift */}
            <div className="card p-5 flex justify-between items-start gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Brent uplift</span>
                <span className="text-2xl font-bold font-mono tracking-tight text-slate-800">
                  ${result.projected.brentUsd.toFixed(2)}
                </span>
                <span className="text-[10px] text-slate-400 font-semibold">
                  ${result.baseline.brentUsd.toFixed(2)} – ${result.projected.brentUsd.toFixed(2)}
                </span>
              </div>
              <div className="flex flex-col items-end justify-between h-full py-0.5">
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700 border border-red-200">
                  ▲ +{brentUplift.toFixed(1)}%
                </span>
                {(() => {
                  const brentPoints = result.timeline.map((t) => t.brentUsd);
                  const minP = Math.min(...brentPoints);
                  const maxP = Math.max(...brentPoints);
                  const range = maxP - minP || 1;
                  const pointsStr = brentPoints
                    .map((p, idx) => {
                      const x = (idx / (brentPoints.length - 1)) * 64;
                      const y = 20 - ((p - minP) / range) * 16 - 2;
                      return `${x},${y}`;
                    })
                    .join(' ');
                  return (
                    <svg className="w-16 h-6 text-red-500 mt-2.5" stroke="currentColor" fill="none" strokeWidth={1.5}>
                      <polyline points={pointsStr} />
                    </svg>
                  );
                })()}
              </div>
            </div>

            {/* Card 2: SPR Runway Lost */}
            <div className="card p-5 flex justify-between items-start gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">SPR runway lost</span>
                <span className="text-2xl font-bold font-mono tracking-tight text-slate-800">
                  {sprDelta.toFixed(1)} d
                </span>
                <span className="text-[10px] text-slate-400 font-semibold">
                  {result.projected.sprCoverDays.toFixed(1)} remaining
                </span>
              </div>
              <div className="flex flex-col items-end justify-start py-0.5">
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700 border border-red-200">
                  ▲ {sprDelta.toFixed(1)} d
                </span>
              </div>
            </div>

            {/* Card 3: GDP Impact */}
            <div className="card p-5 flex justify-between items-start gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">GDP impact</span>
                <span className="text-2xl font-bold font-mono tracking-tight text-slate-850">
                  {result.projected.gdpImpactBps.toFixed(0)} bps
                </span>
                <span className="text-[10px] text-slate-400 font-semibold">
                  vs. baseline trajectory
                </span>
              </div>
              <div className="flex flex-col items-end justify-start py-0.5">
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700 border border-red-200">
                  ▼ {result.projected.gdpImpactBps.toFixed(0)} bps
                </span>
              </div>
            </div>

            {/* Card 4: Inflation Impact */}
            <div className="card p-5 flex justify-between items-start gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Inflation impact</span>
                <span className="text-2xl font-bold font-mono tracking-tight text-slate-850">
                  {result.projected.inflationImpactBps.toFixed(0)} bps
                </span>
                <span className="text-[10px] text-slate-400 font-semibold">
                  WPI / CPI passthrough
                </span>
              </div>
              <div className="flex flex-col items-end justify-start py-0.5">
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700 border border-red-200">
                  ▼ {result.projected.inflationImpactBps.toFixed(0)} bps
                </span>
              </div>
            </div>
          </section>

          {/* Side-by-side Charts Grid */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="card p-5">
              <h3 className="mb-3 text-xs font-bold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider">Cascade Timeline</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#f1f5f9" strokeDasharray="3 3" />
                    <XAxis dataKey="day" stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis yAxisId="usd" stroke="#d97706" tick={{ fill: '#d97706', fontSize: 10 }} />
                    <YAxis yAxisId="mb" orientation="right" stroke="#4f46e5" tick={{ fill: '#4f46e5', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 11, color: '#334155' }}
                      labelStyle={{ color: '#64748b' }}
                    />
                    <Line yAxisId="usd" type="monotone" dataKey="brent" name="Brent (USD)" stroke="#d97706" strokeWidth={2} dot={false} />
                    <Line yAxisId="mb" type="monotone" dataKey="sprDraw" name="SPR daily draw (MB)" stroke="#4f46e5" strokeWidth={2} dot={false} />
                    <Line yAxisId="mb" type="monotone" dataKey="capeRoute" name="Cape rerouting (%)" stroke="#059669" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="card p-5">
              <h3 className="text-xs font-bold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider">
                Sector Trajectory Under Shock
              </h3>
              <p className="mb-3 text-[9px] text-slate-400 font-semibold uppercase tracking-wider">
                Refinery run rate, domestic diesel price, power-sector stress, and GDP growth over the disruption window.
              </p>
              <div className="h-60 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trajectoryData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#f1f5f9" strokeDasharray="3 3" />
                    <XAxis dataKey="day" stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis yAxisId="pct" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} domain={[0, 110]} />
                    <YAxis yAxisId="gdp" orientation="right" stroke="#059669" tick={{ fill: '#059669', fontSize: 10 }} domain={[5, 7]} />
                    <Tooltip
                      contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 11, color: '#334155' }}
                      labelStyle={{ color: '#64748b' }}
                    />
                    <ReferenceLine
                      yAxisId="gdp"
                      y={6.5}
                      stroke="#059669"
                      strokeOpacity={0.4}
                      strokeDasharray="2 4"
                      label={{ value: 'GDP trend 6.5%', position: 'insideTopRight', fill: '#059669', fontSize: 9 }}
                    />
                    <Line yAxisId="pct" type="monotone" dataKey="refinery" name="Refinery run rate (%)" stroke="#2563eb" strokeWidth={2} dot={false} />
                    <Line yAxisId="pct" type="monotone" dataKey="power" name="Power stress index" stroke="#ea580c" strokeWidth={2} dot={false} />
                    <Line yAxisId="pct" type="monotone" dataKey="diesel" name="Diesel (Rs/L)" stroke="#d97706" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                    <Line yAxisId="gdp" type="monotone" dataKey="gdp" name="GDP growth (%)" stroke="#059669" strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {cost && <CostStrip cost={cost} />}

          <NarrativeFeed
            title="Analyst narrative"
            body={result.recommendations.join('\n\n')}
            generatedAt={result.generatedAt}
            model="gemini-2.5-flash"
          />

          {sourcing.length > 0 && meta && (
            <section className="card overflow-hidden">
              <div className="border-b border-slate-200 px-5 py-4 bg-slate-50">
                <h3 className="text-sm font-bold text-slate-800">
                  Alternative Sources for {COMMODITY_LABEL[meta.primary_commodity]}
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="table-op">
                  <thead>
                    <tr>
                      <th className="px-4 py-2 text-left">Rank</th>
                      <th className="px-4 py-2 text-left">Supplier / Country</th>
                      <th className="px-4 py-2 text-right">Volume ({meta ? commodityUnitShort(meta.primary_commodity) : ''})</th>
                      <th className="px-4 py-2 text-right">Lead Time</th>
                      <th className="px-4 py-2 text-right">Risk</th>
                      <th className="px-4 py-2 text-left">Sanctions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sourcing.slice(0, 6).map((s) => (
                      <tr key={`${s.supplier}-${s.country}`} className="border-t border-slate-100 hover:bg-slate-50/50">
                        <td className="px-4 py-3 text-slate-400 font-mono font-bold text-xs">{s.rank}</td>
                        <td className="px-4 py-3">
                          <div className="text-slate-850 font-bold">{s.supplier}</div>
                          <div className="text-[10px] text-slate-400 font-semibold">{s.country}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">{fmtNumber(s.volumeMb, 1)}</td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">{s.leadTimeDays} d</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-slate-850">{s.routeRiskScore.toFixed(0)}</td>
                        <td className="px-4 py-3 text-xs font-semibold">
                          <span
                            className={
                              s.sanctionsCheck === 'clear'
                                ? 'text-emerald-600'
                                : s.sanctionsCheck === 'flag'
                                  ? 'text-amber-600'
                                  : 'text-red-650'
                            }
                          >
                            {s.sanctionsCheck}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-slate-100 px-5 py-3.5 text-[10px] text-slate-400 font-semibold bg-slate-50/50">
                Sourcing intelligence ranks alternatives by current risk, historical share, and lead-time. Refinery compatibility is NOT validated.
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
