import { RiskTier } from './types';

export function formatNumber(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(decimals)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(decimals)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(decimals)}k`;
  return n.toFixed(decimals);
}

export function formatPercent(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return `${n.toFixed(decimals)}%`;
}

export function formatBrent(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '--';
  return `$${usd.toFixed(2)}/bbl`;
}

export const IST_TZ = 'Asia/Kolkata';

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' IST';
}

export function fmtIstTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' IST';
}

export function fmtIstClock(d: Date): string {
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' IST';
}

export function fmtIstDate(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

export function timeSince(iso: string | null | undefined): string {
  if (!iso) return '--';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '--';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function tierColor(tier: RiskTier): string {
  switch (tier) {
    case 'low':
      return 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10';
    case 'elevated':
      return 'text-amber-300 border-amber-500/40 bg-amber-500/10';
    case 'high':
      return 'text-orange-300 border-orange-500/40 bg-orange-500/10';
    case 'critical':
      return 'text-red-300 border-red-500/50 bg-red-500/15';
  }
}

export function formatUsdMillions(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '--';
  return `$${usd.toFixed(1)}M`;
}

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || Number.isNaN(bps)) return '--';
  const sign = bps > 0 ? '+' : '';
  return `${sign}${bps.toFixed(0)} bps`;
}

export interface TierAccent {
  border: string;
  text: string;
  dot: string;
  bg: string;
  ring: string;
}

const TIER_ACCENT_FALLBACK: TierAccent = {
  border: 'border-slate-700',
  text: 'text-slate-300',
  dot: 'bg-slate-500',
  bg: 'bg-slate-800/40',
  ring: 'ring-slate-700',
};

export function tierAccent(tier: RiskTier | string | null | undefined): TierAccent {
  switch (tier) {
    case 'low':
      return {
        border: 'border-emerald-500/40',
        text: 'text-emerald-300',
        dot: 'bg-emerald-500',
        bg: 'bg-emerald-500/10',
        ring: 'ring-emerald-500/30',
      };
    case 'elevated':
      return {
        border: 'border-amber-500/40',
        text: 'text-amber-300',
        dot: 'bg-amber-500',
        bg: 'bg-amber-500/10',
        ring: 'ring-amber-500/30',
      };
    case 'high':
      return {
        border: 'border-orange-500/40',
        text: 'text-orange-300',
        dot: 'bg-orange-500',
        bg: 'bg-orange-500/10',
        ring: 'ring-orange-500/30',
      };
    case 'critical':
      return {
        border: 'border-red-500/50',
        text: 'text-red-300',
        dot: 'bg-red-500',
        bg: 'bg-red-500/15',
        ring: 'ring-red-500/40',
      };
    default:
      return TIER_ACCENT_FALLBACK;
  }
}

export function tierFromImportance(importance: number | null | undefined): RiskTier {
  const i = importance ?? 0;
  if (i >= 9) return 'critical';
  if (i >= 7) return 'high';
  if (i >= 4) return 'elevated';
  return 'low';
}

export function fmtNumber(n: number | null | undefined, decimals = 1): string {
  return formatNumber(n, decimals);
}

export function fmtPct(
  n: number | null | undefined,
  decimals = 1,
  suffix?: string,
): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  if (suffix) return `${n.toFixed(decimals)} ${suffix}`;
  return `${n.toFixed(decimals)}%`;
}

export function fmtTime(iso: string | null | undefined): string {
  return formatDate(iso);
}

export function fmtUsd(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return `$${n.toFixed(decimals)}`;
}

export function fmtBps(bps: number | null | undefined): string {
  return formatBps(bps);
}
