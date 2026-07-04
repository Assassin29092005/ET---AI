import type { CommodityPrice } from '@/lib/types';

interface CommodityTickerProps {
  items: CommodityPrice[];
}

function ChangeArrow({ pct }: { pct: number }) {
  if (Math.abs(pct) < 0.01) return <span className="text-slate-500">·</span>;
  return pct > 0 ? <span className="text-emerald-300">▲</span> : <span className="text-red-300">▼</span>;
}

function commodityShort(c: string): string {
  const map: Record<string, string> = {
    crude_oil: 'BRENT',
    lng: 'JKM',
    coking_coal: 'COAL',
    lithium: 'Li',
    rare_earths: 'NdO',
    cobalt: 'Co',
    nickel: 'Ni',
    solar_pv: 'PV',
    uranium: 'U',
  };
  return map[c] ?? c.toUpperCase();
}

function priceFmt(p: number, unit: string): string {
  if (unit.includes('USD') && p >= 100) return `$${p.toFixed(0)}`;
  if (unit.includes('USD')) return `$${p.toFixed(2)}`;
  return `${p.toFixed(2)}`;
}

export function CommodityTicker({ items }: CommodityTickerProps) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      {items.slice(0, 5).map((item) => (
        <div
          key={item.symbol}
          className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900/60 px-2 py-1"
        >
          <span className="text-slate-400">{commodityShort(item.commodity)}</span>
          <span className="font-semibold text-slate-100 tabular-nums">
            {priceFmt(item.priceUsd, item.unit)}
          </span>
          <ChangeArrow pct={item.changePct24h} />
          <span
            className={
              item.changePct24h > 0
                ? 'text-emerald-300 tabular-nums'
                : item.changePct24h < 0
                  ? 'text-red-300 tabular-nums'
                  : 'text-slate-500 tabular-nums'
            }
          >
            {Math.abs(item.changePct24h).toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

export default CommodityTicker;
