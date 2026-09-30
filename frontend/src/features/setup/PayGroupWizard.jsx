import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { toast } from 'sonner';
import { addMonths, CALENDAR_METHOD_INFO, CALENDAR_METHODS, DAY_NAMES, formatINR, formatYearMonth, monthLabelSafe, POLICY_KINDS, POLICY_KIND_LABELS, POLICY_KIND_MISSING_WARNING } from './wizard-deps';
import { api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { cn, hhmm } from '@/lib/utils';
import { Money, PageHeader, ProportionBar } from '@/components/bits';
import { Chip, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Checkbox } from '@/components/ui/overlay';

const STEPS = ['Basics', 'Calendar method', 'Weekly off and shift', 'Policies', 'Salary structure', 'Review'];

/** Six steps, one decision each, so nothing is buried. */
export default function PayGroupWizard() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const existing = useQuery({ queryKey: ['pay-group', id], queryFn: () => api.get(`/pay-groups/${id}`).then((r) => r.data), enabled: !!id });
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => api.get('/policies').then((r) => r.data) });
  const structures = useQuery({ queryKey: ['structures'], queryFn: () => api.get('/structures').then((r) => r.data) });
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: '', pay_day: 7, calendar_method: 'FIXED_26', weekly_off: ['SUN'], shift_id: '', structure_id: '', policy_ids: [] });
  useEffect(() => {
    const g = existing.data;
    if (g)
      setF({
        name: g.name,
        pay_day: g.pay_day,
        calendar_method: g.calendar_method,
        weekly_off: g.weekly_off,
        shift_id: g.shift.id,
        structure_id: g.structure?.id ?? '',
        policy_ids: g.policies.map((p) => p.id),
      });
  }, [existing.data]);
  useEffect(() => {
    if (!id && lk && !f.shift_id && lk.shifts[0]) setF((x) => ({ ...x, shift_id: lk.shifts[0].id }));
  }, [lk, id, f.shift_id]);

  const cal = useQuery({
    queryKey: ['calendar-methods', f.weekly_off.join(',')],
    queryFn: () => api.get('/calendar-methods', { weekly_off: f.weekly_off.join(','), gross: 2_600_000 }),
  });
  // Changing the structure of a group that has people: choose the month they move, and see who moves first.
  const structureChanged = !!id && !!existing.data && existing.data.headcount > 0 && !!f.structure_id && f.structure_id !== existing.data.structure?.id;
  const [moveFrom, setMoveFrom] = useState(null);
  const move = useQuery({
    queryKey: ['structure-move', id, f.structure_id, moveFrom],
    queryFn: () => api.get(`/pay-groups/${id}/structure-move`, { structure_id: f.structure_id, ...(moveFrom ? { from: moveFrom } : {}) }).then((r) => r.data),
    enabled: structureChanged,
    placeholderData: (p) => p,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => (id ? api.patch(`/pay-groups/${id}`, { ...f, ...(structureChanged && move.data ? { structure_from: move.data.from } : {}) }) : api.post('/pay-groups', f)),
    onSuccess: (r) => {
      const moved = id ? r.data.structure_move : null;
      toast.success(
        moved
          ? `Pay group updated. ${moved.moved} ${moved.moved === 1 ? 'person moves' : 'people move'} to the new structure from ${formatYearMonth(moved.from)}${moved.skipped.length ? `; ${moved.skipped.length} could not be moved` : ''}.`
          : id
            ? 'Pay group updated. Everyone in it now follows these rules.'
            : 'Pay group created and usable immediately.',
      );
      qc.invalidateQueries({ queryKey: ['pay-groups'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      nav('/setup/pay-groups');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (id && existing.isLoading) return <SkeletonBlock className="h-96" />;

  const attached = (policies.data ?? []).filter((p) => f.policy_ids.includes(p.id));
  const today = lk?.today ?? '';
  const missingKinds = POLICY_KINDS.filter((k) => !attached.some((p) => p.kind === k && p.valid_from <= today && (!p.valid_to || p.valid_to >= today)));
  const structure = structures.data?.find((s) => s.id === f.structure_id);
  const canNext = [!!f.name.trim(), true, !!f.shift_id, true, !!f.structure_id && (!structureChanged || !!move.data), true][step];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Pay groups', to: '/setup/pay-groups' }, { label: id ? `Edit ${existing.data?.name ?? ''}` : 'New pay group' }]}
        title={id ? `Edit ${existing.data?.name}` : 'New pay group'}
      />
      <ol className="grid grid-cols-3 gap-1 rounded-lg border bg-card p-1 md:grid-cols-6">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              onClick={() => i <= step && setStep(i)}
              disabled={i > step}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]',
                i === step ? 'bg-primary text-primary-foreground' : i < step ? 'hover:bg-accent' : 'opacity-50',
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]">{i < step ? <Check className="size-3" /> : i + 1}</span>
              <span className="truncate">{s}</span>
            </button>
          </li>
        ))}
      </ol>
      <Card>
        <CardBody className="min-h-[340px]">
          {step === 0 && (
            <div className="grid max-w-xl gap-4">
              <Field label="Name" required>
                {(i) => <Input id={i} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Site workforce" autoFocus />}
              </Field>
              <Field label="Pay frequency" hint="Monthly. There is no attendance cutoff — payroll always covers the full calendar month.">
                {(i) => (
                  <Select id={i} value="MONTHLY" disabled>
                    <option value="MONTHLY">Monthly</option>
                  </Select>
                )}
              </Field>
              <Field label="Pay day" hint="Day of the following month salaries are paid">
                {(i) => <Input id={i} type="number" min={1} max={28} value={f.pay_day} onChange={(e) => setF({ ...f, pay_day: Number(e.target.value) })} />}
              </Field>
            </div>
          )}
          {step === 1 && (
            <div className="flex flex-col gap-3">
              <p className="text-[13px] text-muted-foreground">
                The single most consequential setting: it decides what an absence costs.{cal.data && ` Figures for ${monthLabelSafe(cal.data.meta.month)} on ₹26,000 a month.`}
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {CALENDAR_METHODS.map((m) => {
                  const row = cal.data?.data.find((x) => x.method === m);
                  return (
                    <button
                      key={m}
                      onClick={() => setF({ ...f, calendar_method: m })}
                      className={cn('rounded-lg border p-4 text-left', f.calendar_method === m ? 'border-primary ring-2 ring-primary' : 'hover:bg-accent')}
                      aria-pressed={f.calendar_method === m}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-display text-lg font-semibold">{CALENDAR_METHOD_INFO[m].label}</span>
                        {f.calendar_method === m && <Chip tone="info">Selected</Chip>}
                      </div>
                      <p className="mt-1 text-[13px] text-muted-foreground">{CALENDAR_METHOD_INFO[m].explain}</p>
                      {row && (
                        <p className="mt-2 text-[13px]">
                          One day's pay is <strong>{formatINR(row.day_rate)}</strong> (÷{row.divisor}); a day's absence costs the same.
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="flex max-w-xl flex-col gap-4">
              <div>
                <div className="mb-1 text-[12px] font-medium">Weekly off</div>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((d) => (
                    <button
                      key={d}
                      onClick={() => setF({ ...f, weekly_off: f.weekly_off.includes(d) ? f.weekly_off.filter((x) => x !== d) : [...f.weekly_off, d] })}
                      className={cn('rounded-md border px-3 py-1.5 text-[13px]', f.weekly_off.includes(d) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}
                      aria-pressed={f.weekly_off.includes(d)}
                    >
                      {d.charAt(0) + d.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">Whether the weekly off is paid is a policy, chosen in the next step.</p>
              </div>
              <Field label="Shift">
                {(i) => (
                  <Select id={i} value={f.shift_id} onChange={(e) => setF({ ...f, shift_id: e.target.value })}>
                    {lk?.shifts.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({hhmm(s.start_min)}–{hhmm(s.end_min)})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
          {step === 3 && (
            <div className="flex flex-col gap-4">
              {POLICY_KINDS.map((k) => {
                const list = (policies.data ?? []).filter((p) => p.kind === k);
                return (
                  <div key={k}>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[13px] font-semibold">{POLICY_KIND_LABELS[k]}</span>
                      <Link to={`/setup/policies?kind=${k}&new=1`} target="_blank" className="text-[12px] text-primary hover:underline">
                        Create a {POLICY_KIND_LABELS[k].toLowerCase()} policy
                      </Link>
                    </div>
                    {!list.length ? (
                      <p className="text-[12px] text-muted-foreground">None exist yet.</p>
                    ) : (
                      <ul className="grid gap-1 md:grid-cols-2">
                        {list.map((p) => (
                          <li key={p.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-[13px]">
                            <Checkbox
                              label={`${p.name} v${p.version}`}
                              checked={f.policy_ids.includes(p.id)}
                              onCheckedChange={(v) => setF({ ...f, policy_ids: v ? [...f.policy_ids, p.id] : f.policy_ids.filter((x) => x !== p.id) })}
                            />
                            <span className="flex-1">
                              {p.name} <span className="text-muted-foreground">v{p.version}</span>
                            </span>
                            <span className="text-[11px] text-muted-foreground num">
                              {p.valid_from} → {p.valid_to ?? ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              <p className="text-[12px] text-muted-foreground">Two versions of one policy can both be attached; the engine picks by date. Attach every version you want history to use.</p>
            </div>
          )}
          {step === 4 && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                {structures.data?.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setF({ ...f, structure_id: s.id })}
                    className={cn('rounded-md border p-3 text-left text-[13px]', f.structure_id === s.id ? 'border-primary ring-2 ring-primary' : 'hover:bg-accent')}
                  >
                    <span className="font-medium">{s.name}</span>
                  </button>
                ))}
              </div>
              {structure && (
                <div className="flex flex-col gap-3">
                  {structureChanged && <MovePanel plan={move.data} loading={move.isFetching} error={move.error} onMonth={setMoveFrom} structureName={structure.name} />}
                  <div className="rounded-md border p-3">
                    <div className="mb-2 text-[13px] font-semibold">At ₹24,000 a month</div>
                    <ProportionBar parts={structure.sample.monthly.map((c) => ({ label: c.name, value: c.amount }))} />
                    <table className="mt-2 w-full text-[13px]">
                      <tbody>
                        {structure.sample.monthly.map((c) => (
                          <tr key={c.name} className="border-t">
                            <td className="py-1">{c.name}</td>
                            <td className="text-right">
                              <Money value={c.amount} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          {step === 5 && (
            <div className="flex flex-col gap-4 text-[13px]">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <div className="text-[12px] text-muted-foreground">Name</div>
                  {f.name}
                </div>
                <div>
                  <div className="text-[12px] text-muted-foreground">Calendar</div>
                  {CALENDAR_METHOD_INFO[f.calendar_method].label}
                </div>
                <div>
                  <div className="text-[12px] text-muted-foreground">Weekly off</div>
                  {f.weekly_off.join(', ') || 'None'}
                </div>
                <div>
                  <div className="text-[12px] text-muted-foreground">Shift</div>
                  {lk?.shifts.find((s) => s.id === f.shift_id)?.name}
                </div>
                <div>
                  <div className="text-[12px] text-muted-foreground">Structure</div>
                  {structure?.name}
                </div>
                <div>
                  <div className="text-[12px] text-muted-foreground">Pay day</div>
                  {f.pay_day}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[12px] text-muted-foreground">Policies</div>
                <ul>
                  {attached.map((p) => (
                    <li key={p.id}>
                      {POLICY_KIND_LABELS[p.kind]}: {p.name} v{p.version}
                    </li>
                  ))}
                </ul>
              </div>
              {missingKinds.length > 0 && (
                <Notice tone="warning">
                  <p className="font-medium">Policy kinds with nothing in force today:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {missingKinds.map((k) => (
                      <li key={k}>
                        <strong>{POLICY_KIND_LABELS[k]}</strong> — {POLICY_KIND_MISSING_WARNING[k]}
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}
              {structureChanged && move.data && (
                <Notice tone={move.data.skipped.length ? 'warning' : 'info'}>
                  {move.data.move.length} {move.data.move.length === 1 ? 'person moves' : 'people move'} to <strong>{move.data.structure.name}</strong> from{' '}
                  <strong>{formatYearMonth(move.data.from)}</strong>, each as a dated change in their salary history.
                  {move.data.skipped.length > 0 && ` ${move.data.skipped.length} cannot be moved (see the structure step).`}
                </Notice>
              )}
              {id && existing.data && existing.data.headcount > 0 && (
                <Notice>
                  {existing.data.headcount} people are in this group. Their calendar, weekly off, shift and every policy change with it, from today
                  {structureChanged ? '; the structure from the month above' : ''}. Months already run keep their payslips.
                </Notice>
              )}
            </div>
          )}
        </CardBody>
        <div className="flex justify-between border-t px-4 py-3">
          <Button variant="outline" onClick={() => (step === 0 ? nav('/setup/pay-groups') : setStep(step - 1))}>
            <ArrowLeft /> {step === 0 ? 'Cancel' : 'Back'}
          </Button>
          {step < 5 ? (
            <Button disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next <ArrowRight />
            </Button>
          ) : (
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              <Check /> {id ? 'Save changes' : 'Create pay group'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function MovePanel({ plan, loading, error, onMonth, structureName }) {
  const months = plan ? Array.from({ length: 12 }, (_, i) => addMonths(plan.first_open_month, i)) : [];
  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-[13px]">
      <div className="font-semibold">Move this group to {structureName}</div>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        Everyone in the group is paid on it from the month you pick, as a dated change in their salary history. Agreed pay stays the same: a gross stays the gross, a CTC stays the CTC. Months already
        run keep their payslips.
      </p>
      {error ? (
        <Notice tone="destructive">{errorMessage(error)}</Notice>
      ) : !plan ? (
        <p className="mt-2 text-muted-foreground">Working out who moves…</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <Field label="Paid on it from">
            {(i) => (
              <Select id={i} value={plan.from} onChange={(e) => onMonth(e.target.value)} className="max-w-48">
                {months.map((m) => (
                  <option key={m} value={m}>
                    {formatYearMonth(m)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className={cn('flex flex-wrap gap-1.5', loading && 'opacity-60')}>
            <Chip tone="success">{plan.move.length} move</Chip>
            {plan.unchanged > 0 && <Chip tone="muted">{plan.unchanged} already on it</Chip>}
            {plan.skipped.length > 0 && <Chip tone="warning">{plan.skipped.length} cannot move</Chip>}
          </div>
          {plan.move.some((m) => m.from_gross !== m.to_gross) && (
            <ul className="text-[12px] text-muted-foreground">
              {plan.move
                .filter((m) => m.from_gross !== m.to_gross)
                .map((m) => (
                  <li key={m.employee.id}>
                    {m.employee.name} ({m.employee.code}) — CTC kept, gross {formatINR(m.from_gross)} → {formatINR(m.to_gross)}
                    {m.esi_band ? ' (ESI band: kept on their current side)' : ''}
                  </li>
                ))}
            </ul>
          )}
          {plan.skipped.length > 0 && (
            <ul className="list-disc pl-5 text-[12px]">
              {plan.skipped.map((x) => (
                <li key={x.employee.id}>
                  <Link to={`/people/${x.employee.id}?tab=salary`} className="font-medium hover:underline">
                    {x.employee.name} ({x.employee.code})
                  </Link>{' '}
                  — {x.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
