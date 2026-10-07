import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { CALENDAR_METHOD_INFO, CALENDAR_METHODS, DAY_NAMES, formatINR, monthLabelSafe, POLICY_KINDS, POLICY_KIND_LABELS, POLICY_KIND_MISSING_WARNING } from '../../components/setup/wizard-deps';
import { api, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, hhmm } from '@/utils';
import { PageHeader } from '@/components/bits';
import { Chip, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';

const STEPS = ['Basics', 'Calendar method', 'Weekly off and shift', 'Policies', 'Review'];

function selectedPolicyVersions(rows = [], ids) {
  const keys = new Set(rows.filter((p) => ids.includes(p.id)).map((p) => p.policy_key ?? p.id));
  return [...new Set([...ids, ...rows.filter((p) => keys.has(p.policy_key ?? p.id)).map((p) => p.id)])];
}

/** Salary structures are selected on the employee's salary, independently of group rules. */
export default function PayGroupWizard() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const existing = useQuery({ queryKey: ['pay-group', id], queryFn: () => api.get(`/pay-groups/${id}`).then((r) => r.data), enabled: !!id });
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => api.get('/policies').then((r) => r.data) });
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: '', pay_day: 7, calendar_method: 'FIXED_26', weekly_off: ['SUN'], shift_id: '', policy_ids: [] });
  useEffect(() => {
    const g = existing.data;
    if (g)
      setF({
        name: g.name,
        pay_day: g.pay_day,
        calendar_method: g.calendar_method,
        weekly_off: g.weekly_off,
        shift_id: g.shift.id,
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
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, policy_ids: selectedPolicyVersions(policies.data, f.policy_ids) };
      return id ? api.patch(`/pay-groups/${id}`, body) : api.post('/pay-groups', body);
    },
    onSuccess: () => {
      toast.success(id ? 'Pay group updated. Everyone in it now follows these rules.' : 'Pay group created and usable immediately.');
      for (const key of ['pay-groups', 'pay-group', 'lookups', 'employee', 'employee-pay', 'payslip-preview', 'emp-attendance', 'timeline']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      nav('/setup/pay-groups');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (id && existing.isLoading) return <SkeletonBlock className="h-96" />;
  if (id && existing.isError) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;

  const selectedIds = selectedPolicyVersions(policies.data, f.policy_ids);
  const attached = (policies.data ?? []).filter((p) => selectedIds.includes(p.id));
  const conflictingKinds = new Set(POLICY_KINDS.filter((kind) => new Set(attached.filter((p) => p.kind === kind).map((p) => p.policy_key ?? p.id)).size > 1));
  const today = lk?.today ?? '';
  const missingKinds = POLICY_KINDS.filter((k) => !attached.some((p) => p.kind === k && p.valid_from <= today && (!p.valid_to || p.valid_to >= today)));
  const canNext = [!!f.name.trim(), true, !!f.shift_id, !policies.isFetching && !policies.isError && conflictingKinds.size === 0, true][step];
  const choosePolicy = (kind, policyKey) => {
    const rows = policies.data ?? [];
    const kindIds = new Set(rows.filter((p) => p.kind === kind).map((p) => p.id));
    const chosenIds = rows.filter((p) => p.kind === kind && (p.policy_key ?? p.id) === policyKey).map((p) => p.id);
    setF((prev) => ({ ...prev, policy_ids: [...prev.policy_ids.filter((policyId) => !kindIds.has(policyId)), ...chosenIds] }));
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Pay groups', to: '/setup/pay-groups' }, { label: id ? `Edit ${existing.data?.name ?? ''}` : 'New pay group' }]}
        title={id ? `Edit ${existing.data?.name}` : 'New pay group'}
      />
      <ol className="grid grid-cols-3 gap-1 rounded-lg border bg-card p-1 md:grid-cols-5">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              onClick={() => i <= step && setStep(i)}
              disabled={i > step}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                i === step ? 'bg-primary text-primary-foreground' : i < step ? 'hover:bg-accent' : 'opacity-50',
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-[12px]">{i < step ? <Check className="size-3" /> : i + 1}</span>
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
              <p className="text-[14px] text-muted-foreground">
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
                      <p className="mt-1 text-[14px] text-muted-foreground">{CALENDAR_METHOD_INFO[m].explain}</p>
                      {row && (
                        <p className="mt-2 text-[14px]">
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
                <div className="mb-1 text-[13px] font-medium">Weekly off</div>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((d) => (
                    <button
                      key={d}
                      onClick={() => setF({ ...f, weekly_off: f.weekly_off.includes(d) ? f.weekly_off.filter((x) => x !== d) : [...f.weekly_off, d] })}
                      className={cn('rounded-md border px-3 py-1.5 text-[14px]', f.weekly_off.includes(d) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}
                      aria-pressed={f.weekly_off.includes(d)}
                    >
                      {d.charAt(0) + d.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[13px] text-muted-foreground">Whether the weekly off is paid is a policy, chosen in the next step.</p>
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
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] text-muted-foreground">Choose the policies this pay group follows.</p>
                <Button variant="outline" size="sm" loading={policies.isFetching} onClick={() => policies.refetch()}><RefreshCw /> Refresh policies</Button>
              </div>
              {policies.isError && <ErrorState error={policies.error} onRetry={() => policies.refetch()} compact />}
              {POLICY_KINDS.map((k) => {
                const list = (policies.data ?? []).filter((p) => p.kind === k);
                const lineages = [...new Map(list.map((p) => [p.policy_key ?? p.id, list.filter((x) => (x.policy_key ?? x.id) === (p.policy_key ?? p.id)).sort((a, b) => b.version - a.version)[0]])).values()];
                const selected = list.find((p) => f.policy_ids.includes(p.id));
                const conflicted = conflictingKinds.has(k);
                return (
                  <div key={k} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                    <Field label={POLICY_KIND_LABELS[k]} hint={!list.length && !policies.isLoading ? 'No policies created yet.' : undefined} error={conflicted ? 'Multiple policies are attached. Choose one policy or None to continue.' : undefined}>
                      {(fieldId, invalid) => (
                        <Select
                          id={fieldId}
                          aria-invalid={invalid || undefined}
                          value={conflicted ? '__choose_policy__' : selected ? (selected.policy_key ?? selected.id) : ''}
                          onChange={(e) => choosePolicy(k, e.target.value)}
                          disabled={policies.isLoading || policies.isError}
                        >
                          {conflicted && <option value="__choose_policy__" disabled>Choose a policy or None</option>}
                          <option value="">None</option>
                          {lineages.map((p) => (
                            <option key={p.policy_key ?? p.id} value={p.policy_key ?? p.id}>{p.name} · v{p.version}</option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Link to={`/setup/policies?kind=${k}&new=1`} target="_blank" rel="noreferrer" className="text-[13px] text-primary hover:underline">
                      Create a {POLICY_KIND_LABELS[k].toLowerCase()} policy
                    </Link>
                  </div>
                );
              })}
              <p className="text-[13px] text-muted-foreground">Select one policy for each kind, or None. Earlier versions of the selected policy stay available for their effective dates.</p>
            </div>
          )}
          {step === 4 && (
            <div className="flex flex-col gap-4 text-[14px]">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <div className="text-[13px] text-muted-foreground">Name</div>
                  {f.name}
                </div>
                <div>
                  <div className="text-[13px] text-muted-foreground">Calendar</div>
                  {CALENDAR_METHOD_INFO[f.calendar_method].label}
                </div>
                <div>
                  <div className="text-[13px] text-muted-foreground">Weekly off</div>
                  {f.weekly_off.join(', ') || 'None'}
                </div>
                <div>
                  <div className="text-[13px] text-muted-foreground">Shift</div>
                  {lk?.shifts.find((s) => s.id === f.shift_id)?.name}
                </div>
                <div>
                  <div className="text-[13px] text-muted-foreground">Pay day</div>
                  {f.pay_day}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[13px] text-muted-foreground">Policies</div>
                <ul className="space-y-1">
                  {POLICY_KINDS.map((kind) => {
                    const selected = attached.filter((p) => p.kind === kind).sort((a, b) => b.version - a.version)[0];
                    return <li key={kind}>{POLICY_KIND_LABELS[kind]}: {selected ? `${selected.name} · v${selected.version}` : 'None'}</li>;
                  })}
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
              {id && existing.data && existing.data.headcount > 0 && (
                <Notice>
                  {existing.data.headcount} people are in this group. Their calendar, weekly off, shift and policies follow the group. Salary structures are chosen in each employee's Salary section.
                </Notice>
              )}
            </div>
          )}
        </CardBody>
        <div className="flex justify-between border-t px-4 py-3">
          <Button variant="outline" onClick={() => (step === 0 ? nav('/setup/pay-groups') : setStep(step - 1))}>
            <ArrowLeft /> {step === 0 ? 'Cancel' : 'Back'}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next <ArrowRight />
            </Button>
          ) : (
            <Button loading={save.isPending} disabled={conflictingKinds.size > 0 || policies.isFetching || policies.isError} onClick={() => save.mutate()}>
              <Check /> {id ? 'Save changes' : 'Create pay group'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
