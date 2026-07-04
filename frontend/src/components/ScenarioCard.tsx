import { useNavigate } from "react-router-dom";
import type { Commodity, Corridor } from "../lib/types";
import { CommodityBadge } from "./CommodityBadge";
import { RiskBadge } from "./RiskBadge";
import { scoreToTier } from "../lib/types";

interface ScenarioCardProps {
  name: string;
  title?: string;
  description?: string;
  commodity: Commodity;
  corridor: Corridor;
  default_intensity: number;
  default_duration_days: number;
  primaryRiskScore: number;
}

const CORRIDOR_LABEL: Record<Corridor, string> = {
  hormuz: "Strait of Hormuz",
  bab_el_mandeb: "Bab el-Mandeb",
  malacca: "Strait of Malacca",
  south_china_sea: "South China Sea",
  cape_of_good_hope: "Cape of Good Hope",
  suez: "Suez Canal",
};

export function ScenarioCard({
  name,
  title,
  description,
  commodity,
  corridor,
  default_intensity,
  default_duration_days,
  primaryRiskScore,
}: ScenarioCardProps) {
  const navigate = useNavigate();
  const tier = scoreToTier(primaryRiskScore);

  return (
    <div className="flex flex-col rounded-lg border border-slate-800 bg-slate-900 p-5 transition hover:border-indigo-500/50">
      <div className="mb-3 flex items-start justify-between gap-2">
        <CommodityBadge commodity={commodity} />
        <span className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-xs text-slate-300">
          {CORRIDOR_LABEL[corridor] ?? corridor}
        </span>
      </div>

      <h3 className="text-base font-semibold text-slate-100">{title ?? name}</h3>
      {description && (
        <p className="mt-1 line-clamp-3 text-sm text-slate-400">{description}</p>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-800 pt-3 text-xs">
        <div>
          <div className="text-slate-500">Intensity</div>
          <div className="text-slate-200">{(default_intensity * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-slate-500">Duration</div>
          <div className="text-slate-200">{default_duration_days.toFixed(0)} d</div>
        </div>
        <div>
          <div className="text-slate-500">Risk</div>
          <RiskBadge tier={tier} score={primaryRiskScore} />
        </div>
      </div>

      <button
        onClick={() => navigate(`/scenarios/${name}`)}
        className="mt-4 w-full rounded-md bg-indigo-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-400"
      >
        Run scenario
      </button>
    </div>
  );
}
