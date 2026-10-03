import { describe, expect, it } from 'vitest';
import { computeGratuity, computeSettlement } from '../../src/calculations/index.js';
import { gratuityRulesSchema, mulDiv } from '@ajpwer/shared';
import { GRATUITY_RULES, R } from './fixtures.js';

const base = {
  employee: { joined_on: '2020-01-01', last_day: '2026-09-15', has_bank_account: true },
  monthly_gross: R(30000),
  gratuity_rules: GRATUITY_RULES,
  gratuity_wages: R(15000),
  final_month: { gross: R(15000), reimbursements: 0, statutory: R(1800), statutory_lines: [{ code: 'PF', name: 'Provident fund', amount: R(1800) }] },
  final_month_attendance_submitted: true,
  leave_payout: [{ code: 'PL', name: 'Paid leave', days: 10, wages: R(30000), base: 'GROSS', divisor: 26 }],
  pending_reimbursements: 0,
  loans_outstanding: [],
  advances_outstanding: [],
};

describe('§20.32 Gratuity threshold', () => {
  it('4.9 years: no gratuity, but a warning', () => {
    const g = computeGratuity('2021-10-20', '2026-09-15', R(20000), GRATUITY_RULES);
    expect(g.service_years_decimal).toBeCloseTo(4.9, 1);
    expect(g.eligible).toBe(false);
    expect(g.amount).toBe(0);
    expect(g.warning).toMatch(/threshold/);
  });

  it('5.1 years: basic × 15 × 5 ÷ 26', () => {
    const g = computeGratuity('2021-08-01', '2026-09-08', R(20000), GRATUITY_RULES);
    expect(g.eligible).toBe(true);
    expect(g.completed_years).toBe(5);
    expect(g.amount).toBe(mulDiv(R(20000), 15 * 5, 26));
  });

  it('a part-year over six months counts as a full year', () => {
    const g = computeGratuity('2019-01-01', '2026-08-15', R(20000), GRATUITY_RULES); // 7 years 7 months
    expect(g.completed_years).toBe(8);
  });
});

describe("Gratuity follows the pay group's own policy", () => {
  // 7 years 7 months of service.
  const seven = (rules) => computeGratuity('2019-01-01', '2026-08-15', R(20000), { ...GRATUITY_RULES, ...rules });

  it('completed years only, or pro rata', () => {
    expect(seven({ part_year: 'COMPLETED_YEARS' }).amount).toBe(mulDiv(R(20000), 15 * 7, 26));
    const p = seven({ part_year: 'PRO_RATA' });
    expect(p.completed_years).toBeCloseTo(7.62, 2);
    expect(p.amount).toBe(mulDiv(R(20000), 15 * Math.round(p.completed_years * 100), 26 * 100));
  });

  it('its own days, divisor and qualifying service', () => {
    expect(seven({ days_per_year: 30, divisor: 30 }).amount).toBe(R(20000) * 8);
    expect(computeGratuity('2023-01-01', '2026-08-15', R(20000), { ...GRATUITY_RULES, min_years: 3, flag_from_years: 2.5 }).eligible).toBe(true);
  });

  it('the ceiling caps it and says so', () => {
    const g = seven({ max_amount: R(50000) });
    expect(g.amount).toBe(R(50000));
    expect(g.capped).toBe(true);
    const s = computeSettlement({ ...base, gratuity_rules: { ...GRATUITY_RULES, max_amount: R(50000) } });
    expect(s.earnings.find((l) => l.code === 'GRATUITY').detail).toMatch(/capped at ₹50,000/);
  });

  it('the settlement line names the wages it was worked out on', () => {
    const s = computeSettlement({ ...base, gratuity_rules: { ...GRATUITY_RULES, base: 'GROSS' }, gratuity_wages: R(30000) });
    const line = s.earnings.find((l) => l.code === 'GRATUITY');
    expect(line.amount).toBe(mulDiv(R(30000), 15 * 7, 26)); // 6 years 8 months 14 days → 7
    expect(line.detail).toBe('Last gross × 15 × 7 ÷ 26');
  });

  it('no gratuity policy: no gratuity line, and clearance says why', () => {
    const s = computeSettlement({ ...base, gratuity_rules: null });
    expect(s.earnings.find((l) => l.code === 'GRATUITY')).toBeUndefined();
    expect(s.gratuity).toBeNull();
    expect(s.clearance.find((c) => c.code === 'NO_GRATUITY_POLICY')?.severity).toBe('WARNING');
    expect(s.service).toEqual({ years: 6, months: 8, days: 14 });
  });

  it('rules are checked: the warning cannot start after qualifying', () => {
    expect(gratuityRulesSchema.safeParse(GRATUITY_RULES).success).toBe(true);
    expect(gratuityRulesSchema.safeParse({ ...GRATUITY_RULES, flag_from_years: 6 }).success).toBe(false);
  });
});

describe('§20.33 Negative settlement', () => {
  it('shows as recoverable, never as a negative payable', () => {
    const s = computeSettlement({ ...base, loans_outstanding: [{ id: 'L1', label: 'Personal loan', amount: R(90000) }] });
    expect(s.net).toBeLessThan(0);
    expect(s.recoverable).toBe(-s.net);
    expect(s.payable).toBe(0);
    expect(s.clearance.find((c) => c.code === 'NEGATIVE_NET')?.severity).toBe('WARNING');
  });
});

describe('Settlement lines and gates', () => {
  it('leave encashment at gross ÷ 26; there is no notice line', () => {
    const s = computeSettlement(base);
    expect(s.earnings.find((l) => l.code === 'LEAVE_ENCASH:PL').amount).toBe(mulDiv(R(30000), 10, 26));
    expect([...s.earnings, ...s.deductions].some((l) => l.code.startsWith('NOTICE'))).toBe(false);
  });

  it('no bank account and unsubmitted attendance block payment', () => {
    const s = computeSettlement({ ...base, employee: { ...base.employee, has_bank_account: false }, final_month_attendance_submitted: false });
    expect(s.can_pay).toBe(false);
    expect(
      s.clearance
        .filter((c) => c.severity === 'BLOCKING')
        .map((c) => c.code)
        .sort(),
    ).toEqual(['ATTENDANCE_NOT_SUBMITTED', 'NO_BANK']);
  });

  it('paid separately, a missing bank account only warns: it never reaches a bank file', () => {
    const s = computeSettlement({ ...base, employee: { ...base.employee, has_bank_account: false }, paid_separately: true });
    expect(s.clearance.find((c) => c.code === 'NO_BANK').severity).toBe('WARNING');
    expect(s.can_pay).toBe(true);
  });

  it('loans are recovered in full at settlement — no cap', () => {
    const s = computeSettlement({ ...base, loans_outstanding: [{ id: 'L', label: 'Loan', amount: R(40000) }] });
    expect(s.deductions.find((d) => d.code === 'LOAN:L').amount).toBe(R(40000));
  });
});

describe('No exit policy, no notice period', () => {
  it('every kind of exit is settled alike: nothing is recovered or paid for notice', () => {
    for (const reason of ['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'ABSCONDING']) {
      const s = computeSettlement({ ...base, exit_reason: reason });
      expect([...s.earnings, ...s.deductions].some((l) => l.code.startsWith('NOTICE'))).toBe(false);
      expect(s.net).toBe(computeSettlement(base).net);
    }
  });

  it('leave left is paid on any exit, as the leave policy says', () => {
    const gone = computeSettlement({ ...base, exit_reason: 'ABSCONDING' });
    expect(gone.earnings.find((l) => l.code === 'LEAVE_ENCASH:PL').amount).toBe(mulDiv(R(30000), 10, 26));
    expect(gone.can_pay).toBe(true);
  });

  it('death pays gratuity whatever the service (Payment of Gratuity Act)', () => {
    const young = { ...base.employee, joined_on: '2023-01-01' }; // 3 years 8 months
    expect(computeSettlement({ ...base, employee: young, exit_reason: 'RESIGNATION' }).earnings.find((l) => l.code === 'GRATUITY')).toBeUndefined();
    const death = computeSettlement({ ...base, employee: young, exit_reason: 'DEATH' });
    expect(death.earnings.find((l) => l.code === 'GRATUITY')).toMatchObject({ amount: mulDiv(R(15000), 15 * 4, 26), detail: expect.stringMatching(/on death/) });
  });

  it('salary held and not yet paid is paid with the F&F, and HR can switch it off', () => {
    const held = [{ id: 'h1', period_ym: '2026-08', amount: R(28000), reason: 'Documents pending' }];
    const s = computeSettlement({ ...base, held_pay: held });
    expect(s.earnings.find((l) => l.code === 'HELD:2026-08')).toMatchObject({ name: 'Held salary for August 2026', amount: R(28000), switchable: true });
    expect(s.net).toBe(computeSettlement(base).net + R(28000));
    const off = computeSettlement({ ...base, held_pay: held, adjustments: { excluded: { 'HELD:2026-08': { reason: 'Forfeited on absconding' } } } });
    expect(off.net).toBe(computeSettlement(base).net);
  });

  it('an unfinished exit checklist blocks payment', () => {
    const s = computeSettlement({ ...base, checklist_open: [{ code: 'ASSETS', label: 'Tools, safety gear and ID card returned' }] });
    expect(s.clearance.find((c) => c.code === 'EXIT_CHECKLIST')).toMatchObject({ severity: 'BLOCKING' });
    expect(s.can_pay).toBe(false);
  });
});

describe("HR's changes to a settlement", () => {
  it('a line switched off stays on the statement, struck out, and counts for nothing', () => {
    const before = computeSettlement(base);
    const after = computeSettlement({ ...base, adjustments: { excluded: { 'LEAVE_ENCASH:PL': { reason: 'Leave already paid out in March' } } } });
    expect(after.earnings.find((l) => l.code === 'LEAVE_ENCASH:PL')).toMatchObject({ excluded: true, excluded_reason: 'Leave already paid out in March' });
    expect(after.net).toBe(before.net - mulDiv(R(30000), 10, 26));
  });

  it('the final salary and statutory deductions cannot be switched off', () => {
    const s = computeSettlement({ ...base, adjustments: { excluded: { FINAL_SALARY: { reason: 'x' }, PF: { reason: 'x' } } } });
    expect(s.earnings.find((l) => l.code === 'FINAL_SALARY').excluded).toBeUndefined();
    expect(s.deductions.find((l) => l.code === 'PF').excluded).toBeUndefined();
  });

  it('leave lines can be given other days', () => {
    const s = computeSettlement({ ...base, adjustments: { days: { 'LEAVE_ENCASH:PL': { days: 3, reason: 'Two days were taken off the record' } } } });
    expect(s.earnings.find((l) => l.code === 'LEAVE_ENCASH:PL')).toMatchObject({ days: 3, computed_days: 10, amount: mulDiv(R(30000), 3, 26) });
  });

  it("HR's own earnings and deductions are added with their reasons", () => {
    const s = computeSettlement({
      ...base,
      adjustments: {
        extra: [
          { id: 'a1', kind: 'EARNING', name: 'Project completion bonus', amount: R(5000), reason: 'Promised in the March review' },
          { id: 'a2', kind: 'DEDUCTION', name: 'Damaged multimeter', amount: R(1200), reason: 'Signed off by stores' },
        ],
      },
    });
    expect(s.earnings.find((l) => l.code === 'ADJ:a1')).toMatchObject({ amount: R(5000), detail: 'Promised in the March review', added: true });
    expect(s.net).toBe(computeSettlement(base).net + R(5000) - R(1200));
  });
});
