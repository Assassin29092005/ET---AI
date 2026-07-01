export type Commodity =
  | 'crude_oil'
  | 'lng'
  | 'coking_coal'
  | 'lithium'
  | 'cobalt'
  | 'nickel'
  | 'rare_earths'
  | 'solar_pv'
  | 'uranium'
  | 'lpg'
  | 'atf'
  | 'copper'
  | 'graphite'
  | 'manganese'
  | 'polysilicon'
  | 'silver'
  | 'thermal_coal'
  | 'pgm'
  | 'rock_phosphate'
  | 'potash';

export type Corridor =
  | 'hormuz'
  | 'bab_el_mandeb'
  | 'malacca'
  | 'south_china_sea'
  | 'cape_of_good_hope'
  | 'suez';

export type RiskTier = 'low' | 'elevated' | 'high' | 'critical';

export interface RiskScore {
  corridor: Corridor;
  commodity: Commodity;
  score: number;
  tier: RiskTier;
  components: {
    geopolitical: number;
    chokepoint: number;
    weather: number;
    market: number;
    sanctions: number;
  };
  drivers: string[];
  confidence: number;
  asOf: string;
}

export interface VesselPing {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  speed: number;
  course: number;
  cargo: Commodity;
  origin: string;
  destination: string;
  eta: string;
  corridor: Corridor | null;
  timestamp: string;
}

export interface ScenarioRequest {
  scenarioId: string;
  corridor: Corridor;
  commodity: Commodity;
  shockDurationDays: number;
  shockSeverity: number;
  startDate: string;
  notes?: string;
}

export interface ScenarioResult {
  scenarioId: string;
  request: ScenarioRequest;
  baseline: {
    brentUsd: number;
    sprCoverDays: number;
    importCostUsdM: number;
  };
  projected: {
    brentUsd: number;
    sprCoverDays: number;
    importCostUsdM: number;
    gdpImpactBps: number;
    inflationImpactBps: number;
    fxImpactInrPerUsd: number;
    // Headline price move for the scenario's primary commodity. For oil
    // scenarios this mirrors the Brent uplift; for coal/REE/solar/uranium it is
    // the move in that commodity (Brent stays flat).
    primaryCommodity?: Commodity;
    primaryUpliftPct?: number;
  };
  timeline: Array<{
    day: number;
    brentUsd: number;
    sprDrawDownMb: number;
    routeShareCape: number;
    refineryRunRatePct?: number;
    dieselPriceInr?: number;
    powerStressIndex?: number;
    gdpGrowthPct?: number;
  }>;
  recommendations: string[];
  generatedAt: string;
}

export type RouteStatus = 'open' | 'disrupted' | 'closed';

export type TankerAvailability = 'ample' | 'tight' | 'constrained';
export type GradeCompat = 'match' | 'mismatch' | 'unknown' | 'n/a';

export interface SourcingOption {
  rank: number;
  supplier: string;
  country: string;
  commodity: Commodity;
  importSharePct: number;
  volumeMb: number;
  priceUsd: number;
  spotPriceUsd?: number;
  priceUnit?: string;
  priceSource?: 'spot' | 'planning';
  leadTimeDays: number;
  portDelayDays?: number;
  routeCorridor: string;
  routeStatus: RouteStatus;
  routeRiskScore: number;
  tankerAvailability?: TankerAvailability;
  tankerUtilisation?: number;
  vesselsInCorridor?: number;
  gradeCompat?: GradeCompat;
  gradeNote?: string;
  sanctionsCheck: 'clear' | 'flag' | 'block';
  carbonIntensity: number;
  notes: string;
}

export interface DemandSubstitute {
  name: string;
  type: string;
  maturity: 'available' | 'emerging' | 'nascent' | string;
  displacementPct: number;
  leadTimeMonths: number;
  note: string;
}

export interface DemandSubstitutes {
  commodity: Commodity;
  primaryUse: string | null;
  substitutes: DemandSubstitute[];
  disclaimer?: string;
  asOf?: string;
}

export interface RefineryDemand {
  name: string;
  operator: string;
  capacityMmtpa: number;
  dailyDemandKbpd: number;
  gulfExposurePct: number;
  exposureKbpd: number;
  grades: string[];
}

export interface GapForecastPoint {
  day: number;
  central: number;
  low: number;
  high: number;
}

export interface ReplenishmentWindow {
  startDay: number;
  endDay: number;
  days: number;
  estPriceUsd: number;
  reason: string;
}

export interface SPRPlan {
  asOf: string;
  totalCapacityMb: number;
  currentFillMb: number;
  coverDays: number;
  projectedCoverDays?: number;
  troughCoverDays?: number;
  gapClosedPct?: number;
  peakGapKbpd?: number;
  totalUnmetMb?: number;
  totalReplenishMb?: number;
  totalDemandKbpd?: number;
  scenarioId?: string | null;
  scenarioLabel?: string;
  targetCoverDays?: number;
  marketBias?: string;
  sites: Array<{
    name: string;
    location: string;
    capacityMb: number;
    fillMb: number;
    drawRateMbPerDay: number;
  }>;
  refineryDemand?: RefineryDemand[];
  gapForecast?: GapForecastPoint[];
  replenishmentWindows?: ReplenishmentWindow[];
  releaseSchedule: Array<{
    day: number;
    drawMb: number;
    replenishMb?: number;
    cumulativeMb: number;
    reserveMb?: number | null;
    targetMarket: string;
  }>;
  rationale: string;
}

export interface SPRBrief {
  scenarioId?: string | null;
  scenarioLabel?: string;
  urgency: 'low' | 'elevated' | 'high';
  headline: string;
  situation: string;
  narrative: string;
  actions: string[];
  tradeoffs: string[];
  risks: string[];
  watchItems: string[];
  plan?: Record<string, number>;
  generatedAt: string;
}

export interface FeedItem {
  id: string;
  source: string;
  headline: string;
  summary: string;
  url: string;
  publishedAt: string;
  tags: string[];
  corridor: Corridor | null;
  commodity: Commodity | null;
  sentiment: 'positive' | 'neutral' | 'negative';
  importance: number;
}

export interface ExecutiveBrief {
  generatedAt: string;
  asOfDate: string;
  headline: string;
  summary: string;
  topRisks: Array<{
    corridor: Corridor;
    commodity: Commodity;
    tier: RiskTier;
    note: string;
  }>;
  actions: string[];
  marketSnapshot: {
    brentUsd: number;
    ttfEurMwh: number;
    inrUsd: number;
    coalAud: number;
  };
  citations: Array<{ label: string; url: string }>;
}

export interface CommodityPrice {
  commodity: Commodity;
  symbol: string;
  priceUsd: number;
  change24h: number;
  changePct24h: number;
  unit: string;
  asOf: string;
}

export const CORRIDOR_LABEL: Record<Corridor, string> = {
  hormuz: 'Strait of Hormuz',
  bab_el_mandeb: 'Bab el-Mandeb / Red Sea',
  malacca: 'Strait of Malacca',
  south_china_sea: 'South China Sea',
  cape_of_good_hope: 'Cape of Good Hope',
  suez: 'Suez Canal',
};

export const COMMODITY_LABEL: Record<Commodity, string> = {
  crude_oil: 'Crude Oil',
  lng: 'LNG',
  coking_coal: 'Coking Coal',
  lithium: 'Lithium',
  cobalt: 'Cobalt',
  nickel: 'Nickel',
  rare_earths: 'Rare Earths',
  solar_pv: 'Solar PV',
  uranium: 'Uranium',
  lpg: 'LPG',
  atf: 'ATF',
  copper: 'Copper',
  graphite: 'Graphite',
  manganese: 'Manganese',
  polysilicon: 'Polysilicon / Wafers',
  silver: 'Silver',
  thermal_coal: 'Thermal Coal',
  pgm: 'Platinum Group Metals',
  rock_phosphate: 'Rock Phosphate',
  potash: 'Potash (MOP)',
};

export interface CorridorOverlay {
  id: string;
  name: string;
  tier: RiskTier;
  risk_score: number;
  polyline: Array<{ lat: number; lon: number }>;
}

export interface Refinery {
  id: string;
  name: string;
  lat: number;
  lon: number;
  capacity_mtpa: number;
  operator?: string;
}

export interface Terminal {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: 'lng' | 'crude' | 'coal' | 'container' | 'multi';
  capacity_mtpa?: number;
}

export function scoreToTier(score: number | null | undefined): RiskTier {
  const s = score ?? 0;
  if (s >= 75) return 'critical';
  if (s >= 55) return 'high';
  if (s >= 30) return 'elevated';
  return 'low';
}

export const TIER_COLOR: Record<RiskTier, string> = {
  low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  elevated: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  critical: 'bg-red-500/20 text-red-300 border-red-500/40',
};
