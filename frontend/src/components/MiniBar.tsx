interface MiniBarProps {
  value: number;
  max?: number;
  /** CSS color for the fill. Defaults to the accent blue. */
  color?: string;
  className?: string;
}

/** A thin share/progress bar. Value is clamped to [0, max]. Presentation only. */
export function MiniBar({ value, max = 100, color = "#2563EB", className }: MiniBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`mini-bar ${className ?? ""}`}>
      <span style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export default MiniBar;
