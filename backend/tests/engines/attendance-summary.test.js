import { describe, expect, it } from 'vitest';
import { computeDay, computeMonth, resolvePolicies } from '../../src/calculations/index.js';
import { attendanceSummary, hasMissingPunch, shiftShortfall } from '../../src/services/attendance-summary.service.js';
import { NINE_HOUR_DAY, policy, punch, WEEKOFF_PAID } from './fixtures.js';

const makeDay = (date, worked, patch = {}) => computeDay({
  date, joined_on: '2025-01-01', last_day: null, is_holiday: false, is_weekly_off: false, leave: null,
  punches: worked === null ? [] : [punch(date, '09:00', 'IN'), { ...punch(date, '18:00', 'OUT'), at: punch(date, '09:00', 'IN').at + worked * 60_000 }],
  policies: resolvePolicies([NINE_HOUR_DAY, WEEKOFF_PAID], date), shift_start_min: 540, shift_end_min: 1080,
  ...patch,
});
const pass = (days, overrides = {}, patch = {}) => computeMonth({ ym: '2026-09', days, overrides,
  policiesByDate: Object.fromEntries(days.map((d) => [d.date, { weekoff_pay: { paid: true, sandwich: false } }])), ...patch });

describe('Attendance shift shortfall reporting', () => {
  it('adds 8h40 and 8h45 as 35 minutes of shortfall without changing paid-day tolerance', () => {
    const days = [makeDay('2026-09-01', 520), makeDay('2026-09-02', 525)];
    expect(days.map((d) => d.shift_shortfall_min)).toEqual([20, 15]);
    expect(days.map((d) => d.status)).toEqual(['PRESENT', 'PRESENT']);
    const m = pass(days);
    expect(m.totals.paid_days).toBe(2);
    expect(m.attendance_summary).toMatchObject({ present_days: 2, absent_days: 0, late_minutes: 35, shift_shortfall_min: 35, lop_days: 0 });
  });

  it('uses the attendance policy on each date and does not substitute arrival delay', () => {
    const changed = policy('ATTENDANCE', { standard_min: 480, half_day_min: 240, grace_min: 15 });
    const eight = makeDay('2026-09-02', 475, { policies: resolvePolicies([changed], '2026-09-02') });
    expect(eight.required_shift_min).toBe(480);
    expect(eight.shift_shortfall_min).toBe(5);
    const lateFull = makeDay('2026-09-03', 540, {
      punches: [punch('2026-09-03', '09:40', 'IN'), punch('2026-09-03', '18:40', 'OUT')],
    });
    expect(lateFull.late_min).toBe(40);
    expect(lateFull.shift_shortfall_min).toBe(0);
  });

  it('excludes absence, full leave, off days and unsettled missing punches from shortfall', () => {
    const missing = makeDay('2026-09-02', 520, { punches: [punch('2026-09-02', '09:00', 'IN')] });
    const days = [makeDay('2026-09-01', null), missing,
      makeDay('2026-09-03', null, { leave: { leave_type: 'PL', paid: true, portion: 1 } }),
      makeDay('2026-09-06', 30, { is_weekly_off: true }),
    ];
    expect(days.map(shiftShortfall)).toEqual([0, 0, 0, 0]);
    expect(hasMissingPunch(missing)).toBe(true);
    expect(attendanceSummary(days).missing_punch).toBe(1);
    expect(shiftShortfall({ ...makeDay('2026-09-04', 30), flags: ['AUTO_OUT'] })).toBe(0);
  });

  it('recomputes corrected times while retaining the original missing-punch audit flags', () => {
    const missing = makeDay('2026-09-02', null, { punches: [punch('2026-09-02', '09:00', 'IN')] });
    const corrected = pass([missing], { '2026-09-02': { status: 'PRESENT', day_value: 1, worked_min: 525,
      in_min: 540, out_min: 1065, late_min: 0, ot_min: 0 } });
    expect(corrected.days[0].flags).toContain('UNMATCHED_IN');
    expect(corrected.days[0]).toMatchObject({ required_shift_min: 540, shift_shortfall_min: 15, overridden: true });
    expect(corrected.attendance_summary).toMatchObject({ missing_punch: 0, late_minutes: 15, corrected: 1 });
  });

  it('requires only the non-leave half of an approved half-day leave', () => {
    const d = makeDay('2026-09-01', 260, { leave: { leave_type: 'PL', paid: true, portion: 0.5 } });
    expect(d.required_shift_min).toBe(270);
    expect(d.shift_shortfall_min).toBe(10);
  });

  it('keeps physical absence totals before leave covers them and uses settled LOP', () => {
    const days = [
      { ...makeDay('2026-09-01', 540), baseline_status: 'PRESENT', work_day_value: 1 },
      { ...makeDay('2026-09-02', null), baseline_status: 'ABSENT', work_day_value: 0, status: 'ON_LEAVE', day_value: 1, leave_days: 1, auto_leave: 1 },
      { ...makeDay('2026-09-03', null, { leave: { leave_type: 'PL', paid: true, portion: 1 } }), baseline_status: 'ON_LEAVE', work_day_value: 0, leave_days: 1 },
      { ...makeDay('2026-09-04', null, { leave: { leave_type: 'LOP', paid: false, portion: 1 } }), baseline_status: 'ON_LEAVE', work_day_value: 0 },
      makeDay('2026-09-06', null, { is_weekly_off: true }),
    ];
    expect(attendanceSummary(days)).toMatchObject({ days: 5, working_days: 4, present_days: 1, absent_days: 3,
      paid_leave_days: 1, auto_leave_days: 1, unpaid_leave_days: 1, paid_days: 4, lop_days: 1 });
  });

  it('excludes future dates and dates outside employment, including their LOP', () => {
    const days = [makeDay('2026-09-01', null, { joined_on: '2026-09-02' }), makeDay('2026-09-02', 540),
      makeDay('2026-09-03', null), makeDay('2026-09-04', null), makeDay('2026-09-05', null, { last_day: '2026-09-04' })];
    expect(attendanceSummary(days, { today: '2026-09-03' })).toMatchObject({ as_of: '2026-09-03', days: 2,
      working_days: 2, present_days: 1, absent_days: 1, lop_days: 1 });
    expect(attendanceSummary(days, { today: '2026-08-31' })).toMatchObject({ days: 0, paid_days: 0, lop_days: 0 });
  });

  it('includes a sandwiched unpaid off day in final LOP without calling it a working absence', () => {
    const days = [makeDay('2026-09-05', null), { ...makeDay('2026-09-06', null, { is_weekly_off: true }), day_value: 0,
      flags: ['SANDWICHED'] }, makeDay('2026-09-07', null)];
    expect(attendanceSummary(days)).toMatchObject({ working_days: 2, absent_days: 2, lop_days: 3 });
  });

  it('does not replace worked half-day equivalents with the automatically paid balance', () => {
    const half = { ...makeDay('2026-09-01', 200), baseline_status: 'HALF_DAY', work_day_value: 0.5,
      day_value: 1, leave_days: 0.5, auto_leave: 0.5 };
    expect(attendanceSummary([half])).toMatchObject({ present_days: 0.5, absent_days: 0.5, auto_leave_days: 0.5,
      paid_days: 1, lop_days: 0 });
  });
});
