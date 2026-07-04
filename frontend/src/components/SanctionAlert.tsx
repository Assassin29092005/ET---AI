import { useState } from 'react';
import type { SanctionAlertItem } from '@/lib/api';

interface SanctionAlertProps {
  alert: SanctionAlertItem;
  onDismiss?: () => void;
}

const SEVERITY_BORDER: Record<string, string> = {
  high: 'border-l-amber-500',
  critical: 'border-l-red-500',
};

const SEVERITY_BG: Record<string, string> = {
  high: 'bg-amber-50 border-amber-200',
  critical: 'bg-red-50 border-red-200',
};

const SEVERITY_TEXT: Record<string, string> = {
  high: 'text-amber-700 font-semibold',
  critical: 'text-red-700 font-semibold',
};

export function SanctionAlert({ alert, onDismiss }: SanctionAlertProps) {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border border-slate-200 border-l-4 px-4 py-3 shadow-sm ${SEVERITY_BORDER[alert.severity] ?? 'border-l-slate-400'} ${SEVERITY_BG[alert.severity] ?? 'bg-slate-50'}`}
    >
      <span
        className={`mt-0.5 inline-flex items-center justify-center text-xs ${SEVERITY_TEXT[alert.severity] ?? 'text-slate-500'}`}
        aria-hidden="true"
      >
        ▲
      </span>
      <div className="flex-1 text-sm">
        <div
          className={`text-[10px] uppercase tracking-wider ${SEVERITY_TEXT[alert.severity] ?? 'text-slate-500'}`}
        >
          Sanctions alert · {alert.severity}
        </div>
        <p className="mt-1 text-slate-800 font-medium">
          <span className="font-mono">{alert.vesselName}</span>{' '}
          {alert.mmsi && (
            <span className="text-xs text-slate-400">({alert.mmsi})</span>
          )}{' '}
          - {alert.corridor.replace(/_/g, ' ')}
          {alert.etaPort && <span className="text-slate-400 font-normal"> · ETA {alert.etaPort}</span>}
        </p>
        <p className="mt-1.5 text-xs text-slate-600 leading-snug">{alert.note}</p>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-slate-400 hover:text-slate-600 transition-colors duration-150 text-lg font-bold leading-none"
          aria-label="Dismiss alert"
        >
          ×
        </button>
      )}
    </div>
  );
}

interface SanctionAlertBannerProps {
  alerts: SanctionAlertItem[];
  maxVisible?: number;
}

export function SanctionAlertBanner({ alerts, maxVisible = 3 }: SanctionAlertBannerProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const visible = alerts.filter((a) => !dismissed.has(`${a.vesselName}-${a.mmsi}`));
  if (visible.length === 0) return null;

  const sliced = showAll ? visible : visible.slice(0, maxVisible);

  return (
    <div className="flex flex-col gap-2">
      {sliced.map((a, i) => (
        <SanctionAlert
          key={`${a.vesselName}-${a.mmsi}-${i}`}
          alert={a}
          onDismiss={() => {
            setDismissed((prev) => {
              const next = new Set(prev);
              next.add(`${a.vesselName}-${a.mmsi}`);
              return next;
            });
          }}
        />
      ))}
      {visible.length > maxVisible && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-[11px] uppercase tracking-wider text-indigo-400 hover:text-indigo-300"
        >
          Show {visible.length - maxVisible} more →
        </button>
      )}
    </div>
  );
}

export default SanctionAlert;
