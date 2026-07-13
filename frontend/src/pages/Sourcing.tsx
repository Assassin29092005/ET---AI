import { useEffect, useMemo, useState } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import {
  getSourcing,
  getSourcingSubstitutes,
  postCascadeAnalysis,
  type CascadeAnalysisResponse,
} from '@/lib/api';
import {
  COMMODITY_LABEL,
  CORRIDOR_LABEL,
  type Commodity,
  type Corridor,
  type DemandSubstitutes,
  type RouteStatus,
  type SourcingOption,
} from '@/lib/types';
import { commodityUnitShort, fmtNumber } from '@/lib/fmt';
import CommodityBadge from '@/components/CommodityBadge';
import { Chip, type ChipTone } from '@/components/Chip';

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

// Domain value -> shared Chip tone (semantic colors live in the Chip component).
const STATUS_TONE: Record<RouteStatus, ChipTone> = {
  open: 'low',
  disrupted: 'flag',
  closed: 'block',
};

const MATURITY_TONE: Record<string, ChipTone> = {
  available: 'low',
  emerging: 'elev',
  nascent: 'neutral',
};

const TANKER_TONE: Record<string, ChipTone> = {
  ample: 'low',
  tight: 'elev',
  constrained: 'crit',
};

const GRADE_TONE: Record<string, ChipTone> = {
  match: 'low',
  mismatch: 'crit',
  unknown: 'neutral',
  'n/a': 'neutral',
};

export default function Sourcing() {
  const [commodity, setCommodity] = useState<Commodity>('crude_oil');
  const [disrupted, setDisrupted] = useState<Corridor | ''>('');
  const [options, setOptions] = useState<SourcingOption[]>([]);
  const [substitutes, setSubstitutes] = useState<DemandSubstitutes | null>(null);
  const [cascade, setCascade] = useState<CascadeAnalysisResponse | null>(null);
  const [cascadeLoading, setCascadeLoading] = useState(false);
  const [cascadeError, setCascadeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runCascade() {
    setCascadeLoading(true);
    setCascadeError(null);
    try {
      const data = await postCascadeAnalysis(commodity, disrupted || null);
      setCascade(data);
    } catch (e) {
      setCascadeError(e instanceof Error ? e.message : 'Cascade analysis failed');
    } finally {
      setCascadeLoading(false);
    }
  }

  useEffect(() => {
    setCascade(null);
    setCascadeError(null);
  }, [commodity, disrupted]);

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

  const computeTimeMs = options.length > 0 ? (options[0] as unknown as Record<string, unknown>).computeTimeMs as number | undefined : undefined;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Procurement</p>
          <h1 className="mt-1 text-2xl font-bold text-white leading-tight">Sourcing Intelligence</h1>
          <p className="mt-1 text-xs text-slate-400 font-medium">
            6-factor composite: corridor risk + import share + lead-time + spot pricing + tanker availability + grade compatibility.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold text-slate-400">Commodity</label>
            <select
              value={commodity}
              onChange={(e) => setCommodity(e.target.value as Commodity)}
              className="input-op font-medium"
            >
              {COMMODITIES.map((c) => (
                <option key={c} value={c}>
                  {COMMODITY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold text-slate-400">
              Simulate Cutoff
            </label>
            <select
              value={disrupted}
              onChange={(e) => setDisrupted(e.target.value as Corridor | '')}
              className="input-op font-medium focus:border-red-500 focus:ring-red-500"
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
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 font-medium shadow-sm">
          Simulating <span className="font-bold">{CORRIDOR_LABEL[disrupted]}</span> full cutoff —{' '}
          {closedCount} route{closedCount === 1 ? '' : 's'} closed; recommended volume reallocated to
          open suppliers. Risk for that corridor is forced to 100.
        </div>
      )}

      {recommendation && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 font-medium shadow-sm">
          {recommendation}
        </div>
      )}

      {!loading && options.length > 0 && (
        <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 shadow-sm">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-[pulse_2s_ease-in-out_1]" />
            Ranked {options.filter(o => o.routeStatus !== 'closed').length} open alternatives
            {computeTimeMs != null && <> in <span className="font-bold text-slate-600">{computeTimeMs.toFixed(0)} ms</span></>}
          </span>
          <span className="text-slate-300">
            6-factor composite · spot-linked pricing · AIS tanker proxy · grade match
          </span>
        </div>
      )}

      <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-emerald-800">
              Cascade reasoning (AI)
            </h3>
            <p className="mt-1 text-xs text-emerald-700/80 font-medium">
              Walks the chain reaction from disruption → refineries → downstream sectors → macro, then justifies the top alternatives by which cascade step each one mitigates.
            </p>
          </div>
          <button
            type="button"
            onClick={runCascade}
            disabled={cascadeLoading}
            className="rounded-lg border border-emerald-500 bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors duration-150 shadow-sm"
          >
            {cascadeLoading
              ? 'Analysing...'
              : cascade
                ? 'Re-analyse'
                : disrupted
                  ? `Analyse cascade — ${CORRIDOR_LABEL[disrupted]} cutoff`
                  : 'Analyse current risk picture'}
          </button>
        </div>
        {cascadeError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 font-medium">
            {cascadeError}
          </div>
        )}
        {cascade && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <span>Cascade analysis · {cascade.disruptedCorridor ?? 'no specific disruption'}</span>
              <span className="font-mono">{cascade.model}</span>
            </div>
            <p className="whitespace-pre-line text-xs leading-relaxed text-slate-600 font-medium">
              {cascade.narrative}
            </p>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px,1fr]">
        <section className="card p-5">
          <h3 className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Suggested Mix
          </h3>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip
                  contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 11, color: '#334155' }}
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
          <ul className="mt-3 space-y-2 text-xs">
            {shareByCountry.map((s, i) => (
              <li key={s.country} className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-slate-600 font-medium">
                  <span className="h-2 w-2 rounded-sm" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  {s.country}
                </span>
                <span className="font-mono text-slate-400 font-semibold">{fmtNumber(s.volume, 1)} {commodityUnitShort(commodity)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 bg-slate-50">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-3">
              <span>{COMMODITY_LABEL[commodity]} Ranked Alternatives</span>
              <a
                href={`/api/export/sourcing/${commodity}.csv`}
                download
                className="inline-flex items-center gap-1 rounded bg-white border border-slate-200 hover:border-slate-300 px-2 py-0.5 text-[10px] font-bold text-slate-600 transition-colors shadow-sm"
              >
                <svg className="w-3 h-3 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export CSV
              </a>
            </h3>
            <CommodityBadge commodity={commodity} size="md" />
          </div>
          {loading && (
            <div className="px-5 py-8 text-center text-sm text-slate-400 font-medium">Loading...</div>
          )}
          {!loading && options.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-400 font-medium">
              No alternative sources found for this commodity.
            </div>
          )}
          {!loading && options.length > 0 && (
            <div className="overflow-x-auto">
              <table className="table-op">
                <thead>
                  <tr>
                    <th className="px-4 py-2 text-left">#</th>
                    <th className="px-4 py-2 text-left">Supplier / Country</th>
                    <th className="px-4 py-2 text-right">Import Share</th>
                    <th className="px-4 py-2 text-right">Vol ({commodityUnitShort(commodity)})</th>
                    <th className="px-4 py-2 text-right">Landed Price</th>
                    <th className="px-4 py-2 text-right">Lead Time</th>
                    <th className="px-4 py-2 text-left">Corridor / Status</th>
                    <th className="px-4 py-2 text-right">Risk</th>
                    <th className="px-4 py-2 text-left">Tanker</th>
                    <th className="px-4 py-2 text-left">Grade</th>
                    <th className="px-4 py-2 text-left">Sanctions</th>
                  </tr>
                </thead>
                <tbody>
                  {options.map((o) => {
                    const isClosed = o.routeStatus === 'closed';
                    return (
                      <tr
                        key={`${o.supplier}-${o.country}-${o.rank}`}
                        className={`border-t border-slate-100 hover:bg-slate-50/50 ${isClosed ? 'opacity-50' : ''}`}
                      >
                        <td className="px-4 py-3 text-slate-400 font-mono font-bold text-xs">{o.rank}</td>
                        <td className="px-4 py-3">
                          <div className={`text-slate-800 font-bold ${isClosed ? 'line-through' : ''}`}>
                            {o.supplier}
                          </div>
                          <div className="text-[10px] text-slate-400 font-semibold">{o.country}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700 font-semibold">
                          {o.importSharePct.toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700 font-medium">
                          {o.volumeMb > 0 ? fmtNumber(o.volumeMb, 1) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-700 font-medium">
                          <div className="font-mono font-bold">${o.priceUsd.toFixed(2)}</div>
                          <div className="text-[9px] text-slate-400 font-semibold mt-0.5">
                            {o.priceUnit ?? 'USD'}
                            {o.priceSource === 'spot' && o.spotPriceUsd
                              ? ` · spot $${o.spotPriceUsd.toFixed(2)}`
                              : ' · planning'}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-700 font-medium">
                          <div className="font-mono font-bold">{o.leadTimeDays} d</div>
                          {o.portDelayDays != null && o.portDelayDays > 0 && (
                            <div className="text-[9px] text-amber-600 font-semibold mt-0.5">
                              +{o.portDelayDays.toFixed(1)}d port
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600 font-medium">
                          <div>{o.routeCorridor}</div>
                          {o.routeStatus !== 'open' && (
                            <Chip tone={STATUS_TONE[o.routeStatus]} className="mt-1 uppercase tracking-wider">
                              {o.routeStatus}
                            </Chip>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-slate-800">
                          {o.routeRiskScore.toFixed(0)}
                        </td>
                        <td className="px-4 py-3">
                          {o.tankerAvailability ? (
                            <Chip
                              tone={TANKER_TONE[o.tankerAvailability] ?? 'neutral'}
                              className="uppercase tracking-wider"
                              title={
                                o.vesselsInCorridor != null
                                  ? `${o.vesselsInCorridor} vessels in corridor · util ${(o.tankerUtilisation ?? 0).toFixed(2)}`
                                  : undefined
                              }
                            >
                              {o.tankerAvailability}
                            </Chip>
                          ) : (
                            <span className="text-slate-400 font-mono">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {o.gradeCompat && o.gradeCompat !== 'n/a' ? (
                            <Chip
                              tone={GRADE_TONE[o.gradeCompat] ?? 'neutral'}
                              className="uppercase tracking-wider"
                              title={o.gradeNote || undefined}
                            >
                              {o.gradeCompat}
                            </Chip>
                          ) : (
                            <span className="text-slate-400 text-xs font-semibold">n/a</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Chip tone={o.sanctionsCheck} className="uppercase tracking-wider">
                            {o.sanctionsCheck}
                          </Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-slate-100 px-5 py-3.5 text-[10px] text-slate-400 font-semibold bg-slate-50/50">
            Price is spot × (risk premium + freight premium tied to tanker tightness). Lead-time
            includes live port-congestion delay from the twin. Grade compatibility is a coarse
            planner tag against Indian refinery slates — nomination still needs assay + config sign-off.
          </div>
        </section>
      </div>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-4 bg-slate-50">
          <div>
            <h3 className="text-sm font-bold text-slate-800">
              Demand-side substitution · alternate use cases
            </h3>
            {substitutes?.primaryUse && (
              <p className="mt-1 text-xs text-slate-400 font-medium">
                Primary end-use: {substitutes.primaryUse}
              </p>
            )}
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 font-bold">
            reduces / replaces demand
          </span>
        </div>
        {!substitutes || substitutes.substitutes.length === 0 ? (
          <div className="px-5 py-6 text-sm text-slate-400 font-medium">
            No demand-side substitutes modelled for {COMMODITY_LABEL[commodity]} yet.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
              {substitutes.substitutes.map((sub) => (
                <div
                  key={sub.name}
                  className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50/50 p-4 hover:shadow-sm transition-all duration-150"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-bold text-slate-800">{sub.name}</span>
                    <Chip
                      tone={MATURITY_TONE[sub.maturity] ?? 'neutral'}
                      className="shrink-0 uppercase tracking-wider"
                    >
                      {sub.maturity}
                    </Chip>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="font-mono uppercase tracking-wider text-slate-500 font-bold text-[10px]">
                      {sub.type}
                    </span>
                    <span className="tabular-nums text-emerald-600 font-bold text-[10px]">
                      ~{sub.displacementPct}% displaceable
                    </span>
                    <span className="tabular-nums text-slate-400 font-mono text-[10px] font-semibold">{sub.leadTimeMonths} mo lead</span>
                  </div>
                  <p className="text-xs leading-relaxed text-slate-600 font-medium mt-1">{sub.note}</p>
                </div>
              ))}
            </div>
            {substitutes.disclaimer && (
              <div className="border-t border-slate-200 px-5 py-3 text-[10px] text-slate-400 font-semibold bg-slate-50/50">
                {substitutes.disclaimer}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
