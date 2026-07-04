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
  low: 'bg-emerald-500/15',
  elevated: 'bg-amber-500/15',
  high: 'bg-orange-500/20',
  critical: 'bg-red-500/25',
};

const SEVERITY_TEXT: Record<string, string> = {
  low: 'text-emerald-200',
  elevated: 'text-amber-200',
  high: 'text-orange-200',
  critical: 'text-red-200',
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
      const score = (sev: string) => ({ critical: 4, high: 3, elevated: 2, low: 1 }[sev] ?? 0);
      return score(c.severity) > score(acc.severity) ? c : acc;
    });
  }, [cells]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Matrix</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-100">Stress test</h1>
          <p className="mt-1 text-xs text-slate-400">
            Every scenario × intensity × duration. {cells.length} projections.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] uppercase tracking-wider text-slate-500">Colour by</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200"
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
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>
      )}

      {cells.length === 0 && !error && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-500">
          Loading matrix...
        </div>
      )}

      {cells.length > 0 && (
        <div className="overflow-auto rounded-lg border border-slate-800 bg-slate-900">
          <table className="w-full text-xs">
            <thead className="bg-slate-900/80 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="sticky left-0 z-10 bg-slate-900/80 px-3 py-3 text-left">Scenario</th>
                {intensities.flatMap((i) =>
                  durations.map((d) => (
                    <th key={`${i}-${d}`} className="px-3 py-3 text-center font-mono">
                      <div className="text-slate-300">i={i.toFixed(2)}</div>
                      <div className="text-slate-500">{d}d</div>
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((scenario) => (
                <tr key={scenario} className="border-t border-slate-800">
                  <td className="sticky left-0 z-10 bg-slate-900 px-3 py-2 text-slate-200">
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
                            className={`rounded border border-slate-800 px-2 py-1.5 font-mono tabular-nums text-center ${SEVERITY_BG[c.severity] ?? ''} ${SEVERITY_TEXT[c.severity] ?? 'text-slate-300'} ${isWorst ? 'ring-1 ring-indigo-500' : ''}`}
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
      )}

      {worst && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-4 text-sm text-indigo-200">
          <span className="font-semibold">Worst-case cell:</span> {worst.scenarioId.replace(/_/g, ' ')} at
          intensity {worst.intensity}, {worst.durationDays}-day horizon → GDP{' '}
          {worst.gdpImpactBps.toFixed(0)} bps, ₹{worst.costInrCrore.toFixed(0)} crore.
        </div>
      )}
    </div>
  );
}
