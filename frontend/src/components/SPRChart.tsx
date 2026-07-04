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
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">
          SPR drawdown &amp; reserve trajectory vs baseline
        </h3>
        <div className="text-xs text-slate-500">{plan.currentFillMb.toFixed(1)} Mbbl current fill</div>
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 14, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis
              dataKey="day"
              stroke="#64748b"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              label={{ value: 'Day', position: 'insideBottom', offset: -2, fill: '#64748b', fontSize: 11 }}
            />
            <YAxis
              yAxisId="flow"
              stroke="#64748b"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              label={{ value: 'Mbbl/day', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 10 }}
            />
            <YAxis
              yAxisId="reserve"
              orientation="right"
              stroke="#64748b"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              label={{ value: 'Reserve (Mbbl)', angle: 90, position: 'insideRight', fill: '#64748b', fontSize: 10 }}
            />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#94a3b8' }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area
              yAxisId="flow"
              type="monotone"
              dataKey="optimisedDraw"
              name="Optimised draw (Mbbl/d)"
              fill="#6366f1"
              fillOpacity={0.25}
              stroke="#6366f1"
              strokeWidth={2}
            />
            <Area
              yAxisId="flow"
              type="monotone"
              dataKey="refill"
              name="Refill (Mbbl/d)"
              fill="#10b981"
              fillOpacity={0.25}
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
                fillOpacity={0.12}
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
                stroke="#a5b4fc"
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
