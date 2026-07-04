import type { ReactNode } from "react";
import type { RiskTier } from "@/lib/types";

type Tone = RiskTier | "neutral" | "good" | "accent";

const TONE_COLOR: Record<Tone, string> = {
  low: "#10B981",
  elevated: "#F59E0B",
  high: "#F97316",
  critical: "#EF4444",
  good: "#10B981",
  accent: "#2563EB",
  neutral: "#CBD5E1",
};

interface KpiTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Left accent + value color. Defaults to neutral (value stays ink-colored). */
  tone?: Tone;
  sub?: ReactNode;
}

/**
 * A KPI stat tile with a left tier accent. Value takes the tone color unless
 * neutral. Presentation only.
 */
export function KpiTile({ label, value, unit, tone = "neutral", sub }: KpiTileProps) {
  const color = TONE_COLOR[tone];
  return (
    <div className="kpi-tile" style={{ borderLeftColor: color }}>
      <div className="eyebrow-kicker">{label}</div>
      <div
        className="kpi-value mt-2"
        style={{ color: tone === "neutral" ? undefined : color }}
      >
        {value}
        {unit && <span className="ml-1 text-xs font-medium text-op-ink3">{unit}</span>}
      </div>
      {sub && <div className="mt-1 text-micro text-op-ink3">{sub}</div>}
    </div>
  );
}

export default KpiTile;
