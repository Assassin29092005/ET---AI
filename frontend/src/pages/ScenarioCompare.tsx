import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getScenarios,
  runScenarioByName,
  type ScenarioMeta,
} from '@/lib/api';
import { CORRIDOR_LABEL, type ScenarioResult } from '@/lib/types';

type Direction = 'better' | 'worse' | 'flat';

function deltaInfo(a: number, b: number, lowerIsBetter = true): { delta: number; pct: number; dir: Direction } {
  const delta = b - a;
  const pct = a !== 0 ? (delta / a) * 100 : 0;
  let dir: Direction = 'flat';
  if (Math.abs(delta) > 0.001) {
    const worse = lowerIsBetter ? delta > 0 : delta < 0;
    dir = worse ? 'worse' : 'better';
  }
  return { delta, pct, dir };
}

function fmtDelta(delta: number, format: 'pct' | 'bps' | 'days' | 'usd'): string {
  const sign = delta >= 0 ? '+' : '';
  switch (format) {
    case 'pct':
      return `${sign}${delta.toFixed(1)} pp`;
    case 'bps':
      return `${sign}${delta.toFixed(0)} bps`;
    case 'days':
      return `${sign}${delta.toFixed(1)} d`;
    case 'usd':
      return `$${Math.abs(delta).toFixed(2)}`;
  }
}

function dirColor(dir: Direction, format: 'pct' | 'bps' | 'days' | 'usd'): string {
  if (format === 'usd') return 'text-amber-600 font-bold';
  if (dir === 'worse') return 'text-red-600 font-bold';
  if (dir === 'better') return 'text-emerald-600 font-bold';
  return 'text-slate-450 font-semibold';
}

function MetricRow({
  label,
  a,
  b,
  format,
  lowerIsBetter = true,
  unit = '',
}: {
  label: string;
  a: number;
  b: number;
  format: 'pct' | 'bps' | 'days' | 'usd';
  lowerIsBetter?: boolean;
  unit?: string;
}) {
  const d = deltaInfo(a, b, lowerIsBetter);
  return (
    <div className="grid grid-cols-[1fr,140px,140px] items-center gap-3 border-b border-slate-100 py-3.5 px-5 hover:bg-slate-50/50 transition-colors">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <span className="text-right font-mono tabular-nums text-slate-800 font-bold text-sm">
        {a.toFixed(format === 'bps' ? 0 : 2)}
        {unit && <span className="ml-1 text-[10px] text-slate-400 font-semibold lowercase font-sans">{unit}</span>}
      </span>
      <div className="text-right">
        <span className="font-mono tabular-nums text-slate-800 font-bold text-sm">
          {b.toFixed(format === 'bps' ? 0 : 2)}
          {unit && <span className="ml-1 text-[10px] text-slate-400 font-semibold lowercase font-sans">{unit}</span>}
        </span>
        <div className={`text-[10px] font-mono mt-0.5 ${dirColor(d.dir, format)}`}>
          {fmtDelta(d.delta, format)}
        </div>
      </div>
    </div>
  );
}

export default function ScenarioCompare() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [a, setA] = useState<string>(searchParams.get('a') ?? 'hormuz_partial_closure');
  const [b, setB] = useState<string>(searchParams.get('b') ?? 'red_sea_suspension');
  const [resultA, setResultA] = useState<ScenarioResult | null>(null);
  const [resultB, setResultB] = useState<ScenarioResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getScenarios().then(setScenarios).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSearchParams({ a, b }, { replace: true });
    Promise.all([runScenarioByName(a), runScenarioByName(b)])
      .then(([ra, rb]) => {
        if (cancelled) return;
        setResultA(ra);
        setResultB(rb);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to run scenarios');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [a, b, setSearchParams]);

  const metaA = scenarios.find((s) => s.name === a);
  const metaB = scenarios.find((s) => s.name === b);

  return (
    <div className="flex flex-col gap-6">
      {/* Header section matching image */}
      <header>
        <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Comparison</p>
        <h1 className="mt-1 text-2xl font-bold text-white leading-tight">Scenario Comparison</h1>
        <p className="mt-1.5 text-xs text-slate-400 font-medium">
          Run two scenarios side by side. Deltas computed B - A. Red = worse, green = better.
        </p>
      </header>

      {/* Scenario selection cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Scenario A Card */}
        <div className="card p-5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Scenario A</label>
          <select
            value={a}
            onChange={(e) => setA(e.target.value)}
            className="mt-1.5 w-full input-op font-medium"
          >
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
          {metaA && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shrink-0" />
              <span className="rounded bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700 shadow-sm">
                {CORRIDOR_LABEL[metaA.primary_corridor] ?? metaA.primary_corridor}
              </span>
            </div>
          )}
        </div>

        {/* Scenario B Card */}
        <div className="card p-5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Scenario B</label>
          <select
            value={b}
            onChange={(e) => setB(e.target.value)}
            className="mt-1.5 w-full input-op font-medium"
          >
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
          {metaB && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500 shrink-0" />
              <span className="rounded bg-red-50 border border-red-200 px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-700 shadow-sm">
                {CORRIDOR_LABEL[metaB.primary_corridor] ?? metaB.primary_corridor}
              </span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">{error}</div>
      )}

      {loading && !resultA && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-450 font-medium shadow-sm">
          Running comparison...
        </div>
      )}

      {resultA && resultB && (
        /* Full-Width Metrics Comparison Table */
        <div className="card overflow-hidden">
          <div className="grid grid-cols-[1fr,140px,140px] gap-3 border-b border-slate-200 px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-50">
            <span>Metric</span>
            <span className="text-right">A</span>
            <span className="text-right">B</span>
          </div>
          <div className="bg-white">
            <MetricRow
              label="Brent projected"
              a={resultA.projected.brentUsd}
              b={resultB.projected.brentUsd}
              format="usd"
              unit="/bbl"
            />
            <MetricRow
              label="SPR cover days"
              a={resultA.projected.sprCoverDays}
              b={resultB.projected.sprCoverDays}
              format="days"
              lowerIsBetter={false}
            />
            <MetricRow
              label="GDP impact"
              a={resultA.projected.gdpImpactBps}
              b={resultB.projected.gdpImpactBps}
              format="bps"
            />
            <MetricRow
              label="Inflation impact"
              a={resultA.projected.inflationImpactBps}
              b={resultB.projected.inflationImpactBps}
              format="bps"
            />
            <MetricRow
              label="Import cost"
              a={resultA.projected.importCostUsdM}
              b={resultB.projected.importCostUsdM}
              format="usd"
              unit="m"
            />
          </div>
        </div>
      )}
    </div>
  );
}
