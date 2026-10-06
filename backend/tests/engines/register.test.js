import { describe, expect, it } from 'vitest';
import { dayRegister } from '../../src/services/register.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { punch } from './fixtures.js';

const DATE = '2026-10-06';

function registerDb(punches) {
  return {
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
