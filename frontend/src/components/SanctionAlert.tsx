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
  high: 'bg-amber-500/10',
  critical: 'bg-red-500/10',
};

const SEVERITY_TEXT: Record<string, string> = {
  high: 'text-amber-200',
  critical: 'text-red-200',
};

export function SanctionAlert({ alert, onDismiss }: SanctionAlertProps) {
  return (
    <div
      className={`flex items-start gap-3 rounded-sm border-l-2 px-3 py-2 ${SEVERITY_BORDER[alert.severity] ?? 'border-l-slate-500'} ${SEVERITY_BG[alert.severity] ?? 'bg-slate-800/40'}`}
    >
      <span
        className={`mt-0.5 inline-flex items-center justify-center text-xs ${SEVERITY_TEXT[alert.severity] ?? 'text-slate-300'}`}
        aria-hidden="true"
      >
        ▲
      </span>
      <div className="flex-1 text-sm">
        <div
          className={`text-[10px] uppercase tracking-wider ${SEVERITY_TEXT[alert.severity] ?? 'text-slate-300'}`}
        >
          Sanctions alert · {alert.severity}
        </div>
        <p className="mt-0.5 text-slate-200">
          <span className="font-mono">{alert.vesselName}</span>{' '}
          {alert.mmsi && (
            <span className="text-[11px] text-slate-500">({alert.mmsi})</span>
          )}{' '}
          - {alert.corridor.replace(/_/g, ' ')}
          {alert.etaPort && <span className="text-slate-500"> · ETA {alert.etaPort}</span>}
        </p>
        <p className="mt-1 text-[11px] text-slate-400">{alert.note}</p>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-slate-500 hover:text-slate-300"
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
