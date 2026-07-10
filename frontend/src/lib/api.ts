import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import {
  CommodityPrice,
  DemandSubstitutes,
  ExecutiveBrief,
  FeedItem,
  RiskScore,
  ScenarioRequest,
  ScenarioResult,
  SourcingOption,
  SPRPlan,
  SPRBrief,
  Corridor,
  Commodity,
} from './types';

const client: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await client.request<T>(config);
    return response.data;
  } catch (err) {
    const axiosErr = err as AxiosError;
    const status = axiosErr.response?.status ?? 0;
    if (status >= 500 && status < 600) {
      const response = await client.request<T>(config);
      return response.data;
    }
    throw err;
  }
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  dependencies: Record<string, 'ok' | 'down'>;
  asOf: string;
}

export function getHealthz(): Promise<HealthStatus> {
  return request<HealthStatus>({ method: 'GET', url: '/healthz' });
}

export function getScores(commodity?: Commodity): Promise<RiskScore[]> {
  return request<RiskScore[]>({
    method: 'GET',
    url: '/scores',
    params: commodity ? { commodity } : undefined,
  });
}

export function getScoresByCorridor(corridor: Corridor): Promise<RiskScore[]> {
  return request<RiskScore[]>({
    method: 'GET',
    url: `/scores/${corridor}`,
  });
}

export interface SupplierScore {
  country: string;
  sharePct: number;
  corridor: Corridor;
  corridorScore: number;
  supplierRisk: number;
  tier: 'low' | 'elevated' | 'high' | 'critical';
}

export interface SupplierScoresResponse {
  commodity: string;
  suppliers: SupplierScore[];
  asOf: string;
}

export function getSupplierScores(commodity: string): Promise<SupplierScoresResponse> {
  return request<SupplierScoresResponse>({
    method: 'GET',
    url: `/scores/suppliers/${encodeURIComponent(commodity)}`,
  });
}

export interface ScenarioListItem {
  scenarioId: string;
  name: string;
  description: string;
  corridor: Corridor;
  commodity: Commodity;
}

export function listScenarios(): Promise<ScenarioListItem[]> {
  return request<ScenarioListItem[]>({ method: 'GET', url: '/scenarios' });
}

export interface ScenarioMeta {
  name: string;
  label: string;
  description: string;
  primary_commodity: Commodity;
  primary_corridor: Corridor;
}

export async function getScenarios(): Promise<ScenarioMeta[]> {
  const list = await listScenarios();
  return list.map((s) => ({
    name: s.scenarioId,
    label: s.name,
    description: s.description,
    primary_commodity: s.commodity,
    primary_corridor: s.corridor,
  }));
}

export async function runScenarioByName(
  name: string,
  overrides?: Partial<ScenarioRequest>,
): Promise<ScenarioResult> {
  const all = await listScenarios();
  const match = all.find((s) => s.scenarioId === name);
  if (!match) throw new Error(`Unknown scenario: ${name}`);
  const req: ScenarioRequest = {
    scenarioId: match.scenarioId,
    corridor: match.corridor,
    commodity: match.commodity,
    shockDurationDays: 14,
    shockSeverity: 0.5,
    startDate: new Date().toISOString(),
    ...overrides,
  };
  return runScenario(req);
}

export function runScenario(req: ScenarioRequest): Promise<ScenarioResult> {
  return request<ScenarioResult>({
    method: 'POST',
    url: `/scenarios/${encodeURIComponent(req.scenarioId)}/run`,
    data: req,
  });
}

export interface TwinRefinery {
  name: string;
  operator: string;
  capacityMmtpa: number;
  lat: number;
  lon: number;
  grades: string[];
}

export interface TwinLngTerminal {
  name: string;
  operator: string;
  capacityMtpa: number;
  utilizationPct: number;
  status: string;
  lat: number;
  lon: number;
}

export interface TwinPort {
  name: string;
  lat: number;
  lon: number;
  type: string;
}

export interface TwinSource {
  id: string;
  label: string;
  lat: number;
  lon: number;
  commodity: string;
}

export interface TwinSupplyRoute {
  id: string;
  commodity: string;
  sourceLabel: string;
  destLabel: string;
  corridor: Corridor;
  status: 'open' | 'congested' | 'disrupted' | 'closed';
  sharePct: number;
  path: Array<[number, number]>;
}

export interface TwinDemandCentre {
  name: string;
  lat: number;
  lon: number;
  demandIndex: number;
  fedBy: string[];
}

export interface TwinDistributionLink {
  id: string;
  feeder: string;
  hub: string;
  demandIndex: number;
  path: Array<[number, number]>;
}

export interface TwinPipeline {
  id: string;
  name: string;
  operator: string;
  type?: 'crude' | 'product' | string | null;
  lengthKm?: number | null;
  throughputMtpa?: number | null;
  capacityMmscmd?: number | null;
  polyline: Array<{ lat: number; lon: number }>;
}

export interface TwinVessel {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  course: number;
  speed: number;
  vesselType: string;
  cargo: 'crude' | 'lng' | 'lpg' | 'product' | 'chemical' | 'bulk' | 'container' | 'other';
  flag: string;
  corridor: Corridor | null;
  lastSeen: string;
  anomaly: boolean;
}

export interface TwinState {
  asOf: string;
  corridors: Array<{
    corridor: Corridor;
    throughputMbPerDay: number;
    vesselCount: number;
    averageDelayHours: number;
    status: 'open' | 'congested' | 'disrupted' | 'closed';
  }>;
  vessels: number;
  storage: { sprFillPct: number; lngTerminalFillPct: number };
  refineries?: TwinRefinery[];
  lngTerminals?: TwinLngTerminal[];
  ports?: TwinPort[];
  sources?: TwinSource[];
  supplyRoutes?: TwinSupplyRoute[];
  demandCentres?: TwinDemandCentre[];
  distributionLinks?: TwinDistributionLink[];
  oilPipelines?: TwinPipeline[];
  gasPipelines?: TwinPipeline[];
  vesselPositions?: TwinVessel[];
}

export function getTwinState(): Promise<TwinState> {
  return request<TwinState>({ method: 'GET', url: '/digital-twin/state' });
}

export function getSourcing(
  commodity: Commodity,
  volumeMb: number,
  disruptedCorridor?: Corridor | null,
  severity = 1.0,
): Promise<SourcingOption[]> {
  return request<SourcingOption[]>({
    method: 'GET',
    url: `/sourcing/${encodeURIComponent(commodity)}`,
    params: {
      volumeMb,
      ...(disruptedCorridor ? { disruptedCorridor, severity } : {}),
    },
  });
}

export function getSourcingSubstitutes(commodity: Commodity): Promise<DemandSubstitutes> {
  return request<DemandSubstitutes>({
    method: 'GET',
    url: `/sourcing/${encodeURIComponent(commodity)}/substitutes`,
  });
}

export function getSPRPlan(): Promise<SPRPlan> {
  return request<SPRPlan>({ method: 'GET', url: '/spr/plan' });
}

export interface SPRPlanRequest {
  targetCoverDays: number;
  horizonDays: number;
  marketBias?: 'north' | 'south' | 'balanced';
  scenarioId?: string | null;
  intensity?: number;
  notes?: string;
}

export function postSPRPlan(req: SPRPlanRequest): Promise<SPRPlan> {
  return request<SPRPlan>({
    method: 'POST',
    url: '/spr/plan',
    data: req,
  });
}

export function postSPRBrief(req: SPRPlanRequest): Promise<SPRBrief> {
  return request<SPRBrief>({
    method: 'POST',
    url: '/spr/brief',
    data: req,
  });
}

export function getFeed(limit = 50): Promise<FeedItem[]> {
  return request<FeedItem[]>({
    method: 'GET',
    url: '/feed',
    params: { limit },
  });
}

export function getExecutiveBrief(): Promise<ExecutiveBrief> {
  return request<ExecutiveBrief>({ method: 'GET', url: '/executive-brief' });
}

export function getCommodities(): Promise<CommodityPrice[]> {
  return request<CommodityPrice[]>({ method: 'GET', url: '/commodities' });
}

export interface CostOfInactionResult {
  scenarioId: string;
  durationDays: number;
  intensity: number;
  dailyCostInrCrore: number;
  cumulativeCostInrCrore: number;
  gdpImpactBps: number;
  breakdown: {
    fuelImportCost: number;
    gdpLoss: number;
    refinerySpotPremium: number;
    fxPassthrough: number;
  };
  assumptions: { indiaGdpCrore: number; dailyGdpCrore: number; method: string };
  asOf: string;
}

export type CostOfInaction = CostOfInactionResult;

export function getCostOfInaction(
  scenario: string,
  durationDays = 14,
  intensity = 0.5,
): Promise<CostOfInactionResult> {
  return request<CostOfInactionResult>({
    method: 'GET',
    url: '/cost-of-inaction',
    params: { scenario, durationDays, intensity },
  });
}

export interface BacktestEvent {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  windowDays: number;
  commodity: string;
  corridor: string;
  summary: string;
}

export interface BacktestReplayDay {
  day: number;
  dateIso: string;
  corridorScore: number;
  brentUsd: number;
  narrative: string;
  gdeltCount: number;
  aisAnomaly: number;
}

export function getBacktestEvents(): Promise<BacktestEvent[]> {
  return request<BacktestEvent[]>({ method: 'GET', url: '/backtest/events' });
}

export async function getBacktestReplay(eventId: string): Promise<BacktestReplayDay[]> {
  const raw = await request<BacktestReplayDay[] | { timeline: BacktestReplayDay[] }>({
    method: 'GET',
    url: `/backtest/${encodeURIComponent(eventId)}/replay`,
  });
  if (Array.isArray(raw)) return raw;
  return raw?.timeline ?? [];
}

export interface StressTestCell {
  scenarioId: string;
  intensity: number;
  durationDays: number;
  brentUpliftPct: number;
  gdpImpactBps: number;
  sprRunwayDays: number;
  costInrCrore: number;
  severity: 'low' | 'elevated' | 'high' | 'critical';
}

export async function getStressTest(): Promise<StressTestCell[]> {
  const raw = await request<StressTestCell[] | { cells: StressTestCell[] }>({
    method: 'GET',
    url: '/stress-test',
  });
  if (Array.isArray(raw)) return raw;
  return raw?.cells ?? [];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  answer: string;
  citations: Array<{ label: string; source: string }>;
  generatedAt: string;
}

export function postChat(question: string, history?: ChatMessage[]): Promise<ChatResponse> {
  return request<ChatResponse>({
    method: 'POST',
    url: '/chat',
    data: { question, history: history ?? [] },
  });
}

export interface CascadeCause {
  id: string;
  type: string;
  label: string;
  region: string;
  description: string;
}

export interface CascadePrice {
  currentPrice: number;
  projectedPrice: number;
  priceUpliftPct: number;
  unit: string;
}

export interface CascadeMetric {
  current: number;
  projected: number;
  unit: string;
  deltaLabel: string;
  direction: 'up' | 'down';
}

export interface CascadeImpactNode {
  id: string;
  label: string;
  kind: string;
  severity: number;
  hop: number;
  via: string[];
  path: string[];
  lagDays: number;
  price?: CascadePrice;
  metric?: CascadeMetric;
}

export interface CascadeEdge {
  from: string;
  to: string;
  weight: number;
  mechanism: string;
  lagDays: number;
}

export interface ImpactCascadeResponse {
  causeId: string;
  causeLabel: string;
  affectedCommodities: CascadeImpactNode[];
  sectorImpacts: CascadeImpactNode[];
  macroImpacts: CascadeImpactNode[];
  edgesUsed: CascadeEdge[];
  nodeCount: number;
  intensity: number;
  narrative: string;
  model: string;
  generatedAt: string;
}

export function getCascadeCauses(): Promise<CascadeCause[]> {
  return request<CascadeCause[]>({ method: 'GET', url: '/impact-cascade/causes' });
}

export function postImpactCascade(
  causeId: string,
  intensity = 1.0,
  withNarrative = true,
): Promise<ImpactCascadeResponse> {
  return request<ImpactCascadeResponse>({
    method: 'POST',
    url: '/impact-cascade',
    data: { causeId, intensity, withNarrative },
  });
}

export interface CascadeAnalysisResponse {
  commodity: Commodity;
  disruptedCorridor: string | null;
  narrative: string;
  rankedOptions: Array<{
    supplier: string;
    country: string;
    rank: number;
    leadTimeDays: number;
    routeCorridor: string;
    currentRisk: number;
    rationale: string;
  }>;
  riskSnapshot: {
    corridor_scores: Array<{ corridor: string; score: number; tier: string }>;
    disrupted_corridor: string | null;
  };
  model: string;
  generatedAt: string;
}

export function postCascadeAnalysis(
  commodity: Commodity,
  disruptedCorridor: string | null,
): Promise<CascadeAnalysisResponse> {
  return request<CascadeAnalysisResponse>({
    method: 'POST',
    url: `/sourcing/${encodeURIComponent(commodity)}/analyse`,
    data: { disruptedCorridor },
  });
}

export interface SanctionAlertItem {
  vesselName: string;
  mmsi?: string;
  alertType: string;
  severity: 'high' | 'critical';
  corridor: string;
  etaPort?: string;
  note: string;
}

export interface TwinStateWithAlerts extends TwinState {
  sanctionAlerts: SanctionAlertItem[];
}

export function getTwinStateWithAlerts(): Promise<TwinStateWithAlerts> {
  return request<TwinStateWithAlerts>({ method: 'GET', url: '/digital-twin/state' });
}

export interface SlackPayload {
  title: string;
  body: string;
  severity?: 'info' | 'warn' | 'critical';
}

export interface SlackResponse {
  sent: boolean;
  reason?: string;
  messageTs?: string;
  dryRun?: unknown;
}

export function postSlack(payload: SlackPayload): Promise<SlackResponse> {
  return request<SlackResponse>({
    method: 'POST',
    url: '/integrations/slack',
    data: payload,
  });
}

export interface BaselineEntry {
  value: number;
  source: string;
  refreshed_at?: string;
}

export interface BaselinesResponse {
  live: Record<string, BaselineEntry>;
  operator_overridable: Record<string, { value: number; source: string }>;
  model_parameters_note: string;
  asOf: string;
}

export function getBaselines(): Promise<BaselinesResponse> {
  return request<BaselinesResponse>({ method: 'GET', url: '/baselines' });
}

export interface BaselineOverridePayload {
  spr_cover_days?: number;
  refinery_runrate_pct?: number;
  power_stress_index?: number;
  gdp_growth_pct?: number;
}

export interface BaselineOverrideResponse {
  applied: Record<string, number>;
  errors: Record<string, string>;
  current: {
    spr_cover_days: number;
    refinery_runrate_pct: number;
    power_stress_index: number;
    gdp_growth_pct: number;
  };
  asOf: string;
}

export function postBaselineOverride(
  payload: BaselineOverridePayload,
): Promise<BaselineOverrideResponse> {
  return request<BaselineOverrideResponse>({
    method: 'POST',
    url: '/baselines/override',
    data: payload,
  });
}

export interface CompoundScenarioRequest {
  scenarios: Array<{ name: string; intensity: number; duration_days: number }>;
}

export interface CompoundScenarioBreakdown {
  scenarioId: string;
  label: string;
  intensity: number;
  durationDays: number;
  brentUpliftPct: number;
  lngUpliftPct: number;
  coalUpliftPct: number;
  primaryUpliftPct: number;
  gdpBps: number;
  refineryDropPp: number;
  powerStressRise: number;
  sprRunwayDays: number;
}

export interface CompoundScenarioResult {
  kind: 'compound';
  constituents: Array<{
    scenarioId: string;
    intensity: number;
    durationDays: number;
    label: string;
    primaryCommodity: string;
    primaryCorridor: string;
  }>;
  baseline: { brentUsd: number; sprCoverDays: number; importCostUsdM: number };
  projected: {
    brentUsd: number;
    sprCoverDays: number;
    importCostUsdM: number;
    gdpImpactBps: number;
    inflationImpactBps: number;
    fxImpactInrPerUsd: number;
    brentUpliftPct: number;
    lngUpliftPct: number;
    coalUpliftPct: number;
    primaryUpliftPct: number;
    refineryDropPp: number;
    powerStressRise: number;
  };
  timeline: Array<{
    day: number;
    brentUsd: number;
    sprDrawDownMb: number;
    routeShareCape: number;
    refineryRunRatePct: number;
    dieselPriceInr: number;
    powerStressIndex: number;
    gdpGrowthPct: number;
  }>;
  breakdown: CompoundScenarioBreakdown[];
  notes: string[];
  generatedAt: string;
}

export function postCompoundScenario(
  body: CompoundScenarioRequest,
): Promise<CompoundScenarioResult> {
  return request<CompoundScenarioResult>({
    method: 'POST',
    url: '/scenarios/compound',
    data: body,
  });
}

export interface SPRRun {
  id: number;
  scenario_id: string | null;
  intensity: number | null;
  horizon_days: number | null;
  target_cover_days: number | null;
  bias: string | null;
  release_mode: string | null;
  peak_gap_kbpd: number | null;
  gap_closed_pct: number | null;
  trough_cover_days: number | null;
  projected_cover_days: number | null;
  ran_at: string;
}

export function getSprRuns(limit = 20): Promise<{ runs: SPRRun[]; asOf: string }> {
  return request<{ runs: SPRRun[]; asOf: string }>({
    method: 'GET',
    url: '/spr/runs',
    params: { limit },
  });
}

export interface ScoreHistoryRow {
  id: number;
  corridor: string;
  score: number;
  tier: string;
  computed_at: string;
}

export function getScoreHistory(
  corridor?: string,
  limit = 100,
): Promise<{ corridor: string | null; rows: ScoreHistoryRow[]; asOf: string }> {
  return request<{ corridor: string | null; rows: ScoreHistoryRow[]; asOf: string }>({
    method: 'GET',
    url: '/scores/history',
    params: corridor ? { corridor, limit } : { limit },
  });
}

export interface ScoreSnapshotPayload {
  score: number;
  tier: string;
  disruptionProbability14d: number;
  signals: Record<string, number>;
  detail: Record<string, unknown>;
}

export function getLatestSnapshot(): Promise<{
  snapshot: Record<string, ScoreSnapshotPayload>;
  refreshIntervalSeconds: number;
  changeThreshold: number;
  asOf: string;
}> {
  return request({ method: 'GET', url: '/scores/latest-snapshot' });
}

export interface PipelineTiming {
  scoresMs: number;
  sourcingMs: number;
  scenarioMs: number;
  lastE2eMs: number;
  updatedAt: string;
}

export function getPipelineTiming(): Promise<PipelineTiming> {
  return request<PipelineTiming>({ method: 'GET', url: '/pipeline-timing' });
}

export interface AgentAction {
  chainId: string;
  corridor: string;
  actionType: string;
  details: { message?: string; [key: string]: unknown };
  timestamp: string;
}

export function getAgentActions(limit = 20): Promise<{ actions: AgentAction[]; count: number; asOf: string }> {
  return request({ method: 'GET', url: '/agent/actions', params: { limit } });
}
export default client;
