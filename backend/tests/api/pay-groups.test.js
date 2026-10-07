import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/config/db.js';
import { hashPassword } from '../../src/services/auth.service.js';
import { app, buildFixture, R } from './fixture.js';

let f;
let target;
let original;

beforeAll(async () => {
  f = await buildFixture();
  original = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
  const created = await f.agent.post('/api/v1/pay-groups').send({
    name: 'Office workforce', pay_day: 7, calendar_method: 'ACTUAL', weekly_off: ['SUN'],
    shift_id: original.shift.id, policy_ids: [],
  });
  expect(created.status).toBe(201);
  target = created.body.data;
});

afterAll(async () => { await prisma.$disconnect(); });

describe('Pay groups govern rules without owning salary structures', () => {
  it('creates and updates a group without a salary structure and allows no policies', async () => {
    expect(target).not.toHaveProperty('structure');
    expect(target).not.toHaveProperty('structure_id');
    expect(target.policies).toEqual([]);
    const updated = await f.agent.patch(`/api/v1/pay-groups/${target.id}`).send({ name: 'Office team', policy_ids: [] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.policies).toEqual([]);
    const lookups = await f.agent.get('/api/v1/lookups');
    expect(lookups.body.data.pay_groups.every((group) => !Object.hasOwn(group, 'structure_id'))).toBe(true);
  });

  it('allows dated versions of one policy, but rejects two policy lineages of the same kind', async () => {
    const policy = original.policies.find((p) => p.kind === 'ATTENDANCE');
    const version = await f.agent.post(`/api/v1/policies/${policy.policy_key}/versions`).send({ valid_from: '2026-10-01', rules: policy.rules });
    expect(version.status).toBe(201);
    const ids = [policy.id, version.body.data.id];
    expect((await f.agent.patch(`/api/v1/pay-groups/${target.id}`).send({ policy_ids: ids })).status).toBe(200);
    const other = await f.agent.post('/api/v1/policies').send({ kind: 'ATTENDANCE', name: 'Other attendance', valid_from: '2025-01-01', rules: policy.rules });
    expect(other.status).toBe(201);
    const rejected = await f.agent.patch(`/api/v1/pay-groups/${target.id}`).send({ policy_ids: [...ids, other.body.data.id] });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.field).toBe('policy_ids');
    expect((await f.agent.get(`/api/v1/pay-groups/${target.id}`)).body.data.policies.map((p) => p.id).sort()).toEqual(ids.sort());
    expect((await f.agent.patch(`/api/v1/pay-groups/${target.id}`).send({ policy_ids: [] })).status).toBe(200);
  });

  it('moves selected employees atomically and preserves different salary structures and history', async () => {
    const structure = await prisma.salaryStructure.create({ data: {
      name: 'Employee-specific template', components: { create: [
        { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 60, counts_as_wages: true },
        { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 30 },
        { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0 },
      ] },
    } });
    const revision = await f.agent.post(`/api/v1/employees/${f.employees.B}/salary`).send({
      mode: 'GROSS', amount: R(25000), valid_from: '2026-11-01', structure_id: structure.id, reason: 'Personal salary structure',
    });
    expect(revision.status).toBe(201);
    const ids = [f.employees.A, f.employees.B];
    const salaryRows = () => prisma.employeeSalary.findMany({ where: { employee_id: { in: ids } }, orderBy: { id: 'asc' } });
    const before = await salaryRows();
    expect(before.some((salary) => salary.structure_id === structure.id)).toBe(true);
    const moved = await f.agent.post(`/api/v1/pay-groups/${target.id}/employees`).send({ employee_ids: ids });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ moved: 2, unchanged: 0 });
    expect(await salaryRows()).toEqual(before);
    const members = await f.agent.get(`/api/v1/pay-groups/${target.id}/employees`);
    expect(members.status).toBe(200);
    expect(members.body.data.map((employee) => employee.id).sort()).toEqual(ids.sort());
    for (const employee of members.body.data) {
      expect(Object.keys(employee).sort()).toEqual(['code', 'id', 'name', 'pay_group_id', 'status']);
      expect(employee.pay_group_id).toBe(target.id);
      const events = await prisma.auditLog.findMany({ where: { action: 'employee.pay_group_change', entity_id: employee.id } });
      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({ from: f.payGroupId, to: target.id });
    }
    const unchanged = await f.agent.post(`/api/v1/pay-groups/${target.id}/employees`).send({ employee_ids: ids });
    expect(unchanged.body.data).toMatchObject({ moved: 0, unchanged: 2 });
    expect(await prisma.auditLog.count({ where: { action: 'employee.pay_group_change', entity_id: { in: ids } } })).toBe(2);
    expect(await salaryRows()).toEqual(before);
    const profile = await f.agent.get(`/api/v1/employees/${f.employees.A}`);
    expect(profile.body.data.rules.structure.id).toBe(f.structureId);
  });

  it('does not move anyone when a selected employee is missing or exited', async () => {
    const before = await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.C } });
    const missing = await f.agent.post(`/api/v1/pay-groups/${target.id}/employees`).send({ employee_ids: [f.employees.C, randomUUID()] });
    expect(missing.status).toBe(422);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.C } })).pay_group_id).toBe(before.pay_group_id);
    await prisma.employee.update({ where: { id: f.employees.OFFER }, data: { status: 'EXITED' } });
    const exited = await f.agent.post(`/api/v1/pay-groups/${target.id}/employees`).send({ employee_ids: [f.employees.C, f.employees.OFFER] });
    expect(exited.status).toBe(403);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.C } })).pay_group_id).toBe(before.pay_group_id);
    expect(await prisma.auditLog.count({ where: { action: 'employee.pay_group_change', entity_id: f.employees.C } })).toBe(0);
  });

  it('requires people.write for membership even if the user can configure groups', async () => {
    const role = await prisma.role.create({ data: { name: 'Setup only', permissions: ['setup.read', 'setup.write', 'people.read'] } });
    await prisma.appUser.create({ data: { email: 'setup@test.in', name: 'Setup', role_id: role.id, password_hash: await hashPassword('setup-password-1') } });
    const agent = request.agent(app);
    expect((await agent.post('/api/v1/auth/login').send({ email: 'setup@test.in', password: 'setup-password-1' })).status).toBe(200);
    expect((await agent.get(`/api/v1/pay-groups/${target.id}/employees`)).status).toBe(200);
    expect((await agent.post(`/api/v1/pay-groups/${target.id}/employees`).send({ employee_ids: [f.employees.C] })).status).toBe(403);
  });

  it('requires an explicit offer structure independently of the chosen pay group', async () => {
    const input = {
      name: 'New hire', gender: 'MALE', phone: '9000000000', department_id: f.deptId,
      designation: 'Engineer', pay_group_id: target.id, mode: 'GROSS', amount: R(18000),
      join_by: '2026-11-01', valid_till: '2026-11-10', pt_state: 'Andhra Pradesh',
    };
    expect((await f.agent.post('/api/v1/offers').send(input)).status).toBe(422);
    const created = await f.agent.post('/api/v1/offers').send({ ...input, structure_id: f.structureId });
    expect(created.status).toBe(201);
    const offer = await prisma.offer.findFirstOrThrow({ where: { employee: { name: 'New hire' } } });
    expect(offer.structure_id).toBe(f.structureId);
  });
});
