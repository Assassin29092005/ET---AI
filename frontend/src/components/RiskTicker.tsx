import { useState } from "react";
import type { FeedItem } from "../lib/types";
import { fmtIstTime, tierFromImportance } from "../lib/fmt";

interface RiskTickerProps {
  items: FeedItem[];
}

const TIER_STRIPE: Record<string, string> = {
  low: "bg-op-good",
  elevated: "bg-op-warn",
  high: "bg-amber-500",
  critical: "bg-op-danger",
};

const TIER_LABEL: Record<string, string> = {
  low: "text-op-good",
  elevated: "text-op-warn",
  high: "text-amber-300",
  critical: "text-op-danger",
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
      <div className="rounded-md border border-op-border bg-op-panel p-6 text-sm text-op-ink3">
        No active risk alerts.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-op-border bg-op-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-op-border px-4 py-2.5">
        <h3 className="text-micro uppercase tracking-wider text-op-ink3">Risk feed</h3>
        <span className="font-mono text-micro tabular-nums text-op-ink3">{items.length}</span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto divide-y divide-op-border">
        {items.map((item) => {
          const id = item.id ?? `${item.source}-${item.publishedAt}`;
          const tier = tierFromImportance(item.importance);
          const isOpen = expanded.has(id);
          return (
            <div key={id} className="flex hover:bg-op-panel2 transition-colors duration-150">
              <div className={`w-[3px] shrink-0 ${TIER_STRIPE[tier] ?? "bg-op-ink3"}`} />
              <button
                type="button"
                onClick={() => toggle(id)}
                className="flex-1 px-4 py-2.5 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-micro tabular-nums text-op-ink3">
                    {fmtTimeUtc(item.publishedAt)}
                  </span>
                  <span className="font-mono text-micro uppercase tracking-wider text-op-ink2">
                    {item.source}
                  </span>
                  <span className={`font-mono text-micro uppercase tracking-wider ${TIER_LABEL[tier]}`}>
                    · {tier}
                  </span>
                  {item.commodity && (
                    <span className="font-mono text-micro uppercase tracking-wider text-op-ink3">
                      · {item.commodity.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-op-ink line-clamp-2 leading-snug">{item.headline}</p>
                {isOpen && (
                  <div className="mt-2 border-l border-op-border pl-3">
                    <p className="text-sm leading-relaxed text-op-ink2">{item.summary}</p>
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block rounded border border-op-border px-2 py-0.5 font-mono text-micro uppercase tracking-wider text-op-accent hover:border-op-accent"
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
