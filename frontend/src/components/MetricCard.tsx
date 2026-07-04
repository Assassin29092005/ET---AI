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
  low: "border-l-op-good",
  elevated: "border-l-op-warn",
  high: "border-l-amber-500",
  critical: "border-l-op-danger",
};

const TREND_COLOR: Record<Trend["direction"], string> = {
  up: "text-op-good",
  down: "text-op-danger",
  flat: "text-op-ink3",
};

const TREND_ARROW: Record<Trend["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "·",
};

export function MetricCard({ label, value, subValue, tier, trend, unit }: MetricCardProps) {
  const borderClass = tier ? `border-l-2 ${TIER_BORDER[tier]}` : "";

  return (
    <div className={`rounded-md border border-op-border bg-op-panel p-4 ${borderClass}`}>
      <div className="text-micro uppercase tracking-wider text-op-ink3">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-2xl font-medium tabular-nums tracking-tighter text-op-ink">
          {typeof value === "number" ? value.toFixed(2) : value}
        </span>
        {unit && <span className="text-micro text-op-ink3">{unit}</span>}
        {trend && (
          <span className={`font-mono text-meta tabular-nums ${TREND_COLOR[trend.direction]}`}>
            {TREND_ARROW[trend.direction]}{" "}
            {trend.format === "pct"
              ? `${(trend.delta * 100).toFixed(1)}%`
              : trend.delta.toFixed(2)}
          </span>
        )}
      </div>
      {subValue && <div className="mt-1 text-meta text-op-ink2">{subValue}</div>}
    </div>
  );
}
