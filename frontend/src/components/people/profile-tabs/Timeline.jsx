import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { istTime } from '@/utils';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';
import { AuditDetail, actionLabel } from '../../../pages/setup/Audit';

/** A short kind for each audit action, with a colour, so the list scans at a glance. */
const KINDS = [
  [/attendance|override|punch/, 'Attendance', 'warning'],
  [/salary|statutory|revis/, 'Salary', 'success'],
  [/advance|loan/, 'Advance', 'info'],
  [/face/, 'Face', 'info'],
  [/leave/, 'Leave', 'info'],
  [/exit|resign|settle|rejoin/, 'Exit', 'warning'],
  [/hold|held/, 'Salary hold', 'warning'],
  [/letter|offer/, 'Letter', 'muted'],
  [/pii|identity/, 'Identity', 'muted'],
];
const kindOf = (action) => {
  const k = KINDS.find(([re]) => re.test(action ?? ''));
  return k ? [k[1], k[2]] : ['Details', 'muted'];
};

/** This person's own history, without searching the global log. */
export function TimelineTab({ e }) {
  const q = useQuery({
    queryKey: ['timeline', e.id],
    queryFn: () => api.get(`/employees/${e.id}/timeline`).then((r) => r.data),
  });
  return (
    <Card>
      <CardHeader title="Timeline" description="Everything done to this person, newest first." />
      {q.isLoading ? (
        <SkeletonRows rows={6} cols={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState title="Nothing recorded yet" body="Changes appear here as they happen." />
      ) : (
        <div className="px-5 py-1">
          {q.data.map((a) => {
            const [label, tone] = kindOf(a.action);
            return (
              <div key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 border-b py-3 last:border-0">
                <span className="w-32 shrink-0 text-[12px] text-muted-foreground num">{istTime(a.at, true)}</span>
                <Chip tone={tone} className="min-w-24 justify-center">
                  {label}
                </Chip>
                <div className="min-w-0 flex-1 text-[14px]">
                  <div>{actionLabel(a.action)}</div>
                  <AuditDetail detail={a.detail} />
                </div>
                <span className="text-[12px] text-muted-foreground">{a.actor}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
