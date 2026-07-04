import type { RiskTier } from '@/lib/types';

interface RiskBadgeProps {
  tier: RiskTier;
  score?: number;
  showScore?: boolean;
  size?: 'sm' | 'md';
}

const TIER_BORDER: Record<RiskTier, string> = {
  low: 'border-op-good/60',
  elevated: 'border-op-warn/60',
  high: 'border-amber-500/60',
  critical: 'border-op-danger/60',
};

const TIER_TEXT: Record<RiskTier, string> = {
  low: 'text-op-good',
  elevated: 'text-op-warn',
  high: 'text-amber-300',
  critical: 'text-op-danger',
};

const TIER_DOT: Record<RiskTier, string> = {
  low: 'bg-op-good',
  elevated: 'bg-op-warn',
  high: 'bg-amber-500',
  critical: 'bg-op-danger',
};

export function RiskBadge({ tier, score, showScore = true, size = 'sm' }: RiskBadgeProps) {
  const sizing = size === 'sm' ? 'text-micro px-1.5 py-0.5' : 'text-meta px-2 py-1';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border font-mono uppercase tracking-wider ${sizing} ${TIER_BORDER[tier]} ${TIER_TEXT[tier]}`}
    >
      <span className={`h-1 w-1 rounded-full ${TIER_DOT[tier]}`} />
      <span>{tier}</span>
      {showScore && typeof score === 'number' && (
        <span className="tabular-nums opacity-80">{score.toFixed(0)}</span>
      )}
    </span>
  );
}

export default RiskBadge;
