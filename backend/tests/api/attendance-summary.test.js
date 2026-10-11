import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { istDate, istMidnight, ymOf } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture, YM } from './fixture.js';
import request from 'supertest';

let f;
// The retention escape permits DELETE only. Rebuild test fixture rows with new
// times instead of updating the append-only ledger. Application corrections
// below still use the public override endpoint.
const changeFixturePunches = (fn) => prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL ajpwer.retention = 'on'`;
  return fn(tx);
});
const replaceFixtureOutTimes = (where, timeFor) => changeFixturePunches(async (tx) => {
  const rows = await tx.punch.findMany({ where: { ...where, direction: 'OUT' } });
  await tx.punch.deleteMany({ where: { ...where, direction: 'OUT' } });
  if (rows.length) await tx.punch.createMany({ data: rows.map((p) => {
    const at = timeFor(p);
    return { ...p, punched_at: at, client_punched_at: at };
  }) });
});
beforeEach(async () => {
  f = await buildFixture();
  invalidatePrincipal();
  await prisma.policy.updateMany({ where: { kind: 'ATTENDANCE' },
    data: { rules: { standard_min: 540, half_day_min: 0, half_day_upto_min: 240, grace_min: 15 } } });
  const shift = await prisma.payGroup.findUnique({ where: { id: f.payGroupId }, select: { shift_id: true } });
  await prisma.shift.update({ where: { id: shift.shift_id }, data: { end_min: 1080 } });
  await replaceFixtureOutTimes({}, (p) => new Date(p.work_date.getTime() - 330 * 60_000 + 1080 * 60_000));
});
afterAll(async () => { await prisma.$disconnect(); });

const month = () => f.agent.get('/api/v1/attendance/month').query({ ym: YM });
const profile = () => f.agent.get(`/api/v1/employees/${f.employees.A}/attendance`).query({ month: YM });
const details = (date) => f.agent.get('/api/v1/attendance/day').query({ employee_id: f.employees.A, date });
const outAt = (date, min) => new Date(istMidnight(date).getTime() + min * 60_000);

describe('Consistent attendance month metrics', () => {
  it('shows the same 35 minutes in monthly register, employee profile and payroll without changing paid days', async () => {
    for (const [date, minutes] of [['2026-08-03', 1060], ['2026-08-04', 1065]]) {
      await replaceFixtureOutTimes({ employee_id: f.employees.A, work_date: toDbDate(date) }, () => outAt(date, minutes));
    }
    const register = await month();
    const employee = await profile();
    const payroll = await f.agent.get(`/api/v1/payroll/periods/${YM}/attendance`);
    expect([register.status, employee.status, payroll.status]).toEqual([200, 200, 200]);
    const row = register.body.data.rows.find((r) => r.employee.id === f.employees.A);
    const pay = payroll.body.data.rows.find((r) => r.employee.id === f.employees.A);
    expect(row.attendance_summary).toEqual(employee.body.data.attendance_summary);
    expect(pay.attendance_summary).toEqual(row.attendance_summary);
    expect(row.totals.late_minutes).toBe(35);
    expect(pay.late_minutes).toBe(35);
    expect(pay.paid_days).toBe(31);
    expect(row.days.find((d) => d.date === '2026-08-03')).toMatchObject({ required_shift_min: 540, shift_shortfall_min: 20 });
  });

  it('updates effective day details and summaries after a times correction and restores the missing issue on revert', async () => {
    const date = '2026-08-03';
    await changeFixturePunches((tx) => tx.punch.deleteMany({ where: { employee_id: f.employees.A, work_date: toDbDate(date), direction: 'OUT' } }));
    expect((await profile()).body.data.attendance_summary).toMatchObject({ missing_punch: 1, late_minutes: 0 });
    const saved = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: date,
      mode: 'TIMES', in_min: 540, out_min: 1065, reason_text: 'Confirmed the actual punch-out with the supervisor.' });
    expect(saved.status).toBe(201);
    const day = await details(date);
    expect(day.body.data).toMatchObject({ required_shift_min: 540, shift_shortfall_min: 15,
      day: { status: 'PRESENT', shift_shortfall_min: 15, overridden: true } });
    expect((await profile()).body.data.attendance_summary).toMatchObject({ missing_punch: 0, late_minutes: 15, corrected: 1 });
    const reverted = await f.agent.delete(`/api/v1/attendance/overrides/${day.body.data.override.id}`);
    expect(reverted.status).toBe(200);
    expect((await profile()).body.data.attendance_summary).toMatchObject({ missing_punch: 1, late_minutes: 0, corrected: 0 });
  });

  it('does not include future or pre-joining days in current-month attendance totals', async () => {
    const now = istDate(new Date());
    const ym = ymOf(now);
    const joined = `${ym}-01`;
    await prisma.employee.update({ where: { id: f.employees.A }, data: { joined_on: toDbDate(joined) } });
    const response = await f.agent.get(`/api/v1/employees/${f.employees.A}/attendance`).query({ month: ym });
    expect(response.status).toBe(200);
    expect(response.body.data.attendance_summary.days).toBe(Number(now.slice(8)));
    expect(response.body.data.attendance_summary.lop_days).toBeLessThanOrEqual(Number(now.slice(8)));
  });

  it('keeps read permissions and frozen attendance correction protection on the shared endpoints', async () => {
    expect((await request(app).get('/api/v1/attendance/day').query({ employee_id: f.employees.A, date: '2026-08-03' })).status).toBe(401);
    await prisma.payrollPeriod.create({ data: { period_ym: YM, state: 'DRAFT', steps_submitted: [1] } });
    const response = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: '2026-08-03',
      mode: 'TIMES', in_min: 540, out_min: 1065, reason_text: 'Blocked because payroll attendance has been submitted.' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ATTENDANCE_FROZEN');
  });
});
