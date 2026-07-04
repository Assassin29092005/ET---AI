import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getExecutiveBrief,
  getFeed,
  getScenarios,
  getScores,
  getTwinStateWithAlerts,
  postSlack,
  type ScenarioMeta,
  type SanctionAlertItem,
} from "@/lib/api";
import { connectFeedWebSocket } from "@/lib/ws";
import { fmtIstTime } from "@/lib/fmt";
import { useAppStore } from "@/lib/store";
import {
  COMMODITY_LABEL,
  CORRIDOR_LABEL,
  scoreToTier,
  type Corridor,
  type ExecutiveBrief,
  type FeedItem,
  type RiskScore,
  type RiskTier,
} from "@/lib/types";
import { RiskTicker } from "@/components/RiskTicker";
import { SanctionAlertBanner } from "@/components/SanctionAlert";

const HERO_CORRIDORS: Corridor[] = ["hormuz", "bab_el_mandeb", "malacca", "south_china_sea"];

const HERO_TITLE: Record<Corridor, string> = {
  hormuz: "Hormuz",
  bab_el_mandeb: "Bab el-Mandeb",
  malacca: "Malacca",
  south_china_sea: "South China Sea",
  cape_of_good_hope: "Cape",
  suez: "Suez",
};

const TIER_DOT: Record<RiskTier, string> = {
  low: "bg-op-good",
  elevated: "bg-op-warn",
  high: "bg-amber-500",
  critical: "bg-op-danger",
};

const TIER_TEXT: Record<RiskTier, string> = {
  low: "text-op-good",
  elevated: "text-op-warn",
  high: "text-amber-300",
  critical: "text-op-danger",
};

const REFRESH_MS = 60_000;

function aggregateCorridor(scores: RiskScore[], corridor: Corridor) {
  const subset = scores.filter((s) => s.corridor === corridor);
  if (subset.length === 0) return null;
  const top = subset.reduce((a, b) => (a.score >= b.score ? a : b));
  const drivers = Array.from(new Set(subset.flatMap((s) => s.drivers ?? []))).slice(0, 3);
  return { score: top.score, tier: top.tier, drivers };
}

const fmtTimeUtc = fmtIstTime;

function MetricCard({
  title,
  score,
  tier,
  drivers,
}: {
  title: string;
  score: number | null;
  tier: RiskTier | null;
  drivers: string[];
}) {
  const t = tier ?? "low";
  return (
    <div className="rounded-md border border-op-border bg-op-panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-micro uppercase tracking-wider text-op-ink3">{title} risk</span>
        <span className={`h-1.5 w-1.5 rounded-full ${TIER_DOT[t]}`} />
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className={`font-mono tabular-nums tracking-tighter text-2xl ${TIER_TEXT[t]}`}>
          {score === null ? "--" : score.toFixed(0)}
        </span>
        <span className="font-mono text-micro uppercase tracking-wider text-op-ink2">
          {tier ?? "no signal"}
        </span>
      </div>
      <ul className="mt-3 space-y-1 font-mono text-meta text-op-ink3">
        {drivers.length === 0 ? (
          <li>No active drivers</li>
        ) : (
          drivers.slice(0, 3).map((d, i) => (
            <li key={i} className="line-clamp-1">
              {d}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function ScenarioRow({ s }: { s: ScenarioMeta }) {
  return (
    <Link
      to={`/scenarios/${s.name}`}
      className="group flex items-center justify-between rounded-md border border-op-border bg-op-panel px-4 py-3 hover:border-op-borderStrong hover:bg-op-panel2 transition-colors duration-150"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-op-ink">{s.label}</div>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-micro uppercase tracking-wider text-op-ink3">
            {COMMODITY_LABEL[s.primary_commodity] ?? s.primary_commodity}
          </span>
          <span className="text-op-ink3">·</span>
          <span className="font-mono text-micro uppercase tracking-wider text-op-ink3">
            {CORRIDOR_LABEL[s.primary_corridor] ?? s.primary_corridor}
          </span>
        </div>
      </div>
      <span className="text-op-ink3 group-hover:text-op-accent transition-colors duration-150">→</span>
    </Link>
  );
}

function ExecutiveBriefPanel({ brief, onShare }: { brief: ExecutiveBrief | null; onShare?: () => void }) {
  if (!brief) {
    return (
      <div className="rounded-md border border-op-border bg-op-panel p-6 text-sm text-op-ink3">
        Executive brief loading...
      </div>
    );
  }
  return (
    <div className="rounded-md border border-op-border bg-op-panel">
      <div className="flex items-center justify-between border-b border-op-border px-5 py-3">
        <div>
          <div className="text-micro uppercase tracking-wider text-op-ink3">Executive brief</div>
          <h3 className="mt-0.5 font-serif italic text-op-ink text-base">{brief.headline}</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro tabular-nums text-op-ink3">
            {fmtTimeUtc(brief.generatedAt)}
          </span>
          {onShare && (
            <button type="button" className="btn-ghost text-xs" onClick={onShare}>
              Send to Slack
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-6 px-5 py-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <p className="text-sm leading-relaxed text-op-ink">{brief.summary}</p>
          {brief.actions && brief.actions.length > 0 && (
            <div className="mt-5">
              <div className="text-micro uppercase tracking-wider text-op-ink3 mb-2">
                Recommended actions
              </div>
              <ul className="space-y-2 text-sm text-op-ink">
                {brief.actions.slice(0, 5).map((a, i) => (
                  <li key={i} className="flex gap-2 leading-relaxed">
                    <span className="text-op-accent">›</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <div className="text-micro uppercase tracking-wider text-op-ink3 mb-2">
            Market snapshot
          </div>
          <dl className="space-y-2 text-sm">
            {[
              { k: "Brent", v: brief.marketSnapshot?.brentUsd, unit: "USD/bbl" },
              { k: "TTF", v: brief.marketSnapshot?.ttfEurMwh, unit: "EUR/MWh" },
              { k: "INR/USD", v: brief.marketSnapshot?.inrUsd, unit: "" },
              { k: "Coal", v: brief.marketSnapshot?.coalAud, unit: "AUD/t" },
            ].map((row) => (
              <div
                key={row.k}
                className="flex items-baseline justify-between border-b border-op-border pb-1.5"
              >
                <dt className="text-op-ink2">{row.k}</dt>
                <dd className="font-mono tabular-nums text-op-ink">
                  {(row.v ?? 0).toFixed(2)}
                  {row.unit && <span className="ml-1 text-micro text-op-ink3">{row.unit}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      {brief.citations && brief.citations.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-op-border px-5 py-3">
          {brief.citations.map((c, i) => (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-op-border px-2 py-0.5 font-mono text-micro uppercase tracking-wider text-op-accent hover:border-op-accent transition-colors duration-150"
            >
              {c.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [scores, setScores] = useState<RiskScore[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [brief, setBrief] = useState<ExecutiveBrief | null>(null);
  const [alerts, setAlerts] = useState<SanctionAlertItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const pushFeedItem = useAppStore((s) => s.pushFeedItem);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [s, f, c, b, t] = await Promise.all([
          getScores(),
          getFeed(),
          getScenarios(),
          getExecutiveBrief(),
          getTwinStateWithAlerts(),
        ]);
        if (cancelled) return;
        setScores(s);
        setFeed(f);
        setScenarios(c);
        setBrief(b);
        setAlerts(t.sanctionAlerts ?? []);
        setLoadedAt(new Date().toISOString());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      }
    }

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const conn = connectFeedWebSocket((item) => {
      setFeed((cur) => [item, ...cur.filter((x) => x.id !== item.id)].slice(0, 50));
      pushFeedItem(item);
    });
    return () => conn.disconnect();
  }, [pushFeedItem]);

  const heroCards = useMemo(() => {
    return HERO_CORRIDORS.map((corridor) => {
      const agg = aggregateCorridor(scores, corridor);
      return {
        corridor,
        title: HERO_TITLE[corridor],
        score: agg?.score ?? null,
        tier: (agg?.tier ?? scoreToTier(agg?.score ?? 0)) as RiskTier,
        drivers: agg?.drivers ?? [],
      };
    });
  }, [scores]);

  async function shareToSlack() {
    if (!brief) return;
    setShareStatus("Sending...");
    try {
      const res = await postSlack({
        title: brief.headline,
        body: brief.summary,
        severity: "warn",
      });
      setShareStatus(res.sent ? "Sent to Slack ✓" : `Dry-run (${res.reason ?? "no webhook"})`);
    } catch (e) {
      setShareStatus(e instanceof Error ? e.message : "Failed");
    } finally {
      setTimeout(() => setShareStatus(null), 4000);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-micro uppercase tracking-wider text-op-accent">
            ET AI Hackathon 2026 / PS2
          </p>
          <h1 className="mt-1 font-serif italic text-2xl text-op-ink leading-tight">
            Energy supply chain resilience
          </h1>
          <p className="mt-1 text-sm text-op-ink2">
            Composite risk across maritime corridors. Refresh every 60s; WebSocket push on top.
          </p>
        </div>
        <div className="text-right font-mono text-micro uppercase tracking-wider text-op-ink3">
          {loadedAt ? `Updated ${fmtTimeUtc(loadedAt)}` : "loading..."}
          {error && <div className="mt-1 text-op-danger normal-case">{error}</div>}
          {shareStatus && <div className="mt-1 text-op-accent normal-case">{shareStatus}</div>}
        </div>
      </header>

      {alerts.length > 0 && <SanctionAlertBanner alerts={alerts} maxVisible={2} />}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {heroCards.map((c) => (
          <MetricCard
            key={c.corridor}
            title={c.title}
            score={c.score}
            tier={c.tier}
            drivers={c.drivers}
          />
        ))}
      </section>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr,1fr]">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-micro uppercase tracking-wider text-op-ink3">Narrated feed</h2>
            <span className="font-mono text-micro tabular-nums text-op-ink3">{feed.length} items</span>
          </div>
          <RiskTicker items={feed} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-micro uppercase tracking-wider text-op-ink3">Stress scenarios</h2>
            <Link
              to="/compare"
              className="font-mono text-micro uppercase tracking-wider text-op-accent hover:underline"
            >
              Compare →
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            {scenarios.length === 0 ? (
              <div className="rounded-md border border-op-border bg-op-panel p-6 text-sm text-op-ink3">
                Loading scenarios...
              </div>
            ) : (
              scenarios.slice(0, 7).map((s) => <ScenarioRow key={s.name} s={s} />)
            )}
          </div>
        </div>
      </section>

      <section>
        <ExecutiveBriefPanel brief={brief} onShare={shareToSlack} />
      </section>
    </div>
  );
}
