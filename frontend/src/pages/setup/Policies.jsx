import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchPlus, History, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { addDays, describeOvertimeBase, formatINR, MONTH_NAMES, POLICY_KINDS, POLICY_KIND_LABELS, upgradeLeaveRules } from '@ajpwer/shared';
import { api, ApiError, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { PageHeader } from '@/components/bits';
import { Chip, EmptyState, ErrorState, PermissionDenied, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { Dialog, Tooltip } from '@/components/ui/overlay';
import { DEFAULT_RULES, PolicyForm, WorkedExample } from '../../components/setup/PolicyForm';

function summary(p) {
  const r = p.rules; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (p.kind) {
    case 'ATTENDANCE':
      return r.half_day_upto_min === null || r.half_day_upto_min === undefined
        ? `${r.standard_min / 60}h day, half from ${r.half_day_min / 60}h, ${r.grace_min} min grace`
        : `${r.standard_min / 60}h day, half day up to ${r.half_day_upto_min / 60}h, ${r.grace_min} min grace`;
    case 'OVERTIME':
      return `${r.multiplier}× on ${describeOvertimeBase(r)}, ${r.counts_from === 'SHIFT_END' ? 'from shift end' : 'beyond the standard day'}, after ${r.after_min} min, cap ${r.monthly_cap_min != null ? `${r.monthly_cap_min / 60}h` : 'none'}`;
    case 'WEEKOFF_PAY':
    case 'HOLIDAY_PAY':
      return `${r.paid ? 'Paid' : 'Unpaid'}${r.sandwich ? ', sandwich' : ''}`;
    case 'HOLIDAY_WORK':
      return `Holiday ${r.holiday.mode === 'PAY' ? `${r.holiday.rate_pct}%` : 'none'}, weekly off ${r.weekly_off.mode === 'PAY' ? `${r.weekly_off.rate_pct}%` : 'none'}`;
    case 'LEAVE': {
      const u = upgradeLeaveRules(r);
      return `Year from ${MONTH_NAMES[u.year_start_month - 1]} · ${u.types
        .filter((t) => t.active)
        .map((t) => `${t.code}${t.auto_apply ? ' (pays absences)' : ''}`)
        .join(', ')}`;
    }
    case 'GRATUITY':
      return `From ${r.min_years} years, ${r.days_per_year}/${r.divisor} of last ${r.base === 'BASIC_HRA' ? 'basic + HRA' : r.base.toLowerCase()} a year, ${r.max_amount === null ? 'no ceiling' : `up to ${formatINR(r.max_amount)}`}`;
  }
}

export function useSample() {
  const s = useQuery({ queryKey: ['structures'], queryFn: () => api.get('/structures').then((r) => r.data) });
  return useMemo(() => {
    const sample = s.data?.[0]?.sample;
    const m = sample?.monthly ?? [];
    const basic = sample?.basic ?? m.find((c) => c.name.trim().toLowerCase() === 'basic')?.amount ?? 12_000_00;
    const hra = sample?.hra ?? (sample ? m.filter((c) => /\bhra\b|house rent/i.test(c.name)).reduce((sum, c) => sum + c.amount, 0) : 4_800_00);
    const da = sample?.da ?? m.filter((c) => ['da', 'dearness allowance'].includes(c.name.trim().toLowerCase())).reduce((sum, c) => sum + c.amount, 0);
    return { gross: sample?.gross ?? 24_000_00, basic, hra, da, divisor: 26 };
  }, [s.data]);
}

export default function Policies() {
  const { can } = useSession();
  const read = can('setup.read');
  const manage = can('setup.write');
  const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['policies'], queryFn: () => api.get('/policies').then((r) => r.data), enabled: read });
  const [builder, setBuilder] = useState(null);
  const [history, setHistory] = useState(null);
  const [deleting, setDeleting] = useState(null);
  useEffect(() => {
    const k = sp.get('kind');
    if (read && manage && sp.get('new') && k && POLICY_KINDS.includes(k)) {
      setBuilder({ kind: k, mode: 'new' });
      setSp({}, { replace: true });
    }
  }, [sp, setSp, read, manage]);
  const edit = (policy, versions) => setBuilder({ kind: policy.kind, mode: 'edit', from: policy, versions });
  const latestEditorPolicy = builder?.mode === 'edit' && q.data?.find((p) => p.id === builder.from.id);
  if (!read) return <PermissionDenied message="You need setup viewing access to see policies." />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Policies"
        description="Edit a version to correct it, or publish a new one when rules change. The applicable version is selected by date."
      />
      {q.isLoading ? (
        <SkeletonRows rows={10} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        POLICY_KINDS.map((k) => {
          const rows = (q.data ?? []).filter((p) => p.kind === k);
          const families = new Map();
          for (const row of rows) families.set(row.policy_key, [...(families.get(row.policy_key) ?? []), row]);
          const latest = [...families.values()].map((versions) => [...versions].sort((a, b) => b.version - a.version)[0]);
          return (
            <Card key={k}>
              <CardHeader
                title={POLICY_KIND_LABELS[k]}
                actions={
                  manage && <Button size="sm" variant="outline" onClick={() => setBuilder({ kind: k, mode: 'new' })}>
                    <Plus /> New policy
                  </Button>
                }
              />

              {!latest.length ? (
                <EmptyState title={`No ${POLICY_KIND_LABELS[k].toLowerCase()} policy`} body="Create one, then attach it to a pay group." />
              ) : (
                <div className="overflow-x-auto"><table className="data-table w-full">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Summary</th>
                      <th>Latest version</th>
                      <th>Date range</th>
                      <th>Used by</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {latest.map((p) => {
                      const versions = families.get(p.policy_key);
                      return (
                        <tr key={p.id}>
                          <td className="font-medium">{p.name}</td>
                          <td className="whitespace-normal text-muted-foreground">{summary(p)}</td>
                          <td>
                            <Chip>v{p.version}</Chip>
                          </td>
                          <td className="num">
                            {p.valid_from} → {p.valid_to ?? 'Ongoing'}
                          </td>
                          <td>{p.pay_groups?.map((g) => g.name).join(', ') || <span className="text-muted-foreground">Not attached</span>}</td>
                          <td className="text-right">
                            <span className="flex justify-end gap-1">
                              <Button size="sm" variant="ghost" aria-label={`Version history for ${p.name}`} onClick={() => setHistory({ policyKey: p.policy_key, name: p.name })}>
                                <History /> {versions.length} {versions.length === 1 ? 'version' : 'versions'}
                              </Button>
                              {manage && <>
                                <VersionActions policy={p} compact onEdit={() => edit(p, versions)} onDelete={() => setDeleting({ policy: p, versions })} />
                                <Button size="sm" variant="outline" onClick={() => setBuilder({ kind: k, mode: 'publish', from: p })}>
                                <GitBranchPlus /> Publish new version
                                </Button>
                              </>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              )}
            </Card>
          );
        })
      )}
      {manage && builder && <Builder key={`${builder.mode}-${builder.from?.id ?? builder.kind}`} {...builder} from={latestEditorPolicy || builder.from} onClose={() => setBuilder(null)} />}
      {history && !builder && !deleting && <HistoryDialog {...history} manage={manage} onEdit={edit} onDelete={(policy, versions) => setDeleting({ policy, versions })} onClose={() => setHistory(null)} />}
      {manage && deleting && <DeleteVersionDialog {...deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); if (deleting.versions.length === 1) setHistory(null); }} />}
    </div>
  );
}

function refreshPolicies(queryClient) {
  const keys = [
    'policies', 'policy-versions', 'pay-groups', 'pay-group', 'lookups', 'employee', 'employee-pay', 'employee-tax', 'payslip-preview',
    'sites', 'site-day', 'dashboard', 'register', 'attendance-month', 'emp-attendance', 'emp-attendance-year', 'overtime',
    'leave-types', 'leave-balances', 'emp-leave', 'period', 'settlement', 'payroll-attendance', 'payroll-issues', 'payroll-fnf', 'payroll-preview', 'payroll-summary',
  ];
  for (const key of keys) queryClient.invalidateQueries({ queryKey: [key] });
}

const editReason = (policy) => policy.protection_reason || 'Reload version history to check whether this version can be edited.';
const deleteReason = (policy) => policy.deletion_reason || policy.protection_reason || 'Reload version history to check whether this version can be deleted.';

function VersionActions({ policy, compact = false, onEdit, onDelete }) {
  return <>
    <VersionAction label={compact ? `Edit ${policy.name} v${policy.version}` : `Edit v${policy.version}`} allowed={policy.can_edit === true} reason={editReason(policy)} onClick={onEdit} compact={compact}><Pencil />{!compact && 'Edit'}</VersionAction>
    <VersionAction label={compact ? `Delete ${policy.name} v${policy.version}` : `Delete v${policy.version}`} allowed={policy.can_delete === true} reason={deleteReason(policy)} onClick={onDelete} compact={compact} destructive><Trash2 />{!compact && 'Delete'}</VersionAction>
  </>;
}

function VersionAction({ label, allowed, reason, onClick, compact, destructive, children }) {
  const button = <Button variant="ghost" size={compact ? 'icon' : 'sm'} disabled={!allowed} aria-label={label} onClick={onClick} className={destructive && allowed ? 'text-destructive hover:text-destructive' : undefined}>{children}</Button>;
  return <Tooltip content={allowed ? label : reason}>{allowed ? button : <span tabIndex={0} className="inline-flex" aria-label={`${label} unavailable: ${reason}`}>{button}</span>}</Tooltip>;
}

function Builder({ kind, mode = 'new', from, versions = [], onClose }) {
  const qc = useQueryClient();
  const sample = useSample();
  const editing = mode === 'edit';
  const publishing = mode === 'publish';
  const [name, setName] = useState(from?.name ?? '');
  const [validFrom, setValidFrom] = useState(editing ? from.valid_from : '');
  const [rules, setRules] = useState(from?.rules ?? DEFAULT_RULES[kind]);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const previous = versions.filter((p) => p.version < from?.version).sort((a, b) => b.version - a.version)[0];
  const next = versions.filter((p) => p.version > from?.version).sort((a, b) => a.version - b.version)[0];
  const minimumDate = publishing ? addDays(from.valid_from, 1) : editing && previous ? addDays(previous.valid_from, 1) : undefined;
  const maximumDate = editing ? [from.valid_to, next && addDays(next.valid_from, -1)].filter(Boolean).sort()[0] : undefined;
  const dateHint = editing
    ? previous && maximumDate ? `After ${previous.valid_from} and on or before ${maximumDate}` : previous ? `Must be after ${previous.valid_from}` : maximumDate ? `On or before ${maximumDate}` : undefined
    : publishing ? `Must be after ${from.valid_from}` : undefined;
  const changes = editing ? {
    ...(name.trim() !== from.name ? { name: name.trim() } : {}),
    ...(validFrom !== from.valid_from ? { valid_from: validFrom } : {}),
    ...(JSON.stringify(rules) !== JSON.stringify(from.rules) ? { rules } : {}),
  } : { ...(publishing ? {} : { kind }), name: name.trim(), valid_from: validFrom, rules };
  const save = useMutation({
    mutationFn: () => editing ? api.patch(`/policies/${from.policy_key}/versions/${from.version}`, changes) : publishing ? api.post(`/policies/${from.policy_key}/versions`, changes) : api.post('/policies', changes),
    onSuccess: () => {
      toast.success(editing ? `Version ${from.version} updated.` : publishing ? `New version published from ${validFrom}.` : 'Policy created. Attach it to a pay group.');
      refreshPolicies(qc);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && ['name', 'valid_from'].includes(e.field)) setFieldErrors({ [e.field]: e.message });
      else setError(errorMessage(e));
      if (editing && e instanceof ApiError && e.status === 409) refreshPolicies(qc);
    },
  });
  const disabled = !name.trim() || !validFrom || (editing && (!Object.keys(changes).length || from.can_edit !== true)) || (kind === 'OVERTIME' && rules.base === 'COMPONENTS' && !rules.components?.length);
  const close = () => { if (!save.isPending) onClose(); };
  const submit = () => {
    if (disabled || save.isPending) return;
    setError(null);
    setFieldErrors({});
    if ((minimumDate && validFrom < minimumDate) || (maximumDate && validFrom > maximumDate)) {
      setFieldErrors({ valid_from: dateHint });
      return;
    }
    save.mutate();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      wide
      title={editing ? `Edit ${from.name} · v${from.version}` : publishing ? `Publish a new version of ${from.name}` : `New ${POLICY_KIND_LABELS[kind].toLowerCase()} policy`}
      description={editing ? 'Correct this version’s name, rules or effective date. Unlocked calculations use the updated rules.' : publishing ? `Version ${from.version} will close the day before the new effective date. Earlier dates keep their rules.` : undefined}
      footer={
        <>
          <Button variant="outline" disabled={save.isPending} onClick={close}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={disabled} onClick={submit}>
            {editing ? 'Save changes' : publishing ? 'Publish version' : 'Create policy'}
          </Button>
        </>
      }
    >
      <fieldset disabled={save.isPending} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" error={fieldErrors.name}>{(id, invalid) => <Input id={id} value={name} aria-invalid={invalid || undefined} onChange={(e) => { setName(e.target.value); setFieldErrors((errors) => ({ ...errors, name: undefined })); setError(null); }} />}</Field>
          <Field label="Effective from" required hint={dateHint} error={fieldErrors.valid_from}>
            {(id, invalid) => <Input id={id} required type="date" min={minimumDate} max={maximumDate} value={validFrom} aria-invalid={invalid || undefined} onChange={(e) => { setValidFrom(e.target.value); setFieldErrors((errors) => ({ ...errors, valid_from: undefined })); setError(null); }} />}
          </Field>
        </div>
        <PolicyForm kind={kind} rules={rules} onChange={(value) => { setRules(value); setError(null); }} />
        <WorkedExample kind={kind} rules={rules} s={sample} />
        {editing && from.can_edit !== true && <p className="text-[13px] text-muted-foreground">{editReason(from)}</p>}
        {error && <p className="text-[14px] text-destructive" role="alert">{error}</p>}
      </fieldset>
    </Dialog>
  );
}

function HistoryDialog({ policyKey, name, manage, onEdit, onDelete, onClose }) {
  const q = useQuery({ queryKey: ['policy-versions', policyKey], queryFn: () => api.get(`/policies/${policyKey}/versions`).then((r) => r.data) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} wide title="Version history" description={`${name}. Each version applies to its date range. Locked payroll and finalized settlements protect the rules they used.`}>
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <EmptyState title="No versions found" body="Close this history and refresh the policy list." />
      ) : (
        <div className="overflow-x-auto"><table className="w-full text-[14px]">
          <thead className="text-left text-[13px] text-muted-foreground">
            <tr>
              <th className="py-1">Version</th>
              <th>Date range</th>
              <th>Rules</th>
              {manage && <th className="text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {q.data?.map((p) => (
              <tr key={p.id} className="border-t align-top">
                <td className="py-3 pr-3"><Chip>v{p.version}</Chip><span className="mt-1 block font-medium">{p.name}</span></td>
                <td className="py-3 pr-3 num whitespace-nowrap">{p.valid_from}<span className="block text-muted-foreground">to {p.valid_to ?? 'Ongoing'}</span></td>
                <td className="py-3 pr-3 whitespace-normal">{summary(p)}{p.protection_reason && <p className="mt-1 text-[12px] text-muted-foreground">{p.protection_reason}</p>}{!p.protection_reason && p.can_delete === false && p.deletion_reason && <p className="mt-1 text-[12px] text-muted-foreground">{p.deletion_reason}</p>}</td>
                {manage && <td className="py-2 text-right"><span className="flex justify-end"><VersionActions policy={p} onEdit={() => onEdit(p, q.data)} onDelete={() => onDelete(p, q.data)} /></span></td>}
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Dialog>
  );
}

function DeleteVersionDialog({ policy, versions, onClose, onDeleted }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const q = useQuery({ queryKey: ['policy-versions', policy.policy_key], queryFn: () => api.get(`/policies/${policy.policy_key}/versions`).then((r) => r.data) });
  const currentVersions = q.data ?? versions;
  const target = currentVersions.find((p) => p.id === policy.id);
  const previous = currentVersions.filter((p) => p.version < policy.version).sort((a, b) => b.version - a.version)[0];
  const next = currentVersions.filter((p) => p.version > policy.version).sort((a, b) => a.version - b.version)[0];
  const groups = target?.pay_groups?.map((group) => group.name).join(', ');
  const remove = useMutation({
    mutationFn: () => api.del(`/policies/${policy.policy_key}/versions/${policy.version}`),
    onSuccess: () => { toast.success(`Version ${policy.version} deleted.`); refreshPolicies(qc); onDeleted(); },
    onError: (cause) => { setError(errorMessage(cause)); refreshPolicies(qc); },
  });
  const canDelete = target?.can_delete === true && !q.isFetching && !q.isError;
  const close = () => { if (!remove.isPending) onClose(); };
  return <Dialog open title={`Delete ${policy.name} · v${policy.version}?`} description="Review which rules will apply after this version is removed." onOpenChange={(open) => !open && close()} footer={<><Button variant="outline" disabled={remove.isPending} onClick={close}>Cancel</Button><Button variant="destructive" disabled={!canDelete} loading={remove.isPending} onClick={() => { setError(''); remove.mutate(); }}>Delete version</Button></>}>
    {q.isLoading ? <SkeletonRows rows={3} cols={2} /> : q.isError ? <ErrorState compact error={q.error} onRetry={() => q.refetch()} /> : !target ? <p className="text-[14px] text-muted-foreground">This version has already been removed. Close this dialog to see the remaining history.</p> : <div className="space-y-3 text-[14px]">
      <dl className="space-y-2"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Date range</dt><dd className="num text-right">{target.valid_from} → {target.valid_to ?? 'Ongoing'}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">Pay groups</dt><dd className="text-right">{groups || 'Not attached'}</dd></div></dl>
      <p className="rounded-md border bg-muted/40 p-3">{previous ? `Version ${previous.version} (${previous.name}) will apply from ${target.valid_from}${next ? ` until ${addDays(next.valid_from, -1)}` : ' onward'}. Its previous rules return for this period.` : next ? `Version ${next.version} still starts on ${next.valid_from}. Dates from ${target.valid_from} to ${addDays(next.valid_from, -1)} will use default rules unless another policy covers them.` : 'This removes the policy from the available policies. No pay group is attached.'}</p>
      {target.can_delete !== true && <p className="text-muted-foreground">{deleteReason(target)}</p>}
    </div>}
    {error && <p className="mt-3 text-[14px] text-destructive" role="alert">{error}</p>}
  </Dialog>;
}
