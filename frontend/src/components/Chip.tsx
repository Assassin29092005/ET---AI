import clsx from "clsx";
import type { ReactNode } from "react";
import type { RiskTier } from "@/lib/types";

/** Semantic chip variants. Status/tier color is intentionally separate from the accent hue. */
export type ChipTone =
  | "crit"
  | "high"
  | "elev"
  | "low"
  | "clear"
  | "flag"
  | "block"
  | "neutral"
  | "accent";

interface ChipProps {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
  /** Native tooltip text. */
  title?: string;
}

export function Chip({ tone = "neutral", children, className, title }: ChipProps) {
  return (
    <span className={clsx("chip", `chip-${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

/** Map a 0..100 risk tier to a chip tone. */
export function tierTone(tier: RiskTier): ChipTone {
  switch (tier) {
    case "critical":
      return "crit";
    case "high":
      return "high";
    case "elevated":
      return "elev";
    case "low":
    default:
      return "low";
  }
}

/** Map a sanctions-check outcome to a chip tone. */
export function sanctionsTone(check: "clear" | "flag" | "block"): ChipTone {
  return check;
}

export default Chip;
