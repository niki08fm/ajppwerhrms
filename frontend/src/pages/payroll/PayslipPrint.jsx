import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api } from '@/services/api';
import { mins } from '@/utils';
import { Mono } from '@/components/bits';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { PayslipBody } from '../../components/payroll/PayslipBody';

/** Clean A4 from the browser: no navigation, no buttons, no colour backgrounds. */
export default function PayslipPrint() {
  const { ym, employeeId } = useParams();
  const q = useQuery({ queryKey: ['payslip', ym, employeeId], queryFn: () => api.get(`/payroll/periods/${ym}/payslips/${employeeId}`).then((r) => r.data) });
  if (q.isLoading) return <SkeletonBlock className="m-6 h-[600px]" />;
  if (q.isError) return <ErrorState error={q.error} />;
  const s = q.data;
  const m = s.meta;
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="no-print mb-4 flex justify-between">
        <span className="text-[13px] text-muted-foreground">
          {s.period.state === 'LOCKED' || s.period.state === 'PAID' ? 'Final payslip — this month is locked.' : 'This month is run but not locked; the payslip can still change on a rerun.'}
        </span>
        <Button onClick={() => window.print()}>
          <Printer /> Print
        </Button>
      </div>
      <article className="print-area flex flex-col gap-4 rounded-lg border bg-card p-8">
        <header className="flex items-start justify-between border-b pb-3">
          <div>
            <div className="font-display text-xl font-semibold">{s.company?.name ?? 'AJ Power Engineering'}</div>
            <div className="text-[12px] text-muted-foreground">{s.company?.address}</div>
          </div>
          <div className="text-right">
            <div className="font-display text-lg font-semibold">Payslip</div>
            <div className="text-[13px]">{s.period.label}</div>
          </div>
        </header>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-3">
          <div>
            <span className="text-muted-foreground">Name</span> {m.employee.name}
          </div>
          <div>
            <span className="text-muted-foreground">Code</span> <Mono>{m.employee.code}</Mono>
          </div>
          <div>
            <span className="text-muted-foreground">Designation</span> {m.employee.designation}
          </div>
          <div>
            <span className="text-muted-foreground">Department</span> {m.department.name}
          </div>
          <div>
            <span className="text-muted-foreground">Pay group</span> {m.pay_group.name}
          </div>
          <div>
            <span className="text-muted-foreground">Joined</span> {m.employee.joined_on}
          </div>
          <div>
            <span className="text-muted-foreground">UAN</span> <Mono>{m.ids.uan ?? '—'}</Mono>
          </div>
          <div>
            <span className="text-muted-foreground">ESI no.</span> <Mono>{m.ids.esi_number ?? '—'}</Mono>
          </div>
          <div>
            <span className="text-muted-foreground">Bank</span> <Mono>{m.bank.last4 ? `XXXXXX${m.bank.last4}` : '—'}</Mono> {m.bank.ifsc}
          </div>
          <div>
            <span className="text-muted-foreground">Tax regime</span> {m.regime === 'OLD' ? 'Old' : 'New'}
          </div>
          <div>
            <span className="text-muted-foreground">PT state</span> {m.pt_state}
          </div>
          <div>
            <span className="text-muted-foreground">Worked</span> {mins(m.attendance?.worked_min ?? 0)}
          </div>
        </div>
        <PayslipBody lines={s.lines} totals={s} basis={{ paid_days: s.paid_days, lop_days: s.lop_days, divisor: s.divisor, rule: m.lop_rule_text }} />
        {m.ot && m.ot.excess_min > 0 && <p className="text-[12px]">{mins(m.ot.excess_min)} of overtime above the monthly cap is unpaid.</p>}
        <footer className="border-t pt-2 text-[11px] text-muted-foreground">
          Computed {s.computed_at.slice(0, 10)} · engine {s.engine_version}. This is a computer-generated payslip.
        </footer>
      </article>
    </div>
  );
}
