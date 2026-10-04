import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { dateSpan, monthLabel } from '@/utils';
import { Chip, EmptyState, ErrorState, SkeletonBlock, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { RecordLeave } from '../../../pages/attendance/Leave';
import { LeaveMonth } from './Attendance';

const STATUS_TONE = { APPROVED: 'success', PENDING: 'warning', REJECTED: 'destructive', CANCELLED: 'muted' };
const STATUS_LABEL = { APPROVED: 'Approved', PENDING: 'Waiting', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };

/**
 * One person's leave: a card per leave type with what is left, this month's movement
 * type by type, and every request they have had. HR records leave from here for them.
 */
export function LeaveTab({ e }) {
  const { data: lk } = useLookups();
  const month = (lk?.today ?? new Date().toISOString()).slice(0, 7);
  const [recording, setRecording] = useState(false);
  const balances = useQuery({ queryKey: ['emp-leave', e.id], queryFn: () => api.get(`/employees/${e.id}/leave-balances`).then((r) => r.data) });
  const att = useQuery({ queryKey: ['emp-attendance', e.id, month], queryFn: () => api.get(`/employees/${e.id}/attendance`, { month }).then((r) => r.data) });
  const requests = useQuery({ queryKey: ['leave', 'employee', e.id], queryFn: () => api.get('/leave', { 'filter[employee]': e.id, limit: 50 }).then((r) => r.data) });
  const types = balances.data?.types ?? [];
  const lop = att.data?.days.filter((d) => d.date <= (lk?.today ?? '') && d.day_value < 1 && ['ABSENT', 'HALF_DAY'].includes(d.status)).reduce((a, d) => a + (1 - d.day_value), 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {balances.isLoading ? (
        <SkeletonBlock className="h-28" />
      ) : balances.isError ? (
        <ErrorState error={balances.error} onRetry={() => balances.refetch()} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {types.map((t) => (
            <Card key={t.code} className="px-4 py-3.5">
              <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{t.name}</div>
              <div className="mt-1 text-[26px] leading-tight font-semibold num">
                {t.balance === null ? (t.paid ? 'Paid' : 'Unpaid') : t.balance} {t.balance !== null && <span className="text-[13px] font-normal text-muted-foreground">days left</span>}
              </div>
              <div className="text-[12px] text-muted-foreground">
                {[t.earned_ytd ? `Earned ${t.earned_ytd}` : null, `taken ${t.used_ytd}`, t.auto_ytd ? `auto-covered ${t.auto_ytd}` : null, t.pending ? `${t.pending} waiting` : null].filter(Boolean).join(' · ')} this leave year
              </div>
            </Card>
          ))}
          <Card className="px-4 py-3.5">
            <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Loss of pay · {monthLabel(month).split(' ')[0]}</div>
            <div className={`mt-1 text-[26px] leading-tight font-semibold num ${lop ? 'text-destructive' : ''}`}>
              {lop} <span className="text-[13px] font-normal text-muted-foreground">days</span>
            </div>
            <div className="text-[12px] text-muted-foreground">Absences and missing halves leave did not cover</div>
          </Card>
        </div>
      )}

      {att.data?.leave && <LeaveMonth leave={att.data.leave} month={month} />}

      <Card className="overflow-hidden">
        <CardHeader
          title="Leave requests"
          description="Every request, newest first. Absences nobody applied for are covered from paid leave automatically and show in the month above."
          actions={
            !e.read_only && (
              <Button size="sm" onClick={() => setRecording(true)}>
                <Plus /> Record leave
              </Button>
            )
          }
        />
        {requests.isLoading ? (
          <SkeletonRows rows={4} />
        ) : requests.isError ? (
          <ErrorState error={requests.error} onRetry={() => requests.refetch()} />
        ) : !requests.data.length ? (
          <EmptyState title="No leave requests" body="Leave recorded for this person appears here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Dates</th>
                  <th>Type</th>
                  <th className="text-right">Days</th>
                  <th>Reason</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.data.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{dateSpan(r.from_date, r.to_date)}</td>
                    <td>{r.leave_name ?? r.leave_type}</td>
                    <td className="text-right num">{r.days}</td>
                    <td className="max-w-xs truncate text-muted-foreground">{r.reason || '—'}</td>
                    <td>
                      <Chip tone={STATUS_TONE[r.status] ?? 'muted'}>{STATUS_LABEL[r.status] ?? r.status}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {recording && <RecordLeave employee={{ id: e.id, name: e.name }} onClose={() => setRecording(false)} />}
    </div>
  );
}
