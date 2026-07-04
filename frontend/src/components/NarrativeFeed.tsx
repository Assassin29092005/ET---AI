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
    <article className="card overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5 bg-slate-50/50">
        <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">{title}</h3>
        <div className="text-right text-[9px] font-bold uppercase tracking-wider text-slate-400">
          {model && <div>{model}</div>}
          <div className="mt-0.5">{fmtTime(generatedAt)}</div>
        </div>
      </header>
      <div className="px-5 py-4 text-xs leading-relaxed text-slate-600 whitespace-pre-line font-medium">
        {body}
      </div>
      {citations && citations.length > 0 && (
        <footer className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-3.5 bg-slate-50/30">
          {citations.map((c, i) => (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-blue-600 font-semibold hover:border-blue-300 hover:bg-slate-50"
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
