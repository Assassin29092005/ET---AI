import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  WMSTileLayer,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import {
  getTwinState,
  postImpactCascade,
  type ImpactCascadeResponse,
  type TwinState,
} from '@/lib/api';
import { CORRIDOR_LABEL, type Corridor } from '@/lib/types';
import { fmtNumber, fmtTime } from '@/lib/fmt';

const WHATIF_CAUSE: Record<Corridor, string> = {
  hormuz: 'corridor:hormuz',
  bab_el_mandeb: 'corridor:bab_el_mandeb',
  malacca: 'corridor:malacca',
  south_china_sea: 'corridor:south_china_sea',
  cape_of_good_hope: 'corridor:cape',
  suez: 'corridor:suez',
};

interface WhatIf {
  corridor: Corridor | null;
  intensity: number;
  cascade: ImpactCascadeResponse | null;
  loading: boolean;
}

const REFRESH_MS = 30_000;

/**
 * Haversine distance between two lat/lon points in nautical miles.
 * 1 NM = 1 minute of arc of latitude = 1.852 km.
 */
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R_NM = 3440.065; // Earth radius in nautical miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(a));
}

/** Total polyline distance in nautical miles. */
function routeDistanceNm(path: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversineNm(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  }
  return Math.round(total);
}

const CORRIDOR_COORDS: Record<Corridor, { lat: number; lon: number; label: string }> = {
  hormuz: { lat: 26.5, lon: 56.2, label: 'Strait of Hormuz' },
  bab_el_mandeb: { lat: 12.6, lon: 43.4, label: 'Bab el-Mandeb' },
  malacca: { lat: 2.5, lon: 101.5, label: 'Malacca' },
  south_china_sea: { lat: 12.0, lon: 115.0, label: 'South China Sea' },
  cape_of_good_hope: { lat: -34.3, lon: 18.4, label: 'Cape of Good Hope' },
  suez: { lat: 30.0, lon: 32.5, label: 'Suez' },
};

const STATUS_FILL: Record<string, string> = {
  open: '#10b981',
  congested: '#f59e0b',
  disrupted: '#f97316',
  closed: '#ef4444',
};

const REFINERY_COLOR = '#f59e0b';
const LNG_COLOR = '#22d3ee';
const PORT_COLOR = '#a855f7';
const SOURCE_COLOR = '#94a3b8';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined;
const MAPBOX_STYLE_ID = 'mapbox/light-v11';

function tileLayerUrl(): { url: string; attribution: string } {
  if (MAPBOX_TOKEN) {
    return {
      url: `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_ID}/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      attribution:
        '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    };
  }
  return {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · CARTO',
  };
}

// Fix Leaflet default icon paths in Vite builds
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function InvalidateSize({ refreshKey }: { refreshKey: number }) {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 100);
    return () => clearTimeout(t);
  }, [map, refreshKey]);
  return null;
}

const DEMAND_COLOR = '#34d399';

interface Layers {
  routes: boolean;
  refineries: boolean;
  lng: boolean;
  ports: boolean;
  corridors: boolean;
  sources: boolean;
  distribution: boolean;
  oilPipelines: boolean;
  gasPipelines: boolean;
  vedasOverlay: boolean;
  vessels: boolean;
}

const VESSEL_COLOR: Record<string, string> = {
  crude: '#f97316',
  lng: '#22d3ee',
  lpg: '#a78bfa',
  product: '#fbbf24',
  chemical: '#fb923c',
  bulk: '#94a3b8',
  container: '#c084fc',
  other: '#64748b',
};

const OIL_PIPELINE_COLOR = '#a78bfa';
const GAS_PIPELINE_COLOR = '#22d3ee';

const VEDAS_WMS_URL = 'https://vedas.sac.gov.in/secure/geoserver/powergis_private/wms';
const VEDAS_LAYER_GAS = 'natural_gas_pipeline';
const VEDAS_LAYER_OIL = 'petrolium_products_pipeline';
const VEDAS_ATTRIBUTION =
  '<a href="https://vedas.sac.gov.in/energymap/" target="_blank" rel="noopener">Pipelines © VEDAS / ISRO SAC</a>';


function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs font-bold text-slate-600">{label}</span>
      <button
        type="button"
        onClick={onChange}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
          checked ? 'bg-blue-600' : 'bg-slate-200'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

export default function DigitalTwin() {
  const navigate = useNavigate();
  const [state, setState] = useState<TwinState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>({
    routes: true,
    refineries: true,
    lng: true,
    ports: true,
    corridors: true,
    sources: true,
    distribution: true,
    oilPipelines: true,
    gasPipelines: true,
    vedasOverlay: false,
    vessels: true,
  });
  const [whatIf, setWhatIf] = useState<WhatIf>({
    corridor: null,
    intensity: 1.0,
    cascade: null,
    loading: false,
  });
  const [selectedWhatIfCorridor, setSelectedWhatIfCorridor] = useState<Corridor | ''>('');
  const [mapFocused, setMapFocused] = useState<boolean>(false);

  const handleMapClick = () => {
    setMapFocused(!mapFocused);
  };

  const handleDocumentClick = (e: MouseEvent) => {
    const mapElement = document.querySelector('.leaflet-container');
    if (mapElement && !mapElement.contains(e.target as Node)) {
      setMapFocused(false);
    }
  };

  useEffect(() => {
    if (mapFocused) {
      document.addEventListener('click', handleDocumentClick);
      return () => {
        document.removeEventListener('click', handleDocumentClick);
      };
    }
  }, [mapFocused]);

  useEffect(() => {
    const mapElement = document.querySelector('.leaflet-container') as HTMLElement;
    if (!mapElement) return;

    const handleMapWheel = (e: WheelEvent) => {
      if (!mapFocused) {
        e.preventDefault();
        e.stopPropagation();

        const scrollableParent = document.querySelector('main');
        if (scrollableParent) {
          scrollableParent.scrollTop += e.deltaY;
          scrollableParent.scrollLeft += e.deltaX;
        }
      }
    };

    mapElement.addEventListener('wheel', handleMapWheel, { passive: false });
    return () => {
      mapElement.removeEventListener('wheel', handleMapWheel);
    };
  }, [mapFocused]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getTwinState();
        if (cancelled) return;
        setState(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load twin state');
      }
    }
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const corridors = state?.corridors ?? [];
  const refineries = state?.refineries ?? [];
  const lngTerminals = state?.lngTerminals ?? [];
  const ports = state?.ports ?? [];
  const sources = state?.sources ?? [];
  const routes = state?.supplyRoutes ?? [];
  const demandCentres = state?.demandCentres ?? [];
  const distributionLinks = state?.distributionLinks ?? [];
  const oilPipelines = state?.oilPipelines ?? [];
  const gasPipelines = state?.gasPipelines ?? [];
  const vesselPositions = state?.vesselPositions ?? [];

  const tileLayer = useMemo(() => tileLayerUrl(), []);
  const [baseMap, setBaseMap] = useState<'osm' | 'isro'>('osm');

  const effRouteStatus = (routeCorridor: Corridor, liveStatus: string): string =>
    whatIf.corridor && routeCorridor === whatIf.corridor ? 'closed' : liveStatus;
  const effCorridorStatus = (cor: Corridor, liveStatus: string): string =>
    whatIf.corridor && cor === whatIf.corridor ? 'closed' : liveStatus;

  const affectedDests = useMemo(() => {
    if (!whatIf.corridor) return new Set<string>();
    return new Set(
      routes.filter((r) => r.corridor === whatIf.corridor).map((r) => r.destLabel),
    );
  }, [whatIf.corridor, routes]);

  async function runWhatIf(corridor: Corridor, intensity: number) {
    setWhatIf((w) => ({ ...w, corridor, intensity, loading: true }));
    try {
      const cause = WHATIF_CAUSE[corridor];
      const cascade = await postImpactCascade(cause, intensity, false);
      setWhatIf({ corridor, intensity, cascade, loading: false });
    } catch {
      setWhatIf({ corridor, intensity, cascade: null, loading: false });
    }
  }

  function resetWhatIf() {
    setWhatIf({ corridor: null, intensity: 1.0, cascade: null, loading: false });
    setSelectedWhatIfCorridor('');
  }

  const handleSimulate = () => {
    if (selectedWhatIfCorridor) {
      runWhatIf(selectedWhatIfCorridor, whatIf.intensity);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Top Header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Geospatial</p>
          <h1 className="mt-1 text-2xl font-bold text-white leading-tight">Supply Chain Digital Twin</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] uppercase tracking-wider font-bold shadow-sm">
            <span className="text-slate-400 mr-1">Base Map:</span>
            <button
              type="button"
              onClick={() => setBaseMap('osm')}
              className={`rounded px-2.5 py-1 transition-colors ${
                baseMap === 'osm'
                  ? 'bg-blue-600 text-white font-bold'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              OSM
            </button>
            <button
              type="button"
              onClick={() => setBaseMap('isro')}
              className={`rounded px-2.5 py-1 transition-colors ${
                baseMap === 'isro'
                  ? 'bg-blue-600 text-white font-bold'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              ISRO
            </button>
          </div>
          <div className="text-right text-[10px] text-slate-400 font-bold uppercase tracking-wider">
            {state ? `Refreshed ${fmtTime(state.asOf)}` : 'Loading...'}
            {error && <div className="mt-1 text-red-600 font-bold lowercase">{error}</div>}
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px,1fr,280px] min-h-[620px]">
        {/* Left Sidebar */}
        <aside className="flex flex-col gap-4">
          {/* Quick Actions */}
          <div className="card p-5 flex flex-col gap-4">
            <h3 className="text-xs font-bold text-slate-800 border-b border-slate-100 pb-2">Toggle Map Layers</h3>
            <div className="flex flex-col gap-2">
              <ToggleSwitch
                checked={layers.routes}
                onChange={() => setLayers((prev) => ({ ...prev, routes: !prev.routes }))}
                label="Supply Routes"
              />
              <ToggleSwitch
                checked={layers.corridors}
                onChange={() => setLayers((prev) => ({ ...prev, corridors: !prev.corridors }))}
                label="Corridors"
              />
              <ToggleSwitch
                checked={layers.refineries}
                onChange={() => setLayers((prev) => ({ ...prev, refineries: !prev.refineries }))}
                label="Refineries"
              />
              <ToggleSwitch
                checked={layers.lng}
                onChange={() => setLayers((prev) => ({ ...prev, lng: !prev.lng }))}
                label="LNG Terminals"
              />
              <ToggleSwitch
                checked={layers.ports}
                onChange={() => setLayers((prev) => ({ ...prev, ports: !prev.ports }))}
                label="Ports"
              />
              <ToggleSwitch
                checked={layers.distribution}
                onChange={() => setLayers((prev) => ({ ...prev, distribution: !prev.distribution }))}
                label="Distribution"
              />
              <ToggleSwitch
                checked={layers.oilPipelines}
                onChange={() => setLayers((prev) => ({ ...prev, oilPipelines: !prev.oilPipelines }))}
                label="Oil Pipelines"
              />
              <ToggleSwitch
                checked={layers.gasPipelines}
                onChange={() => setLayers((prev) => ({ ...prev, gasPipelines: !prev.gasPipelines }))}
                label="Gas Pipelines"
              />
              <ToggleSwitch
                checked={layers.vessels}
                onChange={() => setLayers((prev) => ({ ...prev, vessels: !prev.vessels }))}
                label="AIS Vessels"
              />
              <ToggleSwitch
                checked={layers.sources}
                onChange={() => setLayers((prev) => ({ ...prev, sources: !prev.sources }))}
                label="Foreign Sources"
              />
              <ToggleSwitch
                checked={layers.vedasOverlay}
                onChange={() => setLayers((prev) => ({ ...prev, vedasOverlay: !prev.vedasOverlay }))}
                label="VEDAS Overlay (ISRO)"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                type="button"
                onClick={() => navigate('/compare')}
                className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white p-3 text-center transition-all hover:bg-slate-50 hover:shadow-sm"
              >
                <svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span className="text-[10px] font-bold text-slate-700">Open Analysis</span>
              </button>
              <button
                type="button"
                onClick={() => navigate('/spr')}
                className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white p-3 text-center transition-all hover:bg-slate-50 hover:shadow-sm"
              >
                <svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 2v-6m-9 3h9m2 3h-2M4 9h16" />
                </svg>
                <span className="text-[10px] font-bold text-slate-700">Generate Report</span>
              </button>
            </div>
          </div>

          {/* Scenarios (What-If) */}
          <div className="card p-5 flex flex-col gap-4">
            <h3 className="text-xs font-bold text-slate-800 border-b border-slate-100 pb-2">Scenarios (What-If)</h3>
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Select and run common scenarios</label>
                <select
                  value={selectedWhatIfCorridor}
                  onChange={(e) => setSelectedWhatIfCorridor(e.target.value as Corridor | '')}
                  className="input-op w-full font-medium"
                >
                  <option value="">Suez Canal Blockage</option>
                  {corridors.map((c) => (
                    <option key={c.corridor} value={c.corridor}>
                      Close {CORRIDOR_LABEL[c.corridor] ?? c.corridor}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 shrink-0">
                  Intensity {Math.round(whatIf.intensity * 100)}%
                </span>
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.1}
                  value={whatIf.intensity}
                  onChange={(e) => setWhatIf((w) => ({ ...w, intensity: Number(e.target.value) }))}
                  className="w-full accent-blue-600 cursor-pointer"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleSimulate}
                  disabled={!selectedWhatIfCorridor || whatIf.loading}
                  className="btn-accent py-2 text-xs font-semibold bg-blue-600 border-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {whatIf.loading ? 'Simulating...' : 'Simulate'}
                </button>
                <button
                  type="button"
                  onClick={resetWhatIf}
                  className="rounded-lg border border-slate-200 bg-white py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* Map Column */}
        <div className="flex flex-col gap-4 min-w-0">
          <div
            className="flex-1 min-h-[500px] overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm relative"
            onClick={handleMapClick}
          >
            <MapContainer
              center={[16, 72]}
              zoom={4}
              scrollWheelZoom={mapFocused}
              style={{ height: '100%', width: '100%', background: '#f8fafc' }}
              worldCopyJump={true}
            >
              <InvalidateSize refreshKey={corridors.length + refineries.length} />
              {baseMap === 'osm' ? (
                <TileLayer url={tileLayer.url} attribution={tileLayer.attribution} />
              ) : (
                <WMSTileLayer
                  url="/api/vedas/tile/rgb"
                  layers="T0S0M1"
                  format="image/png"
                  version="1.3.0"
                  transparent={false}
                  attribution='Imagery © <a href="https://vedas.sac.gov.in/" target="_blank" rel="noopener">VEDAS / ISRO SAC</a> · Resourcesat AWiFS Temporal RGB'
                />
              )}

              {layers.vedasOverlay && (
                <>
                  <WMSTileLayer
                    url={VEDAS_WMS_URL}
                    layers={VEDAS_LAYER_GAS}
                    format="image/png"
                    transparent
                    version="1.1.1"
                    attribution={VEDAS_ATTRIBUTION}
                    opacity={0.85}
                  />
                  <WMSTileLayer
                    url={VEDAS_WMS_URL}
                    layers={VEDAS_LAYER_OIL}
                    format="image/png"
                    transparent
                    version="1.1.1"
                    opacity={0.85}
                  />
                </>
              )}

              {/* Supply routes */}
              {layers.routes &&
                routes.map((r) => {
                  const status = effRouteStatus(r.corridor, r.status);
                  const color = STATUS_FILL[status] ?? '#64748b';
                  const dashed = status === 'closed' || status === 'disrupted';
                  const distNm = routeDistanceNm(r.path as [number, number][]);
                  return (
                    <Polyline
                      key={r.id}
                      positions={r.path as [number, number][]}
                      pathOptions={{
                        color,
                        weight: 1.5 + r.sharePct / 40,
                        opacity: status === 'closed' ? 0.9 : 0.7,
                        dashArray: dashed ? '6 6' : undefined,
                      }}
                    >
                      <Tooltip sticky>
                        <span className="font-mono text-[11px]">
                          {r.sourceLabel} → {r.destLabel} · {r.commodity.replace(/_/g, ' ')} ·{' '}
                          {r.sharePct}% · {status} · {distNm.toLocaleString()} NM
                        </span>
                      </Tooltip>
                    </Polyline>
                  );
                })}

              {/* Foreign source nodes */}
              {layers.sources &&
                sources.map((s) => (
                  <CircleMarker
                    key={s.id}
                    center={[s.lat, s.lon]}
                    radius={4}
                    pathOptions={{ color: SOURCE_COLOR, fillColor: SOURCE_COLOR, fillOpacity: 0.5, weight: 1 }}
                  >
                    <Tooltip direction="top">
                      <span className="font-mono text-[11px]">{s.label}</span>
                    </Tooltip>
                  </CircleMarker>
                ))}

              {/* Corridor chokepoints */}
              {layers.corridors &&
                corridors.map((c) => {
                  const coords = CORRIDOR_COORDS[c.corridor];
                  if (!coords) return null;
                  const status = effCorridorStatus(c.corridor, c.status);
                  const fill = STATUS_FILL[status] ?? '#94a3b8';
                  return (
                    <CircleMarker
                      key={c.corridor}
                      center={[coords.lat, coords.lon]}
                      radius={status === 'closed' ? 12 : status === 'disrupted' ? 10 : 8}
                      pathOptions={{
                        color: fill,
                        fillColor: fill,
                        fillOpacity: 0.55,
                        weight: whatIf.corridor === c.corridor ? 3 : 2,
                      }}
                      eventHandlers={{
                        click: () => {
                          setSelectedWhatIfCorridor(c.corridor);
                          runWhatIf(c.corridor, whatIf.intensity);
                        },
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                        <span className="font-mono text-[11px]">
                          {coords.label} — {status} (click: what-if)
                        </span>
                      </Tooltip>
                      <Popup>
                        <div className="font-mono text-[12px]">
                          <div className="font-semibold">{coords.label}</div>
                          <div>Status: {c.status}</div>
                          <div>Throughput: {fmtNumber(c.throughputMbPerDay, 1)} Mb/d</div>
                          <div>Vessels: {c.vesselCount}</div>
                          <div>Avg delay: {c.averageDelayHours} h</div>
                          <div className="mt-1 text-red-600">Click marker: simulate closure →</div>
                        </div>
                      </Popup>
                    </CircleMarker>
                  );
                })}

              {/* Indian refineries */}
              {layers.refineries &&
                refineries.map((r) => {
                  const hit = affectedDests.has(r.name);
                  return (
                    <CircleMarker
                      key={r.name}
                      center={[r.lat, r.lon]}
                      radius={Math.max(4, Math.min(11, Math.sqrt(r.capacityMmtpa) * 1.1))}
                      pathOptions={{
                        color: hit ? '#ef4444' : REFINERY_COLOR,
                        fillColor: REFINERY_COLOR,
                        fillOpacity: 0.7,
                        weight: hit ? 3 : 1.5,
                      }}
                    >
                      <Tooltip direction="top">
                        <span className="font-mono text-[11px]">
                          {r.name} · {fmtNumber(r.capacityMmtpa, 1)} MMTPA
                        </span>
                      </Tooltip>
                      <Popup>
                        <div className="font-mono text-[12px]">
                          <div className="font-semibold">{r.name} refinery</div>
                          <div>{r.operator}</div>
                          <div>Capacity: {fmtNumber(r.capacityMmtpa, 1)} MMTPA</div>
                          <div>Grades: {r.grades.join(', ')}</div>
                        </div>
                      </Popup>
                    </CircleMarker>
                  );
                })}

              {/* LNG terminals */}
              {layers.lng &&
                lngTerminals.map((t) => (
                  <CircleMarker
                    key={t.name}
                    center={[t.lat, t.lon]}
                    radius={Math.max(4, Math.min(10, Math.sqrt(t.capacityMtpa) * 1.6))}
                    pathOptions={{ color: LNG_COLOR, fillColor: LNG_COLOR, fillOpacity: 0.7, weight: 1.5 }}
                  >
                    <Tooltip direction="top">
                      <span className="font-mono text-[11px]">
                        {t.name} LNG · {fmtNumber(t.utilizationPct, 0)}% util
                      </span>
                    </Tooltip>
                    <Popup>
                      <div className="font-mono text-[12px]">
                        <div className="font-semibold">{t.name} LNG terminal</div>
                        <div>{t.operator}</div>
                        <div>Capacity: {fmtNumber(t.capacityMtpa, 1)} MTPA</div>
                        <div>Utilisation: {fmtNumber(t.utilizationPct, 1)}%</div>
                        <div>Status: {t.status}</div>
                      </div>
                    </Popup>
                  </CircleMarker>
                ))}

              {/* Distribution ports */}
              {layers.ports &&
                ports.map((p) => (
                  <CircleMarker
                    key={p.name}
                    center={[p.lat, p.lon]}
                    radius={3.5}
                    pathOptions={{ color: PORT_COLOR, fillColor: PORT_COLOR, fillOpacity: 0.6, weight: 1 }}
                  >
                    <Tooltip direction="top">
                      <span className="font-mono text-[11px]">
                        {p.name} · {p.type}
                      </span>
                    </Tooltip>
                  </CircleMarker>
                ))}

              {/* Distribution */}
              {layers.distribution &&
                distributionLinks.map((d) => (
                  <Polyline
                    key={d.id}
                    positions={d.path as [number, number][]}
                    pathOptions={{ color: DEMAND_COLOR, weight: 1, opacity: 0.45, dashArray: '2 4' }}
                  >
                    <Tooltip sticky>
                      <span className="font-mono text-[11px]">
                        {d.feeder} → {d.hub} · product pipeline
                      </span>
                    </Tooltip>
                  </Polyline>
                ))}

              {/* VEDAS oil pipelines */}
              {layers.oilPipelines &&
                oilPipelines.map((p) => (
                  <Polyline
                    key={p.id}
                    positions={p.polyline.map((pt) => [pt.lat, pt.lon]) as [number, number][]}
                    pathOptions={{ color: OIL_PIPELINE_COLOR, weight: 2, opacity: 0.75 }}
                  >
                    <Tooltip sticky>
                      <span className="font-mono text-[11px]">
                        {p.name} · {p.operator}
                        {p.lengthKm ? ` · ${p.lengthKm} km` : ''}
                        {p.throughputMtpa ? ` · ${p.throughputMtpa} MMTPA` : ''}
                      </span>
                    </Tooltip>
                  </Polyline>
                ))}

              {/* VEDAS natural-gas pipelines */}
              {layers.gasPipelines &&
                gasPipelines.map((p) => (
                  <Polyline
                    key={p.id}
                    positions={p.polyline.map((pt) => [pt.lat, pt.lon]) as [number, number][]}
                    pathOptions={{ color: GAS_PIPELINE_COLOR, weight: 2, opacity: 0.75, dashArray: '6 4' }}
                  >
                    <Tooltip sticky>
                      <span className="font-mono text-[11px]">
                        {p.name} · {p.operator}
                        {p.lengthKm ? ` · ${p.lengthKm} km` : ''}
                        {p.capacityMmscmd ? ` · ${p.capacityMmscmd} MMSCMD` : ''}
                      </span>
                    </Tooltip>
                  </Polyline>
                ))}

              {/* AIS vessel positions */}
              {layers.vessels &&
                vesselPositions.map((v) => {
                  const color = VESSEL_COLOR[v.cargo] ?? VESSEL_COLOR.other;
                  return (
                    <CircleMarker
                      key={v.mmsi || `${v.lat}_${v.lon}`}
                      center={[v.lat, v.lon]}
                      radius={v.anomaly ? 4.5 : 3}
                      pathOptions={{
                        color: v.anomaly ? '#fb7185' : color,
                        fillColor: color,
                        fillOpacity: 0.7,
                        weight: v.anomaly ? 2 : 1,
                      }}
                    >
                      <Tooltip direction="top">
                        <span className="font-mono text-[11px]">
                          {v.name} · {v.cargo.toUpperCase()} · {v.flag}
                          {v.anomaly ? ' · ⚠ speed<2kn (possible spoof)' : ''}
                        </span>
                      </Tooltip>
                      <Popup>
                        <div className="font-mono text-[11px] leading-tight">
                          <div className="font-semibold">{v.name}</div>
                          <div>MMSI: {v.mmsi}</div>
                          <div>{v.vesselType} · flag {v.flag}</div>
                          <div>
                            {v.speed.toFixed(1)} kn · course {v.course.toFixed(0)}°
                          </div>
                          {v.corridor && <div>Corridor: {CORRIDOR_LABEL[v.corridor]}</div>}
                          <div>Last seen: {v.lastSeen}</div>
                        </div>
                      </Popup>
                    </CircleMarker>
                  );
                })}

              {/* Domestic demand centres */}
              {layers.distribution &&
                demandCentres.map((h) => (
                  <CircleMarker
                    key={h.name}
                    center={[h.lat, h.lon]}
                    radius={Math.max(4, Math.min(9, h.demandIndex / 12))}
                    pathOptions={{ color: DEMAND_COLOR, fillColor: DEMAND_COLOR, fillOpacity: 0.35, weight: 1.5 }}
                  >
                    <Tooltip direction="top">
                      <span className="font-mono text-[11px]">
                        {h.name} · demand {h.demandIndex}
                      </span>
                    </Tooltip>
                    <Popup>
                      <div className="font-mono text-[12px]">
                        <div className="font-semibold">{h.name}</div>
                        <div>Demand index: {h.demandIndex}</div>
                        <div>Fed by: {h.fedBy.join(', ')}</div>
                      </div>
                    </Popup>
                  </CircleMarker>
                ))}
            </MapContainer>
          </div>
        </div>

        {/* Right Sidebar */}
        <aside className="flex flex-col gap-4">
          {/* Infrastructure Stats Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="card p-4">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Refineries</div>
              <div className="mt-1.5 text-2xl font-bold font-mono text-slate-800">{refineries.length}</div>
              <div className="text-[8px] text-slate-500 mt-1">{refineries.reduce((sum, r) => sum + (r.capacityMmtpa || 0), 0).toFixed(0)} MMTPA</div>
            </div>
            <div className="card p-4">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">LNG Terminals</div>
              <div className="mt-1.5 text-2xl font-bold font-mono text-slate-800">{lngTerminals.length}</div>
              <div className="text-[8px] text-slate-500 mt-1">{lngTerminals.reduce((sum, t) => sum + (t.capacityMtpa || 0), 0).toFixed(0)} MTPA</div>
            </div>
            <div className="card p-4">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Oil Pipelines</div>
              <div className="mt-1.5 text-2xl font-bold font-mono text-slate-800">{oilPipelines.length}</div>
              <div className="text-[8px] text-slate-500 mt-1">8k km - VEDAS</div>
            </div>
            <div className="card p-4">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Gas Pipelines</div>
              <div className="mt-1.5 text-2xl font-bold font-mono text-slate-800">{gasPipelines.length}</div>
              <div className="text-[8px] text-slate-500 mt-1">9k km - VEDAS</div>
            </div>
          </div>

          {/* Corridors Status */}
          <div className="card p-4">
            <h3 className="text-xs font-bold text-slate-800 border-b border-slate-100 pb-2 mb-2.5">Corridors</h3>
            <ul className="space-y-2 text-[11px]">
              {corridors.map((c) => (
                <li key={c.corridor} className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-slate-600">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: STATUS_FILL[c.status] ?? '#94a3b8' }}
                    />
                    {CORRIDOR_LABEL[c.corridor] ?? c.corridor}
                  </span>
                  <span className="flex items-center gap-1.5 tabular-nums text-slate-500">
                    <span className={`font-mono text-[10px] uppercase ${c.status === 'open' ? 'text-emerald-600' : c.status === 'congested' ? 'text-amber-600' : 'text-orange-600'}`}>
                      {c.status}
                    </span>
                    <span>{c.vesselCount}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Network Legend */}
          <div className="card p-3">
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">Network legend</div>
            <div className="flex flex-col gap-1 text-[11px]">
              <LegendDot color={REFINERY_COLOR} label="Refinery (size = capacity)" />
              <LegendDot color={LNG_COLOR} label="LNG terminal" />
              <LegendDot color={PORT_COLOR} label="Distribution port" />
              <LegendDot color={SOURCE_COLOR} label="Foreign source" />
              <LegendDot color={OIL_PIPELINE_COLOR} label="Oil pipeline" />
              <LegendDot color={GAS_PIPELINE_COLOR} label="Gas pipeline (dashed)" />
              <LegendDot color="#f472b6" label="VEDAS WMS overlay (ISRO)" />
              <LegendDot color={VESSEL_COLOR.crude} label="Vessel (color = cargo)" />
              <div className="mt-1 border-t border-slate-200 pt-1.5">
                <div className="mb-1 text-slate-500 text-[10px]">Route / corridor status</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(STATUS_FILL).map(([k]) => (
                    <LegendDot key={k} color={STATUS_FILL[k]} label={k} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* What-If Simulation Results Overlay */}
      {whatIf.corridor && whatIf.cascade && (
        <WhatIfImpact cascade={whatIf.cascade} corridorLabel={CORRIDOR_LABEL[whatIf.corridor] ?? whatIf.corridor} />
      )}
    </div>
  );
}

function WhatIfImpact({
  cascade,
  corridorLabel,
}: {
  cascade: ImpactCascadeResponse;
  corridorLabel: string;
}) {
  const fmt = (v: number) =>
    v >= 1000 ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return (
    <section className="rounded-xl border border-red-200 bg-red-50 p-5 shadow-sm mt-2">
      <div className="mb-3.5 flex items-center justify-between">
        <h3 className="text-sm font-bold text-red-800">
          What-if impact — {corridorLabel} closure
        </h3>
        <span className="text-[10px] font-bold uppercase tracking-wider text-red-650">
          {cascade.affectedCommodities.length} commodities · {cascade.sectorImpacts.length} sectors ·{' '}
          {cascade.macroImpacts.length} macro
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ImpactList title="Commodities" nodes={cascade.affectedCommodities} fmt={fmt} />
        <ImpactList title="Indian sectors" nodes={cascade.sectorImpacts.slice(0, 6)} fmt={fmt} />
        <ImpactList title="Macro" nodes={cascade.macroImpacts} fmt={fmt} />
      </div>
    </section>
  );
}

function ImpactList({
  title,
  nodes,
  fmt,
}: {
  title: string;
  nodes: ImpactCascadeResponse['sectorImpacts'];
  fmt: (v: number) => string;
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</div>
      <div className="flex flex-col gap-1.5">
        {nodes.map((n) => (
          <div
            key={n.id}
            className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"
          >
            <span className="text-slate-700">{n.label}</span>
            {n.metric ? (
              <span className="font-mono tabular-nums text-slate-500 text-[11px] font-medium">
                {fmt(n.metric.current)} → <span className="text-red-600 font-bold">{fmt(n.metric.projected)}</span>{' '}
                <span className="text-[9px] text-slate-400 font-semibold lowercase font-sans">{n.metric.unit}</span>
              </span>
            ) : (
              <span className="font-mono tabular-nums text-slate-500 font-bold">{(n.severity * 100).toFixed(0)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span className="text-slate-500">{label}</span>
    </div>
  );
}
