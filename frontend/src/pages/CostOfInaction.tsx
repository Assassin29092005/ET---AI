import { useEffect, useState, useCallback } from "react";
import { getCostOfInaction, getScenarios, type CostOfInactionResult, type ScenarioMeta } from "@/lib/api";

const DURATIONS = [7, 14, 30, 60, 90];
const INTENSITIES = [0.25, 0.5, 0.75, 1.0];

function fmtCrore(n: number): string {
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(1)}L Cr`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}K Cr`;
  return `₹${n.toFixed(0)} Cr`;
}

function severityColor(bps: number): string {
  const absBps = Math.abs(bps);
  if (absBps >= 30) return "text-red-600 bg-red-50";
  if (absBps >= 15) return "text-amber-600 bg-amber-50";
  return "text-emerald-600 bg-emerald-50";
}

export default function CostOfInaction() {
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<string>("");
  const [duration, setDuration] = useState(14);
  const [intensity, setIntensity] = useState(0.5);
  const [result, setResult] = useState<CostOfInactionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stressGrid, setStressGrid] = useState<Array<{ dur: number; int: number; cost: number; bps: number }>>([]);

  // Load scenarios
  useEffect(() => {
    getScenarios().then((list) => {
      setScenarios(list);
      if (list.length > 0 && !selectedScenario) {
        setSelectedScenario(list[0].name);
      }
    }).catch(() => {});
  }, []);

  // Fetch cost data
  const fetchCost = useCallback(async () => {
    if (!selectedScenario) return;
    setLoading(true);
    try {
      const data = await getCostOfInaction(selectedScenario, duration, intensity);
      setResult(data);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [selectedScenario, duration, intensity]);

  useEffect(() => { fetchCost(); }, [fetchCost]);

  // Build stress grid
  useEffect(() => {
    if (!selectedScenario) return;
    const grid: typeof stressGrid = [];
    Promise.all(
      DURATIONS.flatMap((dur) =>
        INTENSITIES.map(async (int) => {
          try {
            const r = await getCostOfInaction(selectedScenario, dur, int);
            grid.push({ dur, int, cost: r.cumulativeCostInrCrore, bps: r.gdpImpactBps });
          } catch {
            grid.push({ dur, int, cost: 0, bps: 0 });
          }
        })
      )
    ).then(() => setStressGrid(grid));
  }, [selectedScenario]);

  const breakdown = result?.breakdown;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">
            Cost of Inaction
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Every day without action costs the Indian economy real rupees. Select a scenario to quantify the exposure.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 border border-red-500/20 px-3 py-1 text-[10px] font-bold text-red-400 uppercase tracking-wider">
          Business Impact
        </span>
      </div>

      {/* Controls */}
      <div className="card bg-white p-5">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Scenario</label>
            <select
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              value={selectedScenario}
              onChange={(e) => setSelectedScenario(e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Duration (days)</label>
            <select
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Intensity</label>
            <select
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              value={intensity}
              onChange={(e) => setIntensity(Number(e.target.value))}
            >
              {INTENSITIES.map((i) => (
                <option key={i} value={i}>{(i * 100).toFixed(0)}%</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading && (
        <div className="text-center py-8 text-slate-400 text-sm">Computing economic impact...</div>
      )}

      {result && !loading && (
        <>
          {/* Headline cost cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="card bg-white p-5 border-l-4 border-red-500">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Daily Cost</div>
              <div className="mt-2 text-2xl font-black text-red-600">{fmtCrore(result.dailyCostInrCrore)}</div>
              <div className="mt-1 text-xs text-slate-500">per day of inaction</div>
            </div>
            <div className="card bg-white p-5 border-l-4 border-red-600">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Cumulative Cost ({duration}d)</div>
              <div className="mt-2 text-2xl font-black text-red-700">{fmtCrore(result.cumulativeCostInrCrore)}</div>
              <div className="mt-1 text-xs text-slate-500">total over {duration} days</div>
            </div>
            <div className="card bg-white p-5 border-l-4 border-amber-500">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">GDP Impact</div>
              <div className={`mt-2 text-2xl font-black ${Math.abs(result.gdpImpactBps) >= 15 ? 'text-red-600' : 'text-amber-600'}`}>
                {result.gdpImpactBps.toFixed(1)} bps
              </div>
              <div className="mt-1 text-xs text-slate-500">GDP growth drag</div>
            </div>
          </div>

          {/* Breakdown */}
          {breakdown && (
            <div className="card bg-white overflow-hidden">
              <div className="border-b border-slate-100 px-5 py-4 bg-slate-50">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Cost Breakdown</div>
                <h3 className="mt-0.5 text-sm font-bold text-slate-800">Where the losses accumulate</h3>
              </div>
              <div className="p-5">
                <div className="space-y-3">
                  {[
                    { label: "Fuel Import Cost Surge", value: breakdown.fuelImportCost, color: "bg-red-500" },
                    { label: "GDP Output Loss", value: breakdown.gdpLoss, color: "bg-amber-500" },
                    { label: "Refinery Spot Premium", value: breakdown.refinerySpotPremium, color: "bg-orange-500" },
                    { label: "FX Passthrough", value: breakdown.fxPassthrough, color: "bg-blue-500" },
                  ].map((item) => {
                    const pct = result.cumulativeCostInrCrore > 0
                      ? (item.value / result.cumulativeCostInrCrore * 100)
                      : 0;
                    return (
                      <div key={item.label}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold text-slate-600">{item.label}</span>
                          <span className="text-xs font-bold text-slate-800">{fmtCrore(item.value)} ({pct.toFixed(0)}%)</span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-full ${item.color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Stress Matrix */}
          {stressGrid.length > 0 && (
            <div className="card bg-white overflow-hidden">
              <div className="border-b border-slate-100 px-5 py-4 bg-slate-50">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Stress Matrix</div>
                <h3 className="mt-0.5 text-sm font-bold text-slate-800">Cost across intensity × duration combinations</h3>
              </div>
              <div className="p-5 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400">Duration</th>
                      {INTENSITIES.map((i) => (
                        <th key={i} className="px-3 py-2 text-center text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {(i * 100).toFixed(0)}%
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DURATIONS.map((dur) => (
                      <tr key={dur} className="border-t border-slate-50">
                        <td className="px-3 py-2 font-semibold text-slate-600">{dur}d</td>
                        {INTENSITIES.map((int) => {
                          const cell = stressGrid.find((c) => c.dur === dur && c.int === int);
                          return (
                            <td key={`${dur}-${int}`} className="px-3 py-2 text-center">
                              {cell ? (
                                <span className={`inline-block rounded-md px-2 py-1 text-[10px] font-bold ${severityColor(cell.bps)}`}>
                                  {fmtCrore(cell.cost)}
                                </span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Assumptions transparency */}
          {result.assumptions && (
            <div className="card bg-white p-5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Model Assumptions</div>
              <div className="flex gap-6 text-xs text-slate-500">
                <span>India GDP: ₹{(result.assumptions.indiaGdpCrore / 100000).toFixed(1)}L Cr</span>
                <span>Daily GDP: ₹{result.assumptions.dailyGdpCrore.toFixed(0)} Cr</span>
                <span>Method: {result.assumptions.method.replace(/_/g, " ")}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
