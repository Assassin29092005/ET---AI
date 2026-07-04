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
      className="rounded-md border px-3 py-2"
      style={{ borderColor: `${color}55`, background: severityBg(node.severity) }}
      title={node.via.length ? node.via.join(' → ') : node.label}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-100">{node.label}</span>
        {m ? (
          <span className="font-mono text-[10px] tabular-nums font-semibold" style={{ color }}>
            {m.deltaLabel}
          </span>
        ) : (
          <span className="font-mono text-[10px] tabular-nums" style={{ color }}>
            {(node.severity * 100).toFixed(0)}
          </span>
        )}
      </div>
      {m && (
        <div className="mt-1 flex items-baseline gap-1.5 font-mono text-[11px] tabular-nums">
          <span className="text-slate-400">{fmtPrice(m.current)}</span>
          <span className="text-slate-600">→</span>
          <span style={{ color: downGood ? '#fbbf24' : color }}>{fmtPrice(m.projected)}</span>
          <span className="text-[9px] text-slate-500">{m.unit}</span>
        </div>
      )}
      <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-sm bg-slate-800">
        <div className="h-full" style={{ width: `${node.severity * 100}%`, background: color }} />
      </div>
      {showLag && node.lagDays > 0 && (
        <div className="mt-1 text-[10px] text-slate-500">~{node.lagDays}d lag</div>
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
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">{title}</div>
        <div className="text-[10px] text-slate-600">{subtitle}</div>
      </div>
      <div className="flex flex-col gap-2">
        {nodes.length === 0 ? (
          <div className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-[11px] text-slate-600">
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
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Impact engine</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-100">
          Impact cascade — any cause, everything it hits in India
        </h1>
        <p className="mt-1 text-xs text-slate-400 max-w-3xl">
          Pick a cause anywhere in the world. The dependency-graph engine traces the full chain
          reaction into India — commodities, industrial sectors, and macro variables — then the AI
          justifies the chain and flags the non-obvious second-order effect.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">Cause</label>
          <select
            value={causeId}
            onChange={(e) => setCauseId(e.target.value)}
            className="min-w-[280px] rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
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
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Intensity {(intensity * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            className="w-40"
          />
        </div>
        <button
          type="button"
          onClick={trace}
          disabled={loading}
          className="rounded-md border border-indigo-500/60 bg-indigo-500/20 px-4 py-1.5 text-sm font-semibold text-indigo-100 hover:bg-indigo-500/30 disabled:opacity-50"
        >
          {loading ? 'Tracing...' : 'Trace cascade'}
        </button>
        <div className="ml-auto flex items-center gap-3 text-[10px] uppercase tracking-wider text-slate-500">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: '#ef4444' }} />severe</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: '#f97316' }} />high</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: '#f59e0b' }} />moderate</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: '#10b981' }} />low</span>
        </div>
      </div>

      {selectedCause && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 text-xs text-slate-400">
          <span className="font-semibold text-slate-300">{selectedCause.label}</span>
          {selectedCause.region && <span className="ml-2 text-slate-500">· {selectedCause.region}</span>}
          {selectedCause.description && <span className="ml-2">— {selectedCause.description}</span>}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>
      )}

      {result && (
        <>
          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Cascade flow</h2>
              <span className="text-[10px] text-slate-500">
                {result.nodeCount} nodes · {result.edgesUsed.length} transmission edges
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[120px,1fr,1fr,1fr]">
              <div className="flex min-w-0 flex-col">
                <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Cause</div>
                <div
                  className="rounded-md border px-3 py-2"
                  style={{ borderColor: '#6366f155', background: 'rgba(99,102,241,0.12)' }}
                >
                  <span className="text-xs text-indigo-200">{result.causeLabel}</span>
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

          <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5">
            <div className="flex items-center justify-between border-b border-emerald-500/20 px-5 py-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-emerald-400/80">
                  AI cascade justification
                </div>
                <h3 className="text-sm font-semibold text-emerald-100">
                  Why this chain reaction, and what to watch
                </h3>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                {result.model}
              </span>
            </div>
            <div className="px-5 py-4">
              <p className="whitespace-pre-line text-sm leading-relaxed text-slate-200">
                {result.narrative || 'No narrative generated.'}
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
