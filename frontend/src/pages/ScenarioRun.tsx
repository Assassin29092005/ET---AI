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
import { commodityUnitShort, fmtNumber, fmtTime } from '@/lib/fmt';
import CommodityBadge from '@/components/CommodityBadge';
import ImpactBar from '@/components/ImpactBar';
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

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Scenario</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-100">
            {meta?.label ?? name}
          </h1>
          {meta && (
            <div className="mt-2 flex items-center gap-2">
              <CommodityBadge commodity={meta.primary_commodity} size="md" />
              <span className="rounded border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                {CORRIDOR_LABEL[meta.primary_corridor] ?? meta.primary_corridor}
              </span>
            </div>
          )}
        </div>
        <div className="text-right">
          <button
            type="button"
            className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:border-indigo-500 hover:text-slate-100"
            onClick={() => navigate('/twin')}
          >
            Back to digital twin
          </button>
          {result && (
            <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-500">
              Run {fmtTime(result.generatedAt)}
            </div>
          )}
        </div>
      </header>

      {meta && (
        <p className="text-sm text-slate-400">{meta.description}</p>
      )}

      {loading && !result && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-500">
          Running scenario...
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {result && (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <ImpactBar
              label="Brent uplift"
              value={brentUplift}
              max={50}
              format="pct"
              sub={`$${result.baseline.brentUsd.toFixed(2)} → $${result.projected.brentUsd.toFixed(2)}`}
            />
            <ImpactBar
              label="SPR runway lost"
              value={sprDelta}
              max={result.baseline.sprCoverDays}
              format="days"
              sub={`${result.projected.sprCoverDays.toFixed(1)} d remaining`}
            />
            <ImpactBar
              label="GDP impact"
              value={result.projected.gdpImpactBps}
              max={120}
              format="bps"
              positiveIsBad={false}
              sub="vs. baseline trajectory"
            />
            <ImpactBar
              label="Inflation impact"
              value={result.projected.inflationImpactBps}
              max={120}
              format="bps"
              sub="WPI / CPI passthrough"
            />
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-100">Cascade timeline</h3>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="day" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <YAxis yAxisId="usd" stroke="#fbbf24" tick={{ fill: '#fbbf24', fontSize: 11 }} />
                  <YAxis yAxisId="mb" orientation="right" stroke="#818cf8" tick={{ fill: '#818cf8', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Line yAxisId="usd" type="monotone" dataKey="brent" name="Brent (USD)" stroke="#fbbf24" strokeWidth={2} dot={false} />
                  <Line yAxisId="mb" type="monotone" dataKey="sprDraw" name="SPR daily draw (MB)" stroke="#818cf8" strokeWidth={2} dot={false} />
                  <Line yAxisId="mb" type="monotone" dataKey="capeRoute" name="Cape rerouting (%)" stroke="#34d399" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h3 className="mb-1 text-sm font-semibold text-slate-100">
              Sector trajectory under the shock
            </h3>
            <p className="mb-3 text-[11px] text-slate-500">
              Refinery run rate, domestic diesel price, power-sector stress, and GDP growth over the
              disruption window.
            </p>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trajectoryData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="day" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <YAxis yAxisId="pct" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} domain={[0, 110]} />
                  <YAxis yAxisId="gdp" orientation="right" stroke="#34d399" tick={{ fill: '#34d399', fontSize: 11 }} domain={[5, 7]} />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <ReferenceLine
                    yAxisId="gdp"
                    y={6.5}
                    stroke="#34d399"
                    strokeOpacity={0.4}
                    strokeDasharray="2 4"
                    label={{ value: 'GDP trend 6.5%', position: 'insideTopRight', fill: '#34d399', fontSize: 10 }}
                  />
                  <Line yAxisId="pct" type="monotone" dataKey="refinery" name="Refinery run rate (%)" stroke="#60a5fa" strokeWidth={2} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="power" name="Power stress index" stroke="#f97316" strokeWidth={2} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="diesel" name="Diesel (Rs/L)" stroke="#fbbf24" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                  <Line yAxisId="gdp" type="monotone" dataKey="gdp" name="GDP growth (%)" stroke="#34d399" strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {cost && <CostStrip cost={cost} />}

          <NarrativeFeed
            title="Analyst narrative"
            body={result.recommendations.join('\n\n')}
            generatedAt={result.generatedAt}
            model="gemini-2.5-flash"
          />

          {sourcing.length > 0 && meta && (
            <section className="rounded-lg border border-slate-800 bg-slate-900">
              <div className="border-b border-slate-800 px-5 py-3">
                <h3 className="text-sm font-semibold text-slate-100">
                  Alternative sources for {COMMODITY_LABEL[meta.primary_commodity]}
                </h3>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-900/50 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Rank</th>
                    <th className="px-4 py-2 text-left">Supplier / country</th>
                    <th className="px-4 py-2 text-right">Volume {meta ? commodityUnitShort(meta.primary_commodity) : ''}</th>
                    <th className="px-4 py-2 text-right">Lead time</th>
                    <th className="px-4 py-2 text-right">Risk</th>
                    <th className="px-4 py-2 text-left">Sanctions</th>
                  </tr>
                </thead>
                <tbody>
                  {sourcing.slice(0, 6).map((s) => (
                    <tr key={`${s.supplier}-${s.country}`} className="border-t border-slate-800">
                      <td className="px-4 py-2 text-slate-300">{s.rank}</td>
                      <td className="px-4 py-2 text-slate-200">
                        <div>{s.supplier}</div>
                        <div className="text-[11px] text-slate-500">{s.country}</div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">{fmtNumber(s.volumeMb, 1)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">{s.leadTimeDays} d</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">{s.routeRiskScore.toFixed(0)}</td>
                      <td className="px-4 py-2">
                        <span
                          className={
                            s.sanctionsCheck === 'clear'
                              ? 'text-emerald-300'
                              : s.sanctionsCheck === 'flag'
                                ? 'text-amber-300'
                                : 'text-red-300'
                          }
                        >
                          {s.sanctionsCheck}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-slate-800 px-5 py-2 text-[11px] text-slate-500">
                Sourcing intelligence ranks alternatives by current risk, historical share, and lead-time. Refinery compatibility is NOT validated.
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
