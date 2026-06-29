import { useEffect, useMemo, useState } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { getSourcing, getSourcingSubstitutes } from '@/lib/api';
import {
  COMMODITY_LABEL,
  CORRIDOR_LABEL,
  type Commodity,
  type Corridor,
  type DemandSubstitutes,
  type RouteStatus,
  type SourcingOption,
} from '@/lib/types';
import { fmtNumber } from '@/lib/fmt';
import CommodityBadge from '@/components/CommodityBadge';

const COMMODITIES: Commodity[] = [
  'crude_oil',
  'lng',
  'coking_coal',
  'lithium',
  'cobalt',
  'nickel',
  'rare_earths',
  'solar_pv',
  'uranium',
  'copper',
  'graphite',
  'manganese',
  'polysilicon',
  'silver',
  'thermal_coal',
  'pgm',
  'rock_phosphate',
  'potash',
];

// Chokepoints the user can simulate a full cutoff on.
const DISRUPTABLE_CORRIDORS: Corridor[] = [
  'hormuz',
  'bab_el_mandeb',
  'malacca',
  'south_china_sea',
  'suez',
  'cape_of_good_hope',
];

const PIE_COLORS = [
  '#6366f1',
  '#f97316',
  '#10b981',
  '#0ea5e9',
  '#a855f7',
  '#fbbf24',
  '#ef4444',
  '#84cc16',
  '#f43f5e',
  '#94a3b8',
  '#22d3ee',
  '#e879f9',
  '#facc15',
  '#4ade80',
];

const DEFAULT_VOLUME = 100;

const STATUS_PILL: Record<RouteStatus, string> = {
  open: 'border-emerald-500/40 text-emerald-300',
  disrupted: 'border-amber-500/40 text-amber-300',
  closed: 'border-red-500/50 text-red-300',
};

const MATURITY_PILL: Record<string, string> = {
  available: 'border-emerald-500/40 text-emerald-300',
  emerging: 'border-amber-500/40 text-amber-300',
  nascent: 'border-slate-500/40 text-slate-300',
};

export default function Sourcing() {
  const [commodity, setCommodity] = useState<Commodity>('crude_oil');
  const [disrupted, setDisrupted] = useState<Corridor | ''>('');
  const [options, setOptions] = useState<SourcingOption[]>([]);
  const [substitutes, setSubstitutes] = useState<DemandSubstitutes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    async function load() {
      try {
        const data = await getSourcing(commodity, DEFAULT_VOLUME, disrupted || null);
        if (cancelled) return;
        setOptions(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load sourcing');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [commodity, disrupted]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getSourcingSubstitutes(commodity);
        if (!cancelled) setSubstitutes(data);
      } catch {
        if (!cancelled) setSubstitutes(null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [commodity]);

  const shareByCountry = useMemo(() => {
    const map = new Map<string, number>();
    options
      .filter((o) => o.volumeMb > 0)
      .forEach((o) => map.set(o.country, (map.get(o.country) ?? 0) + o.volumeMb));
    return Array.from(map.entries()).map(([country, volume]) => ({ country, volume }));
  }, [options]);

  const closedCount = useMemo(
    () => options.filter((o) => o.routeStatus === 'closed').length,
    [options],
  );

  const recommendation = useMemo(() => {
    const openOptions = options.filter((o) => o.routeStatus !== 'closed');
    if (openOptions.length === 0) return null;
    const top = openOptions[0];
    const cleared = openOptions.filter((o) => o.sanctionsCheck === 'clear').length;
    return `Top open source: ${top.country} (${top.importSharePct.toFixed(0)}% of current imports). ${cleared} of ${openOptions.length} open options pass sanctions check. Composite risk ${top.routeRiskScore.toFixed(0)} via ${top.routeCorridor}.`;
  }, [options]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Procurement</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-100">Sourcing intelligence</h1>
          <p className="mt-1 text-xs text-slate-400">
            Ranks suppliers by live corridor risk + import share + lead-time, and surfaces
            demand-side substitutes. Does NOT validate refinery / smelter chemistry.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-[11px] uppercase tracking-wider text-slate-500">Commodity</label>
            <select
              value={commodity}
              onChange={(e) => setCommodity(e.target.value as Commodity)}
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
            >
              {COMMODITIES.map((c) => (
                <option key={c} value={c}>
                  {COMMODITY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] uppercase tracking-wider text-slate-500">
              Simulate cutoff
            </label>
            <select
              value={disrupted}
              onChange={(e) => setDisrupted(e.target.value as Corridor | '')}
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 focus:border-red-500 focus:outline-none"
            >
              <option value="">None (live risk)</option>
              {DISRUPTABLE_CORRIDORS.map((c) => (
                <option key={c} value={c}>
                  {CORRIDOR_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {disrupted && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Simulating <span className="font-semibold">{CORRIDOR_LABEL[disrupted]}</span> full cutoff —{' '}
          {closedCount} route{closedCount === 1 ? '' : 's'} closed; recommended volume reallocated to
          open suppliers. Risk for that corridor is forced to 100.
        </div>
      )}

      {recommendation && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-200">
          {recommendation}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px,1fr]">
        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Suggested mix
          </h3>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                />
                <Pie
                  data={shareByCountry}
                  dataKey="volume"
                  nameKey="country"
                  innerRadius={48}
                  outerRadius={84}
                  paddingAngle={2}
                  strokeWidth={0}
                >
                  {shareByCountry.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {shareByCountry.map((s, i) => (
              <li key={s.country} className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span className="h-2 w-2 rounded-sm" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  {s.country}
                </span>
                <span className="tabular-nums text-slate-500">{fmtNumber(s.volume, 1)} MB</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-100">
              {COMMODITY_LABEL[commodity]} ranked alternatives
            </h3>
            <CommodityBadge commodity={commodity} size="md" />
          </div>
          {loading && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">Loading...</div>
          )}
          {!loading && options.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">
              No alternative sources found for this commodity.
            </div>
          )}
          {!loading && options.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-900/50 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left">#</th>
                  <th className="px-4 py-2 text-left">Supplier / country</th>
                  <th className="px-4 py-2 text-right">Import share</th>
                  <th className="px-4 py-2 text-right">Vol MB</th>
                  <th className="px-4 py-2 text-right">Price USD</th>
                  <th className="px-4 py-2 text-right">Lead time</th>
                  <th className="px-4 py-2 text-left">Corridor / status</th>
                  <th className="px-4 py-2 text-right">Risk</th>
                  <th className="px-4 py-2 text-left">Sanctions</th>
                </tr>
              </thead>
              <tbody>
                {options.map((o) => {
                  const isClosed = o.routeStatus === 'closed';
                  return (
                    <tr
                      key={`${o.supplier}-${o.country}-${o.rank}`}
                      className={`border-t border-slate-800 ${isClosed ? 'opacity-50' : ''}`}
                    >
                      <td className="px-4 py-2 text-slate-300 tabular-nums">{o.rank}</td>
                      <td className="px-4 py-2">
                        <div className={`text-slate-200 ${isClosed ? 'line-through' : ''}`}>
                          {o.supplier}
                        </div>
                        <div className="text-[11px] text-slate-500">{o.country}</div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-200">
                        {o.importSharePct.toFixed(1)}%
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                        {o.volumeMb > 0 ? fmtNumber(o.volumeMb, 1) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                        ${o.priceUsd.toFixed(2)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">{o.leadTimeDays} d</td>
                      <td className="px-4 py-2 text-xs text-slate-400">
                        <div>{o.routeCorridor}</div>
                        {o.routeStatus !== 'open' && (
                          <span
                            className={`mt-0.5 inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_PILL[o.routeStatus]}`}
                          >
                            {o.routeStatus}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                        {o.routeRiskScore.toFixed(0)}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={
                            o.sanctionsCheck === 'clear'
                              ? 'text-emerald-300'
                              : o.sanctionsCheck === 'flag'
                                ? 'text-amber-300'
                                : 'text-red-300'
                          }
                        >
                          {o.sanctionsCheck}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="border-t border-slate-800 px-5 py-2 text-[11px] text-slate-500">
            Risk is the live corridor composite (matches the dashboard); a simulated cutoff forces
            the corridor to 100 and reallocates volume to open routes.
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-slate-800 bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Demand-side substitution · alternate use cases
            </h3>
            {substitutes?.primaryUse && (
              <p className="mt-0.5 text-xs text-slate-400">
                Primary end-use: {substitutes.primaryUse}
              </p>
            )}
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
            reduces / replaces demand
          </span>
        </div>
        {!substitutes || substitutes.substitutes.length === 0 ? (
          <div className="px-5 py-6 text-sm text-slate-500">
            No demand-side substitutes modelled for {COMMODITY_LABEL[commodity]} yet.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {substitutes.substitutes.map((sub) => (
                <div
                  key={sub.name}
                  className="flex flex-col gap-2 rounded-md border border-slate-800 bg-slate-950/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-slate-100">{sub.name}</span>
                    <span
                      className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                        MATURITY_PILL[sub.maturity] ?? 'border-slate-600 text-slate-400'
                      }`}
                    >
                      {sub.maturity}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="font-mono uppercase tracking-wider text-slate-500">
                      {sub.type}
                    </span>
                    <span className="tabular-nums text-emerald-300">
                      ~{sub.displacementPct}% displaceable
                    </span>
                    <span className="tabular-nums text-slate-500">{sub.leadTimeMonths} mo</span>
                  </div>
                  <p className="text-xs leading-relaxed text-slate-400">{sub.note}</p>
                </div>
              ))}
            </div>
            {substitutes.disclaimer && (
              <div className="border-t border-slate-800 px-5 py-2 text-[11px] text-slate-500">
                {substitutes.disclaimer}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
