import { describe, expect, it } from 'vitest';
import { dayName, LEAVE_TEMPLATES, monthDates, mulDiv } from '@ajpwer/shared';
import { assemblePayslip, closeYear, computeSettlement, creditMonth, leaveYearOf, nextLeaveState, occasionPaidDates, runEmployeeMonth } from '../../src/calculations/index.js';
import { ATTENDANCE, fullDay, HOLIDAY_PAID, payslipInput, punch, R, SHIFT_START, WEEKOFF_PAID, WEEKOFF_SANDWICH } from './fixtures.js';

const tpl = (code, patch = {}) => ({ ...LEAVE_TEMPLATES.find((t) => t.code === code), ...patch });
const PL = tpl('PL', { monthly_max: null });
const SL = tpl('SL');
const LOP = tpl('LOP');
const YEAR = leaveYearOf('2026-09', 4);

/** Leave context for September 2026, nothing taken yet this leave year. */
function ctx(patch = {}) {
  return {
    ym: '2026-09',
    year: YEAR,
    types: [PL, SL, LOP],
    opening: { PL: 0, SL: 0 },
    adjustments: {},
    earned_ytd: {},
    year_opening: {},
    ytd: {},
    grant_due: false,
    joined: '2025-01-01',
    last_day: null,
    close_year: false,
    upto: null,
    usable_from: {},
    ...patch,
  };
}

/** September 2026, Sundays off, a full day on every working day except those listed as absent. */
function month({ absent = [], half = [], leave = {}, policies = [ATTENDANCE, WEEKOFF_PAID, HOLIDAY_PAID], leaveCtx = ctx() } = {}) {
  const punches = {};
  for (const d of monthDates('2026-09')) {
    if (dayName(d) === 'SUN' || absent.includes(d)) continue;
    punches[d] = half.includes(d) ? [punch(d, '09:00', 'IN'), punch(d, '13:00', 'OUT')] : fullDay(d);
  }
  return runEmployeeMonth({
    ym: '2026-09',
    joined_on: '2025-01-01',
    last_day: null,
    weekly_off: ['SUN'],
    holidays: [],
    shift_start_min: SHIFT_START,
    policies,
    punches,
    leave,
    overrides: {},
    leave_ctx: leaveCtx,
  });
}
const day = (m, date) => m.days.find((d) => d.date === date);
const row = (m, code) => m.leave.types.find((t) => t.code === code);

describe('The leave year', () => {
  it('runs April to March: March 2027 belongs to the year that started in April 2026', () => {
    expect(leaveYearOf('2027-03', 4)).toEqual({ year: 2026, start: '2026-04', end: '2027-03' });
    expect(leaveYearOf('2026-04', 4).year).toBe(2026);
    expect(leaveYearOf('2026-03', 4).year).toBe(2025);
    expect(leaveYearOf('2026-03', 1)).toEqual({ year: 2026, start: '2026-01', end: '2026-12' });
  });
});

describe('What a leave type adds in a month', () => {
  it('earned monthly: the full amount, part of it in a part month, never past the yearly cap', () => {
    expect(creditMonth([PL], ctx()).PL).toBe(1.25);
    expect(creditMonth([PL], ctx({ joined: '2026-09-16' })).PL).toBe(0.63); // 15 of 30 days
    expect(creditMonth([PL], ctx({ earned_ytd: { PL: 14.5 } })).PL).toBe(0.5);
    expect(creditMonth([PL], ctx({ earned_ytd: { PL: 15 } })).PL).toBe(0);
  });

  it('given yearly: all of it when the year starts, part of it for a joiner, nothing in other months', () => {
    expect(creditMonth([SL], ctx({ grant_due: true })).SL).toBe(7);
    // Joined in October: October to March is six months, 3.5 days.
    expect(creditMonth([SL], ctx({ ym: '2026-10', joined: '2026-10-05', grant_due: true })).SL).toBe(3.5);
    expect(creditMonth([SL], ctx()).SL).toBeUndefined();
  });
});

describe('Absences nobody applied for are paid from paid leave', () => {
  it('up to the balance; the rest is loss of pay', () => {
    // 1.25 earned this month and 1 left over: 2.25 days, so two absences are paid and the third is not.
    const m = month({ absent: ['2026-09-08', '2026-09-09', '2026-09-10'], leaveCtx: ctx({ opening: { PL: 1 } }) });
    expect(day(m, '2026-09-08').status).toBe('ON_LEAVE');
    expect(day(m, '2026-09-08').flags).toContain('AUTO_LEAVE');
    expect(day(m, '2026-09-09').leave_type).toBe('PL');
    expect(day(m, '2026-09-10').status).toBe('ABSENT');
    expect(m.totals.auto_leave_days).toBe(2);
    expect(m.totals.lop_days).toBe(1);
    expect(row(m, 'PL')).toMatchObject({ opening: 1, earned: 1.25, auto: 2, closing: 0.25 });
  });

  it('never more than the monthly limit', () => {
    const m = month({ absent: ['2026-09-08', '2026-09-09', '2026-09-10'], leaveCtx: ctx({ types: [{ ...PL, monthly_max: 2 }, SL, LOP], opening: { PL: 10 } }) });
    expect(m.totals.auto_leave_days).toBe(2);
    expect(m.totals.lop_days).toBe(1);
    expect(row(m, 'PL').closing).toBe(9.25);
  });

  it('a half day takes half a day of paid leave and is paid in full', () => {
    const m = month({ half: ['2026-09-08'], leaveCtx: ctx({ opening: { PL: 2 } }) });
    expect(day(m, '2026-09-08').status).toBe('HALF_DAY');
    expect(day(m, '2026-09-08').day_value).toBe(1);
    expect(day(m, '2026-09-08').auto_leave).toBe(0.5);
    expect(m.totals.lop_days).toBe(0);
  });

  it('days not yet reached are left alone', () => {
    const m = month({ absent: ['2026-09-08', '2026-09-28'], leaveCtx: ctx({ opening: { PL: 5 }, upto: '2026-09-20' }) });
    expect(day(m, '2026-09-08').status).toBe('ON_LEAVE');
    expect(day(m, '2026-09-28').status).toBe('ABSENT');
  });

  it('a missing punch is not paid from leave: HR corrects it', () => {
    const missing = runEmployeeMonth({
      ym: '2026-09',
      joined_on: '2025-01-01',
      last_day: null,
      weekly_off: ['SUN'],
      holidays: [],
      shift_start_min: SHIFT_START,
      policies: [ATTENDANCE, WEEKOFF_PAID, HOLIDAY_PAID],
      punches: { '2026-09-08': [punch('2026-09-08', '09:00', 'IN')] },
      leave: {},
      overrides: {},
      leave_ctx: ctx({ opening: { PL: 5 } }),
    });
    expect(day(missing, '2026-09-08').status).toBe('MISSING_PUNCH');
    expect(day(missing, '2026-09-08').auto_leave).toBe(0);
  });

  it('an absence paid from leave does not trigger the sandwich rule', () => {
    const m = month({ absent: ['2026-09-12', '2026-09-14'], policies: [ATTENDANCE, WEEKOFF_SANDWICH, HOLIDAY_PAID], leaveCtx: ctx({ opening: { PL: 5 } }) });
    expect(m.totals.sandwiched).toEqual([]);
    expect(m.totals.lop_days).toBe(0);
  });

  it('not before the months of service it needs', () => {
    const m = month({ absent: ['2026-09-08'], leaveCtx: ctx({ opening: { PL: 5 }, usable_from: { PL: '2026-10-01' } }) });
    expect(day(m, '2026-09-08').status).toBe('ABSENT');
  });
});

describe('Leave HR records is paid from its own balance', () => {
  const sick = (d) => ({ leave_type: 'SL', paid: true, portion: 1, request_id: 'r1' });

  it('sick leave uses sick leave, not paid leave', () => {
    const m = month({ leave: { '2026-09-08': sick(), '2026-09-09': sick() }, leaveCtx: ctx({ opening: { PL: 5, SL: 7 } }) });
    expect(row(m, 'SL')).toMatchObject({ used: 2, closing: 7 - 2 });
    expect(row(m, 'PL').closing).toBe(6.25);
    expect(m.totals.lop_days).toBe(0);
  });

  it('when its balance runs out, the day falls to paid leave and is flagged', () => {
    const m = month({ leave: { '2026-09-08': sick(), '2026-09-09': sick() }, leaveCtx: ctx({ opening: { PL: 5, SL: 1 } }) });
    expect(row(m, 'SL')).toMatchObject({ used: 1, unpaid: 1, closing: 0 });
    expect(day(m, '2026-09-09').flags).toEqual(expect.arrayContaining(['LEAVE_UNPAID', 'AUTO_LEAVE']));
    expect(row(m, 'PL').auto).toBe(1);
    expect(m.totals.lop_days).toBe(0);
  });

  it('unpaid leave stays unpaid: paid leave is not used for it', () => {
    const m = month({ leave: { '2026-09-08': { leave_type: 'LOP', paid: false, portion: 1, request_id: 'r2' } }, leaveCtx: ctx({ opening: { PL: 5 } }) });
    expect(day(m, '2026-09-08').status).toBe('ON_LEAVE');
    expect(day(m, '2026-09-08').day_value).toBe(0);
    expect(row(m, 'PL').auto).toBe(0);
    expect(m.totals.lop_days).toBe(1);
  });

  it('per occasion: only the days the occasion allows are paid', () => {
    const working = (d) => dayName(d) !== 'SUN';
    const paidDates = occasionPaidDates('2026-09-07', '2026-09-12', 3, working);
    expect([...paidDates]).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
    const leave = {};
    for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
      leave[d] = { leave_type: 'BRV', paid: true, portion: 1, request_id: 'r3', occasion_paid: paidDates.has(d) };
    }
    const m = month({ leave, leaveCtx: ctx({ types: [PL, tpl('BRV'), LOP], opening: { PL: 0 } }) });
    expect(row(m, 'BRV').used).toBe(3);
    // The other three days fall to paid leave: 1.25 earned pays one of them.
    expect(row(m, 'PL').auto).toBe(1);
    expect(m.totals.lop_days).toBe(2);
  });
});

describe('The end of the leave year', () => {
  it('carry forward up to the limit; the rest is paid out or lapses, as set', () => {
    expect(closeYear([PL], { PL: 34.5 }).PL).toEqual({ carried: 30, encashed: 4.5, lapsed: 0 });
    expect(closeYear([{ ...PL, carry_excess: 'LAPSE' }], { PL: 34.5 }).PL).toEqual({ carried: 30, encashed: 0, lapsed: 4.5 });
    expect(closeYear([{ ...PL, year_end: 'ENCASH' }], { PL: 12 }).PL).toEqual({ carried: 0, encashed: 12, lapsed: 0 });
    expect(closeYear([SL], { SL: 3 }).SL).toEqual({ carried: 0, encashed: 0, lapsed: 3 });
  });

  it("March's month closes the year; what is carried opens the next one", () => {
    const m = runEmployeeMonth({
      ym: '2027-03',
      joined_on: '2025-01-01',
      last_day: null,
      weekly_off: ['SUN'],
      holidays: [],
      shift_start_min: SHIFT_START,
      policies: [ATTENDANCE, WEEKOFF_PAID, HOLIDAY_PAID],
      punches: Object.fromEntries(monthDates('2027-03').filter((d) => dayName(d) !== 'SUN').map((d) => [d, fullDay(d)])),
      leave: {},
      overrides: {},
      leave_ctx: ctx({ ym: '2027-03', year: leaveYearOf('2027-03', 4), opening: { PL: 33.25, SL: 2 }, earned_ytd: { PL: 13.75 }, close_year: true }),
    });
    expect(row(m, 'PL')).toMatchObject({ closing: 34.5, carried: 30, encashed: 4.5 });
    expect(row(m, 'SL')).toMatchObject({ closing: 2, lapsed: 2 });
    expect(nextLeaveState(m.leave).opening.PL).toBe(34.5);
  });

  it('leave paid out is a taxable payslip line on the monthly wages it names', () => {
    const p = assemblePayslip(payslipInput({ leave_encashment: [{ code: 'PL', name: 'Paid leave', days: 4.5, base: 'GROSS', divisor: 26 }] }));
    const line = p.lines.find((l) => l.kind === 'LEAVE');
    expect(line.amount).toBe(mulDiv(R(24000), 450, 2600));
    expect(line.name).toBe('Leave encashment — Paid leave, 4.5 days');
    expect(p.gross).toBe(R(24000) + line.amount);
    expect(p.statutory_gross).toBe(R(24000)); // not wages for ESI or PT
  });
});

describe('Leave left on exit', () => {
  it('is paid in the settlement for each type that pays out on exit', () => {
    const s = computeSettlement({
      employee: { joined_on: '2024-01-01', last_day: '2026-09-15', notice_days: 30, notice_served_days: 30, has_bank_account: true },
      monthly_gross: R(26000),
      gratuity_rules: null,
      gratuity_wages: 0,
      final_month: null,
      final_month_attendance_submitted: true,
      pending_reimbursements: 0,
      loans_outstanding: [],
      advances_outstanding: [],
      leave_payout: [{ code: 'PL', name: 'Paid leave', days: 6.5, wages: R(26000), base: 'GROSS', divisor: 26 }],
    });
    const line = s.earnings.find((l) => l.code === 'LEAVE_ENCASH:PL');
    expect(line.amount).toBe(R(6500));
    expect(line.detail).toBe('6.5 days × gross ÷ 26');
  });
});
