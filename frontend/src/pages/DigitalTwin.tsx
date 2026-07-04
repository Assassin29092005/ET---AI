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

// Twin corridor code -> impact-cascade cause node id (graph uses 'cape' not 'cape_of_good_hope').
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

const CORRIDOR_COORDS: Record<Corridor, { lat: number; lon: number; label: string }> = {
  hormuz: { lat: 26.5, lon: 56.2, label: 'Strait of Hormuz' },
  bab_el_mandeb: { lat: 12.6, lon: 43.4, label: 'Bab el-Mandeb' },
  malacca: { lat: 2.5, lon: 101.5, label: 'Malacca' },
  south_china_sea: { lat: 12.0, lon: 115.0, label: 'South China Sea' },
  cape_of_good_hope: { lat: -34.3, lon: 18.4, label: 'Cape of Good Hope' },
  suez: { lat: 30.0, lon: 32.5, label: 'Suez' },
};

const CORRIDOR_TO_SCENARIO: Record<Corridor, string> = {
  hormuz: 'hormuz_partial_closure',
  bab_el_mandeb: 'red_sea_suspension',
  malacca: 'australia_coking_coal',
  south_china_sea: 'china_rare_earth_curbs',
  cape_of_good_hope: 'red_sea_suspension',
  suez: 'red_sea_suspension',
};

const STATUS_FILL: Record<string, string> = {
  open: '#10b981',
  congested: '#f59e0b',
  disrupted: '#f97316',
  closed: '#ef4444',
};

const STATUS_PILL_TEXT: Record<string, string> = {
  open: 'text-emerald-300',
  congested: 'text-amber-300',
  disrupted: 'text-orange-300',
  closed: 'text-red-300',
};

const REFINERY_COLOR = '#f59e0b';
const LNG_COLOR = '#22d3ee';
const PORT_COLOR = '#a855f7';
const SOURCE_COLOR = '#94a3b8';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined;
const MAPBOX_STYLE_ID = 'mapbox/dark-v11';

function tileLayerUrl(): { url: string; attribution: string } {
  if (MAPBOX_TOKEN) {
    return {
      url: `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_ID}/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
      attribution:
        '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    };
  }
  return {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · CARTO',
  };
}

// Fix Leaflet default icon paths in Vite builds (otherwise blank markers)
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

// Color vessels by their cargo class — matches the supply-route palette so the
// twin reads as one coherent narrative (orange = crude, cyan = LNG, etc.).
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

const OIL_PIPELINE_COLOR = '#a78bfa';   // soft violet — crude/product
const GAS_PIPELINE_COLOR = '#22d3ee';   // cyan — natural gas
const VEDAS_OVERLAY_COLOR = '#f472b6';  // pink — ISRO authoritative overlay tag

// VEDAS GeoServer WMS (powergis_private workspace). GetMap is anonymously
// accessible and returns transparent PNG tiles. Note the typo in the layer
// name: "petrolium" (not petroleum) — this is the actual server-side layer.
const VEDAS_WMS_URL = 'https://vedas.sac.gov.in/secure/geoserver/powergis_private/wms';
const VEDAS_LAYER_GAS = 'natural_gas_pipeline';
const VEDAS_LAYER_OIL = 'petrolium_products_pipeline';
const VEDAS_ATTRIBUTION =
  '<a href="https://vedas.sac.gov.in/energymap/" target="_blank" rel="noopener">Pipelines © VEDAS / ISRO SAC</a>';

function LayerToggle({
  layers,
  setLayers,
}: {
  layers: Layers;
  setLayers: (l: Layers) => void;
}) {
  const items: Array<{ key: keyof Layers; label: string; color: string }> = [
    { key: 'routes', label: 'Supply routes', color: '#10b981' },
    { key: 'refineries', label: 'Refineries', color: REFINERY_COLOR },
    { key: 'lng', label: 'LNG terminals', color: LNG_COLOR },
    { key: 'ports', label: 'Ports', color: PORT_COLOR },
    { key: 'distribution', label: 'Distribution', color: DEMAND_COLOR },
    { key: 'oilPipelines', label: 'Oil pipelines', color: OIL_PIPELINE_COLOR },
    { key: 'gasPipelines', label: 'Gas pipelines', color: GAS_PIPELINE_COLOR },
    { key: 'vessels', label: 'AIS vessels', color: VESSEL_COLOR.crude },
    { key: 'vedasOverlay', label: 'VEDAS overlay (ISRO)', color: VEDAS_OVERLAY_COLOR },
    { key: 'sources', label: 'Foreign sources', color: SOURCE_COLOR },
    { key: 'corridors', label: 'Corridors', color: '#f59e0b' },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => setLayers({ ...layers, [it.key]: !layers[it.key] })}
          className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
            layers[it.key]
              ? 'border-slate-600 bg-slate-800 text-slate-200'
              : 'border-slate-800 bg-slate-900 text-slate-600'
          }`}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: layers[it.key] ? it.color : '#3f3f46' }}
          />
          {it.label}
        </button>
      ))}
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
    ports: false,
    corridors: true,
    sources: true,
    distribution: true,
    oilPipelines: true,
    gasPipelines: true,
    // Default OFF — opt-in because tiles come from a slow gov server. Toggle on
    // during demo to overlay ISRO's authoritative pipeline rendering.
    vedasOverlay: false,
    vessels: true,
  });
  const [whatIf, setWhatIf] = useState<WhatIf>({
    corridor: null,
    intensity: 1.0,
    cascade: null,
    loading: false,
  });

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

  // What-if overrides: when a corridor is simulated closed, its routes + the
  // corridor marker render as closed, and downstream destinations are flagged.
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
  }

  const totalRefineryCapacity = useMemo(
    () => refineries.reduce((a, r) => a + (r.capacityMmtpa || 0), 0),
    [refineries],
  );
  const totalLngCapacity = useMemo(
    () => lngTerminals.reduce((a, t) => a + (t.capacityMtpa || 0), 0),
    [lngTerminals],
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Geospatial</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-100">
            Supply chain digital twin
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-slate-400">
            India's full energy supply network — foreign wellhead/mine → maritime corridor →
            Indian refinery / LNG terminal / distribution port. Run a what-if: close any corridor
            and watch routes reroute and downstream India impacts compute live.
          </p>
        </div>
        <div className="text-right text-[11px] text-slate-500">
          {state ? `Refreshed ${fmtTime(state.asOf)}` : 'Loading...'}
          {error && <div className="mt-1 text-red-400">{error}</div>}
        </div>
      </header>

      {/* What-if control: persistent supply-chain resilience planning */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
        <span className="text-[10px] uppercase tracking-wider text-indigo-400">What-if</span>
        <select
          value={whatIf.corridor ?? ''}
          onChange={(e) => {
            const v = e.target.value as Corridor | '';
            if (v) runWhatIf(v, whatIf.intensity);
            else resetWhatIf();
          }}
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-red-500 focus:outline-none"
        >
          <option value="">Live state (no simulation)</option>
          {corridors.map((c) => (
            <option key={c.corridor} value={c.corridor}>
              Close {CORRIDOR_LABEL[c.corridor] ?? c.corridor}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            Intensity {Math.round(whatIf.intensity * 100)}%
          </span>
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.1}
            value={whatIf.intensity}
            onChange={(e) => {
              const intensity = Number(e.target.value);
              setWhatIf((w) => ({ ...w, intensity }));
              if (whatIf.corridor) runWhatIf(whatIf.corridor, intensity);
            }}
            className="w-32 accent-red-500"
          />
        </div>
        {whatIf.corridor && (
          <button
            type="button"
            onClick={resetWhatIf}
            className="rounded border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500"
          >
            Reset
          </button>
        )}
        {whatIf.loading && <span className="text-xs text-slate-500">Computing impact…</span>}
        {whatIf.corridor && !whatIf.loading && (
          <span className="text-xs text-red-300">
            Simulating {CORRIDOR_LABEL[whatIf.corridor]} closure · {affectedDests.size} downstream
            node(s) affected
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <LayerToggle layers={layers} setLayers={setLayers} />
        <div className="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-[10px] uppercase tracking-wider">
          <span className="text-slate-500">Base</span>
          <button
            type="button"
            onClick={() => setBaseMap('osm')}
            className={
              baseMap === 'osm'
                ? 'rounded bg-slate-700 px-2 py-0.5 text-slate-100'
                : 'rounded px-2 py-0.5 text-slate-400 hover:text-slate-200'
            }
          >
            OSM
          </button>
          <button
            type="button"
            onClick={() => setBaseMap('isro')}
            className={
              baseMap === 'isro'
                ? 'rounded bg-pink-500/30 px-2 py-0.5 text-pink-100'
                : 'rounded px-2 py-0.5 text-slate-400 hover:text-slate-200'
            }
            title="ISRO Temporal RGB composite via VEDAS"
          >
            ISRO
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr,260px]">
        <div className="aspect-[16/10] overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
          <MapContainer
            center={[16, 72]}
            zoom={4}
            scrollWheelZoom={true}
            style={{ height: '100%', width: '100%', background: '#0b0c0f' }}
            worldCopyJump={true}
          >
            <InvalidateSize refreshKey={corridors.length + refineries.length} />
            {baseMap === 'osm' ? (
              <TileLayer url={tileLayer.url} attribution={tileLayer.attribution} />
            ) : (
              // ISRO base map — VEDAS Temporal RGB composite proxied through
              // our backend (key stays server-side). Anchored at India bounds.
              <WMSTileLayer
                url="/api/vedas/tile/rgb"
                layers="T0S0M1"
                format="image/png"
                version="1.3.0"
                transparent={false}
                attribution='Imagery © <a href="https://vedas.sac.gov.in/" target="_blank" rel="noopener">VEDAS / ISRO SAC</a> · Resourcesat AWiFS Temporal RGB'
              />
            )}

            {/* VEDAS / ISRO authoritative pipeline overlay (WMS GetMap tiles
                rendered server-side; transparent PNG over the base map). */}
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

            {/* Supply routes: source -> corridor -> India */}
            {layers.routes &&
              routes.map((r) => {
                const status = effRouteStatus(r.corridor, r.status);
                const color = STATUS_FILL[status] ?? '#64748b';
                const dashed = status === 'closed' || status === 'disrupted';
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
                        {r.sharePct}% · {status}
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
                      click: () => runWhatIf(c.corridor, whatIf.intensity),
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

            {/* Indian refineries (diamond-feel via square marker, sized by capacity) */}
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

            {/* Distribution: refinery / depot -> domestic demand centre */}
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

            {/* VEDAS oil + product pipelines (crude trunk lines) */}
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

            {/* VEDAS natural-gas pipelines (dashed to distinguish from oil) */}
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

            {/* AIS vessel positions — colored by cargo class, with an outlined
                anomaly highlight on speed-zero / drifting tankers (suspected spoof). */}
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

            {/* Domestic demand centres (distribution endpoints) */}
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

        <aside className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Refineries</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-slate-100">
                {refineries.length}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                {fmtNumber(totalRefineryCapacity, 0)} MMTPA
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">LNG terminals</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-slate-100">
                {lngTerminals.length}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                {fmtNumber(totalLngCapacity, 0)} MTPA
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Oil pipelines</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-slate-100">
                {oilPipelines.length}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                {fmtNumber(
                  oilPipelines.reduce((a, p) => a + (p.lengthKm || 0), 0),
                  0,
                )} km · VEDAS
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">Gas pipelines</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-slate-100">
                {gasPipelines.length}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-500">
                {fmtNumber(
                  gasPipelines.reduce((a, p) => a + (p.lengthKm || 0), 0),
                  0,
                )} km · VEDAS
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Vessels tracked</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">
              {state ? state.vessels : '--'}
            </div>
            <div className="mt-1 text-[10px] text-slate-500">
              SPR fill {state ? `${fmtNumber(state.storage.sprFillPct, 0)}%` : '--'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Corridors</div>
            <ul className="space-y-1.5">
              {corridors.map((c) => (
                <li
                  key={c.corridor}
                  className="flex cursor-pointer items-center justify-between rounded px-1 py-0.5 text-xs text-slate-300 hover:bg-slate-800/60"
                  onClick={() => {
                    const scenario = CORRIDOR_TO_SCENARIO[c.corridor];
                    if (scenario) navigate(`/scenarios/${scenario}`);
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: STATUS_FILL[c.status] ?? '#94a3b8' }}
                    />
                    {CORRIDOR_LABEL[c.corridor] ?? c.corridor}
                  </span>
                  <span className="flex items-center gap-1.5 tabular-nums text-slate-500">
                    <span className={`font-mono text-[10px] uppercase ${STATUS_PILL_TEXT[c.status] ?? ''}`}>
                      {c.status}
                    </span>
                    <span>{c.vesselCount}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">Network legend</div>
            <div className="flex flex-col gap-1 text-[11px]">
              <LegendDot color={REFINERY_COLOR} label="Refinery (size = capacity)" />
              <LegendDot color={LNG_COLOR} label="LNG terminal" />
              <LegendDot color={PORT_COLOR} label="Distribution port" />
              <LegendDot color={SOURCE_COLOR} label="Foreign source" />
              <LegendDot color={OIL_PIPELINE_COLOR} label="Oil pipeline (queryable)" />
              <LegendDot color={GAS_PIPELINE_COLOR} label="Gas pipeline (queryable, dashed)" />
              <LegendDot color={VEDAS_OVERLAY_COLOR} label="VEDAS WMS overlay (ISRO)" />
              <LegendDot color={VESSEL_COLOR.crude} label="Vessel (color = cargo)" />
              <LegendDot color="#fb7185" label="⚠ AIS anomaly (speed<2 kn)" />
              <div className="mt-1 border-t border-slate-800 pt-1.5">
                <div className="mb-1 text-slate-500">Route / corridor status</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(STATUS_FILL).map(([k, v]) => (
                    <LegendDot key={k} color={v} label={k} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>

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
    <section className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-red-100">
          What-if impact — {corridorLabel} closure
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {cascade.affectedCommodities.length} commodities · {cascade.sectorImpacts.length} sectors ·{' '}
          {cascade.macroImpacts.length} macro
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
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
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">{title}</div>
      <div className="flex flex-col gap-1">
        {nodes.map((n) => (
          <div
            key={n.id}
            className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/60 px-2 py-1 text-[11px]"
          >
            <span className="text-slate-300">{n.label}</span>
            {n.metric ? (
              <span className="font-mono tabular-nums text-slate-400">
                {fmt(n.metric.current)} → <span className="text-red-300">{fmt(n.metric.projected)}</span>{' '}
                <span className="text-[9px] text-slate-600">{n.metric.unit}</span>
              </span>
            ) : (
              <span className="font-mono tabular-nums text-slate-500">{(n.severity * 100).toFixed(0)}</span>
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
      <span className="text-slate-400">{label}</span>
    </div>
  );
}
