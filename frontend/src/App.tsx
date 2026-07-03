import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
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
import Baselines from "@/pages/Baselines";
import CompoundScenarios from "@/pages/CompoundScenarios";
import ImpactCascade from "@/pages/ImpactCascade";
import ChatDrawer from "@/components/ChatDrawer";
import CommodityTicker from "@/components/CommodityTicker";
import { useAppStore } from "@/lib/store";
import { getCommodities, getHealthz } from "@/lib/api";
import { fmtIstClock } from "@/lib/fmt";
import type { CommodityPrice } from "@/lib/types";

// Helper hook for the current clock
function useIstClock() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return fmtIstClock(now);
}

// Icon Sidebar definitions
interface SidebarItem {
  to: string;
  label: string;
  icon: JSX.Element;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  {
    to: "/",
    label: "Overview",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
  },
  {
    to: "/backtest",
    label: "History",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    to: "/baselines",
    label: "Compliance",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
  },
  {
    to: "/stress-test",
    label: "Benchmarks",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
];

function IconSidebar() {
  return (
    <aside className="w-16 shrink-0 border-r border-slate-200 bg-white flex flex-col items-center py-4 gap-4">
      {SIDEBAR_ITEMS.map((item) => (
        <NavLink
          key={item.label}
          to={item.to}
          className={({ isActive }) =>
            clsx(
              "relative flex items-center justify-center w-12 h-12 rounded-xl transition-all duration-150 group",
              isActive
                ? "bg-blue-50 text-blue-600 font-semibold"
                : "text-slate-400 hover:text-slate-600 hover:bg-slate-50",
            )
          }
          title={item.label}
        >
          {item.icon}
          <span className="absolute left-14 scale-0 group-hover:scale-100 transition-all duration-150 origin-left bg-slate-800 text-white text-[10px] px-2 py-1 rounded shadow-md z-50 whitespace-nowrap">
            {item.label}
          </span>
        </NavLink>
      ))}
    </aside>
  );
}

// Top navigation tabs definition
interface TopTab {
  label: string;
  to: string;
  matcher: (path: string) => boolean;
}

const TOP_TABS: TopTab[] = [
  {
    label: "Dashboard",
    to: "/",
    matcher: (path) => path === "/",
  },
  {
    label: "Analysis",
    to: "/scenarios",
    matcher: (path) =>
      path.startsWith("/scenarios") ||
      path.startsWith("/compare") ||
      path.startsWith("/compound") ||
      path.startsWith("/cascade"),
  },
  {
    label: "Markets",
    to: "/twin",
    matcher: (path) => path.startsWith("/twin") || path.startsWith("/sourcing"),
  },
  {
    label: "Reports",
    to: "/spr",
    matcher: (path) =>
      path.startsWith("/spr") || path.startsWith("/stress-test") || path.startsWith("/backtest"),
  },
  {
    label: "Admin",
    to: "/baselines",
    matcher: (path) => path.startsWith("/baselines"),
  },
];

function TopBar() {
  const clock = useIstClock();
  const location = useLocation();
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
    <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-slate-200 bg-white z-20">
      {/* Brand Logo and Horizontal Tabs */}
      <div className="flex items-center gap-8 h-full">
        {/* Brand Logo */}
        <div className="flex items-center gap-2">
          <span className="font-bold tracking-tight text-slate-800 text-sm">IMPORTRISK</span>
          <span className="font-light text-slate-400 text-xs tracking-wider border-l border-slate-200 pl-2">
            ANALYZE
          </span>
        </div>

        {/* Tabs Navigation */}
        <nav className="flex items-center gap-1 h-full pt-1">
          {TOP_TABS.map((tab) => {
            const isActive = tab.matcher(location.pathname);
            return (
              <NavLink
                key={tab.label}
                to={tab.to}
                className={clsx(
                  "px-4 h-13 flex items-center text-[13px] font-medium border-b-2 transition-all duration-150",
                  isActive
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-200"
                )}
              >
                {tab.label}
              </NavLink>
            );
          })}
        </nav>
      </div>

      {/* Ticker, Status, Profile */}
      <div className="flex items-center gap-4">
        {/* Price Ticker */}
        <div className="hidden lg:block">
          <CommodityTicker items={ticker} />
        </div>

        {/* IST Clock */}
        <span className="hidden sm:inline-block font-mono text-micro tabular-nums text-slate-400">
          {clock}
        </span>

        {/* Health status indicator */}
        <div className="flex items-center gap-1.5 border-l border-slate-200 pl-4 py-1">
          <span
            className={clsx(
              "inline-block h-1.5 w-1.5 rounded-full",
              ok === null ? "bg-slate-300 animate-pulse" : ok ? "bg-emerald-500" : "bg-red-500"
            )}
          />
          <span className="font-mono text-[9px] uppercase tracking-wider text-slate-400 font-semibold">
            {ok === null ? "Checking" : ok ? "Operational" : "Degraded"}
          </span>
        </div>
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
      className="fixed bottom-6 right-6 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 hover:scale-105 active:scale-95 transition-all duration-150 border border-blue-500"
      aria-label="Open analyst chat"
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    </button>
  );
}

export default function App() {
  return (
    <div className="h-screen flex flex-col bg-slate-900 overflow-hidden font-sans">
      {/* Horizontal Topbar */}
      <TopBar />
      
      {/* Sidebar + Main Content */}
      <div className="flex-1 flex min-h-0">
        <IconSidebar />
        
        {/* Navy page frame wrapper */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#0E1B30] overflow-hidden p-6">
          <main className="flex-1 overflow-auto rounded-xl">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/twin" element={<DigitalTwin />} />
              <Route path="/cascade" element={<ImpactCascade />} />
              <Route path="/scenarios" element={<Scenarios />} />
              <Route path="/scenarios/:name" element={<ScenarioRun />} />
              <Route path="/compare" element={<ScenarioCompare />} />
              <Route path="/compound" element={<CompoundScenarios />} />
              <Route path="/stress-test" element={<StressTest />} />
              <Route path="/backtest" element={<Backtest />} />
              <Route path="/sourcing" element={<Sourcing />} />
              <Route path="/spr" element={<SPR />} />
              <Route path="/baselines" element={<Baselines />} />
            </Routes>
          </main>
        </div>
      </div>
      
      {/* Ask analyst overlay drawer */}
      <ChatDrawer />
      <ChatLauncher />
    </div>
  );
}
