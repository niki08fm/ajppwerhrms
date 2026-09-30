import { describe, expect, it } from 'vitest';
import { computeGratuity, computeSettlement, type SettlementInput } from '../../src/engines';
import { mulDiv } from '@ajpwer/shared';
import { R, RATES } from './fixtures';

const base: SettlementInput = {
  employee: { joined_on: '2020-01-01', last_day: '2026-09-15', notice_days: 30, notice_served_days: 30, has_bank_account: true },
  monthly_gross: R(30000),
  last_basic: R(15000),
  final_month: { gross: R(15000), reimbursements: 0, statutory: R(1800), statutory_lines: [{ code: 'PF', name: 'Provident fund', amount: R(1800) }] },
  final_month_attendance_submitted: true,
  encashable_leave_days: 10,
  pending_reimbursements: 0,
  loans_outstanding: [],
  advances_outstanding: [],
  gratuity_rates: RATES.gratuity,
};

describe('§20.32 Gratuity threshold', () => {
  it('4.9 years: no gratuity, but a warning', () => {
    const g = computeGratuity('2021-10-20', '2026-09-15', R(20000), RATES.gratuity);
    expect(g.service_years_decimal).toBeCloseTo(4.9, 1);
    expect(g.eligible).toBe(false);
    expect(g.amount).toBe(0);
    expect(g.warning).toMatch(/threshold/);
  });

  it('5.1 years: basic × 15 × 5 ÷ 26', () => {
    const g = computeGratuity('2021-08-01', '2026-09-08', R(20000), RATES.gratuity);
    expect(g.eligible).toBe(true);
    expect(g.completed_years).toBe(5);
    expect(g.amount).toBe(mulDiv(R(20000), 15 * 5, 26));
  });

  it('a part-year over six months counts as a full year', () => {
    const g = computeGratuity('2019-01-01', '2026-08-15', R(20000), RATES.gratuity); // 7 years 7 months
    expect(g.completed_years).toBe(8);
  });
});

describe('§20.33 Negative settlement', () => {
  it('shows as recoverable, never as a negative payable', () => {
    const s = computeSettlement({
      ...base,
      employee: { ...base.employee, notice_served_days: 0 },
      loans_outstanding: [{ id: 'L1', label: 'Personal loan', amount: R(90000) }],
    });
    expect(s.net).toBeLessThan(0);
    expect(s.recoverable).toBe(-s.net);
    expect(s.payable).toBe(0);
    expect(s.clearance.find((c) => c.code === 'NEGATIVE_NET')?.severity).toBe('WARNING');
  });
});

describe('Settlement lines and gates', () => {
  it('leave encashment at gross ÷ 26 and notice shortfall at gross ÷ 30', () => {
    const s = computeSettlement({ ...base, employee: { ...base.employee, notice_served_days: 20 } });
    expect(s.earnings.find((l) => l.code === 'LEAVE_ENCASH')!.amount).toBe(mulDiv(R(30000), 10, 26));
    expect(s.deductions.find((l) => l.code === 'NOTICE_SHORTFALL')!.amount).toBe(R(10000));
  });

  it('no bank account and unsubmitted attendance block payment', () => {
    const s = computeSettlement({ ...base, employee: { ...base.employee, has_bank_account: false }, final_month_attendance_submitted: false });
    expect(s.can_pay).toBe(false);
    expect(s.clearance.filter((c) => c.severity === 'BLOCKING').map((c) => c.code).sort()).toEqual(['ATTENDANCE_NOT_SUBMITTED', 'NO_BANK']);
  });

  it('loans are recovered in full at settlement — no cap', () => {
    const s = computeSettlement({ ...base, loans_outstanding: [{ id: 'L', label: 'Loan', amount: R(40000) }] });
    expect(s.deductions.find((d) => d.code === 'LOAN:L')!.amount).toBe(R(40000));
  });
});
