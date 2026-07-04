import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getScenarios,
  runScenarioByName,
  type ScenarioMeta,
} from '@/lib/api';
import { COMMODITY_LABEL, CORRIDOR_LABEL, type ScenarioResult } from '@/lib/types';

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
      return `${sign}$${Math.abs(delta).toFixed(2)}`;
  }
}

function dirColor(dir: Direction): string {
  if (dir === 'worse') return 'text-red-300';
  if (dir === 'better') return 'text-emerald-300';
  return 'text-slate-500';
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
    <div className="grid grid-cols-[1fr,140px,140px] items-baseline gap-3 border-b border-slate-800 py-3">
      <span className="text-xs uppercase tracking-wider text-slate-400">{label}</span>
      <span className="text-right font-mono tabular-nums text-slate-200">
        {a.toFixed(format === 'bps' ? 0 : 2)}
        {unit && <span className="ml-1 text-[10px] text-slate-500">{unit}</span>}
      </span>
      <div className="text-right">
        <span className="font-mono tabular-nums text-slate-200">
          {b.toFixed(format === 'bps' ? 0 : 2)}
          {unit && <span className="ml-1 text-[10px] text-slate-500">{unit}</span>}
        </span>
        <div className={`text-[11px] font-mono ${dirColor(d.dir)}`}>{fmtDelta(d.delta, format)}</div>
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
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Comparison</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-100">Scenario A vs scenario B</h1>
        <p className="mt-1 text-xs text-slate-400">
          Run two scenarios side by side. Deltas computed B − A. Red = worse, green = better.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">Scenario A</label>
          <select
            value={a}
            onChange={(e) => setA(e.target.value)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          >
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
          {metaA && (
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                {COMMODITY_LABEL[metaA.primary_commodity]}
              </span>
              <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                {CORRIDOR_LABEL[metaA.primary_corridor]}
              </span>
            </div>
          )}
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">Scenario B</label>
          <select
            value={b}
            onChange={(e) => setB(e.target.value)}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
          >
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
          {metaB && (
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                {COMMODITY_LABEL[metaB.primary_commodity]}
              </span>
              <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                {CORRIDOR_LABEL[metaB.primary_corridor]}
              </span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>
      )}

      {loading && !resultA && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-500">
          Running both scenarios...
        </div>
      )}

      {resultA && resultB && (
        <div className="rounded-lg border border-slate-800 bg-slate-900">
          <div className="grid grid-cols-[1fr,140px,140px] gap-3 border-b border-slate-800 px-4 py-2 text-[10px] uppercase tracking-wider text-slate-500">
            <span>Metric</span>
            <span className="text-right">A</span>
            <span className="text-right">B</span>
          </div>
          <div className="px-4">
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
              unit="M"
            />
          </div>
        </div>
      )}
    </div>
  );
}
