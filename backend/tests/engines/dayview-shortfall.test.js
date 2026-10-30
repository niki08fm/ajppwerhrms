import { describe, expect, it } from 'vitest';
import { computeDay, resolvePolicies } from '../../src/calculations/index.js';
import { completedShiftShortfall, inView, summarize } from '../../src/services/dayview.service.js';
import { NINE_HOUR_DAY, punch } from './fixtures.js';

const DATE = '2026-09-01';
const day = (start = '09:00', end = '17:40', patch = {}) => computeDay({
  date: DATE, joined_on: '2025-01-01', last_day: null, is_holiday: false, is_weekly_off: false, leave: null,
  punches: [punch(DATE, start, 'IN'), ...(end ? [punch(DATE, end, 'OUT')] : [])],
  policies: resolvePolicies([NINE_HOUR_DAY], DATE), shift_start_min: 540, shift_end_min: 1080,
  ...patch,
});
const row = (value, patch = {}) => ({ day: value, open_now: false, ...patch });

describe('Completed shift shortfall views', () => {
  it('counts a completed 8h40 shift as 20 minutes short without changing paid-day tolerance', () => {
    const r = row(day());
    expect(r.day).toMatchObject({ status: 'PRESENT', day_value: 1, required_shift_min: 540 });
    expect(completedShiftShortfall(r)).toBe(20);
    expect(inView('shortfall', r)).toBe(true);
    expect(summarize([r], 1200).shortfall).toBe(1);
  });

  it('keeps a late arrival who completes the shift in Late in, outside unfinished shifts', () => {
    const r = row(day('09:40', '18:40'));
    expect(inView('late', r)).toBe(true);
    expect(completedShiftShortfall(r)).toBe(0);
    expect(inView('shortfall', r)).toBe(false);
  });

  it('never flags a running shift as unfinished', () => {
    const r = row(day(), { open_now: true });
    expect(r.day.shift_shortfall_min).toBe(20);
    expect(completedShiftShortfall(r)).toBe(0);
    expect(inView('shortfall', r)).toBe(false);
  });

  it.each([
    ['missing punch', () => day('09:00', null)],
    ['auto punch-out', () => ({ ...day(), flags: ['AUTO_OUT'] })],
    ['absence', () => day('09:00', null, { punches: [] })],
    ['holiday work', () => day('09:00', '10:00', { is_holiday: true })],
    ['weekly off work', () => day('09:00', '10:00', { is_weekly_off: true })],
    ['approved full leave', () => day('09:00', '10:00', { leave: { leave_type: 'PL', paid: true, portion: 1 } })],
  ])('excludes %s from the unfinished-shift list', (_label, value) => {
    expect(inView('shortfall', row(value()))).toBe(false);
    expect(completedShiftShortfall(row(value()))).toBe(0);
  });

  it('uses the remaining half shift after approved half-day leave', () => {
    const r = row(day('09:00', '13:20', { leave: { leave_type: 'PL', paid: true, portion: 0.5 } }));
    expect(r.day.required_shift_min).toBe(270);
    expect(completedShiftShortfall(r)).toBe(10);
    expect(inView('shortfall', r)).toBe(true);
  });

  it('honours an HR correction even when the original missing-punch audit flag remains', () => {
    const r = row({ ...day(), overridden: true, flags: ['UNMATCHED_IN'] }, { override: { id: 'confirmed' } });
    expect(completedShiftShortfall(r)).toBe(20);
    expect(inView('shortfall', r)).toBe(true);
    // The existing Left early decision remains separate and is not rewritten.
    expect(inView('early', { ...r, day: { ...r.day, early_min: 0 } })).toBe(false);
  });
});
