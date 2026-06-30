import { useEffect, useState, type ReactNode } from 'react';
import {
  getSPRPlan,
  getScenarios,
  getSprRuns,
  postSPRBrief,
  postSPRPlan,
  type SPRRun,
  type ScenarioMeta,
} from '@/lib/api';
import type { SPRBrief, SPRPlan } from '@/lib/types';
import { fmtNumber, fmtTime } from '@/lib/fmt';
import SPRChart from '@/components/SPRChart';
import NarrativeFeed from '@/components/NarrativeFeed';

interface FormState {
  targetCoverDays: number;
  horizonDays: number;
  marketBias: 'north' | 'south' | 'balanced';
  scenarioId: string;
  intensity: number;
  releaseMode: 'drawdown' | 'swap' | 'exchange';
}

const DEFAULT_FORM: FormState = {
  targetCoverDays: 6,
  horizonDays: 60,
  marketBias: 'balanced',
  scenarioId: '',
  intensity: 0.5,
  releaseMode: 'drawdown',
};

const URGENCY_PILL: Record<string, string> = {
  high: 'border-red-500/50 bg-red-500/10 text-red-300',
  elevated: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  low: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
};

function syntheticBaseline(plan: SPRPlan): SPRPlan {
  const releaseSchedule = plan.releaseSchedule.map((r) => {
    const flat = plan.releaseSchedule.length > 0
      ? plan.releaseSchedule.reduce((a, b) => a + b.drawMb, 0) / plan.releaseSchedule.length
      : 0;
    return { ...r, drawMb: flat };
  });
  return { ...plan, releaseSchedule, rationale: 'Constant-rate baseline (no optimisation).' };
}

function reqFromForm(form: FormState) {
  return {
    targetCoverDays: form.targetCoverDays,
    horizonDays: form.horizonDays,
    marketBias: form.marketBias,
    scenarioId: form.scenarioId || null,
    intensity: form.intensity,
    releaseMode: form.releaseMode,
  };
}

export default function SPR() {
  const [plan, setPlan] = useState<SPRPlan | null>(null);
  const [baseline, setBaseline] = useState<SPRPlan | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState<SPRBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<SPRRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [p, sc, r] = await Promise.all([
          getSPRPlan(),
          getScenarios(),
          getSprRuns(8).catch(() => ({ runs: [] as SPRRun[], asOf: '' })),
        ]);
        if (cancelled) return;
        setPlan(p);
        setBaseline(syntheticBaseline(p));
        setScenarios(sc);
        setRecentRuns(r.runs ?? []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load SPR plan');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function solve() {
    setLoading(true);
    setBrief(null);
    try {
      const p = await postSPRPlan(reqFromForm(form));
      setPlan(p);
      setBaseline(syntheticBaseline(p));
      setError(null);
      // Refresh the recent-plans archive after a solve so the audit log updates live.
      try {
        const r = await getSprRuns(8);
        setRecentRuns(r.runs ?? []);
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to solve SPR plan');
    } finally {
      setLoading(false);
    }
  }

  async function generateBrief() {
    setBriefLoading(true);
    setBriefError(null);
    try {
      const b = await postSPRBrief(reqFromForm(form));
      setBrief(b);
    } catch (err) {
      setBriefError(err instanceof Error ? err.message : 'Failed to generate brief');
    } finally {
      setBriefLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Strategic reserves</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-100">
            SPR optimisation agent
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Models optimal drawdown against a scenario-driven supply-gap forecast, refinery demand,
            and replenishment windows — with an AI decision brief for policymakers.
          </p>
        </div>
        {plan && (
          <div className="text-right text-[11px] text-slate-500">
            Plan as of {fmtTime(plan.asOf)}
            {plan.scenarioLabel && (
              <div className="mt-0.5 text-slate-400">Shock: {plan.scenarioLabel}</div>
            )}
          </div>
        )}
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 sm:col-span-2">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">Disruption scenario</label>
          <select
            value={form.scenarioId}
            onChange={(e) => setForm({ ...form, scenarioId: e.target.value })}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
          >
            <option value="">Generic crude shortfall</option>
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Intensity {Math.round(form.intensity * 100)}%
          </label>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={form.intensity}
            onChange={(e) => setForm({ ...form, intensity: Number(e.target.value) })}
            className="mt-2 w-full accent-indigo-500"
          />
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Target cover (days)
          </label>
          <input
            type="number"
            min={3}
            max={9}
            step={1}
            value={form.targetCoverDays}
            onChange={(e) =>
              setForm({ ...form, targetCoverDays: Number(e.target.value) || DEFAULT_FORM.targetCoverDays })
            }
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm tabular-nums text-slate-100"
          />
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">Market bias</label>
          <select
            value={form.marketBias}
            onChange={(e) => setForm({ ...form, marketBias: e.target.value as FormState['marketBias'] })}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
          >
            <option value="balanced">Balanced</option>
            <option value="north">North India</option>
            <option value="south">South India</option>
          </select>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
          <label className="text-[10px] uppercase tracking-wider text-slate-500" title="DOE-style SPR release mechanisms">Release mode</label>
          <select
            value={form.releaseMode}
            onChange={(e) => setForm({ ...form, releaseMode: e.target.value as FormState['releaseMode'] })}
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
          >
            <option value="drawdown">Drawdown (spot sale)</option>
            <option value="swap">Swap (loan vs. future return)</option>
            <option value="exchange">Exchange (delayed delivery)</option>
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={solve}
            disabled={loading}
            className="w-full rounded-md border border-indigo-500/60 bg-indigo-500/20 px-3 py-2 text-sm font-semibold text-indigo-100 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {loading ? 'Solving...' : 'Solve plan'}
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {plan && (
        <>
          {/* AI decision brief */}
          <section className="rounded-lg border border-indigo-500/30 bg-indigo-500/5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-indigo-300">
                  AI decision brief
                </span>
                {brief && (
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      URGENCY_PILL[brief.urgency] ?? URGENCY_PILL.low
                    }`}
                  >
                    {brief.urgency} urgency
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={generateBrief}
                disabled={briefLoading}
                className="rounded-md border border-indigo-500/60 bg-indigo-500/20 px-3 py-1.5 text-xs font-semibold text-indigo-100 hover:bg-indigo-500/30 disabled:opacity-50"
              >
                {briefLoading ? 'Briefing...' : brief ? 'Regenerate brief' : 'Generate decision brief'}
              </button>
            </div>
            <div className="px-5 py-4">
              {briefError && <div className="text-sm text-red-300">{briefError}</div>}
              {!brief && !briefError && (
                <p className="text-sm text-slate-400">
                  Generate an actionable policymaker brief — situation, recommended actions,
                  trade-offs, risks, and what to watch — synthesised from the optimised plan.
                </p>
              )}
              {brief && (
                <div className="flex flex-col gap-4">
                  <div>
                    <h3 className="font-serif italic text-base text-slate-100">{brief.headline}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-200 whitespace-pre-line">
                      {brief.narrative}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <BriefList title="Recommended actions" items={brief.actions} accent="text-op-accent" />
                    <BriefList title="Trade-offs" items={brief.tradeoffs} accent="text-amber-300" />
                    <BriefList title="Key risks" items={brief.risks} accent="text-red-300" />
                    <BriefList title="What to watch" items={brief.watchItems} accent="text-sky-300" />
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Kpi label="Current fill" value={`${fmtNumber(plan.currentFillMb, 1)} Mbbl`} sub={`of ${fmtNumber(plan.totalCapacityMb, 1)} Mbbl`} />
            <Kpi
              label="Cover days"
              value={
                <span>
                  {plan.coverDays.toFixed(1)}
                  <span className="text-base text-slate-500">
                    {' → '}
                    <span className="text-red-300">{(plan.troughCoverDays ?? plan.coverDays).toFixed(1)}</span>
                    {' → '}
                    <span className="text-amber-300">{(plan.projectedCoverDays ?? plan.coverDays).toFixed(1)}</span>
                  </span>
                </span>
              }
              sub="now → trough → rebuilt"
            />
            <Kpi label="Gap closed" value={`${(plan.gapClosedPct ?? 0).toFixed(0)}%`} sub="vs no action" valueClass="text-emerald-300" />
            <Kpi label="Peak shortfall" value={fmtNumber(plan.peakGapKbpd ?? 0, 0)} sub="kbpd at peak" />
            <Kpi label="Uncovered" value={`${fmtNumber(plan.totalUnmetMb ?? 0, 1)} Mbbl`} sub="left to alt sourcing" />
            <Kpi label="Refilled" value={`${fmtNumber(plan.totalReplenishMb ?? 0, 1)} Mbbl`} sub="in window" valueClass="text-emerald-300" />
          </section>

          <SPRChart plan={plan} baseline={baseline ?? undefined} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr,1fr]">
            {/* Refinery demand */}
            <section className="rounded-lg border border-slate-800 bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
                <h3 className="text-sm font-semibold text-slate-100">Refinery demand &amp; corridor exposure</h3>
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  {fmtNumber(plan.totalDemandKbpd ?? 0, 0)} kbpd total
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-900/50 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Refinery</th>
                    <th className="px-4 py-2 text-right">Capacity</th>
                    <th className="px-4 py-2 text-right">Demand</th>
                    <th className="px-4 py-2 text-right">Gulf slate</th>
                    <th className="px-4 py-2 text-right">At risk</th>
                  </tr>
                </thead>
                <tbody>
                  {(plan.refineryDemand ?? []).slice(0, 8).map((r) => (
                    <tr key={r.name} className="border-t border-slate-800">
                      <td className="px-4 py-2">
                        <div className="text-slate-200">{r.name}</div>
                        <div className="text-[11px] text-slate-500">{r.operator}</div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">{r.capacityMmtpa.toFixed(1)} MMTPA</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">{r.dailyDemandKbpd.toFixed(0)} kbpd</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-400">{r.gulfExposurePct.toFixed(0)}%</td>
                      <td className="px-4 py-2 text-right tabular-nums text-amber-300">{r.exposureKbpd.toFixed(0)} kbpd</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-slate-800 px-5 py-2 text-[11px] text-slate-500">
                Exposure inferred from each refinery's sour/heavy (Gulf-typical) crude slate.
              </div>
            </section>

            {/* Forecast + replenishment windows */}
            <section className="flex flex-col gap-4">
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-100">Supply-gap forecast</h3>
                <p className="text-xs text-slate-400">
                  Peak shortfall <span className="tabular-nums text-slate-200">{fmtNumber(plan.peakGapKbpd ?? 0, 0)} kbpd</span>
                  {plan.gapForecast && plan.gapForecast.length > 0 && (
                    <>
                      {' '}· band at day 10{' '}
                      <span className="tabular-nums text-slate-300">
                        {fmtNumber(plan.gapForecast[Math.min(10, plan.gapForecast.length - 1)].low, 0)}–
                        {fmtNumber(plan.gapForecast[Math.min(10, plan.gapForecast.length - 1)].high, 0)} kbpd
                      </span>
                    </>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Central path × intensity with a parametric uncertainty cone (planning estimate).
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-100">Replenishment windows</h3>
                {(plan.replenishmentWindows ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">No clear refill window in the horizon.</p>
                ) : (
                  <ul className="space-y-2">
                    {(plan.replenishmentWindows ?? []).map((w, i) => (
                      <li key={i} className="rounded border border-slate-800 bg-slate-950/40 p-2">
                        <div className="flex items-center justify-between text-sm text-slate-200">
                          <span className="tabular-nums">Day {w.startDay}–{w.endDay}</span>
                          <span className="tabular-nums text-emerald-300">~${w.estPriceUsd.toFixed(0)}/bbl</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">{w.reason}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          {/* Site allocation */}
          <section className="rounded-lg border border-slate-800 bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-100">Site allocation</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                bias: {plan.marketBias ?? 'balanced'}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-900/50 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left">Site</th>
                  <th className="px-4 py-2 text-left">Location</th>
                  <th className="px-4 py-2 text-right">Capacity</th>
                  <th className="px-4 py-2 text-right">Fill</th>
                  <th className="px-4 py-2 text-right">Daily draw</th>
                </tr>
              </thead>
              <tbody>
                {plan.sites.map((s) => (
                  <tr key={s.name} className="border-t border-slate-800">
                    <td className="px-4 py-2 text-slate-200">{s.name}</td>
                    <td className="px-4 py-2 text-slate-400">{s.location}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-300">{fmtNumber(s.capacityMb, 1)} Mbbl</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-300">{fmtNumber(s.fillMb, 1)} Mbbl</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-300">{fmtNumber(s.drawRateMbPerDay, 2)} Mbbl/d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <NarrativeFeed title="LP rationale" body={plan.rationale} generatedAt={plan.asOf} />

          {recentRuns.length > 0 && (
            <section className="rounded-lg border border-slate-800 bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
                <h3 className="text-sm font-semibold text-slate-100">Recent plan solves</h3>
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  audit log · in-process SQLite
                </span>
              </div>
              <table className="w-full text-[12px]">
                <thead className="bg-slate-900/50 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left">When</th>
                    <th className="px-4 py-2 text-left">Scenario</th>
                    <th className="px-4 py-2 text-left">Mode</th>
                    <th className="px-4 py-2 text-right">Intensity</th>
                    <th className="px-4 py-2 text-right">Peak gap</th>
                    <th className="px-4 py-2 text-right">Trough cover</th>
                    <th className="px-4 py-2 text-right">Gap closed</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((r) => (
                    <tr key={r.id} className="border-t border-slate-800 font-mono tabular-nums">
                      <td className="px-4 py-2 text-slate-400">{fmtTime(r.ran_at)}</td>
                      <td className="px-4 py-2 text-slate-200">{r.scenario_id ?? '—'}</td>
                      <td className="px-4 py-2 text-slate-300">{r.release_mode ?? 'drawdown'}</td>
                      <td className="px-4 py-2 text-right text-slate-300">{r.intensity?.toFixed(2) ?? '—'}</td>
                      <td className="px-4 py-2 text-right text-amber-300">{r.peak_gap_kbpd?.toFixed(0) ?? '—'}</td>
                      <td className="px-4 py-2 text-right text-red-300">{r.trough_cover_days?.toFixed(1) ?? '—'}</td>
                      <td className="px-4 py-2 text-right text-emerald-300">{r.gap_closed_pct?.toFixed(0) ?? '—'}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  valueClass = 'text-slate-100',
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function BriefList({ title, items, accent }: { title: string; items: string[]; accent: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">{title}</div>
      <ul className="space-y-1.5 text-sm text-slate-200">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 leading-relaxed">
            <span className={accent}>›</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
