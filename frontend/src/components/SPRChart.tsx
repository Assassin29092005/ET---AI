import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SPRPlan } from '@/lib/types';

interface SPRChartProps {
  plan: SPRPlan;
  baseline?: SPRPlan;
}

interface ChartRow {
  day: number;
  optimisedDraw: number;
  refill: number;
  reserve?: number | null;
  baselineDraw?: number;
}

function toRows(plan: SPRPlan): ChartRow[] {
  return plan.releaseSchedule.map((r) => ({
    day: r.day,
    optimisedDraw: r.drawMb,
    refill: r.replenishMb ?? 0,
    reserve: r.reserveMb ?? null,
  }));
}

function merge(rows: ChartRow[], baseline: SPRPlan | undefined): ChartRow[] {
  if (!baseline) return rows;
  const map = new Map<number, ChartRow>();
  rows.forEach((r) => map.set(r.day, { ...r }));
  baseline.releaseSchedule.forEach((r) => {
    const existing = map.get(r.day);
    if (existing) existing.baselineDraw = r.drawMb;
  });
  return Array.from(map.values()).sort((a, b) => a.day - b.day);
}

export function SPRChart({ plan, baseline }: SPRChartProps) {
  const rows = merge(toRows(plan), baseline);
  const hasReserve = rows.some((r) => r.reserve != null);
  return (
    <div className="card p-5">
      <div className="mb-3.5 flex items-center justify-between border-b border-slate-100 pb-2">
        <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
          SPR Drawdown &amp; Reserve Trajectory
        </h3>
        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
          {plan.currentFillMb.toFixed(1)} Mbbl current fill
        </div>
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 14, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#f1f5f9" strokeDasharray="3 3" />
            <XAxis
              dataKey="day"
              stroke="#94a3b8"
              tick={{ fill: '#64748b', fontSize: 10 }}
              label={{ value: 'Day', position: 'insideBottom', offset: -2, fill: '#64748b', fontSize: 10 }}
            />
            <YAxis
              yAxisId="flow"
              stroke="#64748b"
              tick={{ fill: '#64748b', fontSize: 10 }}
              label={{ value: 'Mbbl/day', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 9 }}
            />
            <YAxis
              yAxisId="reserve"
              orientation="right"
              stroke="#64748b"
              tick={{ fill: '#64748b', fontSize: 10 }}
              label={{ value: 'Reserve (Mbbl)', angle: 90, position: 'insideRight', fill: '#64748b', fontSize: 9 }}
            />
            <Tooltip
              contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 11, color: '#334155' }}
              labelStyle={{ color: '#64748b' }}
            />
            <Legend wrapperStyle={{ fontSize: 10, fontWeight: 600, color: '#4a5568' }} />
            <Area
              yAxisId="flow"
              type="monotone"
              dataKey="optimisedDraw"
              name="Optimised draw (Mbbl/d)"
              fill="#3b82f6"
              fillOpacity={0.15}
              stroke="#3b82f6"
              strokeWidth={2}
            />
            <Area
              yAxisId="flow"
              type="monotone"
              dataKey="refill"
              name="Refill (Mbbl/d)"
              fill="#10b981"
              fillOpacity={0.15}
              stroke="#10b981"
              strokeWidth={2}
            />
            {baseline && (
              <Area
                yAxisId="flow"
                type="monotone"
                dataKey="baselineDraw"
                name="Baseline flat draw (Mbbl/d)"
                fill="#f97316"
                fillOpacity={0.08}
                stroke="#f97316"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            )}
            {hasReserve && (
              <Line
                yAxisId="reserve"
                type="monotone"
                dataKey="reserve"
                name="Reserve level (Mbbl)"
                stroke="#334155"
                strokeWidth={2}
                dot={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default SPRChart;
