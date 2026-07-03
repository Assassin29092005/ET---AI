import type { RiskTier } from "../lib/types";

interface Trend {
  direction: "up" | "down" | "flat";
  delta: number;
  format?: "pct" | "abs";
}

interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  tier?: RiskTier;
  trend?: Trend;
  unit?: string;
}

const TIER_BORDER: Record<RiskTier, string> = {
  low: "border-l-emerald-500",
  elevated: "border-l-amber-500",
  high: "border-l-orange-500",
  critical: "border-l-red-500",
};

const TREND_COLOR: Record<Trend["direction"], string> = {
  up: "text-emerald-600 bg-emerald-50 border-emerald-100",
  down: "text-red-600 bg-red-50 border-red-100",
  flat: "text-slate-500 bg-slate-50 border-slate-100",
};

const TREND_ARROW: Record<Trend["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "•",
};

export function MetricCard({ label, value, subValue, tier, trend, unit }: MetricCardProps) {
  const borderClass = tier ? `border-l-4 ${TIER_BORDER[tier]}` : "";

  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-5 shadow-card transition-all duration-150 hover:shadow-card-hover ${borderClass}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-3 flex items-baseline gap-2 flex-wrap">
        <span className="font-mono text-3xl font-bold tabular-nums tracking-tighter text-slate-800">
          {typeof value === "number" ? value.toFixed(2) : value}
        </span>
        {unit && <span className="text-xs font-semibold text-slate-400">{unit}</span>}
        {trend && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border ${TREND_COLOR[trend.direction]}`}>
            <span>{TREND_ARROW[trend.direction]}</span>
            <span className="font-mono">
              {trend.format === "pct"
                ? `${(trend.delta * 100).toFixed(1)}%`
                : trend.delta.toFixed(2)}
            </span>
          </span>
        )}
      </div>
      {subValue && <div className="mt-2 text-xs font-medium text-slate-500">{subValue}</div>}
    </div>
  );
}
