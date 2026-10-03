import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istMidnight, mulDiv, STATUTORY_GRATUITY_RULES } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { buildFixture, R } from './fixture.js';

let f;

beforeAll(async () => {
  f = await buildFixture();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('Late penalties are gone', () => {
  it('a late-penalty policy can no longer be created', async () => {
    const r = await f.agent
      .post('/api/v1/policies')
      .send({ kind: 'LATE_PENALTY', name: 'Slabs', valid_from: '2026-09-01', rules: { free_per_month: 3, slabs: [{ from_min: 1, to_min: null, deduct_days: 1 }] } });
    expect(r.status).toBe(422);
  });
});

describe('The overview lists late logins and early punch-outs', () => {
  it('late is past the grace period, early is out before the day ends', async () => {
    // General shift 09:00–17:30, an 8-hour day, 15 minutes' grace.
    const at = (key, min, direction) => {
      const t = new Date(istMidnight('2026-09-01').getTime() + min * 60_000);
      return { employee_id: f.employees[key], site_id: f.siteId, direction, punched_at: t, client_punched_at: t, work_date: toDbDate('2026-09-01'), method: 'FACE' };
    };
    await prisma.punch.createMany({
      data: [
        at('A', 9 * 60 + 40, 'IN'), // late; the day ends eight hours later, at 17:40
        at('A', 17 * 60 + 30, 'OUT'),
        at('B', 9 * 60, 'IN'),
        at('B', 17 * 60, 'OUT'), // half an hour before the shift ends
        at('C', 9 * 60 + 10, 'IN'), // inside the grace period
        at('C', 17 * 60 + 30, 'OUT'),
      ],
    });
    const r = await f.agent.get('/api/v1/dashboard/punctuality').query({ date: '2026-09-01' });
    expect(r.status).toBe(200);
    expect(r.body.data.late.map((x) => [x.employee.name, x.late_min])).toEqual([['Person A', 40]]);
    expect(r.body.data.early.map((x) => [x.employee.name, x.early_min])).toEqual([
      ['Person B', 30],
      ['Person A', 10],
    ]);

    const reg = await f.agent.get('/api/v1/attendance').query({ date: '2026-09-01', 'filter[early]': 'yes' });
    expect(reg.body.data.map((x) => x.employee.name).sort()).toEqual(['Person A', 'Person B']);
    expect(reg.body.data.every((x) => x.day.status === 'PRESENT')).toBe(true);
  });
});

describe('Gratuity is a policy attached to the pay group', () => {
  it('without one no gratuity is calculated; attached, its own rules decide the amount', async () => {
    const resign = await f.agent.post(`/api/v1/employees/${f.employees.C}/resign`).send({ resigned_on: '2026-09-01', last_day: '2026-09-30', exit_reason: 'RESIGNATION' });
    expect(resign.status).toBe(200);
    const before = (await f.agent.get(`/api/v1/settlements/${f.employees.C}`)).body.data.result;
    expect(before.earnings.find((l) => l.code === 'GRATUITY')).toBeUndefined();
    expect(before.clearance.map((c) => c.code)).toContain('NO_GRATUITY_POLICY');

    const bad = await f.agent.post('/api/v1/policies').send({ kind: 'GRATUITY', name: 'Bad', valid_from: '2025-01-01', rules: { ...STATUTORY_GRATUITY_RULES, flag_from_years: 6 } });
    expect(bad.status).toBe(422);
    const rules = { ...STATUTORY_GRATUITY_RULES, min_years: 1, flag_from_years: 0.5, base: 'GROSS', max_amount: null };
    const created = await f.agent.post('/api/v1/policies').send({ kind: 'GRATUITY', name: 'One-year gratuity', valid_from: '2025-01-01', rules });
    expect(created.status).toBe(201);

    const group = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
    expect(group.warnings.map((w) => w.kind)).toContain('GRATUITY');
    const attached = await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ policy_ids: [...group.policies.map((p) => p.id), created.body.data.id] });
    expect(attached.status).toBe(200);
    expect(attached.body.data.warnings.map((w) => w.kind)).not.toContain('GRATUITY');

    // 1 year 8 months 29 days: over six months counts as a full year, so two years on a ₹30,000 gross.
    const after = (await f.agent.get(`/api/v1/settlements/${f.employees.C}`)).body.data.result;
    const line = after.earnings.find((l) => l.code === 'GRATUITY');
    expect(line.amount).toBe(mulDiv(R(30000), 15 * 2, 26));
    expect(line.detail).toBe('Last gross × 15 × 2 ÷ 26');
    expect(after.clearance.map((c) => c.code)).not.toContain('NO_GRATUITY_POLICY');
  });
});
