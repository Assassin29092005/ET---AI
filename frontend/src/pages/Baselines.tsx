import { useEffect, useMemo, useState } from 'react';
import {
  getBaselines,
  postBaselineOverride,
  type BaselinesResponse,
  type BaselineOverridePayload,
} from '@/lib/api';
import { fmtTime } from '@/lib/fmt';

const OVERRIDE_LABELS: Record<keyof BaselineOverridePayload, { label: string; unit: string; help: string }> = {
  spr_cover_days: {
    label: 'SPR cover',
    unit: 'days',
    help: 'Strategic Petroleum Reserve cover at current consumption (ISPRL annual).',
  },
  refinery_runrate_pct: {
    label: 'Refinery run rate',
    unit: '%',
    help: 'Nameplate utilisation baseline (PPAC monthly utilisation report).',
  },
  power_stress_index: {
    label: 'Power stress index',
    unit: 'idx',
    help: 'Pre-shock grid stress (POSOCO daily grid report).',
  },
  gdp_growth_pct: {
    label: 'GDP growth',
    unit: '% pa',
    help: 'Annualised GDP trajectory baseline (RBI quarterly bulletin).',
  },
};

const KEY_TO_LABEL: Record<string, string> = {
  brent_usd_bbl: 'Brent',
  copper_usd_t: 'Copper',
  inr_per_usd: 'USD / INR',
  henry_hub_usd_mmbtu: 'Henry Hub LNG',
  india_import_bill_usdm: 'Daily crude import bill',
  diesel_inr_per_l: 'Diesel (retail)',
  petrol_inr_per_l: 'Petrol (retail)',
  lpg_inr_per_cyl: 'LPG cylinder',
  cng_inr_per_kg: 'CNG',
};

const KEY_TO_UNIT: Record<string, string> = {
  brent_usd_bbl: '$/bbl',
  copper_usd_t: '$/t',
  inr_per_usd: 'INR',
  henry_hub_usd_mmbtu: '$/MMBtu',
  india_import_bill_usdm: '$M / day',
  diesel_inr_per_l: '₹/L',
  petrol_inr_per_l: '₹/L',
  lpg_inr_per_cyl: '₹/cyl',
  cng_inr_per_kg: '₹/kg',
};

export default function Baselines() {
  const [data, setData] = useState<BaselinesResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getBaselines()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        const seed: Record<string, string> = {};
        for (const [k, v] of Object.entries(d.operator_overridable)) {
          seed[k] = String(v.value);
        }
        setDraft(seed);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load baselines');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const liveEntries = useMemo(() => Object.entries(data?.live ?? {}), [data]);
  const overrideEntries = useMemo(
    () => Object.entries(data?.operator_overridable ?? {}),
    [data],
  );

  function isDirty(key: string): boolean {
    const current = data?.operator_overridable?.[key]?.value;
    if (current === undefined) return false;
    return String(current) !== draft[key];
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    const payload: BaselineOverridePayload = {};
    for (const key of Object.keys(OVERRIDE_LABELS) as Array<keyof BaselineOverridePayload>) {
      if (!isDirty(key)) continue;
      const num = Number(draft[key]);
      if (!Number.isFinite(num)) {
        setError(`${OVERRIDE_LABELS[key].label}: not a valid number`);
        setSaving(false);
        return;
      }
      payload[key] = num;
    }
    if (Object.keys(payload).length === 0) {
      setMessage('No changes to apply.');
      setSaving(false);
      return;
    }
    try {
      const res = await postBaselineOverride(payload);
      const errorEntries = Object.entries(res.errors);
      if (errorEntries.length > 0) {
        setError(errorEntries.map(([k, v]) => `${k}: ${v}`).join('; '));
      } else {
        setMessage(`Applied ${Object.keys(res.applied).length} override(s).`);
      }
      const refreshed = await getBaselines();
      setData(refreshed);
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(refreshed.operator_overridable)) {
        next[k] = String(v.value);
      }
      setDraft(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Override request failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header section matching style */}
      <header>
        <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">System Administration</p>
        <h1 className="mt-1 text-2xl font-bold text-white leading-tight">Data Baselines</h1>
        <p className="mt-1.5 text-xs text-slate-400 font-medium max-w-4xl">
          The scenario projection runs on top of these data baselines from external APIs on startup. Administrative figures with no machine-readable feed (SPR cover, refinery utilisation, power stress, GDP) can be manually overridden here for the next demo run.
        </p>
      </header>

      {loading && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-450 font-medium shadow-sm">
          Loading baselines...
        </div>
      )}

      {data && (
        <>
          {/* Live Data Card */}
          <section className="card p-5">
            <div className="mb-3.5 flex items-baseline justify-between border-b border-slate-100 pb-2">
              <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Live Data</h2>
              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                Refreshes at API startup
              </span>
            </div>
            {liveEntries.length === 0 ? (
              <p className="text-xs text-slate-500 font-medium">
                No live values loaded. Either ALLOW_INGEST or every upstream call failed; the model is running on documented snapshots.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 mt-3">
                {liveEntries.map(([key, entry]) => (
                  <div key={key} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                        {KEY_TO_LABEL[key] ?? key}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-emerald-600 font-bold">live</span>
                    </div>
                    <div className="mt-1.5 font-mono tabular-nums text-base text-slate-800 font-bold">
                      {entry.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                      <span className="text-xs text-slate-400 font-semibold lowercase font-sans">{KEY_TO_UNIT[key] ?? ''}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-slate-400 font-semibold font-mono">Source: {entry.source}</div>
                    {entry.refreshed_at && (
                      <div className="mt-0.5 font-mono text-[9px] text-slate-400 font-semibold">
                        {fmtTime(entry.refreshed_at)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Operator Overrides Card */}
          <section className="card p-5">
            <div className="mb-3.5 flex items-baseline justify-between border-b border-slate-100 pb-2">
              <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Operator Overrides</h2>
              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                In-process; resets on backend restart
              </span>
            </div>
            <p className="mb-4 text-xs text-slate-500 font-medium">
              These four figures are published only as monthly/quarterly PDFs by Indian regulators. Ahead of a demo without redeploying.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              {overrideEntries.map(([key, entry]) => {
                const meta = OVERRIDE_LABELS[key as keyof BaselineOverridePayload];
                if (!meta) return null;
                const dirty = isDirty(key);
                return (
                  <div key={key} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4">
                    <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                      {meta.label}
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        step="0.1"
                        value={draft[key] ?? ''}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        className={`w-full rounded-lg border px-3 py-1.5 font-mono font-bold text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 ${
                          dirty ? 'border-amber-400 bg-amber-50/10' : 'border-slate-200 bg-slate-50/50'
                        }`}
                      />
                      <span className="font-mono text-xs text-slate-400 font-semibold">{meta.unit}</span>
                    </div>
                    <span className="text-[10px] text-slate-450 leading-relaxed font-semibold">{meta.help}</span>
                    <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-1">
                      Source: {entry.source}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex items-center gap-3 border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="btn-accent px-4 py-2 font-semibold text-xs bg-blue-600 border-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
              >
                {saving ? 'Saving…' : 'Apply overrides'}
              </button>
              {message && <span className="text-xs text-emerald-600 font-bold">{message}</span>}
              {error && <span className="text-xs text-red-600 font-bold">{error}</span>}
            </div>
          </section>

          {/* Note on model parameters */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-[10px] text-slate-500 font-semibold shadow-sm">
            <span className="font-bold text-slate-800">Note on model parameters.</span>{' '}
            Elasticities, passthrough coefficients matrix are deliberately not refreshed — they are calibration constants documented in docs/assumptions.md.
          </div>
        </>
      )}
    </div>
  );
}
