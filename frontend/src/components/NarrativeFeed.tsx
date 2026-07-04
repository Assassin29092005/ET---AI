import { fmtTime } from '@/lib/fmt';

interface NarrativeFeedProps {
  title: string;
  body: string;
  generatedAt: string;
  model?: string;
  citations?: Array<{ label: string; url: string }>;
}

export function NarrativeFeed({ title, body, generatedAt, model, citations }: NarrativeFeedProps) {
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900">
      <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <div className="text-right text-[10px] uppercase tracking-wider text-slate-500">
          {model && <div>{model}</div>}
          <div>{fmtTime(generatedAt)}</div>
        </div>
      </header>
      <div className="px-5 py-4 text-sm leading-relaxed text-slate-300 whitespace-pre-line">
        {body}
      </div>
      {citations && citations.length > 0 && (
        <footer className="flex flex-wrap gap-2 border-t border-slate-800 px-5 py-3">
          {citations.map((c, i) => (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-indigo-400 hover:border-indigo-500"
            >
              {c.label}
            </a>
          ))}
        </footer>
      )}
    </article>
  );
}

export default NarrativeFeed;
