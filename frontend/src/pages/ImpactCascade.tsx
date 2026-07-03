import { useEffect, useMemo, useState } from 'react';
import {
  getCascadeCauses,
  postImpactCascade,
  type CascadeCause,
  type CascadeImpactNode,
  type ImpactCascadeResponse,
} from '@/lib/api';

const CAUSE_TYPE_LABEL: Record<string, string> = {
  corridor: 'Maritime corridors',
  country: 'Country events',
  commodity: 'Commodity shocks',
  cause: 'Other',
};

function severityColor(s: number): string {
  if (s >= 0.6) return '#ef4444';
  if (s >= 0.4) return '#f97316';
  if (s >= 0.2) return '#f59e0b';
  return '#10b981';
}

function severityBg(s: number): string {
  if (s >= 0.6) return 'rgba(239,68,68,0.12)';
  if (s >= 0.4) return 'rgba(249,115,22,0.12)';
  if (s >= 0.2) return 'rgba(245,158,11,0.12)';
  return 'rgba(16,185,129,0.10)';
}

function fmtPrice(v: number): string {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function NodeChip({ node, showLag }: { node: CascadeImpactNode; showLag?: boolean }) {
  const color = severityColor(node.severity);
  const m = node.metric;
  const downGood = m?.direction === 'down';
  return (
    <div
      className="rounded-lg border px-3 py-2.5 transition-shadow hover:shadow-sm bg-white"
      style={{ borderColor: `${color}33` }}
      title={node.via.length ? node.via.join(' → ') : node.label}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-800">{node.label}</span>
        {m ? (
          <span className="font-mono text-[10px] tabular-nums font-bold" style={{ color }}>
            {m.deltaLabel}
          </span>
        ) : (
          <span className="font-mono text-[10px] tabular-nums font-bold" style={{ color }}>
            {(node.severity * 100).toFixed(0)}
          </span>
        )}
      </div>
      {m && (
        <div className="mt-1 flex items-baseline gap-1.5 font-mono text-[10px] tabular-nums">
          <span className="text-slate-400 font-medium">{fmtPrice(m.current)}</span>
          <span className="text-slate-350">→</span>
          <span className="font-bold" style={{ color: downGood ? '#b45309' : color }}>{fmtPrice(m.projected)}</span>
          <span className="text-[9px] text-slate-400 font-semibold font-sans lowercase">{m.unit}</span>
        </div>
      )}
      <div className="mt-2 h-[3px] w-full overflow-hidden rounded-sm bg-slate-100">
        <div className="h-full" style={{ width: `${node.severity * 100}%`, background: color }} />
      </div>
      {showLag && node.lagDays > 0 && (
        <div className="mt-1 text-[9px] text-slate-400 font-semibold">~{node.lagDays}d lag</div>
      )}
    </div>
  );
}

function Column({
  title,
  subtitle,
  nodes,
  showLag,
  empty,
}: {
  title: string;
  subtitle: string;
  nodes: CascadeImpactNode[];
  showLag?: boolean;
  empty?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-2 px-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</div>
        <div className="text-[10px] text-slate-400 font-semibold mt-0.5">{subtitle}</div>
      </div>
      <div className="flex flex-col gap-2.5">
        {nodes.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-400 font-medium">
            {empty ?? 'No nodes reached'}
          </div>
        ) : (
          nodes.map((n) => <NodeChip key={n.id} node={n} showLag={showLag} />)
        )}
      </div>
    </div>
  );
}

export default function ImpactCascade() {
  const [causes, setCauses] = useState<CascadeCause[]>([]);
  const [causeId, setCauseId] = useState<string>('corridor:hormuz');
  const [intensity, setIntensity] = useState<number>(1.0);
  const [result, setResult] = useState<ImpactCascadeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCascadeCauses()
      .then((data) => {
        setCauses(data);
        if (data.length && !data.find((c) => c.id === causeId)) setCauseId(data[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load causes'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function trace() {
    setLoading(true);
    setError(null);
    try {
      const data = await postImpactCascade(causeId, intensity, true);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cascade failed');
    } finally {
      setLoading(false);
    }
  }

  // Auto-run on first mount once causes are available
  useEffect(() => {
    if (causes.length && !result) trace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [causes.length]);

  const groupedCauses = useMemo(() => {
    const groups: Record<string, CascadeCause[]> = {};
    causes.forEach((c) => {
      const k = c.type || 'cause';
      (groups[k] ??= []).push(c);
    });
    return groups;
  }, [causes]);

  const selectedCause = causes.find((c) => c.id === causeId);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Impact Engine</p>
        <h1 className="mt-1 text-2xl font-bold text-white leading-tight">
          Impact Cascade Analysis
        </h1>
        <p className="mt-1 text-xs text-slate-400 font-medium max-w-3xl">
          Pick a cause anywhere in the world. The dependency-graph engine traces the full chain
          reaction into India — commodities, industrial sectors, and macro variables.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-4 card p-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-405 text-slate-400">Cause</label>
          <select
            value={causeId}
            onChange={(e) => setCauseId(e.target.value)}
            className="min-w-[280px] input-op font-medium"
          >
            {Object.entries(groupedCauses).map(([type, list]) => (
              <optgroup key={type} label={CAUSE_TYPE_LABEL[type] ?? type}>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Intensity: {(intensity * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            className="w-40 accent-blue-600 cursor-pointer"
          />
        </div>
        <button
          type="button"
          onClick={trace}
          disabled={loading}
          className="btn-accent px-5 py-2 text-xs font-semibold bg-blue-600 border-blue-600 text-white hover:bg-blue-700 hover:border-blue-700 disabled:opacity-50 h-[38px] flex items-center justify-center min-w-[120px]"
        >
          {loading ? 'Tracing...' : 'Trace Cascade'}
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[9px] font-bold uppercase tracking-wider text-slate-400">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: '#ef4444' }} />severe</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: '#f97316' }} />high</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: '#f59e0b' }} />moderate</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: '#10b981' }} />low</span>
        </div>
      </div>

      {selectedCause && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-500 font-medium shadow-sm">
          <span className="font-bold text-slate-700">{selectedCause.label}</span>
          {selectedCause.region && <span className="ml-2 text-slate-400">· {selectedCause.region}</span>}
          {selectedCause.description && <span className="ml-2 text-slate-400 font-normal">— {selectedCause.description}</span>}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 font-medium">{error}</div>
      )}

      {result && (
        <>
          <section className="card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-800">Cascade Flow</h2>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                {result.nodeCount} nodes · {result.edgesUsed.length} transmission edges
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[120px,1fr,1fr,1fr]">
              <div className="flex min-w-0 flex-col">
                <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Cause</div>
                <div
                  className="rounded-lg border px-3 py-2.5 flex items-center justify-center text-center font-bold bg-indigo-50/50"
                  style={{ borderColor: '#6366f133' }}
                >
                  <span className="text-xs text-indigo-700">{result.causeLabel}</span>
                </div>
              </div>
              <Column
                title="Commodities hit"
                subtitle="current → projected price"
                nodes={result.affectedCommodities}
              />
              <Column
                title="Indian sectors"
                subtitle="current → projected (Rs)"
                nodes={result.sectorImpacts}
                showLag
              />
              <Column
                title="Macro variables"
                subtitle="CPI · INR · GDP · fiscal"
                nodes={result.macroImpacts}
                showLag
              />
            </div>
          </section>

          <section className="rounded-xl border border-emerald-250 bg-emerald-50/50 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-emerald-200 px-5 py-4 bg-emerald-100/30">
              <div>
                <div className="text-[9px] font-bold uppercase tracking-wider text-emerald-700">
                  AI cascade justification
                </div>
                <h3 className="text-sm font-bold text-emerald-800 mt-0.5">
                  Why this chain reaction, and what to watch
                </h3>
              </div>
              <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-slate-400">
                {result.model}
              </span>
            </div>
            <div className="px-5 py-4">
              <p className="whitespace-pre-line text-xs leading-relaxed text-slate-650 font-medium">
                {result.narrative || 'No narrative generated.'}
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
