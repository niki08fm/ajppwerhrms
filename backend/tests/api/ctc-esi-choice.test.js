import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

const amount = R(275316);
const options = [{ gross: R(21000), esi: true }, { gross: R(21644), esi: false }];
const previewInput = (overrides = {}) => ({ mode: 'CTC', amount, structure_id: f.structureId,
  employee_id: f.employees.A, date: '2026-09-01', ...overrides });
const revisionInput = (overrides = {}) => ({ mode: 'CTC', amount, structure_id: f.structureId,
  valid_from: '2026-09-01', reason: 'Reviewed CTC choice', ...overrides });
const employeeInput = (overrides = {}) => ({ name: 'CTC employee', gender: 'MALE', phone: '9000000000',
  department_id: f.deptId, designation: 'Engineer', pay_group_id: f.payGroupId,
  joined_on: '2026-08-01', status: 'ACTIVE', pt_state: 'Andhra Pradesh',
  salary: { mode: 'CTC', amount, structure_id: f.structureId }, ...overrides });
const salaryRows = (id = f.employees.A) => prisma.employeeSalary.findMany({ where: { employee_id: id, deleted_at: null }, orderBy: { valid_from: 'desc' } });

describe('ESI-first CTC preview retains an explicit saved choice', () => {
  it('previews eligible ESI first and requires an explicit valid choice before inserting a revision', async () => {
    const result = await f.agent.post('/api/v1/employees/salary-preview').send(previewInput());
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({ gross: R(21000), esi_eligible_gross: R(21000), esi_within_ceiling: true,
      ctc: { employer_pf: R(1260), employer_esi: R(683), annual_ctc: amount },
      solution: { ambiguous: true, alternative: { gross: R(21644), breakdown: { esi_applies: false } } },
    });
    for (const input of [revisionInput(), revisionInput({ chosen_gross: R(19000) })]) {
      const rejected = await f.agent.post(`/api/v1/employees/${f.employees.A}/salary`).send(input);
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toMatchObject({ code: 'CTC_AMBIGUOUS', details: { options } });
      expect(rejected.body.error.message).toMatch(/21,000.*with ESI.*21,644.*without ESI/);
    }
    expect(await salaryRows()).toHaveLength(1);
  });

  it('creates either explicitly chosen employee agreement and preserves the selected gross on profile reads', async () => {
    const missing = await f.agent.post('/api/v1/employees').send(employeeInput());
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('CTC_AMBIGUOUS');
    for (const option of options) {
      const result = await f.agent.post('/api/v1/employees').send(employeeInput({
        salary: { mode: 'CTC', amount, structure_id: f.structureId, chosen_gross: option.gross },
      }));
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const id = result.body.data.id;
      const rows = await salaryRows(id);
      expect(rows[0]).toMatchObject({ mode: 'CTC', amount: BigInt(amount), monthly_gross: BigInt(option.gross) });
      expect((await prisma.employeeStatutory.findUniqueOrThrow({ where: { employee_id: id } })).esi_enabled).toBe(option.esi);
      const pay = await f.agent.get(`/api/v1/employees/${id}/pay`);
      expect(pay.status, JSON.stringify(pay.body)).toBe(200);
      expect(pay.body.data.salary.monthly_gross).toBe(option.gross);
      expect(pay.body.data.preview.gross).toBe(option.gross);
      expect(pay.body.data.preview.ctc.employer_esi).toBe(option.esi ? R(683) : 0);
    }
  });

  it('freezes either chosen offer option and carries it unchanged through onboarding', async () => {
    const offer = { name: 'CTC offered employee', gender: 'MALE', phone: '9000000000',
      department_id: f.deptId, designation: 'Engineer', pay_group_id: f.payGroupId,
      mode: 'CTC', amount, structure_id: f.structureId, join_by: '2026-11-01', valid_till: '2026-10-31', pt_state: 'Andhra Pradesh' };
    const missing = await f.agent.post('/api/v1/offers').send(offer);
    expect(missing.status).toBe(409);
    expect(await prisma.offer.count()).toBe(0);
    for (const option of options) {
      const result = await f.agent.post('/api/v1/offers').send({ ...offer, chosen_gross: option.gross });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const { employee_id, offer_id } = result.body.data;
      const saved = await prisma.offer.findUniqueOrThrow({ where: { id: offer_id } });
      expect(saved.monthly_gross).toBe(BigInt(option.gross));
      const letter = await prisma.letter.findFirstOrThrow({ where: { employee_id, kind: 'OFFER' } });
      expect(letter.snapshot.salary).toMatchObject({ monthly_gross: option.gross, annual_ctc: amount, employer_esi: option.esi ? R(683) : 0 });
      expect((await f.agent.post(`/api/v1/offers/${offer_id}/accept`)).status).toBe(200);
      expect((await f.agent.post(`/api/v1/offers/${offer_id}/onboard`)).status).toBe(200);
      expect((await salaryRows(employee_id))[0].monthly_gross).toBe(BigInt(option.gross));
      expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).snapshot).toEqual(letter.snapshot);
    }
  });

  it('saves and edits revisions with the explicit without-ESI choice without changing the earlier agreement', async () => {
    const initial = await f.agent.post(`/api/v1/employees/${f.employees.A}/salary`).send(revisionInput({ chosen_gross: R(21000) }));
    expect(initial.status, JSON.stringify(initial.body)).toBe(201);
    const next = await f.agent.post(`/api/v1/employees/${f.employees.A}/salary`).send(revisionInput({ valid_from: '2026-10-01', chosen_gross: R(21644) }));
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const before = await salaryRows();
    const changed = await f.agent.patch(`/api/v1/employees/${f.employees.A}/salary/${next.body.data.id}`).send(revisionInput({
      valid_from: '2026-10-01', chosen_gross: R(21644), reason: 'Reviewed existing without-ESI agreement',
    }));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const after = await salaryRows();
    expect(after[0].monthly_gross).toBe(BigInt(R(21644)));
    expect(after[1]).toEqual(before[1]);
    const pay = await f.agent.get(`/api/v1/employees/${f.employees.A}/pay`);
    expect(pay.body.data.preview).toMatchObject({ gross: R(21644), esi_within_ceiling: false, ctc: { employer_esi: 0 } });
  });

  it('keeps disabled ESI disabled, exposes its eligible candidate, and accepts a unique no-ESI fallback', async () => {
    const preview = await f.agent.post('/api/v1/employees/salary-preview').send(previewInput({ esi_enabled: false }));
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ gross: R(21644), esi_eligible_gross: R(21000), esi_within_ceiling: false,
      solution: { ambiguous: false }, ctc: { employer_esi: 0 }, esi: { employee: 0 },
    });
    for (const input of [employeeInput({ esi_enabled: false }), employeeInput({ salary: { mode: 'CTC', amount: R(400000), structure_id: f.structureId } })]) {
      const created = await f.agent.post('/api/v1/employees').send(input);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.data.id;
      expect((await prisma.employeeStatutory.findUniqueOrThrow({ where: { employee_id: id } })).esi_enabled).toBe(false);
      const pay = await f.agent.get(`/api/v1/employees/${id}/pay`);
      expect(pay.body.data.preview.ctc.employer_esi).toBe(0);
      if (input.salary.amount === R(400000)) expect(pay.body.data.preview.esi_eligible_gross).toBeNull();
    }
  });

  it('keeps saved salary and letter gross unchanged after disabling ESI, without trusting a client gross override', async () => {
    const created = await f.agent.post(`/api/v1/employees/${f.employees.A}/salary`).send(revisionInput({ chosen_gross: R(21000) }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const before = await salaryRows();
    const off = await f.agent.patch(`/api/v1/employees/${f.employees.A}/statutory`).send({ esi_enabled: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const pay = await f.agent.get(`/api/v1/employees/${f.employees.A}/pay`);
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    expect(pay.body.data.preview).toMatchObject({ gross: R(21000), ctc: { employer_esi: 0 }, esi: { employee: 0 } });
    const letter = await f.agent.post(`/api/v1/employees/${f.employees.A}/letters`).send({ kind: 'JOINING', issue: false });
    expect(letter.status, JSON.stringify(letter.body)).toBe(201);
    expect(letter.body.data.snapshot.salary).toMatchObject({ monthly_gross: R(21000), employer_esi: 0 });
    expect(await salaryRows()).toEqual(before);
    const savedBefore = await f.agent.post('/api/v1/employees/salary-preview').send(previewInput({ salary_id: created.body.data.id }));
    expect(savedBefore.status, JSON.stringify(savedBefore.body)).toBe(200);
    expect(savedBefore.body.data.gross).toBe(R(21000));
    const foreign = await f.agent.post('/api/v1/employees/salary-preview').send(previewInput({ salary_id: created.body.data.id, employee_id: f.employees.B }));
    expect(foreign.status).toBe(404);
    const mismatched = await f.agent.post('/api/v1/employees/salary-preview').send(previewInput({ salary_id: created.body.data.id, amount: amount + R(100) }));
    expect(mismatched.status).toBe(422);
    expect(mismatched.body.error.field).toBe('salary_id');
    const noEmployee = previewInput({ salary_id: created.body.data.id });
    delete noEmployee.employee_id;
    expect((await f.agent.post('/api/v1/employees/salary-preview').send(noEmployee)).status).toBe(422);
    const injected = await f.agent.post('/api/v1/employees/salary-preview').send(previewInput({ saved_gross: R(19000) }));
    expect(injected.status).toBe(422);
    const editable = await f.agent.post('/api/v1/employees/salary-preview').send(previewInput({ chosen_gross: R(21000) }));
    expect(editable.body.data.gross).toBe(R(21644));
  });

  it('supports choosing the CTC option in the live structure sample', async () => {
    const components = [
      { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, counts_as_wages: true },
      { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 40 },
      { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0 },
    ].map((component) => ({ frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false, ...component }));
    for (const chosen_gross of [undefined, R(21644)]) {
      const result = await f.agent.post('/api/v1/structures/validate').send({ components, sample: {
        mode: 'CTC', amount, pf_enabled: true, esi_enabled: true, ...(chosen_gross === undefined ? {} : { chosen_gross }),
      } });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.data.breakup).toMatchObject({ gross: chosen_gross ?? R(21000), esi_eligible_gross: R(21000),
        ctc: { employer_esi: chosen_gross ? 0 : R(683) }, solution: { ambiguous: true },
      });
    }
  });

  it('uses current rules for a saved comparison when no historical preview date is requested', async () => {
    const [saved] = await salaryRows();
    expect(saved.valid_from.toISOString().slice(0, 10)).toBe('2025-01-01');
    const result = await f.agent.post('/api/v1/employees/salary-preview').send({
      mode: saved.mode, amount: Number(saved.amount), structure_id: saved.structure_id,
      employee_id: f.employees.A, salary_id: saved.id,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.gross).toBe(Number(saved.monthly_gross));
  });
});
