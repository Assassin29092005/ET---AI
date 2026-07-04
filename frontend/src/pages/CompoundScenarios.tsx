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
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Innovation</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-100">Compound scenarios</h1>
        <p className="mt-1 max-w-3xl text-xs text-slate-400">
          Stack 2-4 disruptions simultaneously to see compound shocks (e.g. Hormuz closure + Australia coking
          coal outage). Price uplifts add, refinery drop wins by max, SPR runway wins by min. Composition
          rules documented inline below.
        </p>
      </header>

      <section className="rounded-lg border border-slate-800 bg-slate-900 p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Compose shock stack</h2>
          <button
            type="button"
            onClick={addRow}
            disabled={picks.length >= 4 || catalogue.length === 0}
            className="rounded border border-slate-700 px-2 py-1 text-[11px] uppercase tracking-wider text-slate-300 hover:border-indigo-500 disabled:opacity-40"
          >
            + Add scenario
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3">
          {picks.map((p, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr,140px,140px,28px] gap-3 rounded border border-slate-800 bg-slate-950/50 p-3"
            >
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-slate-400">
                Scenario
                <select
                  value={p.scenarioId}
                  onChange={(e) => update(idx, { scenarioId: e.target.value })}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 outline-none focus:border-indigo-500"
                >
                  {catalogue.length === 0 && (
                    <option value={p.scenarioId}>{p.scenarioId}</option>
                  )}
                  {catalogue.map((c) => (
                    <option key={metaName(c)} value={metaName(c)}>
                      {metaLabel(c) || metaName(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-slate-400">
                Intensity
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  value={p.intensity}
                  onChange={(e) => update(idx, { intensity: Number(e.target.value) })}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono tabular-nums text-sm text-slate-100 outline-none focus:border-indigo-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-slate-400">
                Duration (days)
                <input
                  type="number"
                  step="1"
                  min={1}
                  max={365}
                  value={p.durationDays}
                  onChange={(e) => update(idx, { durationDays: Number(e.target.value) })}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono tabular-nums text-sm text-slate-100 outline-none focus:border-indigo-500"
                />
              </label>
              <button
                type="button"
                onClick={() => removeRow(idx)}
                disabled={picks.length <= 2}
                className="self-end rounded border border-slate-800 px-1 py-1 text-[11px] text-slate-500 hover:border-red-500 hover:text-red-300 disabled:opacity-30"
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
            className="rounded-md border border-indigo-500/60 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run compound shock'}
          </button>
          {error && <span className="text-xs text-red-300">{error}</span>}
        </div>
      </section>

      {result && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card label="Brent" value={`+${result.projected.brentUpliftPct.toFixed(1)}%`} sub={`→ $${result.projected.brentUsd.toFixed(2)}/bbl`} />
            <Card label="GDP impact" value={`${result.projected.gdpImpactBps.toFixed(0)} bps`} sub="(negative = drag)" warn={result.projected.gdpImpactBps < 0} />
            <Card label="SPR cover (min)" value={`${result.projected.sprCoverDays.toFixed(1)} d`} sub={`baseline ${result.baseline.sprCoverDays} d`} warn={result.projected.sprCoverDays < result.baseline.sprCoverDays} />
            <Card label="Refinery drop (max)" value={`-${result.projected.refineryDropPp.toFixed(1)} pp`} sub={`power +${result.projected.powerStressRise.toFixed(1)} idx`} warn={result.projected.refineryDropPp > 0} />
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">Combined trajectory</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timelineData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="day" stroke="#64748b" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="pct" stroke="#64748b" tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                  <YAxis yAxisId="brent" orientation="right" stroke="#fb923c" tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line yAxisId="brent" type="monotone" dataKey="brent" name="Brent ($/bbl)" stroke="#fb923c" strokeWidth={1.5} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="refinery" name="Refinery run rate (%)" stroke="#a78bfa" strokeWidth={1.5} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="diesel" name="Diesel (Rs/L)" stroke="#facc15" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="power" name="Power stress idx" stroke="#22d3ee" strokeWidth={1.5} dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="gdp" name="GDP growth (%)" stroke="#34d399" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">Per-scenario contribution</h2>
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px] tabular-nums">
                <thead className="border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="px-2 py-1 text-left">Scenario</th>
                    <th className="px-2 py-1 text-right">Brent uplift</th>
                    <th className="px-2 py-1 text-right">LNG uplift</th>
                    <th className="px-2 py-1 text-right">Coal uplift</th>
                    <th className="px-2 py-1 text-right">Primary uplift</th>
                    <th className="px-2 py-1 text-right">GDP bps</th>
                    <th className="px-2 py-1 text-right">Refinery -pp</th>
                    <th className="px-2 py-1 text-right">Power +idx</th>
                    <th className="px-2 py-1 text-right">SPR days</th>
                  </tr>
                </thead>
                <tbody>
                  {result.breakdown.map((b, i) => (
                    <tr key={b.scenarioId} className="border-b border-slate-800/60">
                      <td className="px-2 py-1 text-left text-slate-200" style={{ color: ROW_COLORS[i] }}>
                        ● {b.label}
                      </td>
                      <td className="px-2 py-1 text-right">{b.brentUpliftPct.toFixed(2)}%</td>
                      <td className="px-2 py-1 text-right">{b.lngUpliftPct.toFixed(2)}%</td>
                      <td className="px-2 py-1 text-right">{b.coalUpliftPct.toFixed(2)}%</td>
                      <td className="px-2 py-1 text-right">{b.primaryUpliftPct.toFixed(2)}%</td>
                      <td className={`px-2 py-1 text-right ${b.gdpBps < 0 ? 'text-red-300' : 'text-slate-400'}`}>{b.gdpBps.toFixed(1)}</td>
                      <td className="px-2 py-1 text-right">{b.refineryDropPp.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right">{b.powerStressRise.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right">{b.sprRunwayDays.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-[11px] text-slate-400">
            <p className="mb-1 font-semibold text-slate-200">Composition rules</p>
            <ul className="list-disc pl-5">
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
    <div className={`rounded-lg border p-3 ${warn ? 'border-red-500/30 bg-red-500/5' : 'border-slate-800 bg-slate-900'}`}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 font-mono tabular-nums text-xl ${warn ? 'text-red-200' : 'text-slate-100'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}
