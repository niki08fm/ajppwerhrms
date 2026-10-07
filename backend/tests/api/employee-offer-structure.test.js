import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

describe('Offers preserve an employee-specific salary structure', () => {
  const offerBody = () => ({ name: 'Offered engineer', gender: 'FEMALE', phone: '9000000000',
    department_id: f.deptId, designation: 'Engineer', pay_group_id: f.payGroupId,
    mode: 'GROSS', amount: R(30000), join_by: '2026-11-01', valid_till: '2026-10-31',
    pt_state: 'Andhra Pradesh' });

  it('requires a structure before issuing an offer', async () => {
    const result = await f.agent.post('/api/v1/offers').send(offerBody());
    expect(result.status).toBe(422);
    expect(await prisma.offer.count()).toBe(0);
  });

  it('freezes selected components and carries the structure through onboarding and pay-group moves', async () => {
    const structure = await prisma.salaryStructure.create({ data: { name: 'Engineer salary', components: { create: [
      { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 60, counts_as_wages: true },
      { seq: 2, name: 'DA', calc_type: 'FIXED', calc_value: R(2000), counts_as_wages: true },
      { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0 },
    ] } } });
    const result = await f.agent.post('/api/v1/offers').send({ ...offerBody(), structure_id: structure.id });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const { employee_id, offer_id } = result.body.data;
    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: offer_id } });
    expect(offer.structure_id).toBe(structure.id);
    const letter = await prisma.letter.findFirstOrThrow({ where: { employee_id, kind: 'OFFER' } });
    expect(letter.snapshot.salary.components).toContainEqual({ name: 'Basic', amount: R(18000) });
    expect(letter.snapshot.salary.components).toContainEqual({ name: 'DA', amount: R(2000) });
    expect((await f.agent.post(`/api/v1/offers/${offer_id}/accept`)).status).toBe(200);
    expect((await f.agent.post(`/api/v1/offers/${offer_id}/onboard`)).status).toBe(200);
    const salary = await prisma.employeeSalary.findFirstOrThrow({ where: { employee_id, deleted_at: null } });
    expect(salary.structure_id).toBe(structure.id);
    expect(salary.monthly_gross).toBe(BigInt(R(30000)));
    const group = await prisma.payGroup.findUniqueOrThrow({ where: { id: f.payGroupId } });
    const other = await prisma.payGroup.create({ data: { name: 'Engineer calendar', calendar_method: 'ACTUAL', weekly_off: ['SUN'], shift_id: group.shift_id } });
    expect((await f.agent.post(`/api/v1/pay-groups/${other.id}/employees`).send({ employee_ids: [employee_id] })).status).toBe(200);
    expect(await prisma.employeeSalary.findUniqueOrThrow({ where: { id: salary.id } })).toEqual(salary);
    expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).snapshot).toEqual(letter.snapshot);
  });
});
