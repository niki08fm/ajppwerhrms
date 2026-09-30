import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { DAY_STATUSES, DAY_STATUS_LABELS, OVERRIDE_REASONS, OVERRIDE_REASON_LABELS, type DayStatus } from '@ajpwer/shared';
import { api, errorMessage } from '@/lib/api';
import { istTime, longDate, mins } from '@/lib/utils';
import { KV, Mono } from '@/components/bits';
import { DayChip, ErrorState, LockedNotice, SkeletonBlock, Chip } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';

interface DayDetail {
  employee: { id: string; code: string; name: string };
  date: string;
  punches: { id: string; punched_at: string; direction: 'IN' | 'OUT'; method: string; match_score: number | null; distance_m: number | null; flagged: boolean; flag_reason: string | null; site: { code: string; name: string } }[];
  computed: { status: DayStatus; day_value: number; worked_min: number; ot_min: number; late_min: number; flags: string[]; sites: string[]; break_min: number } | null;
  not_in_employment: boolean;
  override: { id: string; status: DayStatus; day_value: number; worked_min: number; ot_min: number; late_min: number; reason_code: string; reason_text: string; created_by: string; created_at: string } | null;
  frozen: { frozen: boolean; reason: string | null };
}

const FLAG_TEXT: Record<string, string> = {
  ORPHAN_OUT: 'An OUT punch with no IN before it',
  UNMATCHED_IN: 'An IN with no OUT after it',
  CROSS_SITE: 'Worked at more than one site — one day, valued by total hours',
  LATE: 'Arrived after shift start plus grace',
  NO_ATTENDANCE_POLICY: 'No attendance policy on this date — the documented default was used',
  SANDWICHED: 'Unpaid by the sandwich rule',
};

export function CorrectionDrawer({ employeeId, date, open, onOpenChange }: { employeeId: string; date: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['attendance-day', employeeId, date], queryFn: () => api.get<{ data: DayDetail }>('/attendance/day', { employee_id: employeeId, date }).then((r) => r.data), enabled: open });
  const d = q.data;
  const [f, setF] = useState({ status: 'PRESENT' as DayStatus, day_value: '1', worked_min: '480', ot_min: '0', late_min: '0', reason_code: '', reason_text: '' });
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const src = d?.override ?? d?.computed;
    if (src) setF({ status: src.status, day_value: String(src.day_value), worked_min: String(src.worked_min), ot_min: String(src.ot_min), late_min: String(src.late_min), reason_code: '', reason_text: '' });
    setTouched(false);
  }, [d]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['attendance-day', employeeId, date] });
    qc.invalidateQueries({ queryKey: ['register'] });
    qc.invalidateQueries({ queryKey: ['emp-attendance'] });
    qc.invalidateQueries({ queryKey: ['payroll-attendance'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.post('/attendance/overrides', {
        employee_id: employeeId,
        work_date: date,
        status: f.status,
        day_value: Number(f.day_value),
        worked_min: Number(f.worked_min),
        ot_min: Number(f.ot_min),
        late_min: Number(f.late_min),
        reason_code: f.reason_code,
        reason_text: f.reason_text,
      }),
    onSuccess: () => {
      toast.success('Correction saved. The computed values are kept alongside it.');
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revert = useMutation({
    mutationFn: () => api.del(`/attendance/overrides/${d!.override!.id}`),
    onSuccess: () => {
      toast.success('Reverted to what the punches say');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const current = d?.override ?? d?.computed;
  const unchanged =
    !!current &&
    current.status === f.status &&
    Number(current.day_value) === Number(f.day_value) &&
    current.worked_min === Number(f.worked_min) &&
    current.ot_min === Number(f.ot_min) &&
    current.late_min === Number(f.late_min);
  const textError = touched && f.reason_text.trim().length < 8 ? 'Write at least eight characters explaining the correction.' : null;
  const catError = touched && !f.reason_code ? 'Pick a category.' : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={d ? `${d.employee.name} — ${longDate(date)}` : 'Correct a day'} description={d ? <Mono>{d.employee.code}</Mono> : undefined}>
      {q.isLoading ? (
        <SkeletonBlock className="h-80" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d?.not_in_employment ? (
        <p className="text-[13px] text-muted-foreground">This person was not employed on this date.</p>
      ) : d ? (
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="mb-2 font-display font-semibold">1. What the punches say</h3>
            {d.punches.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No punches on this date.</p>
            ) : (
              <table className="w-full text-[12px]">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1">Time</th>
                    <th>Dir.</th>
                    <th>Site</th>
                    <th>Method</th>
                    <th className="text-right">Match</th>
                    <th className="text-right">Distance</th>
                  </tr>
                </thead>
                <tbody>
                  {d.punches.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="py-1 num">{istTime(p.punched_at)}</td>
                      <td>{p.direction}</td>
                      <td>{p.site.name}</td>
                      <td>
                        {p.method.toLowerCase()}
                        {p.flagged && (
                          <Chip tone="warning" className="ml-1" title={p.flag_reason ?? ''}>
                            flagged
                          </Chip>
                        )}
                      </td>
                      <td className="text-right num">{p.match_score !== null ? `${Math.round(p.match_score * 100)}%` : '—'}</td>
                      <td className="text-right num">{p.distance_m !== null ? `${p.distance_m} m` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.computed && (
              <div className="mt-3 rounded-md border bg-muted/40 p-3">
                <KV
                  cols={3}
                  items={[
                    ['Computed status', <DayChip status={d.computed.status} />],
                    ['Day value', d.computed.day_value],
                    ['Worked', mins(d.computed.worked_min)],
                    ['Overtime', mins(d.computed.ot_min)],
                    ['Late', d.computed.late_min ? `${d.computed.late_min} min` : '—'],
                    ['Breaks', mins(d.computed.break_min)],
                  ]}
                />
                {d.computed.flags.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-[12px] text-muted-foreground">
                    {d.computed.flags.map((fl) => (
                      <li key={fl}>{FLAG_TEXT[fl] ?? fl}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 font-display font-semibold">2. Existing correction</h3>
            {d.override ? (
              <div className="rounded-md border p-3 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <DayChip status={d.override.status} /> · day value {d.override.day_value} · worked {mins(d.override.worked_min)}
                  </span>
                  {!d.frozen.frozen && (
                    <Button size="sm" variant="outline" loading={revert.isPending} onClick={() => revert.mutate()}>
                      <Undo2 /> Revert
                    </Button>
                  )}
                </div>
                <p className="mt-2">
                  <span className="text-muted-foreground">{OVERRIDE_REASON_LABELS[d.override.reason_code as keyof typeof OVERRIDE_REASON_LABELS]}:</span> {d.override.reason_text}
                </p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  By {d.override.created_by} on {istTime(d.override.created_at, true)}
                </p>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">None. Payroll reads what the punches say.</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 font-display font-semibold">3. Correct this day</h3>
            {d.frozen.frozen ? (
              <LockedNotice title="Attendance for this month is submitted">{d.frozen.reason}</LockedNotice>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Status">
                    {(id) => (
                      <Select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as DayStatus })}>
                        {DAY_STATUSES.filter((s) => s !== 'NOT_JOINED' && s !== 'EXITED').map((s) => (
                          <option key={s} value={s}>
                            {DAY_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Day value">
                    {(id) => (
                      <Select id={id} value={f.day_value} onChange={(e) => setF({ ...f, day_value: e.target.value })}>
                        {['0', '0.25', '0.5', '0.75', '1'].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Worked (minutes)" hint={mins(Number(f.worked_min))}>
                    {(id) => <Input id={id} type="number" min={0} value={f.worked_min} onChange={(e) => setF({ ...f, worked_min: e.target.value })} />}
                  </Field>
                  <Field label="Overtime (minutes)">{(id) => <Input id={id} type="number" min={0} value={f.ot_min} onChange={(e) => setF({ ...f, ot_min: e.target.value })} />}</Field>
                  <Field label="Late (minutes)">{(id) => <Input id={id} type="number" min={0} value={f.late_min} onChange={(e) => setF({ ...f, late_min: e.target.value })} />}</Field>
                  <Field label="Category" required error={catError}>
                    {(id, inv) => (
                      <Select id={id} aria-invalid={inv} value={f.reason_code} onChange={(e) => setF({ ...f, reason_code: e.target.value })}>
                        <option value="">Choose…</option>
                        {OVERRIDE_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {OVERRIDE_REASON_LABELS[r]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
                <Field label="Explanation" required error={textError} hint="Not optional. This is what HR will read when the payslip is questioned.">
                  {(id, inv) => <Textarea id={id} aria-invalid={inv} value={f.reason_text} onBlur={() => setTouched(true)} onChange={(e) => setF({ ...f, reason_text: e.target.value })} />}
                </Field>
                {unchanged && <p className="text-[12px] text-muted-foreground">Nothing differs from the current values yet — an override that changes nothing is not saved.</p>}
                <div className="flex justify-end">
                  <Button
                    loading={save.isPending}
                    disabled={unchanged}
                    onClick={() => {
                      setTouched(true);
                      if (f.reason_text.trim().length >= 8 && f.reason_code) save.mutate();
                    }}
                  >
                    Save correction
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
