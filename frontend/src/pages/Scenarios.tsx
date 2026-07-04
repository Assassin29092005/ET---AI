import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getScenarios, type ScenarioMeta } from '@/lib/api';
import { CORRIDOR_LABEL, COMMODITY_LABEL } from '@/lib/types';

export default function Scenarios() {
  const [items, setItems] = useState<ScenarioMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getScenarios()
      .then((data) => {
        if (!cancelled) {
          setItems(data);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load scenarios');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Catalogue</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-100">Stress scenarios</h1>
          <p className="mt-1 text-xs text-slate-400">
            Seven named disruptions spanning crude, LNG, coking coal, critical minerals, solar PV and uranium.
          </p>
        </div>
        <Link
          to="/compare"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:border-indigo-500 hover:text-slate-100"
        >
          Compare scenarios →
        </Link>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-500">
          Loading scenarios...
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((s) => (
            <Link
              key={s.name}
              to={`/scenarios/${s.name}`}
              className="group flex flex-col rounded-lg border border-slate-800 bg-slate-900 p-4 transition hover:border-indigo-500/60"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                  {COMMODITY_LABEL[s.primary_commodity] ?? s.primary_commodity}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">
                  {CORRIDOR_LABEL[s.primary_corridor] ?? s.primary_corridor}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-slate-100">{s.label}</h3>
              <p className="mt-2 line-clamp-3 text-xs text-slate-400 leading-relaxed">{s.description}</p>
              <span className="mt-3 text-[11px] uppercase tracking-wider text-indigo-400 group-hover:text-indigo-300">
                Run scenario →
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
