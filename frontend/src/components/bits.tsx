import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn, inr, mins } from '@/lib/utils';
import { Card } from './ui/card';

/** Money: ₹1,23,456, tabular. Negative reads −₹1,234, coloured and labelled. */
export function Money({ value, paise, className, negativeLabel }: { value: number | null | undefined; paise?: boolean; className?: string; negativeLabel?: string }) {
  const neg = (value ?? 0) < 0;
  return (
    <span className={cn('num whitespace-nowrap', neg && 'text-destructive', className)}>
      {inr(value, paise)}
      {neg && negativeLabel && <span className="ml-1 text-[11px] font-medium">{negativeLabel}</span>}
    </span>
  );
}

export function Minutes({ value }: { value: number | null | undefined }) {
  return <span className="num whitespace-nowrap">{value ? mins(value) : '—'}</span>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[12px]', className)}>{children}</span>;
}

export function PersonLink({ id, name, code, tab }: { id: string; name: string; code?: string; tab?: string }) {
  return (
    <Link to={`/people/${id}${tab ? `?tab=${tab}` : ''}`} className="group inline-flex min-w-0 items-baseline gap-1.5 hover:underline">
      <span className="truncate font-medium">{name}</span>
      {code && <Mono className="text-muted-foreground group-hover:no-underline">{code}</Mono>}
    </Link>
  );
}

export interface Crumb {
  label: string;
  to?: string;
}

export function PageHeader({ title, description, actions, crumbs, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: Crumb[]; meta?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-2">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[12px] text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {c.to ? (
                <Link to={c.to} className="hover:text-foreground hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span className="text-foreground">{c.label}</span>
              )}
              {i < crumbs.length - 1 && <ChevronRight className="size-3" />}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold leading-tight">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-[13px] text-muted-foreground">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** A KPI tile. Big figures use the display face. */
export function Stat({ label, value, sub, tone, to }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'destructive' | 'warning' | 'success'; to?: string }) {
  const body = (
    <Card className={cn('px-4 py-3', to && 'transition-colors hover:border-primary/40')}>
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 font-display text-2xl font-semibold num', tone === 'destructive' && 'text-destructive', tone === 'warning' && 'text-warning-foreground dark:text-warning', tone === 'success' && 'text-success')}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-muted-foreground">{sub}</div>}
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

/** Proportion bar for component breakdowns. */
export function ProportionBar({ parts }: { parts: { label: string; value: number; colour?: string }[] }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  const colours = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {parts.map((p, i) => (
          <div key={p.label} style={{ width: `${(Math.max(0, p.value) / total) * 100}%`, background: p.colour ? `var(--${p.colour})` : colours[i % colours.length] }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        {parts.map((p, i) => (
          <span key={p.label} className="flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: p.colour ? `var(--${p.colour})` : colours[i % colours.length] }} />
            {p.label} {Math.round((Math.max(0, p.value) / total) * 1000) / 10}%
          </span>
        ))}
      </div>
    </div>
  );
}

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 | 4 }) {
  const grid = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3', 4: 'grid-cols-2 lg:grid-cols-4' }[cols];
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', grid)}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[12px] text-muted-foreground">{k}</dt>
          <dd className="mt-0.5 truncate text-[13px]">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
