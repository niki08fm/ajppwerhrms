import { useState } from 'react';
import { istDate } from '@ajpwer/shared';
import { monthLabel } from '@/utils';
import { Card, CardHeader } from '@/components/ui/card';
import { EmployeeAttendanceWorkspace } from '../../attendance/EmployeeAttendanceWorkspace';
import { useLookups } from '@/hooks/useLookups';

const num = (x) => (x ? String(x) : '—');

/** The month's leave, type by type: what it opened with, what came in, what was taken, what is left. */
export function LeaveMonth({ leave, month }) {
  const auto = leave.types.find((t) => t.auto_apply);
  return (
    <Card>
      <CardHeader
        title="Leave this month"
        description={`Leave year ${monthLabel(leave.year.start)} to ${monthLabel(leave.year.end)}.${auto ? ` Absences nobody applied for, and the missing half of half days, are paid from ${auto.name.toLowerCase()} while it lasts.` : ''}`}
      />
      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Type</th>
              <th className="text-right">Start of {monthLabel(month).split(' ')[0]}</th>
              <th className="text-right">Earned</th>
              <th className="text-right">Added by HR</th>
              <th className="text-right">Taken</th>
              <th className="text-right">Automatic</th>
              <th className="text-right">Left</th>
              <th className="text-right">Year end</th>
            </tr>
          </thead>
          <tbody>
            {leave.types.map((t) => (
              <tr key={t.code}>
                <td>
                  {t.name} <span className="text-muted-foreground">{t.code}</span>
                </td>
                <td className="text-right num">{t.opening === null ? '—' : t.opening}</td>
                <td className="text-right num">{num(t.earned)}</td>
                <td className="text-right num">{num(t.adjusted)}</td>
                <td className="text-right num">
                  {num(t.used)}
                  {t.unpaid ? <span className="text-destructive"> (+{t.unpaid} unpaid)</span> : ''}
                </td>
                <td className="text-right num">{num(t.auto)}</td>
                <td className="text-right num font-medium">{t.closing === null ? '—' : t.closing}</td>
                <td className="text-right text-muted-foreground">
                  {[t.carried && `${t.carried} carried`, t.encashed && `${t.encashed} paid out`, t.lapsed && `${t.lapsed} lapsed`].filter(Boolean).join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function AttendanceTab({ e }) {
  const { data: lk } = useLookups();
  const today = lk?.today ?? istDate(new Date());
  // Until the server's date arrives, follow it rather than the browser's: null means "today's month".
  const [monthPick, setMonth] = useState(null);
  const month = monthPick ?? today.slice(0, 7);
  return (
    <EmployeeAttendanceWorkspace
      key={e.id}
      employeeId={e.id}
      month={month}
      readOnly={!!e.read_only}
      showMonthNavigation
      onMonthChange={setMonth}
    />
  );
}
