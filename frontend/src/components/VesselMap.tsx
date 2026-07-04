import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, Marker } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import L from "leaflet";
import type { VesselPing, CorridorOverlay, Refinery, Terminal } from "../lib/types";

interface VesselMapProps {
  vessels: VesselPing[];
  corridors: CorridorOverlay[];
  refineries?: Refinery[];
  terminals?: Terminal[];
  height?: string;
}

const CORRIDOR_COLOR: Record<string, string> = {
  low: "#10b981",
  elevated: "#f59e0b",
  high: "#f97316",
  critical: "#dc2626",
};

const VESSEL_COLOR: Record<string, string> = {
  crude: "#818cf8",
  lng: "#06b6d4",
  lpg: "#0ea5e9",
  coking_coal: "#a78bfa",
  container: "#94a3b8",
  product: "#fbbf24",
};

const refineryIcon = L.divIcon({
  className: "",
  html: '<div style="width:10px;height:10px;background:#f59e0b;border:2px solid #1e293b;transform:rotate(45deg)"></div>',
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});

const terminalIcon = L.divIcon({
  className: "",
  html: '<div style="width:10px;height:10px;background:#6366f1;border:2px solid #1e293b;border-radius:2px"></div>',
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});

export function VesselMap({
  vessels,
  corridors,
  refineries = [],
  terminals = [],
  height = "32rem",
}: VesselMapProps) {
  const center: LatLngExpression = [20, 60];

  return (
    <div
      className="overflow-hidden rounded-lg border border-slate-800"
      style={{ height }}
    >
      <MapContainer
        center={center}
        zoom={4}
        scrollWheelZoom={true}
        style={{ height: "100%", width: "100%", background: "#0f172a" }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {corridors.map((c) => {
          const color = CORRIDOR_COLOR[c.tier] ?? "#64748b";
          const positions: LatLngExpression[] = c.polyline.map(
            (p: { lat: number; lon: number }) =>
              [p.lat, p.lon] as LatLngExpression,
          );
          return (
            <Polyline
              key={c.id}
              positions={positions}
              pathOptions={{ color, weight: 4, opacity: 0.7 }}
            >
              <Tooltip sticky>
                <div className="text-xs">
                  <div className="font-semibold">{c.name}</div>
                  <div>Tier: {c.tier}</div>
                  <div>Score: {c.risk_score.toFixed(2)}</div>
                </div>
              </Tooltip>
            </Polyline>
          );
        })}

        {vessels.map((v) => {
          const color = VESSEL_COLOR[v.cargo] ?? "#94a3b8";
          return (
            <CircleMarker
              key={v.mmsi}
              center={[v.lat, v.lon]}
              radius={4}
              pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1 }}
            >
              <Tooltip>
                <div className="text-xs">
                  <div className="font-semibold">{v.name ?? v.mmsi}</div>
                  <div>{(v.cargo ?? "").toUpperCase()}</div>
                  <div>
                    Speed: {v.speed.toFixed(1)} kt | Course: {v.course.toFixed(0)}
                  </div>
                  {v.destination && <div>To: {v.destination}</div>}
                </div>
              </Tooltip>
            </CircleMarker>
          );
        })}

        {refineries.map((r) => (
          <Marker key={r.id} position={[r.lat, r.lon]} icon={refineryIcon}>
            <Tooltip>
              <div className="text-xs">
                <div className="font-semibold">{r.name}</div>
                <div>Capacity: {r.capacity_mtpa.toFixed(1)} MTPA</div>
              </div>
            </Tooltip>
          </Marker>
        ))}

        {terminals.map((t) => (
          <Marker key={t.id} position={[t.lat, t.lon]} icon={terminalIcon}>
            <Tooltip>
              <div className="text-xs">
                <div className="font-semibold">{t.name}</div>
                <div>{t.type.toUpperCase()}</div>
              </div>
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
