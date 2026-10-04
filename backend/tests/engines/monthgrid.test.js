import { describe, expect, it } from 'vitest';
import { monthRows } from '../../src/services/monthgrid.service.js';

/** The monthly register's rows: a cell per day, blank after today, and the figures so far. */
const day = (date, status, extra = {}) => ({ date, status, day_value: { PRESENT: 1, HALF_DAY: 0.5, ABSENT: 0, WEEKLY_OFF: 1, ON_LEAVE: 1, MISSING_PUNCH: 1, NOT_JOINED: 0, OFF_WORKED: 1 }[status], late_min: 0, early_min: 0, ot_min: 0, overridden: false, ...extra });
const E = { id: 'e1', code: 'AJ0001', name: 'Ravi Kumar', department: { id: 'd1', name: 'Electrical', colour: 'chart-1' } };
const months = (days) => new Map([['e1', { result: { days } }]]);

describe('monthly register rows', () => {
  const days = [
    day('2026-09-01', 'NOT_JOINED'),
    day('2026-09-02', 'PRESENT', { late_min: 12, ot_min: 30 }),
    day('2026-09-03', 'HALF_DAY', { early_min: 200 }),
    day('2026-09-04', 'ABSENT'),
    day('2026-09-05', 'WEEKLY_OFF'),
    day('2026-09-06', 'OFF_WORKED', { ot_min: 120 }),
    day('2026-09-07', 'MISSING_PUNCH', { overridden: true }),
    day('2026-09-08', 'ABSENT'),
  ];

  it('counts only the days up to today and leaves later days blank', () => {
    const [r] = monthRows([E], months(days), '2026-09', '2026-09-07');
    expect(r.days[7]).toEqual({ date: '2026-09-08', future: true });
    expect(r.days[1]).toMatchObject({ status: 'PRESENT', late_min: 12, ot_min: 30 });
    expect(r.totals).toMatchObject({ days: 6, paid: 4.5, lop: 1.5, present: 1, half_day: 1, absent: 1, missing_punch: 1, late_days: 1, corrected: 1 });
  });

  it('keeps off-day hours out of overtime, as payroll does', () => {
    const [r] = monthRows([E], months(days), '2026-09', '2026-09-07');
    expect(r.totals.ot_min).toBe(30);
    expect(r.days[5].ot_min).toBe(0);
  });

  it('counts the whole month once it is over', () => {
    const [r] = monthRows([E], months(days), '2026-09', '2026-10-04');
    expect(r.days.some((d) => d.future)).toBe(false);
    expect(r.totals).toMatchObject({ days: 7, absent: 2, lop: 2.5 });
  });
});
