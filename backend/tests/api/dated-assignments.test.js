import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { computeMonths } from '../../src/services/attendance.service.js';
import { payGroupRules } from '../../src/services/rules.service.js';
import { withReadScope } from '../../src/utils/read-scope.js';
import { buildFixture, runAndWait, submitSteps, YM } from './fixture.js';

let f;
const dateOf = (d) => d?.toISOString().slice(0, 10) ?? null;

afterAll(async () => {
  await prisma.$disconnect();
});

async function lockAugust() {
  await submitSteps(f.agent, YM, 6);
  expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
  expect((await f.agent.post(`/api/v1/payroll/periods/${YM}/lock`)).status).toBe(200);
}

async function attendancePolicy(name, grace) {
  const r = await f.agent.post('/api/v1/policies').send({ kind: 'ATTENDANCE', name, valid_from: '2025-04-01', rules: { standard_min: 480, half_day_min: 240, grace_min: grace } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data;
}

async function swapAttendance(next, extra = {}) {
  const group = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
  const policy_ids = group.policies.filter((p) => p.kind !== 'ATTENDANCE').map((p) => p.id).concat(next.id);
  return f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ policy_ids, ...extra });
}

describe('Pay group policies are dated', () => {
  beforeEach(async () => {
    f = await buildFixture();
  });

  it('swapping a policy after locked payroll ends the old one at the locked month and starts the new one after', async () => {
    const oldPolicy = await prisma.policy.findFirstOrThrow({ where: { kind: 'ATTENDANCE', deleted_at: null } });
    await lockAugust();
    const next = await attendancePolicy('Strict attendance', 5);
    const r = await swapAttendance(next);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const links = await prisma.payGroupPolicy.findMany({ where: { pay_group_id: f.payGroupId, policy: { kind: 'ATTENDANCE' } } });
    const oldLink = links.find((l) => l.policy_id === oldPolicy.id);
    const newLink = links.find((l) => l.policy_id === next.id);
    expect([oldLink.deleted_at, dateOf(oldLink.effective_to)]).toEqual([null, '2026-08-31']);
    expect(dateOf(newLink.effective_from)).toBe('2026-09-01');

    // August keeps the old rules; September uses the new ones.
    const rules = await withReadScope(() => payGroupRules(prisma, f.payGroupId));
    const attendance = rules.policies.filter((p) => p.kind === 'ATTENDANCE').map((p) => [p.id, p.valid_from, p.valid_to]);
    expect(attendance).toEqual(expect.arrayContaining([[oldPolicy.id, '2025-04-01', '2026-08-31'], [next.id, '2026-09-01', null]]));
    const view = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
    expect(view.policies.filter((p) => p.kind === 'ATTENDANCE').map((p) => p.id)).toEqual([next.id]);
    expect(view.policy_history.map((p) => [p.id, p.ended_on])).toEqual([[oldPolicy.id, '2026-08-31']]);
  });

  it('refuses a policy change dated inside locked payroll', async () => {
    await lockAugust();
    const next = await attendancePolicy('Strict attendance', 5);
    const r = await swapAttendance(next, { policies_effective_from: '2026-08-15' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PAYROLL_FROZEN');
  });

  it('with no frozen payroll, a swap applies throughout as before', async () => {
    const oldPolicy = await prisma.policy.findFirstOrThrow({ where: { kind: 'ATTENDANCE', deleted_at: null } });
    const next = await attendancePolicy('Strict attendance', 5);
    expect((await swapAttendance(next)).status).toBe(200);
    const oldLink = await prisma.payGroupPolicy.findFirstOrThrow({ where: { pay_group_id: f.payGroupId, policy_id: oldPolicy.id } });
    expect(oldLink.deleted_at).not.toBeNull();
  });
});

describe('Employee pay group moves are dated', () => {
  beforeEach(async () => {
    f = await buildFixture();
  });

  async function otherGroup() {
    const g = await prisma.payGroup.findUniqueOrThrow({ where: { id: f.payGroupId }, include: { policies: true } });
    return prisma.payGroup.create({ data: { name: 'Office', calendar_method: 'ACTUAL', weekly_off: ['SAT', 'SUN'], shift_id: g.shift_id, policies: { create: g.policies.map((p) => ({ policy_id: p.policy_id })) } } });
  }

  it('a move after locked payroll starts the next month; earlier months keep the old group', async () => {
    await lockAugust();
    const office = await otherGroup();
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.A } });
    const r = await f.agent.patch(`/api/v1/employees/${e.id}`).send({ pay_group_id: office.id, updated_at: e.updated_at.toISOString() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = await prisma.employeePayGroup.findMany({ where: { employee_id: e.id }, orderBy: { valid_from: 'asc' } });
    expect(rows.map((x) => [x.pay_group_id, dateOf(x.valid_from), dateOf(x.valid_to)])).toEqual([[f.payGroupId, '1900-01-01', '2026-08-31'], [office.id, '2026-09-01', null]]);

    const moved = await prisma.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect(moved.pay_group_id).toBe(office.id);
    const august = await withReadScope(() => computeMonths(prisma, [moved], YM));
    const september = await withReadScope(() => computeMonths(prisma, [moved], '2026-09'));
    expect(august.get(e.id).rules.id).toBe(f.payGroupId);
    expect(september.get(e.id).rules.id).toBe(office.id);
  });

  it('refuses a move that does not start on the 1st, or that starts inside locked payroll', async () => {
    await lockAugust();
    const office = await otherGroup();
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.A } });
    const mid = await f.agent.patch(`/api/v1/employees/${e.id}`).send({ pay_group_id: office.id, pay_group_effective_from: '2026-09-15', updated_at: e.updated_at.toISOString() });
    expect(mid.status).toBe(422);
    const frozen = await f.agent.post(`/api/v1/pay-groups/${office.id}/employees`).send({ employee_ids: [e.id], effective_from: '2026-08-01' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe('PAYROLL_FROZEN');
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).pay_group_id).toBe(f.payGroupId);
  });
});
