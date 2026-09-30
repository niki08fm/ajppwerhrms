import type { ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Card, CardHeader } from './ui/card';
import { ErrorState, SkeletonBlock } from './states';

export const CHART = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export const axis = { stroke: 'var(--muted-foreground)', fontSize: 11, tickLine: false, axisLine: false } as const;
export const grid = { stroke: 'var(--border)', strokeDasharray: '3 3', vertical: false } as const;
export const tooltipStyle = {
  contentStyle: { background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--popover-foreground)' },
  labelStyle: { color: 'var(--muted-foreground)' },
} as const;

export const rupeesShort = (p: number) => {
  const r = p / 100;
  if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
  if (Math.abs(r) >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
  if (Math.abs(r) >= 1e3) return `₹${(r / 1e3).toFixed(0)}k`;
  return `₹${r.toFixed(0)}`;
};

/**
 * A dashboard card with its own query: loading shows a skeleton, an error shows a
 * retry, and a failure here never blanks the rest of the page.
 */
export function QueryCard<T>({
  title,
  description,
  actions,
  query,
  children,
  height = 220,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  height?: number;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader title={title} description={description} actions={actions} />
      <div className="p-3">
        {query.isLoading ? (
          <SkeletonBlock className="w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} compact />
        ) : query.data !== undefined ? (
          children(query.data)
        ) : null}
        {query.isLoading && <div style={{ height }} />}
      </div>
    </Card>
  );
}

export { useQuery };
