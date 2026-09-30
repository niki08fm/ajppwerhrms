import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { istTime } from '@/utils';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';
import { AuditDetail, actionLabel } from '../../../pages/setup/Audit';

/** This person's own history, without searching the global log. */
export function TimelineTab({ e }) {
  const q = useQuery({
    queryKey: ['timeline', e.id],
    queryFn: () => api.get(`/employees/${e.id}/timeline`).then((r) => r.data),
  });
  return (
    <Card>
      <CardHeader title="Timeline" description="Every change to this person, newest first, from the insert-only audit log." />
      {q.isLoading ? (
        <SkeletonRows rows={6} cols={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState title="Nothing recorded yet" body="Changes appear here as they happen." />
      ) : (
        <ol className="relative ml-6 border-l py-3">
          {q.data.map((a) => (
            <li key={a.id} className="mb-4 ml-4">
              <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full border-2 border-card bg-primary" />
              <div className="text-[12px] text-muted-foreground num">
                {istTime(a.at, true)} · {a.actor}
              </div>
              <div className="text-[13px] font-medium">{actionLabel(a.action)}</div>
              <AuditDetail detail={a.detail} />
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
