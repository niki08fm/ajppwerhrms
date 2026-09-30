import { Money } from '@/components/bits';
import { Chip } from '@/components/states';
import { cn } from '@/utils';

const NA = <span className="text-muted-foreground">—</span>;

function Section({ children, first }) {
  return (
    <tr>
      <td colSpan={3} className={cn('pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground', first ? 'pt-1' : 'pt-5')}>
        {children}
      </td>
    </tr>
  );
}

function Line({ label, sub, monthly, yearly, muted }) {
  return (
    <tr className={cn('border-t border-border/60', muted && 'text-muted-foreground')}>
      <td className="py-1.5 pr-2">
        {label}
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </td>
      <td className="py-1.5 pl-2 text-right whitespace-nowrap">{monthly}</td>
      <td className="py-1.5 pl-2 text-right whitespace-nowrap">{yearly}</td>
    </tr>
  );
}

function Total({ label, monthly, yearly, tone }) {
  return (
    <tr className={cn('border-t font-semibold', tone === 'ctc' && 'bg-primary/5', tone === 'net' && 'bg-success/10 text-success')}>
      <td className={cn('py-1.5 pr-2', tone && 'pl-2')}>{label}</td>
      <td className="py-1.5 pl-2 text-right whitespace-nowrap">
        <Money value={monthly} />
      </td>
      <td className={cn('py-1.5 pl-2 text-right whitespace-nowrap', tone && 'pr-2')}>
        <Money value={yearly} />
      </td>
    </tr>
  );
}

/**
 * A salary breakup in the order people read one: earnings add up to gross;
 * the company's contributions on top of gross make the CTC; the employee's
 * deductions come off gross to leave net pay. Monthly and yearly side by side.
 */
export function SalaryBreakup({ p, rates, rules, capped, className }) {
  const pct = (v) => (v === undefined ? '' : ` (${v}%)`);
  const esiOn = p.esi.applicable;
  const esiNote = !esiOn
    ? p.esi_within_ceiling
      ? 'Switched off for this person'
      : `Only when gross is ${rates?.esi?.ceiling ? `₹${(rates.esi.ceiling / 100).toLocaleString('en-IN')}` : 'at the ESI ceiling'} or less`
    : undefined;
  const yearlyItems = p.structure.yearly.reduce((s, c) => s + c.amount, 0);

  const contributions = p.ctc.employer_pf + p.ctc.employer_esi;
  const ptYear = p.pt.amount * 11 + p.pt_february.amount;
  const deductionsYear = (p.pf.employee + p.pf.vpf + p.esi.employee) * 12 + ptYear + p.annual_tax;
  const netYear = p.gross * 12 + yearlyItems - deductionsYear;

  return (
    <table className={cn('w-full text-[13px]', className)}>
      <thead className="text-[12px] text-muted-foreground">
        <tr>
          <th className="py-1 text-left font-normal" />
          <th className="py-1 pl-2 text-right font-normal">Monthly</th>
          <th className="py-1 pl-2 text-right font-normal">Yearly</th>
        </tr>
      </thead>
      <tbody>
        <Section first>Earnings</Section>
        {p.structure.monthly.map((c) => (
          <Line
            key={c.name}
            label={
              <>
                {c.name}
                {capped?.has(c.name) && (
                  <Chip tone="warning" className="ml-1.5">
                    max
                  </Chip>
                )}
              </>
            }
            sub={rules?.[c.name]}
            monthly={<Money value={c.amount} />}
            yearly={<Money value={c.amount * 12} />}
          />
        ))}
        <Total label="Gross salary" monthly={p.gross} yearly={p.gross * 12} />
        {p.structure.yearly.map((c) => (
          <Line key={c.name} label={c.name} sub={c.pay_month ? `Paid once a year, month ${c.pay_month}` : 'Paid once a year'} monthly={NA} yearly={<Money value={c.amount} />} />
        ))}

        <Section>Company contributions</Section>
        <Line
          label={`PF — company share${pct(rates?.pf?.employer_pct)}`}
          sub={p.pf.employer_total ? `Pension ₹${(p.pf.eps / 100).toLocaleString('en-IN')} + EPF ₹${(p.pf.employer_epf / 100).toLocaleString('en-IN')}` : 'PF is off'}
          monthly={p.pf.employer_total ? <Money value={p.pf.employer_total} /> : NA}
          yearly={p.pf.employer_total ? <Money value={p.pf.employer_total * 12} /> : NA}
        />
        <Line
          label={`ESI — company share${pct(rates?.esi?.employer_pct)}`}
          sub={esiNote}
          monthly={esiOn ? <Money value={p.esi.employer} /> : NA}
          yearly={esiOn ? <Money value={p.esi.employer * 12} /> : NA}
        />
        <Total label="Total company contributions" monthly={contributions} yearly={contributions * 12} />
        <Total label="Cost to company (CTC)" monthly={p.ctc.monthly_cost} yearly={p.ctc.annual_ctc} tone="ctc" />

        <Section>Deductions</Section>
        <Line
          label={`PF — employee share${pct(rates?.pf?.employee_pct)}`}
          sub={p.pf.employee ? `On a PF wage of ₹${(p.pf.pf_wage / 100).toLocaleString('en-IN')}` : 'PF is off'}
          monthly={p.pf.employee ? <Money value={p.pf.employee} /> : NA}
          yearly={p.pf.employee ? <Money value={p.pf.employee * 12} /> : NA}
        />
        {p.pf.vpf > 0 && <Line label="Voluntary PF" monthly={<Money value={p.pf.vpf} />} yearly={<Money value={p.pf.vpf * 12} />} />}
        <Line
          label={`ESI — employee share${pct(rates?.esi?.employee_pct)}`}
          sub={esiNote}
          monthly={esiOn ? <Money value={p.esi.employee} /> : NA}
          yearly={esiOn ? <Money value={p.esi.employee * 12} /> : NA}
        />
        <Line
          label="Professional tax"
          sub={p.pt.state ? `${p.pt.state}${p.pt_february.amount !== p.pt.amount ? `, February ₹${(p.pt_february.amount / 100).toLocaleString('en-IN')}` : ''}` : undefined}
          monthly={<Money value={p.pt.amount} />}
          yearly={<Money value={ptYear} />}
        />
        <Line label="Income tax (TDS)" monthly={<Money value={p.tds_monthly} />} yearly={<Money value={p.annual_tax} />} />
        <Total label="Total deductions" monthly={p.employee_statutory} yearly={deductionsYear} />
        <Total label="Net pay (take-home)" monthly={p.take_home} yearly={netYear} tone="net" />
      </tbody>
    </table>
  );
}
