import { describe, expect, it } from 'vitest';
import { computeDay, resolvePolicies, siteOvertimeMinutes } from '../../src/calculations/index.js';
import { allocatePaise, allocateSiteWages, recordedSiteIntervals } from '../../src/calculations/attendance/site-wages.js';
import { ATTENDANCE, NINE_HOUR_DAY, OVERTIME, policy, punch } from './fixtures.js';

const D1 = '2026-10-01';
const D2 = '2026-10-02';
const row = (date, site_id, worked_min, ot_min = 0, first_at = 0) => ({ date, site_id, worked_min, ot_min, first_at });
const total = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0);

describe('Site wage allocations conserve the whole-month money before filtering', () => {
  it('splits paise deterministically with a largest remainder, including signed amounts', () => {
    expect(allocatePaise(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocatePaise(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocatePaise(100, [0, 0])).toEqual([0, 0]);
  });
  it('keeps overtime wages on the later OT site, without spreading them across normal minutes', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 480), row(D1, 'beta', 120, 120, 1)], normal_wages: 100000, ot_wages: 20000, paid_ot_min: 120 });
    expect(r.rows[0]).toMatchObject({ normal_wages: 100000, ot_wages: 0 });
    expect(r.rows[1]).toMatchObject({ normal_wages: 0, ot_wages: 20000, paid_ot_min: 120 });
    expect(r.unallocated_wages).toBe(0);
  });
  it('uses the whole payroll month denominator for a requested site/date subrange', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 480), row(D2, 'beta', 480)], normal_wages: 100001, ot_wages: 0 });
    expect(r.rows.map((x) => x.normal_wages)).toEqual([50001, 50000]);
    expect(total(r.rows, 'total_wages')).toBe(100001);
  });
  it('does not put future paid holidays/leave or monthly bonus into an already worked day', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 480)], normal_wages: 500000, ot_wages: 0, other_wages: 100000,
      paid_days: [1, 5, 12, 19, 26].map((day) => ({ date: `2026-10-${String(day).padStart(2, '0')}`, day_value: 1 })) });
    expect(r.rows[0]).toMatchObject({ normal_wages: 100000, other_wages: 20000 });
    expect(r.unallocated_wages).toBe(480000);
  });
  it('respects half paid dates and leaves unlocated paid days unallocated', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 240)], normal_wages: 30000, ot_wages: 0,
      paid_days: [{ date: D1, day_value: 0.5 }, { date: D2, day_value: 1 }] });
    expect(r.rows[0].normal_wages).toBe(10000);
    expect(r.unallocated_normal).toBe(20000);
  });
  it('allocates a monthly cap chronologically, leaving later worked OT unpaid', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 600, 120), row(D2, 'beta', 600, 120)], normal_wages: 200000, ot_wages: 10000, paid_ot_min: 60 });
    expect(r.rows.map((x) => x.ot_wages)).toEqual([10000, 0]);
    expect(r.rows.map((x) => x.paid_ot_min)).toEqual([60, 0]);
    expect(total(r.rows, 'ot_min')).toBe(240);
  });
  it('lets earlier unlocated override OT consume the cap before later recorded site OT', () => {
    const r = allocateSiteWages({ rows: [row(D2, 'beta', 600, 120)], normal_wages: 100000, ot_wages: 10000, paid_ot_min: 60,
      ot_days: [{ date: D1, ot_min: 60 }, { date: D2, ot_min: 120 }] });
    expect(r.rows[0]).toMatchObject({ ot_wages: 0, paid_ot_min: 0 });
    expect(r.unallocated_ot).toBe(10000);
  });
  it('does not pay recorded OT removed by an HR override just because another date has paid OT', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 600, 120), row(D2, 'beta', 600, 120)], normal_wages: 200000, ot_wages: 10000, paid_ot_min: 60,
      ot_days: [{ date: D1, ot_min: 0 }, { date: D2, ot_min: 120 }] });
    expect(r.rows.map((x) => x.ot_wages)).toEqual([0, 10000]);
  });
  it('retains OT pay with no recorded location as unallocated instead of inventing site wages', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 540, 60)], normal_wages: 100000, ot_wages: 20000, paid_ot_min: 120 });
    expect(r.rows[0].ot_wages).toBe(10000);
    expect(r.unallocated_ot).toBe(10000);
    expect(total(r.rows, 'total_wages') + r.unallocated_wages).toBe(120000);
  });
  it('allocates off-day pay only on its dated intervals and keeps other earning totals reconciled', () => {
    const r = allocateSiteWages({ rows: [row(D1, 'alpha', 480), row(D2, 'beta', 480)], normal_wages: 100000, ot_wages: 0,
      other_wages: 40000, dated_other: [{ date: D2, amount: 30000 }] });
    expect(r.rows.map((x) => x.other_wages)).toEqual([5000, 35000]);
    expect(total(r.rows, 'total_wages')).toBe(140000);
  });
  it('keeps all money unallocated when there are no closed intervals', () => {
    const r = allocateSiteWages({ rows: [], normal_wages: 100000, ot_wages: 20000, paid_ot_min: 60, other_wages: 30000 });
    expect(r.unallocated_wages).toBe(150000);
  });
});

function intervals(punches, { attendance = ATTENDANCE, ...extra } = {}) {
  const input = { date: D1, joined_on: '2025-01-01', is_holiday: false, is_weekly_off: false,
    punches, policies: resolvePolicies([attendance, policy('OVERTIME', { ...OVERTIME.rules, counts_from: 'STANDARD_DAY' })], D1),
    shift_start_min: 540, shift_end_min: 1050, shift_break_min: 30, ...extra };
  const day = computeDay(input);
  const rows = recordedSiteIntervals(day, input);
  const bySite = new Map();
  for (const r of rows) bySite.set(r.site_id, (bySite.get(r.site_id) ?? 0) + r.ot_min);
  for (const [site, minutes] of siteOvertimeMinutes(day, input)) expect(bySite.get(site)).toBe(minutes);
  expect(total(rows, 'ot_min')).toBe(day.ot_min);
  return rows;
}

describe('Closed site intervals retain exact overtime chronology', () => {
  it('keeps a cross-site OUT on the original IN site', () => {
    expect(intervals([punch(D1, '09:00', 'IN', 'alpha'), punch(D1, '19:00', 'OUT', 'beta')])[0]).toMatchObject({ site_id: 'alpha', worked_min: 600, ot_min: 120 });
  });
  it('preserves separate repeat visits so an early normal visit cannot steal a later OT cap', () => {
    const rows = intervals([punch(D1, '09:00', 'IN', 'alpha'), punch(D1, '17:00', 'OUT', 'alpha'),
      punch(D1, '17:00', 'IN', 'beta'), punch(D1, '18:00', 'OUT', 'beta'),
      punch(D1, '18:00', 'IN', 'alpha'), punch(D1, '19:00', 'OUT', 'alpha')]);
    expect(rows.map((r) => r.ot_min)).toEqual([0, 60, 60]);
    const r = allocateSiteWages({ rows, normal_wages: 100000, ot_wages: 10000, paid_ot_min: 60 });
    expect(r.rows.map((x) => x.ot_wages)).toEqual([0, 10000, 0]);
  });
  it('handles SHIFT_END full-day eligibility and late eligible intervals', () => {
    const rows = intervals([punch(D1, '09:00', 'IN', 'alpha'), punch(D1, '13:00', 'OUT', 'alpha'),
      punch(D1, '15:00', 'IN', 'beta'), punch(D1, '18:00', 'OUT', 'beta'),
      punch(D1, '18:00', 'IN', 'alpha'), punch(D1, '19:00', 'OUT', 'alpha'),
      punch(D1, '19:00', 'IN', 'beta'), punch(D1, '19:30', 'OUT', 'beta')], {
      attendance: NINE_HOUR_DAY, shift_end_min: 1080, shift_break_min: 60,
      policies: resolvePolicies([NINE_HOUR_DAY, policy('OVERTIME', { ...OVERTIME.rules, counts_from: 'SHIFT_END', after_min: 0, rounding_min: 1 })], D1) });
    expect(rows.map((r) => r.ot_min)).toEqual([0, 0, 0, 30]);
  });
  it('does not fabricate closed hours or OT from an open punch', () => {
    expect(intervals([punch(D1, '09:00', 'IN', 'alpha')])).toEqual([]);
  });
});
