import { useState } from "react";
import type { FeedItem } from "../lib/types";
import { fmtIstTime, tierFromImportance } from "../lib/fmt";

interface RiskTickerProps {
  items: FeedItem[];
}

const TIER_STRIPE: Record<string, string> = {
  low: "bg-emerald-500",
  elevated: "bg-amber-500",
  high: "bg-orange-500",
  critical: "bg-red-500",
};

const TIER_LABEL: Record<string, string> = {
  low: "text-emerald-600 font-semibold",
  elevated: "text-amber-600 font-semibold",
  high: "text-orange-600 font-semibold",
  critical: "text-red-600 font-semibold",
};

const fmtTimeUtc = fmtIstTime;

export function RiskTicker({ items }: RiskTickerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!items || items.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-400">
        No active risk alerts.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-card">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 bg-slate-50">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Risk feed</h3>
        <span className="font-mono text-xs font-semibold text-slate-400 bg-slate-200/60 px-2 py-0.5 rounded-full">{items.length}</span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto divide-y divide-slate-100">
        {items.map((item) => {
          const id = item.id ?? `${item.source}-${item.publishedAt}`;
          const tier = tierFromImportance(item.importance);
          const isOpen = expanded.has(id);
          return (
            <div key={id} className="flex hover:bg-slate-50 transition-colors duration-150">
              <div className={`w-[3.5px] shrink-0 ${TIER_STRIPE[tier] ?? "bg-slate-300"}`} />
              <button
                type="button"
                onClick={() => toggle(id)}
                className="flex-1 px-5 py-3 text-left"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[10px] tabular-nums text-slate-400">
                    {fmtTimeUtc(item.publishedAt)}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 font-semibold border-l border-slate-200 pl-2">
                    {item.source}
                  </span>
                  <span className={`font-mono text-[10px] uppercase tracking-wider ${TIER_LABEL[tier]}`}>
                    · {tier}
                  </span>
                  {item.commodity && (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                      · {item.commodity.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-sm font-medium text-slate-800 line-clamp-2 leading-snug">{item.headline}</p>
                {isOpen && (
                  <div className="mt-2.5 border-l-2 border-slate-200 pl-3 py-0.5">
                    <p className="text-xs leading-relaxed text-slate-600 font-medium">{item.summary}</p>
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2.5 inline-flex items-center rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-blue-600 hover:border-blue-600 hover:text-blue-700 font-semibold"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {item.source}
                      </a>
                    )}
                  </div>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default RiskTicker;
