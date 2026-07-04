import { useEffect, useMemo, useState } from 'react';
import { getStressTest, type StressTestCell } from '@/lib/api';

type Metric = 'gdpImpactBps' | 'brentUpliftPct' | 'sprRunwayDays' | 'costInrCrore';

const METRIC_LABELS: Record<Metric, string> = {
  gdpImpactBps: 'GDP impact (bps)',
  brentUpliftPct: 'Brent uplift (%)',
  sprRunwayDays: 'SPR runway (days)',
  costInrCrore: 'Cost (₹ crore)',
};

const SEVERITY_BG: Record<string, string> = {
  low: 'bg-emerald-50 border-emerald-200/80',
  elevated: 'bg-amber-50 border-amber-200/80',
  high: 'bg-orange-55/20 border-orange-200/80 bg-orange-50',
  critical: 'bg-red-50 border-red-200/80',
};

const SEVERITY_TEXT: Record<string, string> = {
  low: 'text-emerald-700 font-bold',
  elevated: 'text-amber-700 font-bold',
  high: 'text-orange-700 font-bold',
  critical: 'text-red-700 font-bold',
};

function formatValue(v: number, m: Metric): string {
  if (m === 'gdpImpactBps') return `${v >= 0 ? '+' : ''}${v.toFixed(0)}`;
  if (m === 'brentUpliftPct') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  if (m === 'sprRunwayDays') return `${v.toFixed(1)}d`;
  return `₹${v.toFixed(0)}`;
}

export default function StressTest() {
  const [cells, setCells] = useState<StressTestCell[]>([]);
  const [metric, setMetric] = useState<Metric>('gdpImpactBps');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStressTest()
      .then(setCells)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load stress test'));
  }, []);

  const scenarios = useMemo(() => Array.from(new Set(cells.map((c) => c.scenarioId))), [cells]);
  const intensities = useMemo(
    () => Array.from(new Set(cells.map((c) => c.intensity))).sort((a, b) => a - b),
    [cells],
  );
  const durations = useMemo(
    () => Array.from(new Set(cells.map((c) => c.durationDays))).sort((a, b) => a - b),
    [cells],
  );

  const cellMap = useMemo(() => {
    const m = new Map<string, StressTestCell>();
    cells.forEach((c) => m.set(`${c.scenarioId}|${c.intensity}|${c.durationDays}`, c));
    return m;
  }, [cells]);

  const worst = useMemo(() => {
    if (cells.length === 0) return null;
    return cells.reduce((acc, c) => {
      const score = (accSec: string) => ({ critical: 4, high: 3, elevated: 2, low: 1 }[accSec] ?? 0);
      return score(c.severity) > score(acc.severity) ? c : acc;
    });
  }, [cells]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header section matching image */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Stress Analysis</p>
          <h1 className="mt-1 text-2xl font-bold text-white leading-tight">Stress Matrix</h1>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Colour By</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
            className="input-op font-medium min-w-[150px]"
          >
            {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
              <option key={m} value={m}>
                {METRIC_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">{error}</div>
      )}

      {cells.length === 0 && !error && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-450 font-medium shadow-sm">
          Loading matrix...
        </div>
      )}

      {cells.length > 0 && (
        <>
          {/* Stress Matrix Table Grid */}
          <div className="overflow-auto card">
            <table className="table-op text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-50 border-r border-slate-200/80 px-3 py-3 text-left font-bold text-slate-500">Scenario</th>
                  {intensities.flatMap((i) =>
                    durations.map((d) => (
                      <th key={`${i}-${d}`} className="px-3 py-3 text-center font-mono text-[9px] font-bold text-slate-400">
                        <div>I={i.toFixed(2)}</div>
                        <div className="mt-0.5">{d}D</div>
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {scenarios.map((scenario) => (
                  <tr key={scenario} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="sticky left-0 z-10 bg-white border-r border-slate-200/80 px-4 py-3 text-slate-800 font-bold capitalize whitespace-nowrap">
                      {scenario.replace(/_/g, ' ')}
                    </td>
                    {intensities.flatMap((intensity) =>
                      durations.map((duration) => {
                        const c = cellMap.get(`${scenario}|${intensity}|${duration}`);
                        if (!c) return <td key={`${intensity}-${duration}`} className="px-3 py-2"></td>;
                        const isWorst = worst && c === worst;
                        return (
                          <td key={`${intensity}-${duration}`} className="px-1 py-1">
                            <div
                              title={`Brent ${c.brentUpliftPct.toFixed(1)}% | GDP ${c.gdpImpactBps.toFixed(0)} bps | SPR ${c.sprRunwayDays.toFixed(1)}d | ₹${c.costInrCrore.toFixed(0)} cr`}
                              className={`rounded border px-2.5 py-1.5 font-mono tabular-nums text-center text-xs ${SEVERITY_BG[c.severity] ?? ''} ${SEVERITY_TEXT[c.severity] ?? 'text-slate-600'} ${isWorst ? 'ring-2 ring-blue-600 font-extrabold shadow-sm' : ''}`}
                            >
                              {formatValue(c[metric] as number, metric)}
                            </div>
                          </td>
                        );
                      }),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Worst case alert pill */}
          {worst && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-700 font-semibold shadow-sm">
              <span className="font-bold text-blue-800 uppercase tracking-wider mr-2">Worst-case cell:</span>{' '}
              {worst.scenarioId.replace(/_/g, ' ')} at intensity {worst.intensity}, {worst.durationDays}-day → GDP{' '}
              {worst.gdpImpactBps.toFixed(0)} bps, ₹{worst.costInrCrore.toFixed(0)} crore.
            </div>
          )}

          {/* Bottom Cards Grid */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr,1.8fr]">
            {/* Top Risk Vectors Card */}
            <section className="card p-5">
              <h3 className="text-xs font-bold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider mb-4">
                Top Risk Vectors
              </h3>
              <div className="flex flex-col gap-4">
                {[
                  { name: 'China rare-earths', pct: 80, color: 'bg-blue-600' },
                  { name: 'Hormuz closure', pct: 40, color: 'bg-blue-600' },
                  { name: 'Indonesia-earths', pct: 30, color: 'bg-emerald-600' },
                  { name: 'China nickel', pct: 20, color: 'bg-orange-600' },
                  { name: 'Indriai.ieme', pct: 10, color: 'bg-amber-600' },
                ].map((item, idx) => (
                  <div key={item.name} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-xs font-bold">
                      <div className="flex items-center gap-2 text-slate-700">
                        <span className="text-slate-400">{idx + 1}</span>
                        <span>{item.name}</span>
                        <span className="rounded bg-slate-100 px-1 py-0.5 text-[8px] font-bold text-slate-450 uppercase tracking-wider border border-slate-200">
                          upper-case
                        </span>
                      </div>
                      <span className="font-mono text-slate-800">{item.pct}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full ${item.color} rounded-full`} style={{ width: `${item.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Scenario Cascade Timeline Node Flow Chart */}
            <section className="card p-5">
              <h3 className="text-xs font-bold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider mb-6">
                Scenario Cascade Timeline
              </h3>
              <div className="flex flex-col gap-8 py-2">
                {/* Row 1 */}
                <div className="grid grid-cols-[1.5fr,auto,1.2fr,auto,1.2fr] items-center gap-4">
                  <span className="text-xs font-bold text-slate-750">Simulate alternative sourcing</span>
                  <svg className="h-4 w-6 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                  <div className="rounded-lg bg-blue-600 px-3 py-2 text-center text-xs font-bold text-white shadow-sm">
                    Gunor step-labels
                  </div>
                  <svg className="h-4 w-6 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                  <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-center text-xs font-bold text-slate-600 shadow-sm">
                    Genr step-labels
                  </div>
                </div>

                {/* Split Row 2 & 3 */}
                <div className="grid grid-cols-[1.5fr,auto,1fr] items-center gap-4">
                  <span className="text-xs font-bold text-slate-750">Mitigatng specific critical risks</span>
                  
                  {/* Branching SVG Arrow */}
                  <div className="flex justify-center items-center">
                    <svg className="h-20 w-8 text-slate-300" fill="none" viewBox="0 0 32 80" stroke="currentColor">
                      {/* Top branch line */}
                      <path d="M0,40 C10,40 10,15 20,15 L26,15" strokeWidth={2} />
                      <path d="M26,12 L30,15 L26,18 Z" fill="currentColor" />
                      {/* Middle straight line */}
                      <path d="M0,40 L26,40" strokeWidth={2} />
                      <path d="M26,37 L30,40 L26,43 Z" fill="currentColor" />
                      {/* Bottom branch line */}
                      <path d="M0,40 C10,40 10,65 20,65 L26,65" strokeWidth={2} />
                      <path d="M26,62 L30,65 L26,68 Z" fill="currentColor" />
                    </svg>
                  </div>

                  {/* Flow destinations stacked */}
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-[1.2fr,auto,1.2fr] items-center gap-4">
                      <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-center text-xs font-bold text-slate-650 shadow-sm">
                        Refinary labels
                      </div>
                      <svg className="h-4 w-6 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                      </svg>
                      <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-center text-xs font-bold text-slate-600 shadow-sm">
                        Suep-labels
                      </div>
                    </div>

                    <div className="grid grid-cols-[1.2fr,auto,1.2fr] items-center gap-4">
                      <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-center text-xs font-bold text-slate-650 shadow-sm">
                        Refinary labels
                      </div>
                      <svg className="h-4 w-6 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                      </svg>
                      <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-center text-xs font-bold text-slate-600 shadow-sm">
                        Step-labels
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
