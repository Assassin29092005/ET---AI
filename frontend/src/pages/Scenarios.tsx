import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getScenarios,
  runScenarioByName,
  type ScenarioMeta,
} from '@/lib/api';
import {
  COMMODITY_LABEL,
  CORRIDOR_LABEL,
  type ScenarioResult,
} from '@/lib/types';

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


function MarketMetricRow({
  label,
  a,
  b,
  format,
  unit = '',
}: {
  label: string;
  a: number;
  b: number;
  format: 'pct' | 'bps' | 'days' | 'usd';
  unit?: string;
}) {
  const maxVal = Math.max(Math.abs(a), Math.abs(b), 1);
  const wA = Math.min(100, Math.max(10, (Math.abs(a) / maxVal) * 100));
  const wB = Math.min(100, Math.max(10, (Math.abs(b) / maxVal) * 100));

  return (
    <div className="grid grid-cols-[1fr,120px,100px,100px] items-center gap-3 border-b border-slate-100 py-3 px-1 hover:bg-slate-50/50 transition-colors">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      {/* Visual compare bars */}
      <div className="flex items-center gap-1 w-full justify-center">
        <div className="flex items-center justify-end w-12">
          <div className="h-3 bg-emerald-500 rounded-l" style={{ width: `${wA}%` }} />
        </div>
        <div className="flex items-center justify-start w-12">
          <div className="h-3 bg-blue-600 rounded-r" style={{ width: `${wB}%` }} />
        </div>
      </div>
      <span className="text-right font-mono tabular-nums text-slate-800 font-bold text-xs">
        {a.toFixed(format === 'bps' ? 0 : 2)}
        {unit && <span className="ml-0.5 text-[9px] text-slate-400 font-semibold">{unit}</span>}
      </span>
      <span className="text-right font-mono tabular-nums text-slate-800 font-bold text-xs">
        {b.toFixed(format === 'bps' ? 0 : 2)}
        {unit && <span className="ml-0.5 text-[9px] text-slate-400 font-semibold">{unit}</span>}
      </span>
    </div>
  );
}

function MacroMetricRow({
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
    <div className="grid grid-cols-[1fr,120px,100px,100px] items-center gap-3 border-b border-slate-100 py-3 px-1 hover:bg-slate-50/50 transition-colors">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      {/* Better/Worse tags */}
      <div className="flex items-center gap-1.5 justify-center">
        {d.dir === 'better' && (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 border border-emerald-200">Better</span>
        )}
        {d.dir === 'worse' && (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700 border border-red-200">Worse</span>
        )}
        {d.dir === 'flat' && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500 border border-slate-200">Flat</span>
        )}
      </div>
      <span className="text-right font-mono tabular-nums text-slate-800 font-bold text-xs">
        {a.toFixed(format === 'bps' ? 0 : 2)}
        {unit && <span className="ml-0.5 text-[9px] text-slate-400 font-semibold">{unit}</span>}
      </span>
      <div className="text-right">
        <span className="font-mono tabular-nums text-slate-800 font-bold text-xs">
          {b.toFixed(format === 'bps' ? 0 : 2)}
          {unit && <span className="ml-0.5 text-[9px] text-slate-400 font-semibold">{unit}</span>}
        </span>
      </div>
    </div>
  );
}

export default function Scenarios() {
  const [items, setItems] = useState<ScenarioMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Comparison State
  const [a, setA] = useState<string>('hormuz_partial_closure');
  const [b, setB] = useState<string>('red_sea_suspension');
  const [resultA, setResultA] = useState<ScenarioResult | null>(null);
  const [resultB, setResultB] = useState<ScenarioResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getScenarios()
      .then((data) => {
        if (!cancelled) {
          setItems(data);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load scenarios');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runCompare = () => {
    setCompareLoading(true);
    setCompareError(null);
    Promise.all([runScenarioByName(a), runScenarioByName(b)])
      .then(([ra, rb]) => {
        setResultA(ra);
        setResultB(rb);
      })
      .catch((e) => {
        setCompareError(e instanceof Error ? e.message : 'Failed to compare scenarios');
      })
      .finally(() => {
        setCompareLoading(false);
      });
  };

  // Run initial comparison when items are loaded
  useEffect(() => {
    if (items.length > 0 && !resultA) {
      runCompare();
    }
  }, [items]);

  const metaA = items.find((s) => s.name === a);
  const metaB = items.find((s) => s.name === b);

  const scrollToCompare = () => {
    document.getElementById('compare-center')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Explore Risk Scenarios Header */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Explore Risk Scenarios</p>
          <h1 className="mt-1 text-2xl font-bold text-white leading-tight">7 Named Disruptions</h1>
          <p className="mt-1 text-xs text-slate-400 font-medium">
            7 Named Disruptions (Crude, LNG, Coking Coal, Critical Minerals, Solar PV, Uranium)
          </p>
        </div>
        <button
          onClick={scrollToCompare}
          className="btn-accent px-4 py-2 font-semibold bg-blue-600 border-blue-600 text-white hover:bg-blue-700 text-xs shadow-sm flex items-center"
        >
          Compare Scenarios →
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">
          {error}
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-400 font-medium shadow-sm">
          Loading scenarios...
        </div>
      )}

      {/* Disruption Cards Grid */}
      {!loading && items.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((s) => (
            <div key={s.name} className="group flex flex-col card p-4 hover:shadow-md transition-shadow">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <span className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  {COMMODITY_LABEL[s.primary_commodity] ?? s.primary_commodity}
                </span>
                <span className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">
                  {CORRIDOR_LABEL[s.primary_corridor] ?? s.primary_corridor}
                </span>
              </div>
              <h3 className="text-sm font-bold text-slate-800 leading-tight mb-2">{s.label}</h3>
              <p className="text-xs text-slate-500 leading-relaxed font-medium flex-1">{s.description}</p>
              <div className="mt-4 pt-2">
                <Link
                  to={`/scenarios/${s.name}`}
                  className="inline-block btn-accent px-4 py-2 text-xs font-semibold bg-blue-600 border-blue-600 text-white hover:bg-blue-700"
                >
                  Run Scenario →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Scenario Comparison Center */}
      <section id="compare-center" className="card p-5 mt-4 flex flex-col gap-5">
        <h2 className="text-xs font-bold text-slate-800 border-b border-slate-100 pb-2">Scenario Comparison Center</h2>
        
        {/* Selector Panel */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr,32px,1fr,120px] items-end">
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Scenario A</label>
            <select
              value={a}
              onChange={(e) => setA(e.target.value)}
              className="input-op w-full font-medium"
            >
              {items.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label}
                </option>
              ))}
            </select>
            {metaA && (
              <div className="text-[9px] font-bold uppercase text-slate-400 mt-1">
                {CORRIDOR_LABEL[metaA.primary_corridor] ?? metaA.primary_corridor}
              </div>
            )}
          </div>
          
          <div className="flex items-center justify-center h-[38px] text-[10px] font-bold text-slate-400 uppercase">
            VS
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Scenario B</label>
            <select
              value={b}
              onChange={(e) => setB(e.target.value)}
              className="input-op w-full font-medium"
            >
              {items.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label}
                </option>
              ))}
            </select>
            {metaB && (
              <div className="text-[9px] font-bold uppercase text-slate-400 mt-1">
                {CORRIDOR_LABEL[metaB.primary_corridor] ?? metaB.primary_corridor}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={runCompare}
            disabled={compareLoading}
            className="btn-accent h-[38px] flex items-center justify-center font-semibold bg-blue-600 border-blue-600 text-white hover:bg-blue-700 text-xs shadow-sm"
          >
            {compareLoading ? 'Comparing...' : 'Run Comparison'}
          </button>
        </div>

        {compareError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">
            {compareError}
          </div>
        )}

        {/* Side-by-side Results */}
        {resultA && resultB && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mt-2">
            {/* Market Impact */}
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 bg-slate-50">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Market Impact</h3>
                <div className="flex gap-10 text-[9px] font-bold uppercase text-slate-400">
                  <span className="w-12 text-center">Better</span>
                  <span className="w-12 text-center">Compare</span>
                  <span>A</span>
                  <span>B</span>
                </div>
              </div>
              <div className="p-3 bg-white flex flex-col gap-0.5">
                <MarketMetricRow
                  label="Brent projected"
                  a={resultA.projected.brentUsd}
                  b={resultB.projected.brentUsd}
                  format="usd"
                  unit="/bbl"
                />
                <MarketMetricRow
                  label="SPR cover days"
                  a={resultA.projected.sprCoverDays}
                  b={resultB.projected.sprCoverDays}
                  format="days"
                />
                <MarketMetricRow
                  label="GDP impact"
                  a={resultA.projected.gdpImpactBps}
                  b={resultB.projected.gdpImpactBps}
                  format="bps"
                />
                <MarketMetricRow
                  label="Inflation impact"
                  a={resultA.projected.inflationImpactBps}
                  b={resultB.projected.inflationImpactBps}
                  format="bps"
                />
                <MarketMetricRow
                  label="Import cost"
                  a={resultA.projected.importCostUsdM}
                  b={resultB.projected.importCostUsdM}
                  format="usd"
                  unit="m"
                />
              </div>
            </div>

            {/* Macro Impact */}
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 bg-slate-50">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Macro Impact</h3>
                <div className="flex gap-12 text-[9px] font-bold uppercase text-slate-400">
                  <span>Delta</span>
                  <span>A</span>
                  <span>B</span>
                </div>
              </div>
              <div className="p-3 bg-white flex flex-col gap-0.5">
                <MacroMetricRow
                  label="Brent projected"
                  a={resultA.projected.brentUsd}
                  b={resultB.projected.brentUsd}
                  format="usd"
                  unit="/bbl"
                />
                <MacroMetricRow
                  label="SPR cover days"
                  a={resultA.projected.sprCoverDays}
                  b={resultB.projected.sprCoverDays}
                  format="days"
                  lowerIsBetter={false}
                />
                <MacroMetricRow
                  label="GDP impact"
                  a={resultA.projected.gdpImpactBps}
                  b={resultB.projected.gdpImpactBps}
                  format="bps"
                />
                <MacroMetricRow
                  label="Inflation impact"
                  a={resultA.projected.inflationImpactBps}
                  b={resultB.projected.inflationImpactBps}
                  format="bps"
                />
                <MacroMetricRow
                  label="Import cost"
                  a={resultA.projected.importCostUsdM}
                  b={resultB.projected.importCostUsdM}
                  format="usd"
                  unit="m"
                />
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
