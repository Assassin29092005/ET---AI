import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  getScenarios,
  postCompoundScenario,
  type CompoundScenarioResult,
  type ScenarioMeta,
} from '@/lib/api';

interface RowInput {
  scenarioId: string;
  intensity: number;
  durationDays: number;
}

const DEFAULT_PICKS: RowInput[] = [
  { scenarioId: 'hormuz_partial_closure', intensity: 0.6, durationDays: 21 },
  { scenarioId: 'australia_coking_coal', intensity: 0.5, durationDays: 30 },
];

const ROW_COLORS = ['#fb923c', '#22d3ee', '#a78bfa', '#facc15'];

function metaName(m: ScenarioMeta): string {
  return (m.name ?? (m as { scenarioId?: string }).scenarioId ?? '') as string;
}

function metaLabel(m: ScenarioMeta): string {
  return m.label ?? (m as { name?: string }).name ?? '';
}

export default function CompoundScenarios() {
  const [catalogue, setCatalogue] = useState<ScenarioMeta[]>([]);
  const [picks, setPicks] = useState<RowInput[]>(DEFAULT_PICKS);
  const [result, setResult] = useState<CompoundScenarioResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getScenarios()
      .then((rows) => {
        if (!cancelled) setCatalogue(rows);
      })
      .catch(() => {
        // non-fatal — dropdowns just stay empty
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update(idx: number, patch: Partial<RowInput>) {
    setPicks((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addRow() {
    if (picks.length >= 4) return;
    const used = new Set(picks.map((p) => p.scenarioId));
    const next = catalogue.find((c) => !used.has(metaName(c)));
    setPicks((prev) => [
      ...prev,
      {
        scenarioId: metaName(next ?? catalogue[0] ?? ({ name: 'hormuz_partial_closure' } as ScenarioMeta)),
        intensity: 0.5,
        durationDays: 21,
      },
    ]);
  }
  function removeRow(idx: number) {
    if (picks.length <= 2) return;
    setPicks((prev) => prev.filter((_, i) => i !== idx));
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await postCompoundScenario({
        scenarios: picks.map((p) => ({
          name: p.scenarioId,
          intensity: p.intensity,
          duration_days: p.durationDays,
        })),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compound run failed.');
    } finally {
      setRunning(false);
    }
  }

  const timelineData = useMemo(() => {
    if (!result) return [];
    return result.timeline.map((t) => ({
      day: t.day,
      brent: t.brentUsd,
      refinery: t.refineryRunRatePct,
      diesel: t.dieselPriceInr,
      power: t.powerStressIndex,
      gdp: t.gdpGrowthPct,
    }));
  }, [result]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Innovation</p>
        <h1 className="mt-1 text-2xl font-bold text-white leading-tight">Compound Scenarios</h1>
        <p className="mt-1 max-w-3xl text-xs text-slate-400 font-medium">
          Stack 2-4 disruptions simultaneously to see compound shocks (e.g. Hormuz closure + Australia coking
          coal outage). Price uplifts add, refinery drop wins by max, SPR runway wins by min.
        </p>
      </header>

      <section className="card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-855 text-slate-800">Compose Shock Stack</h2>
          <button
            type="button"
            onClick={addRow}
            disabled={picks.length >= 4 || catalogue.length === 0 || picks.length >= catalogue.length}
            className="btn-ghost text-xs bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-600 font-bold px-3 py-1.5 rounded-lg"
          >
            + Add Scenario
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4">
          {picks.map((p, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr,140px,140px,28px] gap-3 rounded-lg border border-slate-205 border-slate-200 bg-slate-50 p-4"
            >
              <label className="flex flex-col gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Scenario
                <select
                  value={p.scenarioId}
                  onChange={(e) => update(idx, { scenarioId: e.target.value })}
                  className="input-op font-medium"
                >
                  {catalogue.length === 0 && (
                    <option value={p.scenarioId}>{p.scenarioId}</option>
                  )}
                  {(() => {
                    const used = new Set(picks.map((x) => x.scenarioId));
                    return catalogue
                      .filter((c) => metaName(c) === p.scenarioId || !used.has(metaName(c)))
                      .map((c) => (
                        <option key={metaName(c)} value={metaName(c)}>
                          {metaLabel(c) || metaName(c)}
                        </option>
                      ));
                  })()}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Intensity
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  value={p.intensity}
                  onChange={(e) => update(idx, { intensity: Number(e.target.value) })}
                  className="input-op font-mono font-bold"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Duration (days)
                <input
                  type="number"
                  step="1"
                  min={1}
                  max={365}
                  value={p.durationDays}
                  onChange={(e) => update(idx, { durationDays: Number(e.target.value) })}
                  className="input-op font-mono font-bold"
                />
              </label>
              <button
                type="button"
                onClick={() => removeRow(idx)}
                disabled={picks.length <= 2}
                className="self-end h-[38px] w-[28px] flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:border-red-500 hover:text-red-600 disabled:opacity-30 transition-colors font-bold text-slate-400"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="btn-accent px-5 py-2 text-xs font-semibold bg-blue-600 border-blue-600 text-white hover:bg-blue-700 hover:border-blue-700 disabled:opacity-50 h-[38px] flex items-center justify-center min-w-[120px]"
          >
            {running ? 'Running…' : 'Run Compound Shock'}
          </button>
          {error && <span className="text-xs text-red-600 font-semibold">{error}</span>}
        </div>
      </section>

      {result && (
        <>
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Card label="Brent" value={`+${result.projected.brentUpliftPct.toFixed(1)}%`} sub={`→ $${result.projected.brentUsd.toFixed(2)}/bbl`} />
            <Card label="GDP impact" value={`${result.projected.gdpImpactBps.toFixed(0)} bps`} sub="(negative = drag)" warn={result.projected.gdpImpactBps < 0} />
            <Card label="SPR cover (min)" value={`${result.projected.sprCoverDays.toFixed(1)} d`} sub={`baseline ${result.baseline.sprCoverDays} d`} warn={result.projected.sprCoverDays < result.baseline.sprCoverDays} />
            <Card label="Refinery drop (max)" value={`-${result.projected.refineryDropPp.toFixed(1)} pp`} sub={`power +${result.projected.powerStressRise.toFixed(1)} idx`} warn={result.projected.refineryDropPp > 0} />
          </section>

          <section className="card p-5">
            <h2 className="mb-3.5 text-sm font-bold text-slate-800">Combined Trajectory</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timelineData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                  <XAxis dataKey="day" stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 10 }} />
                  <YAxis yAxisId="pct" stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 10 }} domain={[0, 'auto']} />
                  <YAxis yAxisId="brent" orientation="right" stroke="#ea580c" tick={{ fill: '#ea580c', fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 11, color: '#334155' }} />
                  <Legend wrapperStyle={{ fontSize: 10, fontWeight: 600 }} />
                  <Line yAxisId="brent" type="monotone" dataKey="brent" name="Brent ($/bbl)" stroke="#ea580c" strokeWidth={2} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="refinery" name="Refinery run rate (%)" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="diesel" name="Diesel (Rs/L)" stroke="#d97706" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="power" name="Power stress idx" stroke="#0ea5e9" strokeWidth={1.5} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="gdp" name="GDP growth (%)" stroke="#059669" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 bg-slate-50">
              <h2 className="text-sm font-bold text-slate-850">Per-Scenario Contribution</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="table-op font-mono text-xs">
                <thead>
                  <tr>
                    <th className="px-4 py-2 text-left">Scenario</th>
                    <th className="px-4 py-2 text-right">Brent Uplift</th>
                    <th className="px-4 py-2 text-right">LNG Uplift</th>
                    <th className="px-4 py-2 text-right">Coal Uplift</th>
                    <th className="px-4 py-2 text-right">Primary Uplift</th>
                    <th className="px-4 py-2 text-right">GDP Bps</th>
                    <th className="px-4 py-2 text-right">Refinery -pp</th>
                    <th className="px-4 py-2 text-right">Power +idx</th>
                    <th className="px-4 py-2 text-right">SPR Days</th>
                  </tr>
                </thead>
                <tbody>
                  {result.breakdown.map((b, i) => (
                    <tr key={b.scenarioId} className="border-t border-slate-100 hover:bg-slate-50/50">
                      <td className="px-4 py-3 text-left font-bold" style={{ color: ROW_COLORS[i % ROW_COLORS.length] }}>
                        ● {b.label}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700 font-semibold">{b.brentUpliftPct.toFixed(2)}%</td>
                      <td className="px-4 py-3 text-right text-slate-700 font-semibold">{b.lngUpliftPct.toFixed(2)}%</td>
                      <td className="px-4 py-3 text-right text-slate-700 font-semibold">{b.coalUpliftPct.toFixed(2)}%</td>
                      <td className="px-4 py-3 text-right text-slate-700 font-semibold">{b.primaryUpliftPct.toFixed(2)}%</td>
                      <td className={`px-4 py-3 text-right font-bold ${b.gdpBps < 0 ? 'text-red-650' : 'text-slate-500'}`}>{b.gdpBps.toFixed(1)}</td>
                      <td className="px-4 py-3 text-right text-slate-700 font-semibold">{b.refineryDropPp.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-slate-700 font-semibold">{b.powerStressRise.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-slate-700 font-semibold">{b.sprRunwayDays.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-xl border border-slate-205 border-slate-200 bg-slate-50 p-5 text-xs text-slate-500 font-medium leading-relaxed shadow-sm">
            <p className="mb-2 font-bold text-slate-800 text-[13px]">Composition Rules</p>
            <ul className="list-disc pl-5 space-y-1.5">
              {result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Card({ label, value, sub, warn = false }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 shadow-sm transition-all duration-150 ${warn ? 'border-red-200 bg-red-50/50' : 'border-slate-200 bg-white'}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1.5 font-bold font-mono tracking-tight tabular-nums text-xl ${warn ? 'text-red-650' : 'text-slate-800'}`}>{value}</div>
      {sub && <div className="mt-1 text-[10px] text-slate-450 font-semibold">{sub}</div>}
    </div>
  );
}
