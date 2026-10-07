import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { istTime, longDate } from '@/utils';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';
import { AuditDetail, actionLabel } from '../../../pages/setup/Audit';

/** A short kind for each audit action, with a colour, so the list scans at a glance. */
const KINDS = [
  [/designation/, 'Designation', 'info'],
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
  const explicitDesignationTimes = new Set((q.data ?? []).filter((event) => event.action === 'employee.designation_change').map((event) => event.at));
  const events = (q.data ?? []).flatMap((event) => {
    if (event.action !== 'employee.update' || !event.detail?.changes?.designation || !explicitDesignationTimes.has(event.at)) return [event];
    const { designation: _designation, ...changes } = event.detail.changes;
    return Object.keys(changes).length ? [{ ...event, detail: { ...event.detail, changes } }] : [];
  });
  return (
    <Card>
      <CardHeader title="Employee journey" description="Joining, designation changes, salary revisions and other employee events, newest first." />
      {q.isLoading ? (
        <SkeletonRows rows={6} cols={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !events.length ? (
        <EmptyState title="Nothing recorded yet" body="Changes appear here as they happen." />
      ) : (
        <div className="px-5 py-1">
          {events.map((a) => {
            const [label, tone] = kindOf(a.action);
            const designation =
              a.action === 'employee.designation_change'
                ? {
                    from: a.detail?.from,
                    to: a.detail?.to,
                    effective_on: a.detail?.effective_on,
                  }
                : a.detail?.changes?.designation;
            const title = designation
              ? 'Designation changed'
              : a.action === 'salary.edit'
                ? 'Salary revision corrected'
                : a.action === 'salary.delete'
                  ? 'Salary revision removed'
                  : actionLabel(a.action);
            return (
              <div key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 border-b py-3 last:border-0">
                <span className="w-32 shrink-0 text-[12px] text-muted-foreground num">{istTime(a.at, true)}</span>
                <Chip tone={tone} className="min-w-24 justify-center">
                  {label}
                </Chip>
                <div className="min-w-0 flex-1 text-[14px]">
                  <div>{title}</div>
                  {designation ? (
                    <div className="mt-0.5 text-[13px] text-muted-foreground">
                      <span>{designation.from || 'Not provided'}</span> →{' '}
                      <span className="font-medium text-foreground">{designation.to || 'Not provided'}</span>
                      {designation.effective_on && ` · Effective ${longDate(designation.effective_on)}`}
                    </div>
                  ) : (
                    <AuditDetail detail={a.detail ?? {}} />
                  )}
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
