import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { exitName, longDate, monthLabel, toPaise } from '@/utils';
import { Money, Mono, PageHeader } from '@/components/bits';
import { Chip, ErrorState, Notice, SeverityChip, SkeletonBlock } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/form';
import { Dialog, Menu } from '@/components/ui/overlay';

export const useSettlement = (employeeId) => useQuery({ queryKey: ['settlement', employeeId], queryFn: () => api.get(`/settlements/${employeeId}`).then((r) => r.data) });

/** Where the F&F stands, in a few words. */
export function fnfStatus(s) {
  if (!s) return 'Not worked out yet';
  if (s.state === 'PAID') return s.paid_separately ? `Paid separately (${s.paid_separately.payment_ref})` : `Paid with ${monthLabel(s.period_ym)} payroll`;
  if (s.state === 'INCLUDED') return s.paid_separately ? `In ${monthLabel(s.period_ym)} payroll, paid separately` : `In ${monthLabel(s.period_ym)} payroll`;
  return 'Not processed';
}

/**
 * Full and final settlement: what is owed and what comes back, with HR's changes. Negative
 * net reads as recoverable, never as a negative payable. Used on its own page and inside the
 * profile's Exit tab.
 */
export function SettlementPanel({ employeeId, print }) {
  const qc = useQueryClient();
  const q = useSettlement(employeeId);
  const [decision, setDecision] = useState({ decision: 'PURSUE', note: '' });
  const decide = useMutation({
    mutationFn: () => api.post(`/settlements/${q.data.settlement_id}/decision`, decision),
    onSuccess: () => {
      toast.success('Decision recorded');
      qc.invalidateQueries({ queryKey: ['settlement', employeeId] });
      qc.invalidateQueries({ queryKey: ['exits'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [ask, setAsk] = useState(null);
  const adjust = useMutation({
    mutationFn: (body) => api.post(`/settlements/${employeeId}/adjust`, body),
    onSuccess: () => {
      toast.success('Settlement changed and worked out again');
      setAsk(null);
      for (const key of [['settlement', employeeId], ['exits'], ['exit', employeeId]]) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <SkeletonBlock className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const r = d.result;
  const earnings = r?.earnings ?? d.settlement?.earnings ?? [];
  const deductions = r?.deductions ?? d.settlement?.deductions ?? [];
  const totalE = r?.total_earnings ?? d.settlement?.total_earnings ?? 0;
  const totalD = r?.total_deductions ?? d.settlement?.total_deductions ?? 0;
  const net = r?.net ?? d.settlement?.net ?? 0;
  // HR can change it while live, until the payroll it is processed in moves past step 2.
  const editable = !print && !d.frozen && !d.locked;
  const lineMenu = (l) => {
    const items = [];
    if (l.switchable) items.push(l.excluded ? { label: 'Switch back on', onSelect: () => adjust.mutate({ action: 'INCLUDE', code: l.code }) } : { label: 'Switch off…', onSelect: () => setAsk({ action: 'EXCLUDE', code: l.code, title: `Switch off ${l.name}` }) });
    if (l.days !== undefined && !l.excluded) {
      items.push({ label: 'Change days…', onSelect: () => setAsk({ action: 'SET_DAYS', code: l.code, days: String(l.days), title: `Days for ${l.name}` }) });
      if (l.days_reason) items.push({ label: `Back to ${l.computed_days} days`, onSelect: () => adjust.mutate({ action: 'CLEAR_DAYS', code: l.code }) });
    }
    if (l.added) items.push({ label: 'Remove this line', destructive: true, onSelect: () => adjust.mutate({ action: 'REMOVE_LINE', id: l.id }) });
    return items;
  };

  const statement = (
    <Card className="print-area">
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-display text-lg font-semibold">{d.company?.name ?? 'AJ Power Engineering'}</div>
            <div className="text-[13px] text-muted-foreground">{d.company?.address}</div>
          </div>
          <div className="text-right">
            <div className="font-display text-lg font-semibold">Full and final settlement</div>
            <div className="text-[13px] text-muted-foreground">{d.frozen ? `Paid ${d.settlement?.paid_at?.slice(0, 10)}` : 'Worked out live — not yet paid'}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-[14px] sm:grid-cols-4">
          <div>
            <div className="text-[13px] text-muted-foreground">Employee</div>
            {d.employee.name} <Mono>{d.employee.code}</Mono>
          </div>
          <div>
            <div className="text-[13px] text-muted-foreground">Joined</div>
            {longDate(d.employee.joined_on)}
          </div>
          <div>
            <div className="text-[13px] text-muted-foreground">Last day · {exitName(d.employee.exit_reason)}</div>
            {longDate(d.employee.last_day)}
          </div>
          <div>
            <div className="text-[13px] text-muted-foreground">Service</div>
            {r ? `${r.service.years} years ${r.service.months} months` : '—'}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[
            ['What is owed', earnings, totalE],
            ['What comes back', deductions, totalD],
          ].map(([title, lines, total]) => (
            <div key={title}>
              <h4 className="border-b pb-1 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
              <table className="w-full text-[14px]">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.code} className="border-b border-dashed align-top">
                      <td className="py-1.5">
                        <span className={l.excluded ? 'text-muted-foreground line-through' : undefined}>{l.name}</span>
                        {l.added && <Chip className="ml-1">Added by HR</Chip>}
                        {l.detail && <div className="text-[12px] text-muted-foreground">{l.detail}</div>}
                        {l.days_reason && <div className="text-[12px] text-info">Changed from {l.computed_days} days: {l.days_reason}</div>}
                        {l.excluded && <div className="text-[12px] text-destructive">Switched off: {l.excluded_reason}</div>}
                      </td>
                      <td className={`py-1.5 text-right ${l.excluded ? 'text-muted-foreground line-through' : ''}`}>
                        <Money value={l.amount} paise />
                      </td>
                      {editable && (
                        <td className="w-8 py-0.5 text-right">
                          {lineMenu(l).length > 0 && (
                            <Menu
                              trigger={
                                <Button size="icon" variant="ghost" aria-label={`Change ${l.name}`}>
                                  <MoreHorizontal />
                                </Button>
                              }
                              items={lineMenu(l)}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr>
                      <td className="py-1 text-muted-foreground">None</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="flex justify-between border-t py-1 text-[14px] font-semibold">
                <span>Total</span>
                <Money value={total} paise />
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between rounded-md border-2 border-primary/40 px-3 py-2">
          <span className="font-display text-[16px] font-semibold">{net < 0 ? 'Recoverable from the employee' : 'Net payable'}</span>
          <span className={`text-xl font-semibold num ${net < 0 ? 'text-destructive' : ''}`}>
            <Money value={Math.abs(net)} paise />
          </span>
        </div>
        <p className="text-[12px] text-muted-foreground">
          No notice period and no asset recovery. Loans and advances are recovered in full at settlement; the monthly recovery cap does not apply. Salary held and not yet paid is paid with it.
        </p>
      </CardBody>
    </Card>
  );

  if (print) return statement;

  return (
    <div className="flex flex-col gap-4">
      {editable && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="min-w-0">
            <div className="font-semibold">Add to this F&F</div>
            <p className="m-0 text-[13px] text-muted-foreground">An earning (bonus, incentive, reimbursement) or a deduction (notice recovery, asset not returned). Every change needs a reason and is audited. Use the menu on a line to switch it off or change its days.</p>
          </div>
          <span className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => setAsk({ action: 'ADD_LINE', kind: 'EARNING', title: 'Add an earning' })}>
              <Plus /> Add earning
            </Button>
            <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" onClick={() => setAsk({ action: 'ADD_LINE', kind: 'DEDUCTION', title: 'Add a deduction' })}>
              <Plus /> Add deduction
            </Button>
          </span>
        </div>
      )}
      {d.locked && !d.frozen && <Notice tone="info">{d.locked}</Notice>}
      {r && r.clearance.length > 0 && (
        <Card>
          <CardHeader title="Clearance" description={r.can_pay ? 'Nothing blocks payment. Warnings need a look.' : 'This settlement cannot be paid while a blocking item stands.'} />
          <ul className="divide-y text-[14px]">
            {r.clearance.map((c) => (
              <li key={c.code} className="flex items-center gap-3 px-5 py-2.5">
                <SeverityChip severity={c.severity} /> {c.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {statement}
      {r && r.net < 0 && d.settlement_id && (
        <Card>
          <CardHeader title="Recoverable amount" description="A negative settlement never goes into a bank file. Decide deliberately whether to write it off or pursue it." />
          <CardBody className="grid gap-3 sm:grid-cols-3">
            {d.recoverable_decision && <Notice tone="info">Current decision: {d.recoverable_decision === 'WRITE_OFF' ? 'write off' : 'pursue'}.</Notice>}
            <Select value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })} aria-label="Decision">
              <option value="PURSUE">Pursue recovery</option>
              <option value="WRITE_OFF">Write off</option>
            </Select>
            <Textarea className="sm:col-span-2" placeholder="Why, and who approved it" value={decision.note} onChange={(e) => setDecision({ ...decision, note: e.target.value })} />
            <div className="flex justify-end sm:col-span-3">
              <Button disabled={decision.note.trim().length < 8} loading={decide.isPending} onClick={() => decide.mutate()}>
                Record decision
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
      {ask && <AdjustDialog ask={ask} busy={adjust.isPending} onClose={() => setAsk(null)} onSave={(body) => adjust.mutate(body)} />}
    </div>
  );
}

/** The settlement on its own page: for printing, and from the Exits list. Processing it happens on the Exit tab. */
export default function SettlementStatement({ print }) {
  const { employeeId } = useParams();
  const q = useSettlement(employeeId);
  if (print) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="no-print mb-4 flex justify-end">
          <Button onClick={() => window.print()}>
            <Printer /> Print
          </Button>
        </div>
        <SettlementPanel employeeId={employeeId} print />
      </div>
    );
  }
  const d = q.data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Exits and settlement', to: '/exits' }, { label: d?.employee.name ?? '…' }]}
        title={d ? `F&F — ${d.employee.name}` : 'F&F'}
        meta={d && <Chip tone={d.frozen ? 'success' : d.state === 'INCLUDED' ? 'info' : 'muted'}>{fnfStatus({ state: d.frozen ? 'PAID' : d.state, period_ym: d.period_ym, paid_separately: d.paid_separately })}</Chip>}
        actions={
          <>
            {d && (
              <Link className={buttonVariants({ variant: 'outline' })} to={`/people/${d.employee.id}?tab=exit`}>
                Open the exit
              </Link>
            )}
            <Button variant="outline" onClick={() => window.open(`/print/settlement/${employeeId}`, '_blank')}>
              <Printer /> Print statement
            </Button>
          </>
        }
      />
      <SettlementPanel employeeId={employeeId} />
    </div>
  );
}

/** One change to a settlement that needs details and a reason. */
function AdjustDialog({ ask, busy, onClose, onSave }) {
  const [f, setF] = useState({ days: ask.days ?? '', name: '', amount: '', reason: '' });
  const body =
    ask.action === 'SET_DAYS'
      ? { action: 'SET_DAYS', code: ask.code, days: Number(f.days), reason: f.reason }
      : ask.action === 'ADD_LINE'
        ? { action: 'ADD_LINE', kind: ask.kind, name: f.name, amount: toPaise(f.amount), reason: f.reason }
        : { action: 'EXCLUDE', code: ask.code, reason: f.reason };
  const ok = f.reason.trim().length >= 8 && (ask.action !== 'SET_DAYS' || f.days !== '') && (ask.action !== 'ADD_LINE' || (f.name.trim().length >= 2 && toPaise(f.amount) > 0));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={ask.title}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!ok} onClick={() => onSave(body)}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {ask.action === 'SET_DAYS' && <Field label="Days">{(id) => <Input id={id} type="number" step="0.25" min="0" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />}</Field>}
        {ask.action === 'ADD_LINE' && (
          <>
            <Field label="Name" hint={ask.kind === 'EARNING' ? 'e.g. Project completion bonus, ex-gratia' : 'e.g. Damaged tools, canteen dues'}>
              {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
            </Field>
            <Field label="Amount">{(id) => <MoneyInput id={id} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
          </>
        )}
        <Field label="Reason" hint="At least eight characters. It shows on the statement and in the audit log.">
          {(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}
