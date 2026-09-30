import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { longDate } from '@/utils';
import { Money, Mono, PageHeader } from '@/components/bits';
import { Chip, ErrorState, Notice, SeverityChip, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/form';

/** Full and final settlement. Negative net reads as recoverable, never as a negative payable. */
export default function SettlementStatement({ print }) {
  const { employeeId } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settlement', employeeId], queryFn: () => api.get(`/settlements/${employeeId}`).then((r) => r.data) });
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
  if (q.isLoading) return <SkeletonBlock className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const r = d.result;
  const earnings = r?.earnings ?? d.settlement?.earnings ?? [];
  const deductions = r?.deductions ?? d.settlement?.deductions ?? [];
  const totalE = r?.total_earnings ?? d.settlement?.total_earnings ?? 0;
  const totalD = r?.total_deductions ?? d.settlement?.total_deductions ?? 0;
  const net = r?.net ?? d.settlement?.net ?? 0;

  const statement = (
    <Card className="print-area">
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="font-display text-lg font-semibold">{d.company?.name ?? 'AJ Power Engineering'}</div>
            <div className="text-[12px] text-muted-foreground">{d.company?.address}</div>
          </div>
          <div className="text-right">
            <div className="font-display text-lg font-semibold">Full and final settlement</div>
            <div className="text-[12px] text-muted-foreground">{d.frozen ? `Paid ${d.settlement?.paid_at?.slice(0, 10)}` : 'Computed live — not yet paid'}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
          <div>
            <div className="text-[12px] text-muted-foreground">Employee</div>
            {d.employee.name} <Mono>{d.employee.code}</Mono>
          </div>
          <div>
            <div className="text-[12px] text-muted-foreground">Joined</div>
            {longDate(d.employee.joined_on)}
          </div>
          <div>
            <div className="text-[12px] text-muted-foreground">Last day</div>
            {longDate(d.employee.last_day)}
          </div>
          <div>
            <div className="text-[12px] text-muted-foreground">Service</div>
            {r ? `${r.gratuity.service.years} years ${r.gratuity.service.months} months` : '—'}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[
            ['What is owed', earnings, totalE],
            ['What comes back', deductions, totalD],
          ].map(([title, lines, total]) => (
            <div key={title}>
              <h4 className="border-b pb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
              <table className="w-full text-[13px]">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.code} className="border-b border-dashed">
                      <td className="py-1">
                        {l.name}
                        {l.detail && <div className="text-[11px] text-muted-foreground">{l.detail}</div>}
                      </td>
                      <td className="py-1 text-right">
                        <Money value={l.amount} paise />
                      </td>
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr>
                      <td className="py-1 text-muted-foreground">None</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="flex justify-between border-t py-1 text-[13px] font-semibold">
                <span>Total</span>
                <Money value={total} paise />
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between rounded-md border-2 border-primary/40 px-3 py-2">
          <span className="font-display text-[15px] font-semibold">{net < 0 ? 'Recoverable from the employee' : 'Net payable'}</span>
          <span className={`font-display text-xl font-semibold ${net < 0 ? 'text-destructive' : ''}`}>
            <Money value={Math.abs(net)} paise />
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          No asset recovery: AJ Power Engineering does not issue assets. Loans and advances are recovered in full at settlement; the monthly recovery cap does not apply.
        </p>
      </CardBody>
    </Card>
  );

  if (print) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="no-print mb-4 flex justify-end">
          <Button onClick={() => window.print()}>
            <Printer /> Print
          </Button>
        </div>
        {statement}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Exits and settlement', to: '/exits' }, { label: d.employee.name }]}
        title={`Settlement — ${d.employee.name}`}
        meta={
          <>
            {d.frozen ? <Chip tone="success">Paid — frozen</Chip> : <Chip tone="info">Live</Chip>}
            {d.state === 'INCLUDED' && <Chip tone="info">Ticked for {d.period_ym}</Chip>}
            <Link className="text-[13px] text-primary hover:underline" to={`/people/${d.employee.id}?tab=exit`}>
              Profile
            </Link>
          </>
        }
        actions={
          <Button variant="outline" onClick={() => window.open(`/print/settlement/${d.employee.id}`, '_blank')}>
            <Printer /> Print statement
          </Button>
        }
      />

      {r && r.clearance.length > 0 && (
        <Card>
          <CardHeader title="Clearance" description={r.can_pay ? 'Nothing blocks payment. Warnings need a look.' : 'This settlement cannot be paid while a blocking item stands.'} />
          <ul className="divide-y text-[13px]">
            {r.clearance.map((c) => (
              <li key={c.code} className="flex items-center gap-3 px-4 py-2">
                <SeverityChip severity={c.severity} /> {c.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {statement}
      {r && r.net < 0 && d.settlement_id && (
        <Card>
          <CardHeader title="Recoverable amount" description="A negative settlement is never put into the bank file. Decide deliberately whether to write it off or pursue it." />
          <CardBody className="grid gap-3 sm:grid-cols-3">
            {d.recoverable_decision && <Notice tone="info">Current decision: {d.recoverable_decision === 'WRITE_OFF' ? 'write off' : 'pursue'}.</Notice>}
            <Select value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })} aria-label="Decision">
              <option value="PURSUE">Pursue recovery</option>
              <option value="WRITE_OFF">Write off</option>
            </Select>
            <Textarea className="sm:col-span-2" placeholder="Why, and who approved it" value={decision.note} onChange={(e) => setDecision({ ...decision, note: e.target.value })} />
            <div className="sm:col-span-3 flex justify-end">
              <Button disabled={decision.note.trim().length < 8} loading={decide.isPending} onClick={() => decide.mutate()}>
                Record decision
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
      {!d.frozen && (
        <p className="text-[13px] text-muted-foreground">
          To pay it, tick it in step 2 of the payroll run for{' '}
          {d.period_ym ? (
            <Link className="text-primary hover:underline" to={`/payroll/${d.period_ym}`}>
              {d.period_ym}
            </Link>
          ) : (
            'the month of the last day'
          )}
          . When that month is marked paid, the settlement freezes, loans and advances close, and the person moves to exited.
        </p>
      )}
    </div>
  );
}
