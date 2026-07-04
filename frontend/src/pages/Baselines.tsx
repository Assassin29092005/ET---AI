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
      // Refresh from server so we show authoritative state.
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
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">System</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-100">Data baselines</h1>
        <p className="mt-1 max-w-3xl text-xs text-slate-400">
          The scenario projection runs on top of these data baselines. Live values refresh from external APIs
          on startup. Administrative figures with no machine-readable feed (SPR cover, refinery utilisation,
          power stress, GDP) can be manually overridden here for the next demo run.
        </p>
      </header>

      {loading && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-500">
          Loading baselines...
        </div>
      )}

      {data && (
        <>
          <section className="rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Live data</h2>
              <span className="text-[10px] uppercase tracking-wider text-slate-500">
                Refreshes at API startup
              </span>
            </div>
            {liveEntries.length === 0 ? (
              <p className="text-xs text-slate-500">
                No live values loaded. Either <code className="text-slate-300">ALLOW_LIVE_INGEST</code> is
                disabled or every upstream call failed; the model is running on documented snapshots.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {liveEntries.map(([key, entry]) => (
                  <div key={key} className="rounded border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] uppercase tracking-wider text-slate-400">
                        {KEY_TO_LABEL[key] ?? key}
                      </span>
                      <span className="text-[10px] uppercase tracking-wider text-emerald-400">live</span>
                    </div>
                    <div className="mt-1 font-mono tabular-nums text-base text-slate-100">
                      {entry.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                      <span className="text-xs text-slate-500">{KEY_TO_UNIT[key] ?? ''}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">{entry.source}</div>
                    {entry.refreshed_at && (
                      <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                        {fmtTime(entry.refreshed_at)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Operator overrides</h2>
              <span className="text-[10px] uppercase tracking-wider text-slate-500">
                In-process; resets on backend restart
              </span>
            </div>
            <p className="mb-4 text-[11px] text-slate-500">
              These four figures are published only as monthly/quarterly PDFs by Indian regulators with no
              machine-readable feed. Update them ahead of a demo without redeploying.
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
              {overrideEntries.map(([key, entry]) => {
                const meta = OVERRIDE_LABELS[key as keyof BaselineOverridePayload];
                if (!meta) return null;
                const dirty = isDirty(key);
                return (
                  <label key={key} className="flex flex-col gap-1 rounded border border-slate-800 bg-slate-950/60 p-3">
                    <span className="text-[11px] uppercase tracking-wider text-slate-400">
                      {meta.label}
                    </span>
                    <div className="flex items-baseline gap-2">
                      <input
                        type="number"
                        step="0.1"
                        value={draft[key] ?? ''}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        className={`w-full rounded border bg-slate-900 px-2 py-1 font-mono tabular-nums text-sm text-slate-100 outline-none focus:border-indigo-500 ${
                          dirty ? 'border-amber-400/50' : 'border-slate-700'
                        }`}
                      />
                      <span className="font-mono text-[11px] text-slate-500">{meta.unit}</span>
                    </div>
                    <span className="text-[10px] text-slate-500">{meta.help}</span>
                    <span className="text-[10px] text-slate-600">
                      Source: {entry.source}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-md border border-indigo-500/60 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Apply overrides'}
              </button>
              {message && <span className="text-xs text-emerald-300">{message}</span>}
              {error && <span className="text-xs text-red-300">{error}</span>}
            </div>
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-400">
            <p>
              <span className="font-semibold text-slate-200">Note on model parameters.</span>{' '}
              {data.model_parameters_note}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
