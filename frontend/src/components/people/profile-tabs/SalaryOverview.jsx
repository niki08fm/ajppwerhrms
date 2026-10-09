import { useState } from 'react';
import { formatINR } from '@ajpwer/shared';
import { Money } from '@/components/bits';
import { Card, CardHeader } from '@/components/ui/card';

/** The same computed monthly amounts as the salary breakup, shown visually. */
export function SalaryOverview({ p }) {
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);
  const components = p.structure.monthly;
  const candidate = hovered ?? selected;
  const highlighted = components.some(component => component.name === candidate) ? candidate : null;
  const circumference = 2 * Math.PI * 64;
  let offset = 0;
  const netShare = p.gross > 0 && p.take_home >= 0 && p.take_home <= p.gross ? p.take_home / p.gross : null;
  return (
    <Card className="min-w-0 overflow-hidden" role="region" aria-label="Salary overview">
      <CardHeader title="Salary overview" description="Monthly earnings" />
      <div className="p-5">
        <div className="flex flex-wrap items-center justify-center gap-5" onPointerLeave={() => setHovered(null)}>
          <div className="relative size-44 shrink-0">
            <svg viewBox="0 0 176 176" role="img" aria-label="Monthly salary earnings" className="size-full">
              <title>{`Monthly salary earnings: ${formatINR(p.gross)}`}</title>
              <circle cx="88" cy="88" r="64" fill="none" stroke="var(--muted)" strokeWidth="24" />
              {components.map((component, index) => {
                const share = p.gross > 0 ? component.amount / p.gross : 0;
                const length = Math.max(0, share) * circumference;
                const start = offset;
                offset += length;
                if (!length) return null;
                return (
                  <circle key={component.name} cx="88" cy="88" r="64" fill="none"
                    stroke={`var(--chart-${index % 5 + 1})`} strokeWidth="24"
                    strokeDasharray={`${length} ${circumference}`} strokeDashoffset={-start} transform="rotate(-90 88 88)"
                    opacity={highlighted === null || highlighted === component.name ? 1 : 0.3}
                    onPointerEnter={() => setHovered(component.name)}>
                    <title>{`${component.name}: ${formatINR(component.amount)} (${(share * 100).toFixed(1)}%)`}</title>
                  </circle>
                );
              })}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
              <span className="text-[12px] text-muted-foreground">Gross salary</span>
              <Money value={p.gross} className="mt-1 text-[20px] font-semibold" />
            </div>
          </div>
          <ul className="min-w-0 flex-1 space-y-2 text-[13px]">
            {components.map((component, index) => (
              <li key={component.name}>
                <button type="button"
                  className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  onPointerEnter={() => setHovered(component.name)} onFocus={() => setHovered(component.name)} onBlur={() => setHovered(null)}
                  onClick={() => setSelected(selected === component.name ? null : component.name)}
                  aria-label={`${component.name}: ${formatINR(component.amount)}`} aria-pressed={selected === component.name}>
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: `var(--chart-${index % 5 + 1})` }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words">{component.name}</span>
                  <Money value={component.amount} className="font-medium" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-5 border-t pt-4">
          <div className="flex flex-wrap justify-between gap-3 text-[13px]">
            <div><span className="text-muted-foreground">Net pay</span><div className="mt-1 text-success"><Money value={p.take_home} className="text-[18px] font-semibold" /></div></div>
            <div className="text-right"><span className="text-muted-foreground">Deductions</span><div className="mt-1"><Money value={p.gross - p.take_home} className="text-[18px] font-semibold" /></div></div>
          </div>
          {netShare !== null && (
            <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="bg-success" style={{ width: `${netShare * 100}%` }} />
              <div className="bg-chart-5" style={{ width: `${(1 - netShare) * 100}%` }} />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
