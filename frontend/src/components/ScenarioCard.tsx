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
    <div className="flex flex-col card p-5 border-slate-200 bg-white">
      <div className="mb-3 flex items-start justify-between gap-2">
        <CommodityBadge commodity={commodity} />
        <span className="rounded-md border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-[10px] font-semibold text-slate-500">
          {CORRIDOR_LABEL[corridor] ?? corridor}
        </span>
      </div>

      <h3 className="text-base font-bold text-slate-800">{title ?? name}</h3>
      {description && (
        <p className="mt-2 line-clamp-3 text-xs text-slate-500 leading-relaxed">{description}</p>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 text-xs font-medium">
        <div>
          <div className="text-slate-400 text-[10px] uppercase font-semibold">Intensity</div>
          <div className="text-slate-700 font-mono mt-0.5">{(default_intensity * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-slate-400 text-[10px] uppercase font-semibold">Duration</div>
          <div className="text-slate-700 font-mono mt-0.5">{default_duration_days.toFixed(0)} d</div>
        </div>
        <div>
          <div className="text-slate-400 text-[10px] uppercase font-semibold mb-0.5">Risk</div>
          <RiskBadge tier={tier} score={primaryRiskScore} />
        </div>
      </div>

      <button
        onClick={() => navigate(`/scenarios/${name}`)}
        className="mt-5 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
      >
        Run scenario
      </button>
    </div>
  );
}
