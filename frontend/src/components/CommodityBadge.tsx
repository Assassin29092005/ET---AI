import { COMMODITY_LABEL, type Commodity } from '@/lib/types';

interface CommodityBadgeProps {
  commodity: Commodity;
  size?: 'sm' | 'md';
}

const COMMODITY_TONE: Record<Commodity, string> = {
  crude_oil: 'bg-amber-50 text-amber-800 border-amber-200',
  lng: 'bg-blue-50 text-blue-800 border-blue-200',
  coking_coal: 'bg-slate-100 text-slate-800 border-slate-200',
  lithium: 'bg-fuchsia-50 text-fuchsia-800 border-fuchsia-200',
  cobalt: 'bg-sky-50 text-sky-800 border-sky-200',
  nickel: 'bg-teal-50 text-teal-800 border-teal-200',
  rare_earths: 'bg-violet-50 text-violet-800 border-violet-200',
  solar_pv: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  uranium: 'bg-lime-50 text-lime-800 border-lime-200',
  lpg: 'bg-orange-50 text-orange-800 border-orange-200',
  atf: 'bg-cyan-50 text-cyan-800 border-cyan-200',
  copper: 'bg-orange-50 text-orange-800 border-orange-200',
  graphite: 'bg-slate-100 text-slate-800 border-slate-200',
  manganese: 'bg-rose-50 text-rose-800 border-rose-200',
  polysilicon: 'bg-amber-50 text-amber-800 border-amber-200',
  silver: 'bg-slate-100 text-slate-700 border-slate-300',
  thermal_coal: 'bg-slate-100 text-slate-800 border-slate-200',
  pgm: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  rock_phosphate: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  potash: 'bg-red-50 text-red-800 border-red-200',
};

export function CommodityBadge({ commodity, size = 'sm' }: CommodityBadgeProps) {
  const tone = COMMODITY_TONE[commodity] ?? 'bg-slate-50 text-slate-800 border-slate-200';
  const sizing = size === 'sm' ? 'text-[9px] px-1.5 py-0.5 rounded' : 'text-xs px-2 py-0.5 rounded-md';
  return (
    <span
      className={`inline-flex items-center border font-semibold uppercase tracking-wider ${sizing} ${tone}`}
    >
      {COMMODITY_LABEL[commodity] ?? commodity}
    </span>
  );
}

export default CommodityBadge;
