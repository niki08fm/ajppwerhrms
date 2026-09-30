import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchPlus, History, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { POLICY_KINDS, POLICY_KIND_LABELS } from '@ajpwer/shared';
import { api, ApiError, errorMessage } from '@/services/api';
import { PageHeader } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { DEFAULT_RULES, PolicyForm, WorkedExample } from '../../components/setup/PolicyForm';

function summary(p) {
  const r = p.rules; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (p.kind) {
    case 'ATTENDANCE':
      return `${r.standard_min / 60}h day, half from ${r.half_day_min / 60}h, ${r.grace_min} min grace`;
    case 'OVERTIME':
      return `${r.multiplier}× on ${r.base === 'BASIC_HRA' ? 'basic + HRA' : r.base.toLowerCase()}, after ${r.after_min} min, cap ${r.monthly_cap_min ? `${r.monthly_cap_min / 60}h` : 'none'}`;
    case 'WEEKOFF_PAY':
    case 'HOLIDAY_PAY':
      return `${r.paid ? 'Paid' : 'Unpaid'}${r.sandwich ? ', sandwich' : ''}`;
    case 'HOLIDAY_WORK':
      return `Holiday ${r.holiday.mode === 'PAY' ? `${r.holiday.rate_pct}%` : 'none'}, weekly off ${r.weekly_off.mode === 'PAY' ? `${r.weekly_off.rate_pct}%` : 'none'}`;
    case 'LATE_PENALTY':
      return `${r.free_per_month} free, ${r.slabs.length} slabs`;
    case 'LEAVE':
      return r.types.map((t) => `${t.code} ${t.annual_days}`).join(', ');
  }
}

export function useSample() {
  const s = useQuery({ queryKey: ['structures'], queryFn: () => api.get('/structures').then((r) => r.data) });
  return useMemo(() => {
    const m = s.data?.[0]?.sample.monthly ?? [];
    const basic = m.find((c) => c.name.toLowerCase() === 'basic')?.amount ?? 12_000_00;
    const hra = m.find((c) => c.name.toLowerCase().includes('hra'))?.amount ?? 4_800_00;
    return { gross: 24_000_00, basic, hra, divisor: 26 };
  }, [s.data]);
}

export default function Policies() {
  const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['policies'], queryFn: () => api.get('/policies').then((r) => r.data) });
  const [builder, setBuilder] = useState(null);
  const [history, setHistory] = useState(null);
  useEffect(() => {
    const k = sp.get('kind');
    if (sp.get('new') && k && POLICY_KINDS.includes(k)) {
      setBuilder({ kind: k });
      setSp({}, { replace: true });
    }
  }, [sp, setSp]);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Policies"
        description="Seven kinds. Editing a policy is not allowed: publishing a new version takes an effective date, closes the current one the day before, and attaches the new one wherever the old one was. Both stay attached; the engine picks by date."
      />
      {q.isLoading ? (
        <SkeletonRows rows={10} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        POLICY_KINDS.map((k) => {
          const rows = q.data.filter((p) => p.kind === k);
          const latest = [...new Map(rows.map((p) => [p.policy_key, rows.filter((x) => x.policy_key === p.policy_key).sort((a, b) => b.version - a.version)[0]])).values()];
          return (
            <Card key={k}>
              <CardHeader
                title={POLICY_KIND_LABELS[k]}
                actions={
                  <Button size="sm" variant="outline" onClick={() => setBuilder({ kind: k })}>
                    <Plus /> New policy
                  </Button>
                }
              />

              {!latest.length ? (
                <EmptyState title={`No ${POLICY_KIND_LABELS[k].toLowerCase()} policy`} body="Create one, then attach it to a pay group." />
              ) : (
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Summary</th>
                      <th>Current version</th>
                      <th>Date range</th>
                      <th>Used by</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {latest.map((p) => {
                      const versions = rows.filter((x) => x.policy_key === p.policy_key).length;
                      return (
                        <tr key={p.id}>
                          <td className="font-medium">{p.name}</td>
                          <td className="whitespace-normal text-muted-foreground">{summary(p)}</td>
                          <td>
                            <Chip>v{p.version}</Chip>
                          </td>
                          <td className="num">
                            {p.valid_from} → {p.valid_to ?? ''}
                          </td>
                          <td>{p.pay_groups.map((g) => g.name).join(', ') || <span className="text-muted-foreground">Not attached</span>}</td>
                          <td className="text-right">
                            <span className="flex justify-end gap-1">
                              {versions > 1 && (
                                <Button size="sm" variant="ghost" onClick={() => setHistory(p.policy_key)}>
                                  <History /> {versions} versions
                                </Button>
                              )}
                              <Button size="sm" variant="outline" onClick={() => setBuilder({ kind: k, from: p })}>
                                <GitBranchPlus /> Publish new version
                              </Button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          );
        })
      )}
      {builder && <Builder kind={builder.kind} from={builder.from} onClose={() => setBuilder(null)} />}
      {history && <HistoryDialog policyKey={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function Builder({ kind, from, onClose }) {
  const qc = useQueryClient();
  const sample = useSample();
  const [name, setName] = useState(from?.name ?? '');
  const [validFrom, setValidFrom] = useState('');
  const [rules, setRules] = useState(from?.rules ?? DEFAULT_RULES[kind]);
  const [error, setError] = useState(null);
  const save = useMutation({
    mutationFn: () => (from ? api.post(`/policies/${from.policy_key}/versions`, { valid_from: validFrom, name, rules }) : api.post('/policies', { kind, name, valid_from: validFrom, rules })),
    onSuccess: () => {
      toast.success(
        from ? `Version ${from.version + 1} published from ${validFrom}. v${from.version} now ends the day before and stays attached for history.` : 'Policy created. Attach it to a pay group.',
      );
      qc.invalidateQueries({ queryKey: ['policies'] });
      qc.invalidateQueries({ queryKey: ['pay-groups'] });
      onClose();
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title={from ? `Publish a new version of ${from.name}` : `New ${POLICY_KIND_LABELS[kind].toLowerCase()} policy`}
      description={from ? `Version ${from.version} (from ${from.valid_from}) will close the day before the new effective date. Months before it are not recomputed.` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!name.trim() || !validFrom} onClick={() => save.mutate()}>
            {from ? `Publish v${from.version + 1}` : 'Create policy'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Effective from" required hint={from ? `Must be after ${from.valid_from}` : undefined}>
            {(id) => <Input id={id} type="date" min={from?.valid_from} value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />}
          </Field>
        </div>
        <PolicyForm kind={kind} rules={rules} onChange={setRules} />
        <WorkedExample kind={kind} rules={rules} s={sample} />
        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </div>
    </Dialog>
  );
}

function HistoryDialog({ policyKey, onClose }) {
  const q = useQuery({ queryKey: ['policy-versions', policyKey], queryFn: () => api.get(`/policies/${policyKey}/versions`).then((r) => r.data) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} wide title="Version history" description="Every version stays; the engine uses whichever covers each date.">
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : (
        <table className="w-full text-[13px]">
          <thead className="text-left text-[12px] text-muted-foreground">
            <tr>
              <th className="py-1">Version</th>
              <th>From</th>
              <th>To</th>
              <th>Rules</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((p) => (
              <tr key={p.id} className="border-t align-top">
                <td className="py-1.5">v{p.version}</td>
                <td className="num">{p.valid_from}</td>
                <td className="num">{p.valid_to ?? '—'}</td>
                <td className="whitespace-normal">{summary(p)}</td>
                <td className="text-muted-foreground">{p.created_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}
