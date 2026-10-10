import { describe, expect, it } from 'vitest';
import { computeDay, resolvePolicies, siteOvertimeMinutes } from '../../src/calculations/index.js';
import { ATTENDANCE, NINE_HOUR_DAY, OVERTIME, policy, punch } from './fixtures.js';

const DATE = '2026-10-10';
const interval = (site, from, to) => [punch(DATE, from, 'IN', site), punch(DATE, to, 'OUT', site)];
function calculate(punches, { attendance = ATTENDANCE, overtime = { ...OVERTIME.rules, counts_from: 'STANDARD_DAY' }, ...extra } = {}) {
  const input = { date: DATE, joined_on: '2025-01-01', last_day: null, is_holiday: false, is_weekly_off: false,
    punches, policies: resolvePolicies([attendance, ...(overtime ? [policy('OVERTIME', overtime)] : [])], DATE),
    shift_start_min: 540, shift_end_min: 1050, shift_break_min: 30, ...extra };
  const day = computeDay(input);
  const bySite = siteOvertimeMinutes(day, input);
  expect([...bySite.values()].reduce((sum, minutes) => sum + minutes, 0)).toBe(day.ot_min);
  return { day, bySite: Object.fromEntries(bySite) };
}

describe('Recorded overtime attributed to the site where its interval occurred', () => {
  it('fills the standard day across sites and assigns the remaining OT only to the later site', () => {
    expect(calculate([...interval('alpha', '09:00', '17:00'), ...interval('beta', '17:00', '19:00')]).bySite).toEqual({ beta: 120 });
  });
  it('rounds once across site intervals, retaining chronological eligible minutes', () => {
    const r = calculate([...interval('alpha', '09:00', '17:25'), ...interval('beta', '17:25', '17:50')]);
    expect(r.day.ot_min).toBe(30);
    expect(r.bySite).toEqual({ alpha: 25, beta: 5 });
  });
  it('applies the minimum OT threshold once to the combined day', () => {
    expect(calculate(interval('alpha', '09:00', '17:29')).bySite).toEqual({});
    expect(calculate([...interval('alpha', '09:00', '17:15'), ...interval('beta', '17:15', '17:30')]).bySite).toEqual({ alpha: 15, beta: 15 });
  });
  it('uses SHIFT_END and assigns only time past the shift end', () => {
    const r = calculate([...interval('alpha', '09:00', '17:00'), ...interval('beta', '17:00', '19:00')], {
      overtime: { ...OVERTIME.rules, counts_from: 'SHIFT_END', after_min: 0, rounding_min: 1 } });
    expect(r.bySite).toEqual({ beta: 90 });
  });
  it('uses full-day eligibility plus break allowance before assigning later SHIFT_END intervals', () => {
    const r = calculate([...interval('alpha', '09:00', '13:00'), ...interval('beta', '15:00', '18:00'),
      ...interval('alpha', '18:00', '19:00'), ...interval('beta', '19:00', '19:30')], {
      attendance: NINE_HOUR_DAY, shift_end_min: 1080, shift_break_min: 60,
      overtime: { ...OVERTIME.rules, counts_from: 'SHIFT_END', after_min: 0, rounding_min: 1 } });
    expect(r.day.ot_min).toBe(30);
    expect(r.bySite).toEqual({ beta: 30 });
  });
  it('credits grace minutes for on-time arrival under SHIFT_END', () => {
    const r = calculate(interval('alpha', '09:15', '19:00'), { attendance: NINE_HOUR_DAY, shift_end_min: 1080,
      overtime: { ...OVERTIME.rules, counts_from: 'SHIFT_END', after_min: 0, rounding_min: 1 } });
    expect(r.day.late_min).toBe(0);
    expect(r.bySite).toEqual({ alpha: 60 });
  });
  it('moves late arrival due-out forward before attributing SHIFT_END OT', () => {
    const r = calculate([...interval('alpha', '09:30', '18:30'), ...interval('beta', '18:30', '19:30')], {
      attendance: NINE_HOUR_DAY, shift_end_min: 1080,
      overtime: { ...OVERTIME.rules, counts_from: 'SHIFT_END', after_min: 0, rounding_min: 1 } });
    expect(r.day.due_out_min).toBe(1110);
    expect(r.bySite).toEqual({ beta: 60 });
  });
  it('handles overnight shift ends after midnight on the original work date', () => {
    const out = punch('2026-10-11', '07:00', 'OUT', 'alpha');
    out.work_date = DATE;
    const r = calculate([punch(DATE, '22:00', 'IN', 'alpha'), out], { shift_start_min: 1320, shift_end_min: 1800,
      overtime: { ...OVERTIME.rules, counts_from: 'SHIFT_END', after_min: 0, rounding_min: 1 } });
    expect(r.bySite).toEqual({ alpha: 60 });
  });
  it('preserves SHIFT_END endpoint-minute rounding for a short closed interval', () => {
    const short = interval('beta', '18:00', '18:01');
    short[0].at += 59_000;
    short[1].at += 1_000;
    const r = calculate([...interval('alpha', '08:00', '18:00'), ...short], { attendance: NINE_HOUR_DAY, shift_end_min: 1080,
      overtime: { ...OVERTIME.rules, counts_from: 'SHIFT_END', after_min: 0, rounding_min: 1 } });
    expect(r.day.pairs[1].minutes).toBe(0);
    expect(r.day.ot_min).toBe(1);
    expect(r.bySite).toEqual({ beta: 1 });
  });
  it('attributes a legacy interval closed at another site to its original IN site', () => {
    const r = calculate([punch(DATE, '09:00', 'IN', 'alpha'), punch(DATE, '19:00', 'OUT', 'beta')]);
    expect(r.bySite).toEqual({ alpha: 120 });
  });
  it('does not infer OT from missing punches, even when one earlier interval was closed', () => {
    const r = calculate([...interval('alpha', '09:00', '19:00'), punch(DATE, '19:30', 'IN', 'beta')]);
    expect(r.day.status).toBe('MISSING_PUNCH');
    expect(r.bySite).toEqual({});
  });
  it.each(['is_holiday', 'is_weekly_off'])('keeps %s work out of OT', (kind) => {
    expect(calculate(interval('alpha', '09:00', '20:00'), { [kind]: true }).bySite).toEqual({});
  });
  it('shows zero when the pay group has no overtime policy', () => {
    expect(calculate(interval('alpha', '09:00', '20:00'), { overtime: null }).bySite).toEqual({});
  });
});
