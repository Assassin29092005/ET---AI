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
  notes?: string;
}

export function postSPRPlan(req: SPRPlanRequest): Promise<SPRPlan> {
  return request<SPRPlan>({
    method: 'POST',
    url: '/spr/plan',
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

export interface CostOfInaction {
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
  asOf: string;
}

export function getCostOfInaction(
  scenario: string,
  durationDays = 14,
  intensity = 0.5,
): Promise<CostOfInaction> {
  return request<CostOfInaction>({
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

export default client;
