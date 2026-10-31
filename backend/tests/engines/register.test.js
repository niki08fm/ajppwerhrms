import { describe, expect, it, vi } from 'vitest';
import { dayRegister, dayRegisters } from '../../src/services/register.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { punch } from './fixtures.js';

const DATE = '2026-10-06';

function registerDb(punches) {
  return {
    $executeRaw: async () => 1,
    employee: { findMany: async () => [{
      id: 'worker', code: 'AJ001', name: 'Worker', pay_group_id: 'general',
      joined_on: toDbDate('2025-01-01'), last_day: null,
      department: { id: 'civil', name: 'Civil', colour: 'chart-1' },
    }] },
    punch: { findMany: async () => punches.map((p) => ({
      ...p, employee_id: 'worker', punched_at: new Date(p.at), work_date: toDbDate(p.work_date),
    })) },
    attendanceOverride: { findMany: async () => [] },
    leaveRequest: { findMany: async () => [] },
    holiday: { findMany: async () => [] },
    siteChange: { findMany: async () => [] },
    payGroup: { findUniqueOrThrow: async () => ({
      id: 'general', name: 'General', weekly_off: ['SUN'], policies: [],
      shift: { start_min: 540, end_min: 1080, break_min: 60 },
    }) },
  };
}

describe('current site in the day register', () => {
  it('counts a worker who moved from Alpha to Beta only at their open Beta punch', async () => {
    const punches = [
      punch(DATE, '09:00', 'IN', 'alpha'),
      punch(DATE, '12:00', 'OUT', 'alpha'),
      punch(DATE, '13:00', 'IN', 'beta'),
    ];
    const [row] = await dayRegister(registerDb(punches), DATE, undefined, DATE);
    expect(row.day.sites).toEqual(['alpha', 'beta']);
    expect(row.open_now).toBe(true);
    expect(row.current_site_id).toBe('beta');

    const [closed] = await dayRegister(registerDb([...punches, punch(DATE, '18:00', 'OUT', 'beta')]), DATE, undefined, DATE);
    expect(closed.open_now).toBe(false);
    expect(closed.current_site_id).toBeNull();

    const [past] = await dayRegister(registerDb(punches), DATE, undefined, '2026-10-07');
    expect(past.open_now).toBe(false);
    expect(past.current_site_id).toBeNull();
  });
});


function rangeDb() {
  const db = registerDb([]);
  const employee = { id: 'worker', code: 'AJ001', name: 'Worker', pay_group_id: 'general', joined_on: toDbDate('2025-01-01'), last_day: null, department: { id: 'civil', name: 'Civil' } };
  const employees = [employee, { ...employee, id: 'new', name: 'New joiner', joined_on: toDbDate('2026-10-02') }, { ...employee, id: 'exited', name: 'Exited worker', last_day: toDbDate('2026-10-03') }];
  const punches = [
    ['2026-09-30', '09:00', 'IN', 'alpha'], ['2026-09-30', '13:00', 'OUT', 'alpha'],
    ['2026-10-01', '09:00', 'IN', 'alpha'],
    ['2026-10-05', '09:00', 'IN', 'alpha'], ['2026-10-05', '12:00', 'OUT', 'alpha'], ['2026-10-05', '13:00', 'IN', 'beta'],
  ].map(([date, time, dir, site]) => { const p = punch(date, time, dir, site); return { ...p, id: `${date}-${time}-${dir}`, employee_id: 'worker', punched_at: new Date(p.at), work_date: toDbDate(date) }; });
  const overrides = [{ id: 'override', employee_id: 'worker', work_date: toDbDate('2026-10-03'), status: 'PRESENT', day_value: 1, worked_min: 480, ot_min: 0, late_min: 0, in_min: 540, out_min: 1080 }];
  const leaves = [{ employee_id: 'worker', from_date: toDbDate('2026-10-01'), to_date: toDbDate('2026-10-02'), days: 2, leave_type: 'SL' }];
  const holidays = [{ date: toDbDate('2026-10-02'), name: 'Holiday' }];
  const changes = [{ employee_id: 'worker', work_date: toDbDate('2026-10-05'), status: 'COUNTED', travel_min: 60, hr_travel_min: 30 }];
  const within = (date, q) => q instanceof Date ? +date === +q : +date >= +q.gte && +date <= +q.lte;
  db.employee.findMany = vi.fn(async ({ where }) => employees.filter((e) => e.joined_on <= where.joined_on.lte && (!e.last_day || e.last_day >= where.OR[1].last_day.gte) && (!where.id || where.id.in.includes(e.id))));
  db.punch.findMany = vi.fn(async ({ where }) => punches.filter((p) => where.employee_id.in.includes(p.employee_id) && within(p.work_date, where.work_date)));
  db.attendanceOverride.findMany = vi.fn(async ({ where }) => overrides.filter((o) => where.employee_id.in.includes(o.employee_id) && within(o.work_date, where.work_date)));
  db.leaveRequest.findMany = vi.fn(async ({ where }) => leaves.filter((l) => where.employee_id.in.includes(l.employee_id) && l.from_date <= where.from_date.lte && l.to_date >= where.to_date.gte));
  db.holiday.findMany = vi.fn(async ({ where }) => holidays.filter((h) => within(h.date, where.date)));
  db.siteChange.findMany = vi.fn(async ({ where }) => changes.filter((c) => where.employee_id.in.includes(c.employee_id) && within(c.work_date, where.work_date)));
  db.payGroup.findUniqueOrThrow = vi.fn(db.payGroup.findUniqueOrThrow);
  return db;
}

describe('batched approval registers', () => {
  const dates = ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29'];
  it('matches separate day reads across employment boundaries, leave, holidays, corrections and transfers with fewer DB reads', async () => {
    const reference = rangeDb();
    const expected = new Map(await Promise.all(dates.map(async (d) => [d, await dayRegister(reference, d, undefined, dates[0])])));
    const db = rangeDb();
    const actual = await dayRegisters(db, dates, undefined, dates[0]);
    expect(actual).toEqual(expected);
    expect(actual.get('2026-10-01').some((r) => r.employee.id === 'new')).toBe(false);
    expect(actual.get('2026-10-04').some((r) => r.employee.id === 'exited')).toBe(false);
    expect(actual.get('2026-10-05').find((r) => r.employee.id === 'worker').current_site_id).toBe('beta');
    for (const model of ['employee', 'punch', 'attendanceOverride', 'leaveRequest', 'holiday', 'siteChange']) {
      expect(db[model].findMany).toHaveBeenCalledTimes(1);
      expect(reference[model].findMany).toHaveBeenCalledTimes(7);
    }
    expect(db.payGroup.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(reference.payGroup.findUniqueOrThrow).toHaveBeenCalledTimes(7);
  });
  it('retains employee scope and skips unrelated reads for an empty selection', async () => {
    const db = rangeDb();
    expect([...(await dayRegisters(db, dates, [], dates[0])).values()]).toEqual(dates.map(() => []));
    expect(db.punch.findMany).not.toHaveBeenCalled();
    expect(db.payGroup.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(await dayRegisters(db, [], undefined, dates[0])).toEqual(new Map());
  });
});
