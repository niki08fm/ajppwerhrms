import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeOvertimeBase } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R, YM } from './fixture.js';

let f;
beforeAll(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

it('lists month-end joiners with the effective component policy and the same hourly rate and amount as payroll', async () => {
  const rules = { base: 'GROSS', divisor: 25, after_min: 30, multiplier: 1, counts_from: 'SHIFT_END', rounding_min: 30, hours_per_day: 8, monthly_cap_min: null };
  const original = await f.agent.post('/api/v1/policies').send({ kind: 'OVERTIME', name: 'Site overtime', valid_from: '2025-04-01', rules });
  expect(original.status, JSON.stringify(original.body)).toBe(201);
  const group = await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`);
  const attached = await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ policy_ids: [...group.body.data.policies.map((p) => p.id), original.body.data.id] });
  expect(attached.status, JSON.stringify(attached.body)).toBe(200);
  const revision = await f.agent.post(`/api/v1/policies/${original.body.data.policy_key}/versions`).send({
    valid_from: `${YM}-29`, rules: { ...rules, base: 'COMPONENTS', components: ['basic', 'da'], multiplier: 2 },
  });
  expect(revision.status, JSON.stringify(revision.body)).toBe(201);

  const structure = await prisma.salaryStructure.create({ data: {
    name: 'Basic and DA salary', components: { create: [
      { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, counts_as_wages: true },
      { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 40 },
      { seq: 3, name: 'DA', calc_type: 'FIXED', calc_value: R(2000), counts_as_wages: true },
      { seq: 4, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0 },
    ] },
  } });
  const employee = await f.agent.post('/api/v1/employees').send({
    name: 'Month-end joiner', gender: 'FEMALE', phone: '9000000001', department_id: f.deptId,
    designation: 'Engineer', pay_group_id: f.payGroupId, joined_on: `${YM}-29`, status: 'ACTIVE',
    pt_state: 'Andhra Pradesh', salary: { mode: 'GROSS', amount: R(20000), structure_id: structure.id },
  });
  expect(employee.status, JSON.stringify(employee.body)).toBe(201);
  const overtime = await f.agent.post('/api/v1/attendance/overrides').send({
    employee_id: employee.body.data.id, work_date: `${YM}-31`, mode: 'MARK', status: 'PRESENT',
    ot_min: 120, reason_text: 'Two hours of approved site overtime',
  });
  expect(overtime.status, JSON.stringify(overtime.body)).toBe(201);

  const result = await f.agent.get('/api/v1/overtime').query({ month: YM });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.data).toHaveLength(1);
  const row = result.body.data[0];
  expect(row).toMatchObject({
    employee: { id: employee.body.data.id }, ot_min: 120, paid_min: 120, excess_min: 0,
    base: 'COMPONENTS', components: ['basic', 'da'], multiplier: 2,
    policy: { name: 'Site overtime', version: 2 }, hourly: R(60), amount: R(240),
  }); // (₹10,000 Basic + ₹2,000 DA) ÷ (25 × 8) × 2 hours × 2.
  expect(describeOvertimeBase(row)).toBe('Basic + DA');
});
