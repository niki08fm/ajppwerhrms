import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFixture, R } from './fixture.js';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';

let f;
let observed = null;
prisma.$use(async (params, next) => { observed?.push({ model: params.model, action: params.action }); return next(params); });
beforeEach(async () => { f = await buildFixture(); invalidatePrincipal(); });
afterEach(() => { observed = null; });
afterAll(async () => { await prisma.$disconnect(); });

const extraStructure = (name) => prisma.salaryStructure.create({ data: { name, components: { create: [
  { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, counts_as_wages: true },
  { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 40 },
  { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0 },
] } } });

describe('Batched setup list reads', () => {
  it('matches structure details and preserves immutable/history and current headcounts with one shared preview context', async () => {
    const future = await extraStructure('Future structure');
    const unused = await extraStructure('Unused structure');
    const revision = await f.agent.post(`/api/v1/employees/${f.employees.A}/salary`).send({ mode: 'GROSS', amount: R(30000), valid_from: '2099-01-01', structure_id: future.id, reason: 'Future salary agreement' });
    expect(revision.status, JSON.stringify(revision.body)).toBe(201);
    const ids = [f.structureId, future.id, unused.id];
    const expected = new Map();
    for (const id of ids) {
      const detail = await f.agent.get(`/api/v1/structures/${id}`);
      expect(detail.status).toBe(200);
      expected.set(id, detail.body.data);
    }
    const reads = [];
    observed = reads;
    const list = await f.agent.get('/api/v1/structures');
    observed = null;
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toHaveLength(3);
    for (const row of list.body.data) expect(row).toEqual(expected.get(row.id));
    expect(list.body.data.find((row) => row.id === future.id)).toMatchObject({ immutable: true, people: 0 });
    expect(list.body.data.find((row) => row.id === unused.id)).toMatchObject({ immutable: false, people: 0 });
    const count = (model, action) => reads.filter((r) => r.model === model && r.action === action).length;
    expect(count('SalaryStructure', 'findUniqueOrThrow')).toBe(0);
    expect(count('EmployeeSalary', 'groupBy')).toBe(2);
    expect(count('EmployeeSalary', 'count')).toBe(0);
    expect(count('Payslip', 'count')).toBe(0);
    expect(count('StatutoryRates', 'findFirst')).toBe(1);
    expect(count('PtSlab', 'findMany')).toBe(1);
    expect(count('TaxRegime', 'findMany')).toBe(1);
    expect(count('EmployeeStatutory', 'groupBy')).toBe(1);
  });

  it('matches each pay-group detail while reading monthly holidays only once', async () => {
    const original = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
    for (const name of ['Office', 'Workshop']) {
      const created = await f.agent.post('/api/v1/pay-groups').send({ name, pay_day: 7, calendar_method: 'ACTUAL', weekly_off: ['SUN'], shift_id: original.shift.id, policy_ids: [] });
      expect(created.status).toBe(201);
    }
    const reads = [];
    observed = reads;
    const list = await f.agent.get('/api/v1/pay-groups');
    observed = null;
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toHaveLength(3);
    expect(reads.filter((r) => r.model === 'Holiday' && r.action === 'findMany')).toHaveLength(1);
    expect(reads.filter((r) => r.model === 'PayGroup' && r.action === 'findUniqueOrThrow')).toHaveLength(0);
    for (const row of list.body.data) expect(row).toEqual((await f.agent.get(`/api/v1/pay-groups/${row.id}`)).body.data);
  });

  it('still records a masked identity-read audit when opening an employee profile', async () => {
    const response = await f.agent.get(`/api/v1/employees/${f.employees.A}`);
    expect(response.status).toBe(200);
    expect(response.body.data.rules.pay_group.id).toBe(f.payGroupId);
    expect(response.body.data.rules.structure.id).toBe(f.structureId);
    expect(await prisma.auditLog.count({ where: { action: 'pii.read', entity_id: f.employees.A } })).toBe(1);
  });
});
