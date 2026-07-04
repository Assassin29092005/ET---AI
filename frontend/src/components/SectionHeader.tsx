import type { ReactNode } from "react";

interface SectionHeaderProps {
  /** Small uppercase kicker above the title. */
  eyebrow?: string;
  title: ReactNode;
  /** Optional route/id shown as a mono code chip next to the title. */
  route?: string;
  description?: ReactNode;
  /** Right-aligned action (button, status, etc.). */
  action?: ReactNode;
}

/**
 * Consistent page/section header: kicker + title (+ route code) + description,
 * with an optional right-aligned action. Pure presentation — no data logic.
 */
export function SectionHeader({ eyebrow, title, route, description, action }: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="eyebrow-kicker">{eyebrow}</div>}
        <h2 className="mt-0.5 flex items-center gap-2 text-lg font-bold tracking-tight text-op-ink">
          {title}
          {route && <code className="route-code">{route}</code>}
        </h2>
        {description && <p className="mt-0.5 text-sm text-op-ink3">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export default SectionHeader;
