import { useEffect, useState, useMemo, type ReactNode } from 'react';
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
  high: 'border-red-200 bg-red-50 text-red-700',
  elevated: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-emerald-200 bg-emerald-50 text-emerald-700',
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
    <div className="flex flex-col gap-6">
      {/* Header section matching style */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">SPR Simulation</p>
          <h1 className="mt-1 text-2xl font-bold text-white leading-tight">
            SPR Optimization Agent
          </h1>
          <p className="mt-1 text-xs text-slate-400 font-medium max-w-3xl">
            Simulate a linear program solver to balance crude refinery demand, maritime risk constraints, and storage withdrawals.
          </p>
        </div>
        {plan && (
          <div className="text-right font-mono text-[9px] uppercase tracking-wider text-slate-400">
            Plan as of {fmtTime(plan.asOf)}
            {plan.scenarioLabel && (
              <div className="mt-0.5 text-slate-500 font-semibold font-sans normal-case">Shock: {plan.scenarioLabel}</div>
            )}
          </div>
        )}
      </header>

      {/* Parameters Panel Container */}
      <div className="card p-5 bg-slate-50/50 flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Disruption</label>
            <select
              value={form.scenarioId}
              onChange={(e) => setForm({ ...form, scenarioId: e.target.value })}
              className="input-op w-full font-medium"
            >
              <option value="">SPR Optimization Agent</option>
              {scenarios.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Scenario</label>
            <select
              value={form.targetCoverDays}
              onChange={(e) => setForm({ ...form, targetCoverDays: Number(e.target.value) })}
              className="input-op w-full font-medium"
            >
              <option value="6">New policy policy</option>
              <option value="4">Emergency minimum</option>
              <option value="8">Full resilience hold</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Duration - {form.intensity.toFixed(1)}</label>
            <div className="flex items-center h-[38px]">
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={form.intensity}
                onChange={(e) => setForm({ ...form, intensity: Number(e.target.value) })}
                className="w-full accent-blue-600 cursor-pointer"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Release Mode</label>
            <select
              value={form.releaseMode}
              onChange={(e) => setForm({ ...form, releaseMode: e.target.value as FormState['releaseMode'] })}
              className="input-op w-full font-medium"
            >
              <option value="drawdown">Release Mode</option>
              <option value="swap">Swap (loan vs future)</option>
              <option value="exchange">Exchange (delayed)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Target Flow</label>
            <select
              value={form.horizonDays}
              onChange={(e) => setForm({ ...form, horizonDays: Number(e.target.value) })}
              className="input-op w-full font-medium font-mono"
            >
              <option value="60">North Sose</option>
              <option value="30">South Sose</option>
              <option value="90">Extended solve</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Market Bias</label>
            <select
              value={form.marketBias}
              onChange={(e) => setForm({ ...form, marketBias: e.target.value as FormState['marketBias'] })}
              className="input-op w-full font-medium"
            >
              <option value="balanced">Drawdown (Post Bias)</option>
              <option value="north">North India Bias</option>
              <option value="south">South India Bias</option>
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={solve}
            disabled={loading}
            className="btn-accent px-6 py-2 font-bold text-xs bg-blue-600 border-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            {loading ? 'Solving...' : 'Solve Plan'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">
          {error}
        </div>
      )}

      {plan && (
        <>
          {/* AI decision brief section */}
          <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-4 bg-slate-100/50">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-indigo-800 font-bold">
                  AI decision brief
                </span>
                {brief && (
                  <span
                    className={`rounded border px-1.5 py-0.5 font-semibold text-[9px] uppercase tracking-wider ${
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
                className="btn-ghost text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold border-indigo-200 px-3 py-1.5 rounded-lg"
              >
                {briefLoading ? 'Briefing...' : brief ? 'Regenerate brief' : 'Generate decision brief'}
              </button>
            </div>
            <div className="px-5 py-4">
              {briefError && <div className="text-sm text-red-600 font-medium">{briefError}</div>}
              {!brief && !briefError && (
                <p className="text-xs text-slate-400 font-medium leading-relaxed">
                  Generate an actionable policymaker brief — situation, recommended actions, trade-offs, risks, and what to watch — synthesised from the optimised plan.
                </p>
              )}
              {brief && (
                <div className="flex flex-col gap-4">
                  <div>
                    <h3 className="font-bold text-sm text-slate-800 leading-tight">{brief.headline}</h3>
                    <p className="mt-2 text-xs leading-relaxed text-slate-600 font-medium whitespace-pre-line">
                      {brief.narrative}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <BriefList title="Recommended actions" items={brief.actions} accent="text-blue-600" />
                    <BriefList title="Trade-offs" items={brief.tradeoffs} accent="text-amber-600" />
                    <BriefList title="Key risks" items={brief.risks} accent="text-red-600" />
                    <BriefList title="What to watch" items={brief.watchItems} accent="text-sky-600" />
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 6 KPI Cards Grid */}
          <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Peak Shortfall" value={`${fmtNumber(plan.peakGapKbpd ?? 0, 0)} Mbal`} sub="Peak + relief" />
            <Kpi
              label="Horizon"
              value={`${plan.coverDays.toFixed(1)} d`}
              sub="Trough · cover"
            />
            <Kpi label="Max Draw" value={`${(plan.gapClosedPct ?? 0).toFixed(0)}N`} sub="Main status" valueClass="text-emerald-600" />
            <Kpi label="Total Release" value={fmtNumber(plan.totalUnmetMb ?? 0, 0)} sub="Net Impact" />
            <Kpi label="Max Flow" value={`${fmtNumber(plan.totalReplenishMb ?? 0, 1)} Mbal`} sub="Safe flow reserve" />
            <Kpi label="SPR Reserve" value={`${fmtNumber(plan.currentFillMb, 1)} Mbal`} sub="Net Effect" valueClass="text-emerald-600" />
          </section>

          {/* Composed Trajectory and Forecast side-by-side */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.8fr,1fr]">
            <SPRChart plan={plan} baseline={baseline ?? undefined} />

            <section className="flex flex-col gap-4">
              <div className="card p-5">
                <h3 className="mb-2 text-xs font-bold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider">Supply-Gap Forecast</h3>
                <p className="text-xs text-slate-500 font-medium">
                  Peak shortfall (p50){' '}
                  <span className="font-mono text-slate-800 font-bold ml-1">
                    {fmtNumber(plan.uncertainty?.peakP50 ?? plan.peakGapKbpd ?? 0, 0)} kbpd
                  </span>
                  {plan.uncertainty && (
                    <>
                      {' '}· 80% CI{' '}
                      <span className="font-mono text-slate-600 font-semibold">
                        {fmtNumber(plan.uncertainty.peakP10, 0)}–{fmtNumber(plan.uncertainty.peakP90, 0)} kbpd
                      </span>
                    </>
                  )}
                </p>
                {plan.uncertainty && (
                  <div className="mt-3.5 grid grid-cols-3 gap-2.5 text-[10px] font-semibold">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">P(peak &gt; 500)</div>
                      <div className="mt-1 font-mono font-bold text-slate-800">
                        {(plan.uncertainty.probAbove500Kbpd * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">P(peak &gt; 1000)</div>
                      <div className={`mt-1 font-mono font-bold ${plan.uncertainty.probAbove1000Kbpd > 0.3 ? 'text-amber-600 font-extrabold' : 'text-slate-800'}`}>
                        {(plan.uncertainty.probAbove1000Kbpd * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">P(peak &gt; 2000)</div>
                      <div className={`mt-1 font-mono font-bold ${plan.uncertainty.probAbove2000Kbpd > 0.1 ? 'text-red-600 font-extrabold' : 'text-slate-800'}`}>
                        {(plan.uncertainty.probAbove2000Kbpd * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                )}
                <p className="mt-2.5 text-[9px] text-slate-400 font-medium leading-relaxed uppercase tracking-wider">
                  {plan.uncertainty?.method ?? 'Central path with parametric band.'}
                </p>
              </div>

              <div className="card p-5">
                <h3 className="mb-2 text-xs font-bold text-slate-800 border-b border-slate-100 pb-2 uppercase tracking-wider">Replenishment Windows</h3>
                {(plan.replenishmentWindows ?? []).length === 0 ? (
                  <p className="text-xs text-slate-400 font-medium">No clear refill window in the horizon.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {(plan.replenishmentWindows ?? []).map((w, i) => (
                      <li key={i} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
                        <div className="flex items-center justify-between text-xs font-semibold text-slate-800">
                          <span className="font-mono">Day {w.startDay}–{w.endDay}</span>
                          <span className="font-mono text-emerald-600 font-bold">~${w.estPriceUsd.toFixed(0)}/bbl</span>
                        </div>
                        <div className="mt-1 text-[10px] text-slate-400 font-semibold leading-relaxed">{w.reason}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          {/* Refinery Exposure */}
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 bg-slate-50">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Refinery Demand &amp; Corridor Exposure</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                {fmtNumber(plan.totalDemandKbpd ?? 0, 0)} kbpd total
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="table-op">
                <thead>
                  <tr>
                    <th className="px-4 py-2 text-left">Refinery</th>
                    <th className="px-4 py-2 text-right">Capacity</th>
                    <th className="px-4 py-2 text-right">Demand</th>
                    <th className="px-4 py-2 text-right">Gulf Slate</th>
                    <th className="px-4 py-2 text-right">At Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {(plan.refineryDemand ?? []).slice(0, 8).map((r) => (
                    <tr key={r.name} className="border-t border-slate-100 hover:bg-slate-50/50">
                      <td className="px-4 py-3">
                        <div className="text-slate-800 font-bold">{r.name}</div>
                        <div className="text-[10px] text-slate-400 font-semibold">{r.operator}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">{r.capacityMmtpa.toFixed(1)} MMTPA</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">{r.dailyDemandKbpd.toFixed(0)} kbpd</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-500 font-medium">{r.gulfExposurePct.toFixed(0)}%</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-600 font-bold">{r.exposureKbpd.toFixed(0)} kbpd</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-5 py-3.5 text-[10px] text-slate-400 font-semibold bg-slate-50/50">
              Exposure inferred from each refinery's sour/heavy (Gulf-typical) crude slate.
            </div>
          </section>

          {/* Site allocation */}
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 bg-slate-50">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Site Allocation</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                bias: {plan.marketBias ?? 'balanced'}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="table-op">
                <thead>
                  <tr>
                    <th className="px-4 py-2 text-left">Site</th>
                    <th className="px-4 py-2 text-left">Location</th>
                    <th className="px-4 py-2 text-right">Capacity</th>
                    <th className="px-4 py-2 text-right">Fill</th>
                    <th className="px-4 py-2 text-right">Daily Draw</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.sites.map((s) => (
                    <tr key={s.name} className="border-t border-slate-100 hover:bg-slate-50/50">
                      <td className="px-4 py-3 text-slate-800 font-bold">{s.name}</td>
                      <td className="px-4 py-3 text-slate-500 font-semibold text-xs">{s.location}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">{fmtNumber(s.capacityMb, 1)} Mbbl</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">{fmtNumber(s.fillMb, 1)} Mbbl</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">{fmtNumber(s.drawRateMbPerDay, 2)} Mbbl/d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* LP Rationale Text */}
          <NarrativeFeed title="LP rationale" body={plan.rationale} generatedAt={plan.asOf} />

          {/* Audit solver log */}
          {recentRuns.length > 0 && (
            <section className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 bg-slate-50">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Recent Plan Solves</h3>
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                  audit log · SQLite archives
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="table-op font-mono text-xs">
                  <thead>
                    <tr>
                      <th className="px-4 py-2 text-left">When</th>
                      <th className="px-4 py-2 text-left">Scenario</th>
                      <th className="px-4 py-2 text-left">Mode</th>
                      <th className="px-4 py-2 text-right">Intensity</th>
                      <th className="px-4 py-2 text-right">Peak Gap</th>
                      <th className="px-4 py-2 text-right">Trough Cover</th>
                      <th className="px-4 py-2 text-right">Gap Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                        <td className="px-4 py-3 text-slate-400 font-semibold">{fmtTime(r.ran_at)}</td>
                        <td className="px-4 py-3 text-slate-700 font-bold">{r.scenario_id ?? '—'}</td>
                        <td className="px-4 py-3 text-slate-600 font-medium">{r.release_mode ?? 'drawdown'}</td>
                        <td className="px-4 py-3 text-right text-slate-600 font-medium">{r.intensity?.toFixed(2) ?? '—'}</td>
                        <td className="px-4 py-3 text-right text-amber-600 font-bold">{r.peak_gap_kbpd?.toFixed(0) ?? '—'} kbpd</td>
                        <td className="px-4 py-3 text-right text-red-600 font-bold">{r.trough_cover_days?.toFixed(1) ?? '—'} d</td>
                        <td className="px-4 py-3 text-right text-emerald-600 font-bold">{r.gap_closed_pct?.toFixed(0) ?? '—'}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
  valueClass = 'text-slate-800',
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="card p-4">
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-2 text-2xl font-bold font-mono tracking-tight tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="mt-1 text-[9px] font-bold uppercase tracking-wider text-slate-400">{sub}</div>}
    </div>
  );
}

function BriefList({ title, items, accent }: { title: string; items: string[]; accent: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</div>
      <ul className="space-y-1.5 text-xs text-slate-600 font-medium">
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
