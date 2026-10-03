import { useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn, inr, mins } from '@/utils';
import { Card } from './ui/card';

/** Money: ₹1,23,456, tabular. Negative reads −₹1,234, coloured and labelled. */
export function Money({ value, paise, className, negativeLabel }) {
  const neg = (value ?? 0) < 0;
  return (
    <span className={cn('num whitespace-nowrap', neg && 'text-destructive', className)}>
      {inr(value, paise)}
      {neg && negativeLabel && <span className="ml-1 text-[12px] font-medium">{negativeLabel}</span>}
    </span>
  );
}

export function Minutes({ value }) {
  return <span className="num whitespace-nowrap">{value ? mins(value) : '—'}</span>;
}

export function Mono({ children, className }) {
  return <span className={cn('font-mono text-[12.5px] tracking-normal', className)}>{children}</span>;
}

export function PersonLink({ id, name, code, tab }) {
  return (
    <Link to={`/people/${id}${tab ? `?tab=${tab}` : ''}`} className="group inline-flex min-w-0 items-baseline gap-1.5 hover:underline">
      <span className="truncate font-medium">{name}</span>
      {code && <Mono className="text-muted-foreground group-hover:no-underline">{code}</Mono>}
    </Link>
  );
}

export function PageHeader({ title, description, actions, crumbs, meta }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[13px] text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {c.to ? (
                <Link to={c.to} className="hover:text-foreground hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span className="font-medium text-foreground">{c.label}</span>
              )}
              {i < crumbs.length - 1 && <ChevronRight className="size-3.5" />}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[28px] leading-tight font-semibold">{title}</h1>
          {description && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
          {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * A figure that matters. The number leads (28px, even-width digits); the label is
 * demoted to a small tracked caption above it; one tone only when it means something.
 */
/**
 * Steps a figure down in size until it fits its box on one line, so a payroll total
 * in a narrow card shrinks instead of spilling over the edge. Short figures keep their size.
 */
function useFitWidth(boxRef, textRef, value) {
  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!box || !text || typeof ResizeObserver === 'undefined') return;
    let width = -1;
    const fit = () => {
      // Only a change of width matters; the height changing with the size must not refit.
      if (box.clientWidth === width) return;
      width = box.clientWidth;
      box.style.fontSize = '';
      const need = text.offsetWidth;
      if (need > width && width > 0) box.style.fontSize = `${Math.max(16, Math.floor((parseFloat(getComputedStyle(box).fontSize) * width) / need))}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [boxRef, textRef, value]);
}

export function Stat({ label, value, sub, tone, to }) {
  const box = useRef(null);
  const text = useRef(null);
  useFitWidth(box, text, value);
  const body = (
    <Card className={cn('h-full px-5 py-4', to && 'transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-md')}>
      <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</div>
      <div
        ref={box}
        className={cn(
          'mt-1 text-[28px] leading-none font-semibold whitespace-nowrap num',
          tone === 'destructive' && 'text-destructive',
          tone === 'warning' && 'text-warning-foreground dark:text-warning',
          tone === 'success' && 'text-success',
        )}
      >
        <span ref={text}>{value}</span>
      </div>
      {sub && <div className="mt-2 text-[13px] text-muted-foreground">{sub}</div>}
    </Card>
  );
  return to ? (
    <Link to={to} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Proportion bar for component breakdowns. */
export function ProportionBar({ parts }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  const colours = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {parts.map((p, i) => (
          <div key={p.label} style={{ width: `${(Math.max(0, p.value) / total) * 100}%`, background: p.colour ? `var(--${p.colour})` : colours[i % colours.length] }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
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

export function KV({ items, cols = 2 }) {
  const grid = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3', 4: 'grid-cols-2 lg:grid-cols-4' }[cols];
  return (
    <dl className={cn('grid gap-x-8 gap-y-4', grid)}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[13px] text-muted-foreground">{k}</dt>
          <dd className="mt-0.5 truncate text-sm font-medium">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
