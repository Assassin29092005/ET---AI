import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getBacktestEvents,
  getBacktestReplay,
  type BacktestEvent,
  type BacktestReplayDay,
} from '@/lib/api';

export default function Backtest() {
  const [events, setEvents] = useState<BacktestEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [days, setDays] = useState<BacktestReplayDay[]>([]);
  const [currentDay, setCurrentDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    getBacktestEvents()
      .then((data) => {
        setEvents(data);
        if (data.length > 0) setSelectedId(data[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load events'));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setPlaying(false);
    setCurrentDay(0);
    getBacktestReplay(selectedId)
      .then((data) => {
        if (!cancelled) setDays(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load replay');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!playing) {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    timerRef.current = window.setInterval(() => {
      setCurrentDay((d) => {
        if (d >= days.length - 1) {
          setPlaying(false);
          return d;
        }
        return d + 1;
      });
    }, 600);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [playing, days.length]);

  const selectedEvent = events.find((e) => e.id === selectedId);
  const day = days[currentDay];

  const chartData = useMemo(
    () =>
      days.map((d) => ({
        day: d.day,
        score: d.corridorScore,
        brent: d.brentUsd,
      })),
    [days],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header section matching style */}
      <header>
        <p className="text-[10px] uppercase tracking-wider text-blue-600 font-bold">Replay</p>
        <h1 className="mt-1 text-2xl font-bold text-white leading-tight">Historical backtest</h1>
        <p className="mt-1.5 text-xs text-slate-400 font-medium leading-relaxed max-w-4xl">
          Replay a real disruption event. Watch the system's risk score evolve day-by-day.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-655 font-medium">{error}</div>
      )}

      {/* 3 cards side-by-side select grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {events.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => setSelectedId(e.id)}
            className={`card p-4 text-left transition-all duration-150 ${
              selectedId === e.id
                ? 'ring-2 ring-blue-500 shadow-md bg-white'
                : 'bg-white border-slate-200 hover:border-slate-350 hover:shadow-sm'
            }`}
          >
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
              {e.startDate} — {e.endDate} ({e.windowDays} days)
            </div>
            <div className="mt-1.5 text-xs font-bold text-slate-800 leading-snug">{e.label}</div>
            <p className="mt-2 text-[10px] text-slate-500 leading-relaxed font-semibold line-clamp-3">{e.summary}</p>
          </button>
        ))}
      </div>

      {selectedEvent && days.length > 0 && (
        <>
          {/* Main graphics side-by-side panel */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr,1fr]">
            {/* Metrics and narrative card */}
            <div className="card p-5 flex flex-col justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100 pb-2 mb-4">
                  Day {currentDay + 1} of {days.length} · {day?.dateIso}
                </div>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Metric label="Corridor score" value={day?.corridorScore.toFixed(0) ?? '--'} valueClass="text-amber-500 font-extrabold" />
                  <Metric label="Brent USD" value={`$${day?.brentUsd.toFixed(2) ?? '--'}`} />
                  <Metric label="GDELT events 24h" value={day?.gdeltCount.toFixed(0) ?? '--'} />
                  <Metric label="AIS anomaly σ" value={day?.aisAnomaly.toFixed(2) ?? '--'} />
                </div>
              </div>
              <p className="mt-6 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs leading-relaxed text-slate-600 font-medium">
                {day?.narrative ?? 'Select a day from the timeline.'}
              </p>
            </div>

            {/* Recharts stacked graphs */}
            <div className="card p-4 flex flex-col gap-4">
              <div>
                <div className="mb-2 text-[9px] font-bold uppercase tracking-wider text-slate-400">
                  Score Trajectory
                </div>
                <div className="h-28 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke="#f1f5f9" strokeDasharray="3 3" />
                      <XAxis dataKey="day" stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 9 }} />
                      <YAxis stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 9 }} />
                      <Tooltip
                        contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 10, color: '#334155' }}
                        labelStyle={{ color: '#64748b' }}
                      />
                      <Line type="monotone" dataKey="score" stroke="#3b82f6" strokeWidth={1.8} dot={false} />
                      <ReferenceLine x={currentDay} stroke="#d97706" strokeWidth={1.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[9px] font-bold uppercase tracking-wider text-slate-400">
                  Brent USD
                </div>
                <div className="h-28 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke="#f1f5f9" strokeDasharray="3 3" />
                      <XAxis dataKey="day" stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 9 }} />
                      <YAxis stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 9 }} />
                      <Tooltip
                        contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 10, color: '#334155' }}
                        labelStyle={{ color: '#64748b' }}
                      />
                      <Line type="monotone" dataKey="brent" stroke="#d97706" strokeWidth={1.8} dot={false} />
                      <ReferenceLine x={currentDay} stroke="#d97706" strokeWidth={1.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>

          {/* Footer controller bar */}
          <div className="card px-5 py-3.5 flex items-center justify-between gap-4 bg-slate-50/50">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCurrentDay(0)}
                disabled={currentDay === 0}
                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-650 hover:bg-slate-50 disabled:opacity-40 shadow-sm"
                title="Skip to Start"
              >
                ⏮
              </button>
              <button
                type="button"
                onClick={() => setCurrentDay((d) => Math.max(0, d - 1))}
                disabled={currentDay === 0}
                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-650 hover:bg-slate-50 disabled:opacity-40 shadow-sm"
                title="Previous Step"
              >
                ◀
              </button>
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="flex items-center gap-1 rounded-lg px-4 py-1 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm"
              >
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button
                type="button"
                onClick={() => setCurrentDay((d) => Math.min(days.length - 1, d + 1))}
                disabled={currentDay === days.length - 1}
                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-650 hover:bg-slate-50 disabled:opacity-40 shadow-sm"
                title="Next Step"
              >
                ▶
              </button>
              <button
                type="button"
                onClick={() => setCurrentDay(days.length - 1)}
                disabled={currentDay === days.length - 1}
                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-650 hover:bg-slate-50 disabled:opacity-40 shadow-sm"
                title="Skip to End"
              >
                ⏭
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={days.length - 1}
              value={currentDay}
              onChange={(e) => setCurrentDay(Number(e.target.value))}
              className="flex-1 accent-blue-600 cursor-pointer"
            />
            <span className="font-mono text-xs font-bold text-slate-500">
              {currentDay + 1} / {days.length}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, valueClass = 'text-slate-800' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`font-mono text-lg font-bold tabular-nums tracking-tight ${valueClass}`}>{value}</div>
    </div>
  );
}
