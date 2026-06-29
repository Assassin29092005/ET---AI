import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import clsx from "clsx";
import Dashboard from "@/pages/Dashboard";
import DigitalTwin from "@/pages/DigitalTwin";
import ScenarioRun from "@/pages/ScenarioRun";
import Sourcing from "@/pages/Sourcing";
import SPR from "@/pages/SPR";
import Scenarios from "@/pages/Scenarios";
import ScenarioCompare from "@/pages/ScenarioCompare";
import StressTest from "@/pages/StressTest";
import Backtest from "@/pages/Backtest";
import ChatDrawer from "@/components/ChatDrawer";
import CommodityTicker from "@/components/CommodityTicker";
import { useAppStore } from "@/lib/store";
import { getCommodities, getHealthz } from "@/lib/api";
import { fmtIstClock } from "@/lib/fmt";
import type { CommodityPrice } from "@/lib/types";

interface NavGroup {
  label: string;
  items: Array<{ to: string; label: string; end?: boolean }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operations",
    items: [
      { to: "/", label: "Dashboard", end: true },
      { to: "/twin", label: "Digital twin" },
      { to: "/scenarios", label: "Scenarios" },
      { to: "/compare", label: "Compare" },
    ],
  },
  {
    label: "Analytics",
    items: [
      { to: "/stress-test", label: "Stress test" },
      { to: "/backtest", label: "Backtest" },
      { to: "/sourcing", label: "Sourcing" },
      { to: "/spr", label: "Strategic reserves" },
    ],
  },
];

function Sidebar() {
  return (
    <aside className="w-[220px] shrink-0 border-r border-op-border bg-op-panel flex flex-col">
      <div className="px-5 pt-6 pb-5 border-b border-op-border">
        <div className="text-micro uppercase tracking-wider text-op-ink3">PS2 RESILIENCE</div>
        <div className="mt-1 font-serif italic text-op-ink2 text-sm leading-tight">
          India energy intelligence
        </div>
      </div>
      <nav className="px-2 py-3 flex-1 flex flex-col gap-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-3 mb-2 text-micro uppercase tracking-wider text-op-ink3">
              {group.label}
            </div>
            <div className="flex flex-col gap-px">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    clsx(
                      "relative px-3 py-1.5 text-sm transition-colors duration-150",
                      isActive
                        ? "text-op-ink bg-op-panel2 border-l-2 border-l-op-accent pl-[10px]"
                        : "text-op-ink2 hover:text-op-ink hover:bg-op-panel2/60",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-5 py-4 border-t border-op-border text-micro uppercase tracking-wider text-op-ink3 font-mono">
        BUILD v0.2 / 2026
      </div>
    </aside>
  );
}

function useIstClock() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return fmtIstClock(now);
}

function Header() {
  const clock = useIstClock();
  const [ok, setOk] = useState<boolean | null>(null);
  const [ticker, setTicker] = useState<CommodityPrice[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        await getHealthz();
        if (!cancelled) setOk(true);
      } catch {
        if (!cancelled) setOk(false);
      }
      try {
        const prices = await getCommodities();
        if (!cancelled) setTicker(prices);
      } catch {
        // silent
      }
    }
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <header className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-op-border bg-op-panel">
      <div className="flex items-center gap-3">
        <span
          className={clsx(
            "inline-block h-1.5 w-1.5 rounded-full",
            ok === null ? "bg-op-ink3" : ok ? "bg-op-good" : "bg-op-danger",
          )}
        />
        <span className="font-mono text-micro uppercase tracking-wider text-op-ink2">
          {ok === null ? "checking" : ok ? "operational" : "degraded"}
        </span>
        <span className="hidden sm:inline-block w-px h-3 bg-op-border" />
        <span className="hidden sm:inline-block font-serif italic text-op-ink text-sm">
          Resilience console
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden lg:block">
          <CommodityTicker items={ticker} />
        </div>
        <span className="font-mono text-micro tabular-nums text-op-ink2">{clock}</span>
      </div>
    </header>
  );
}

function ChatLauncher() {
  const toggleChat = useAppStore((s) => s.toggleChat);
  const isOpen = useAppStore((s) => s.isChatOpen);
  if (isOpen) return null;
  return (
    <button
      type="button"
      onClick={toggleChat}
      className="fixed bottom-6 right-6 z-30 flex h-10 items-center gap-2 rounded-full border border-op-accent bg-op-accentSoft px-4 text-sm text-op-accent hover:bg-op-accent/20 transition-colors duration-150"
      aria-label="Open chat with the analyst"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-op-accent" aria-hidden="true" />
      <span className="font-serif italic">Ask analyst</span>
    </button>
  );
}

export default function App() {
  return (
    <div className="min-h-screen flex bg-op-bg text-op-ink">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 overflow-auto p-6 bg-op-bg">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/twin" element={<DigitalTwin />} />
            <Route path="/scenarios" element={<Scenarios />} />
            <Route path="/scenarios/:name" element={<ScenarioRun />} />
            <Route path="/compare" element={<ScenarioCompare />} />
            <Route path="/stress-test" element={<StressTest />} />
            <Route path="/backtest" element={<Backtest />} />
            <Route path="/sourcing" element={<Sourcing />} />
            <Route path="/spr" element={<SPR />} />
          </Routes>
        </main>
      </div>
      <ChatDrawer />
      <ChatLauncher />
    </div>
  );
}
