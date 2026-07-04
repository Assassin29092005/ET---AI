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
    }, 500);
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
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.2em] text-indigo-400">Replay</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-100">Historical backtest</h1>
        <p className="mt-1 text-xs text-slate-400">
          Replay a real disruption event. Watch the system's risk score evolve day-by-day.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {events.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => setSelectedId(e.id)}
            className={`rounded-lg border p-4 text-left transition ${
              selectedId === e.id
                ? 'border-indigo-500/60 bg-indigo-500/10'
                : 'border-slate-800 bg-slate-900 hover:border-slate-700'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              {e.startDate} → {e.endDate} ({e.windowDays} days)
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{e.label}</div>
            <div className="mt-2 line-clamp-2 text-xs text-slate-400 leading-relaxed">{e.summary}</div>
          </button>
        ))}
      </div>

      {selectedEvent && days.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr,2fr]">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                Day {currentDay} of {days.length - 1} · {day?.dateIso}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Corridor score" value={day?.corridorScore.toFixed(0) ?? '--'} />
                <Metric label="Brent USD" value={`$${day?.brentUsd.toFixed(2) ?? '--'}`} />
                <Metric label="GDELT events 24h" value={day?.gdeltCount.toFixed(0) ?? '--'} />
                <Metric label="AIS anomaly σ" value={day?.aisAnomaly.toFixed(2) ?? '--'} />
              </div>
              <p className="mt-4 rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm leading-relaxed text-slate-200">
                {day?.narrative ?? 'Select a day from the timeline.'}
              </p>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">
                Score trajectory
              </div>
              <div className="h-32 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis dataKey="day" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <YAxis stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }}
                      labelStyle={{ color: '#94a3b8' }}
                    />
                    <Line type="monotone" dataKey="score" stroke="#818cf8" strokeWidth={1.5} dot={false} />
                    <ReferenceLine x={currentDay} stroke="#f59e0b" strokeWidth={1.5} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 text-[10px] uppercase tracking-wider text-slate-500">Brent USD</div>
              <div className="h-32 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis dataKey="day" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <YAxis stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }}
                      labelStyle={{ color: '#94a3b8' }}
                    />
                    <Line type="monotone" dataKey="brent" stroke="#fbbf24" strokeWidth={1.5} dot={false} />
                    <ReferenceLine x={currentDay} stroke="#f59e0b" strokeWidth={1.5} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
            <button
              type="button"
              onClick={() => setCurrentDay(0)}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-indigo-500"
            >
              ⏮
            </button>
            <button
              type="button"
              onClick={() => setCurrentDay((d) => Math.max(0, d - 1))}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-indigo-500"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="rounded border border-indigo-500/60 bg-indigo-500/20 px-3 py-1 text-xs font-semibold text-indigo-100 hover:bg-indigo-500/30"
            >
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              type="button"
              onClick={() => setCurrentDay((d) => Math.min(days.length - 1, d + 1))}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-indigo-500"
            >
              ▶
            </button>
            <button
              type="button"
              onClick={() => setCurrentDay(days.length - 1)}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-indigo-500"
            >
              ⏭
            </button>
            <input
              type="range"
              min={0}
              max={days.length - 1}
              value={currentDay}
              onChange={(e) => setCurrentDay(Number(e.target.value))}
              className="flex-1"
            />
            <span className="font-mono text-xs text-slate-400">
              {currentDay + 1} / {days.length}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 font-mono text-xl tabular-nums text-slate-100">{value}</div>
    </div>
  );
}
