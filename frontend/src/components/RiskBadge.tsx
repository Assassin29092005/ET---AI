import { TIER_COLOR, type RiskTier } from '@/lib/types';

interface RiskBadgeProps {
  tier: RiskTier;
  score?: number;
  showScore?: boolean;
  size?: 'sm' | 'md';
}

const TIER_DOT: Record<RiskTier, string> = {
  low: 'bg-emerald-500',
  elevated: 'bg-amber-500',
  high: 'bg-orange-500',
  critical: 'bg-red-500',
};

export function RiskBadge({ tier, score, showScore = true, size = 'sm' }: RiskBadgeProps) {
  const sizing = size === 'sm' ? 'text-[9px] px-1.5 py-0.5 rounded' : 'text-xs px-2.5 py-1 rounded-md';
  return (
    <span
      className={`inline-flex items-center gap-1.5 border font-semibold uppercase tracking-wider ${sizing} ${TIER_COLOR[tier]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${TIER_DOT[tier]}`} />
      <span>{tier}</span>
      {showScore && typeof score === 'number' && (
        <span className="tabular-nums font-mono opacity-80 pl-1 border-l border-current/20">{score.toFixed(0)}</span>
      )}
    </span>
  );
}

export default RiskBadge;
