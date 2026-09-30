import { cn } from '@/lib/utils';
import { Money } from '@/components/bits';

const isAdhocDed = (l) => l.kind === 'DEDUCTION' && l.code.startsWith('ADHOC_DED:');

/**
 * The six blocks, in the order AJPWER confirmed — the same in the process screen,
 * the register and the printed payslip:
 *   1 Gross · 2 Employer contributions · 3 Employee deductions ·
 *   4 Adhoc additions · 5 Adhoc deductions · 6 Net pay
 * Block 1 + block 2 is cost to company; 1 − 3 + 4 − 5 is net pay.
 */
export function PayslipBody({ lines, totals, basis, compact }) {
  const gross = lines.filter((l) => ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY'].includes(l.kind));
  const employer = lines.filter((l) => l.kind === 'EMPLOYER');
  const deductions = lines.filter((l) => l.kind === 'DEDUCTION' && !isAdhocDed(l));
  const adhocAdd = lines.filter((l) => l.kind === 'ADHOC' || l.kind === 'REIMBURSEMENT');
  const adhocDed = lines.filter(isAdhocDed);
  const sum = (xs) => xs.reduce((a, l) => a + l.amount, 0);

  const Block = ({ n, title, rows, total, totalLabel, note, showFull }) => (
    <section className="break-inside-avoid">
      <h4 className="flex items-baseline gap-2 border-b pb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="num">{n}</span> {title}
      </h4>
      {rows.length === 0 ? (
        <p className="py-1.5 text-[12px] text-muted-foreground">None</p>
      ) : (
        <table className="w-full text-[13px]">
          <tbody>
            {rows.map((l) => (
              <tr key={`${l.seq}-${l.code}`} className="border-b border-dashed last:border-0">
                <td className="py-1 pr-2">
                  {l.name}
                  {l.kind === 'REIMBURSEMENT' && <span className="ml-1 text-[11px] text-muted-foreground">(reimbursement, tax-free)</span>}
                  {l.kind === 'ADHOC' && <span className="ml-1 text-[11px] text-muted-foreground">({l.is_taxable ? 'taxable' : 'exempt'})</span>}
                </td>
                {showFull && !compact && <td className="py-1 text-right text-[12px] text-muted-foreground">{l.full_amount !== l.amount ? <Money value={l.full_amount} paise /> : ''}</td>}
                <td className="py-1 text-right">
                  <Money value={l.amount} paise />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {total !== undefined && (
        <div className="flex justify-between border-t py-1 text-[13px] font-semibold">
          <span>{totalLabel}</span>
          <Money value={total} paise />
        </div>
      )}
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </section>
  );

  return (
    <div className={cn('flex flex-col gap-3', compact && 'text-[12px]')}>
      {basis && (
        <p className="rounded bg-muted px-2 py-1.5 text-[12px] text-muted-foreground">
          Paid days <strong className="text-foreground num">{basis.paid_days}</strong> · loss of pay <strong className="text-foreground num">{basis.lop_days}</strong> · divisor{' '}
          <strong className="text-foreground num">{basis.divisor}</strong>. {basis.rule}.
        </p>
      )}
      <Block
        n={1}
        title="Gross"
        rows={gross}
        total={sum(gross)}
        totalLabel="Gross"
        showFull
        note={!compact ? 'Where a figure is shown in grey beside a line, that is the full amount before loss of pay.' : undefined}
      />
      <Block n={2} title="Employer contributions" rows={employer} total={sum(employer)} totalLabel="Paid by the company on top" />
      <Block n={3} title="Employee deductions" rows={deductions} total={sum(deductions)} totalLabel="Total deductions" />
      <Block n={4} title="Adhoc additions" rows={adhocAdd} />
      <Block n={5} title="Adhoc deductions" rows={adhocDed} />
      <section className="flex items-center justify-between rounded-md border-2 border-primary/40 px-3 py-2">
        <span className="font-display text-[15px] font-semibold">6 Net pay</span>
        <span className="font-display text-xl font-semibold">
          <Money value={totals.net} paise />
        </span>
      </section>
      {!compact && (
        <p className="text-[11px] text-muted-foreground num">
          Cost to company this month (1 + 2): <Money value={totals.salary_gross + totals.employer_total} paise />. Net pay (1 − 3 + 4 − 5): <Money value={totals.net} paise />.
        </p>
      )}
    </div>
  );
}
