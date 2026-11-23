import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R } from './fixture.js';

let f;
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => { f = await buildFixture(); });

// Person C earns ₹30,000 a month and joined on 1 January 2025.
const personal = { name: 'Personal loan', kind: 'LOAN', max_gross_multiple: 2, max_amount: R(100000), max_instalments: 12, recovery_method: 'EQUAL_INSTALMENTS', max_instalment_pct: 40, min_service_months: 6 };

describe('Loan and advance types', () => {
  it('HR sets up types; granting checks the limits and fixes the instalment', async () => {
    const t = await f.agent.post('/api/v1/loan-types').send(personal);
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const list = await f.agent.get('/api/v1/loan-types');
    expect(list.body.data[0].description).toMatch(/at most 12 instalments/);

    const preview = await f.agent.post('/api/v1/loans/preview').send({ type_id: t.body.data.id, employee_id: f.employees.C, amount: R(70000), instalments: 10, granted_on: '2026-09-01' });
    expect(preview.body.data.limit).toBe(R(60000));
    expect(preview.body.data.errors[0]).toMatch(/at most ₹60,000/);

    const refused = await f.agent.post('/api/v1/loans').send({ employee_id: f.employees.C, type_id: t.body.data.id, principal: R(70000), months: 10, started_on: '2026-09-01' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('LOAN_RULES');

    const granted = await f.agent.post('/api/v1/loans').send({ employee_id: f.employees.C, type_id: t.body.data.id, principal: R(60000), months: 6, started_on: '2026-09-01' });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(granted.body.data).toMatchObject({ emi: R(10000), months: 6 });
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: granted.body.data.id } });
    expect(loan).toMatchObject({ loan_type: 'Personal loan', type_id: t.body.data.id });

    // One at a time.
    const second = await f.agent.post('/api/v1/loans').send({ employee_id: f.employees.C, type_id: t.body.data.id, principal: R(10000), months: 2, started_on: '2026-09-01' });
    expect(second.body.error.message).toMatch(/one at a time/i);
    // A type in use cannot be deleted; it can be switched off.
    expect((await f.agent.delete(`/api/v1/loan-types/${t.body.data.id}`)).status).toBe(409);
    expect((await f.agent.patch(`/api/v1/loan-types/${t.body.data.id}`).send({ active: false })).status).toBe(200);
  });

  it('an advance type recovering a fixed amount, capped as a share of gross', async () => {
    const t = await f.agent.post('/api/v1/loan-types').send({ name: 'Salary advance', kind: 'ADVANCE', max_gross_multiple: 1, max_instalments: 3, recovery_method: 'FIXED_AMOUNT', max_instalment_pct: 33 });
    const body = { employee_id: f.employees.C, type_id: t.body.data.id, amount: R(24000), reason: 'Festival', granted_on: '2026-09-01' };
    expect((await f.agent.post('/api/v1/advances').send({ ...body, instalment: R(12000) })).body.error.message).toMatch(/33% of gross/);
    const ok = await f.agent.post('/api/v1/advances').send({ ...body, instalment: R(8000) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.instalment).toBe(R(8000));
    // A loan type cannot be used for an advance.
    const loanType = await f.agent.post('/api/v1/loan-types').send(personal);
    expect((await f.agent.post('/api/v1/advances').send({ ...body, type_id: loanType.body.data.id, instalments: 3, employee_id: f.employees.B })).status).toBe(422);
  });
});
