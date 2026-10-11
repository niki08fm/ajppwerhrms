import { describe, expect, it } from 'vitest';
import { structureCreateSchema } from '@ajpwer/shared';
import { assemblePayslip } from '../../src/calculations/index.js';
import { fullMonthTotals, OVERTIME, payslipInput, R, STANDARD_STRUCTURE } from './fixtures.js';

const selected = STANDARD_STRUCTURE.map((c) => ({ ...c, counts_as_esi_wages: ['Basic', 'HRA'].includes(c.name) }));
const covered = { ...payslipInput().statutory, esi_applicable: true };
const amount = (result, code) => result.lines.find((line) => line.code === code)?.amount ?? 0;

describe('Selected ESI wages in payslips', () => {
  it('deducts on selected monthly earnings and keeps PF, PT and gross independent', () => {
    const result = assemblePayslip(payslipInput({ components: selected, statutory: covered }));
    expect(result.gross).toBe(R(24000));
    expect(result.statutory_gross).toBe(R(24000));
    expect(result.esi_wage).toBe(R(16800));
    expect(amount(result, 'ESI')).toBe(R(126));
    expect(amount(result, 'ER_ESI')).toBe(R(546));
    expect(amount(result, 'PF')).toBe(R(1440));
    expect(amount(result, 'PT')).toBe(R(200));
    expect(result.gross - result.total_deductions + result.reimbursements).toBe(result.net);
  });

  it('reduces selected earnings for LOP and includes OT and off-day pay', () => {
    const result = assemblePayslip(payslipInput({
      components: selected, statutory: covered, divisor: 30,
      attendance: fullMonthTotals('2026-09', 30, { paid_days: 24, lop_days: 6, ot_min: 60 }),
      overtime_rules: OVERTIME.rules,
      offday_work: [{ date: '2026-09-06', kind: 'WEEKLY_OFF', rate_pct: 200, base: 'GROSS', day_paid: true }],
    }));
    expect(amount(result, 'OT')).toBe(R(140));
    expect(amount(result, 'OFFDAY')).toBe(R(800));
    expect(result.statutory_gross).toBe(R(20140));
    expect(result.esi_wage).toBe(R(14380));
    expect(amount(result, 'ESI')).toBe(R(108));
    expect(amount(result, 'ER_ESI')).toBe(R(468));
    expect(amount(result, 'PT')).toBe(R(200));
  });

  it('preserves legacy wages and excludes yearly and adhoc payouts', () => {
    const result = assemblePayslip(payslipInput({
      statutory: covered,
      components: [...STANDARD_STRUCTURE, { seq: 5, name: 'Annual bonus', calc_type: 'FIXED', calc_value: R(12000), frequency: 'YEARLY', pay_month: 9, is_taxable: true, counts_as_wages: false, counts_as_esi_wages: true }],
      adhoc: [{ id: 'bonus', kind: 'EARNING', name: 'Bonus', amount: R(5000), is_taxable: true }],
    }));
    expect(result.gross).toBe(R(41000));
    expect(result.esi_wage).toBe(result.statutory_gross);
    expect(result.esi_wage).toBe(R(24000));
    expect(amount(result, 'ESI')).toBe(R(180));
    expect(amount(result, 'ER_ESI')).toBe(R(780));
  });

  it('keeps contribution-period coverage above the ceiling and employee opt-out', () => {
    const input = payslipInput({ monthly_gross: R(40000), components: selected, statutory: covered });
    const coveredResult = assemblePayslip(input);
    expect(coveredResult.esi_wage).toBe(R(28000));
    expect(amount(coveredResult, 'ESI')).toBe(R(210));
    const off = assemblePayslip({ ...input, statutory: { ...covered, esi_applicable: false } });
    expect(off.esi_wage).toBe(R(28000));
    expect(amount(off, 'ESI')).toBe(0);
    expect(amount(off, 'ER_ESI')).toBe(0);
  });

  it('does not create contributions when every monthly component is excluded', () => {
    const result = assemblePayslip(payslipInput({ components: selected.map((c) => ({ ...c, counts_as_esi_wages: false })), statutory: covered }));
    expect(result.gross).toBe(R(24000));
    expect(result.esi_wage).toBe(0);
    expect(amount(result, 'ESI')).toBe(0);
    expect(amount(result, 'ER_ESI')).toBe(0);
  });
});

describe('ESI component schema compatibility', () => {
  it('defaults legacy monthly rows and the inserted Special Allowance to included', () => {
    const structure = structureCreateSchema.parse({ name: 'Legacy', components: STANDARD_STRUCTURE.slice(0, 3) });
    expect(structure.components.every((c) => c.counts_as_esi_wages)).toBe(true);
    expect(structure.components.at(-1).name).toBe('Special Allowance');
  });

  it('retains monthly choices and excludes yearly earnings', () => {
    const structure = structureCreateSchema.parse({ name: 'Selected', components: [
      ...selected,
      { seq: 5, name: 'Annual bonus', calc_type: 'FIXED', calc_value: R(12000), frequency: 'YEARLY', pay_month: 9, is_taxable: true, counts_as_wages: false, counts_as_esi_wages: true },
    ] });
    expect(structure.components.find((c) => c.name === 'HRA').counts_as_esi_wages).toBe(true);
    expect(structure.components.find((c) => c.name === 'Conveyance').counts_as_esi_wages).toBe(false);
    expect(structure.components.at(-1).counts_as_esi_wages).toBe(false);
  });
});
