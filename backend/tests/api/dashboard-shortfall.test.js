import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { buildFixture } from './fixture.js';

afterAll(async () => { await prisma.$disconnect(); });

describe('Today unfinished shifts and attendance register', () => {
  it('shares exact shortfall scope and minutes, distinct from a late arrival or missing punch', async () => {
    const f = await buildFixture();
    const date = '2026-08-03';
    await prisma.policy.updateMany({ where: { kind: 'ATTENDANCE' },
      data: { rules: { standard_min: 540, half_day_min: 240, grace_min: 15 } } });
    const group = await prisma.payGroup.findUnique({ where: { id: f.payGroupId }, select: { shift_id: true } });
    await prisma.shift.update({ where: { id: group.shift_id }, data: { end_min: 1080 } });
    for (const [employeeId, inMin, outMin] of [[f.employees.A, 540, 1060], [f.employees.B, 580, 1120]]) {
      const corrected = await f.agent.post('/api/v1/attendance/overrides').send({
        employee_id: employeeId, work_date: date, mode: 'TIMES', in_min: inMin, out_min: outMin,
        reason_text: 'Actual completed shift confirmed with the supervisor.',
      });
      expect(corrected.status).toBe(201);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ajpwer.retention = 'on'`;
      await tx.punch.deleteMany({ where: { employee_id: f.employees.C, work_date: toDbDate(date), direction: 'OUT' } });
    });
    const overview = await f.agent.get('/api/v1/dashboard/overview').query({ date });
    expect(overview.status).toBe(200);
    const people = overview.body.data.people;
    const short = people.find((p) => p.id === f.employees.A);
    const late = people.find((p) => p.id === f.employees.B);
    const missing = people.find((p) => p.id === f.employees.C);
    expect(short).toMatchObject({ required_shift_min: 540, shift_shortfall_min: 20, late_min: 0 });
    expect(short.views).toContain('shortfall');
    expect(late).toMatchObject({ required_shift_min: 540, shift_shortfall_min: 0, late_min: 40 });
    expect(late.views).toContain('late');
    expect(late.views).not.toContain('shortfall');
    expect(missing).toMatchObject({ status: 'MISSING_PUNCH', shift_shortfall_min: 0 });
    expect(missing.views).not.toContain('shortfall');
    const register = await f.agent.get('/api/v1/attendance').query({ date, 'filter[view]': 'shortfall' });
    expect(register.status).toBe(200);
    expect(register.body.data.map((r) => r.employee.id)).toEqual([f.employees.A]);
    expect(register.body.meta.summary.shortfall).toBe(1);
    expect(register.body.data[0].day).toMatchObject({ day_value: 1, shift_shortfall_min: 20 });
  });
});
