import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

const offerBody = (extra = {}) => ({ name: 'Offered artist', gender: 'FEMALE', phone: '9000000000',
  department_id: f.deptId, designation: '3D Artist', pay_group_id: f.payGroupId, structure_id: f.structureId,
  mode: 'GROSS', amount: R(30000), valid_till: '2026-11-30', pt_state: 'Andhra Pradesh', ...extra });
async function offer(extra) {
  const r = await f.agent.post('/api/v1/offers').send(offerBody(extra));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data;
}
const accept = (o) => f.agent.post(`/api/v1/offers/${o.offer_id}/accept`);
const pipeline = async () => (await f.agent.get('/api/v1/offers')).body.data;

describe('An offer without a joining date', () => {
  it('is issued without one, and its letter says the date will follow', async () => {
    const o = await offer();
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: o.employee_id } });
    expect(e).toMatchObject({ status: 'OFFER', joined_on: null });
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: o.offer_id } })).join_by).toBeNull();
    const letter = await prisma.letter.findFirstOrThrow({ where: { employee_id: o.employee_id, kind: 'OFFER' } });
    expect(letter.snapshot.offer.join_by).toBeNull();
    expect(letter.snapshot.employee.joined_on).toBeNull();
    expect((await pipeline()).find((p) => p.id === o.employee_id)).toMatchObject({ status: 'OFFER', joined_on: null });
  });

  it('still opens in the profile, pay and letters', async () => {
    const o = await offer();
    for (const path of ['', '/pay', '/tax', '/letters', '/attendance', '/leave-balances']) {
      const r = await f.agent.get(`/api/v1/employees/${o.employee_id}${path}`);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
    }
  });

  it('cannot be onboarded until a joining date is given', async () => {
    const o = await offer();
    expect((await accept(o)).status).toBe(200);
    const r = await f.agent.post(`/api/v1/offers/${o.offer_id}/onboard`);
    expect(r.status).toBe(422);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: o.employee_id } })).status).toBe('ACCEPTED');
  });

  it('is never left without a date once onboarding starts (database rule)', async () => {
    const o = await offer();
    await expect(prisma.employee.update({ where: { id: o.employee_id }, data: { status: 'ONBOARDING' } })).rejects.toThrow();
  });
});

describe('Revoking an offer', () => {
  it('takes an open or accepted offer out of the pipeline, keeping it on record under Revoked', async () => {
    const open = await offer({ name: 'Open offer' });
    const accepted = await offer({ name: 'Accepted offer' });
    expect((await accept(accepted)).status).toBe(200);
    expect((await f.agent.post(`/api/v1/offers/${open.offer_id}/revoke`).send({ reason: 'x' })).status).toBe(422);
    for (const o of [open, accepted]) {
      const r = await f.agent.post(`/api/v1/offers/${o.offer_id}/revoke`).send({ reason: 'Position closed' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const rows = await pipeline();
    for (const o of [open, accepted]) {
      expect(rows.find((p) => p.id === o.employee_id)).toMatchObject({ status: 'REVOKED', offer: { revoke_reason: 'Position closed' } });
      expect(await prisma.employee.findFirst({ where: { id: o.employee_id, deleted_at: null } })).toBeNull();
    }
    expect((await f.agent.get('/api/v1/employees')).body.data.map((p) => p.id)).not.toContain(open.employee_id);
    expect((await accept(open)).status).toBe(409);
    const audit = await prisma.auditLog.findMany({ where: { action: 'offer.revoke' } });
    expect(audit).toHaveLength(2);
  });

  it('cannot revoke someone already onboarding', async () => {
    const o = await offer({ join_by: '2026-11-02' });
    await accept(o);
    expect((await f.agent.post(`/api/v1/offers/${o.offer_id}/onboard`)).status).toBe(200);
    expect((await f.agent.post(`/api/v1/offers/${o.offer_id}/revoke`).send({ reason: 'Changed our mind' })).status).toBe(409);
  });
});

describe('Onboarding accepted candidates with a joining date', () => {
  it('moves several at once: joining date, salary from that date, joining letter issued, steps ticked', async () => {
    const a = await offer({ name: 'First joiner' });
    const b = await offer({ name: 'Second joiner', join_by: '2026-11-15' });
    await accept(a);
    await accept(b);
    const r = await f.agent.post('/api/v1/offers/onboard').send({ offer_ids: [a.offer_id, b.offer_id], joined_on: '2026-11-02' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const o of [a, b]) {
      const e = await prisma.employee.findUniqueOrThrow({ where: { id: o.employee_id }, include: { onboarding_tasks: true } });
      expect(e.status).toBe('ONBOARDING');
      expect(e.joined_on.toISOString().slice(0, 10)).toBe('2026-11-02');
      expect((await prisma.offer.findUniqueOrThrow({ where: { id: o.offer_id } })).join_by.toISOString().slice(0, 10)).toBe('2026-11-02');
      const salary = await prisma.employeeSalary.findFirstOrThrow({ where: { employee_id: o.employee_id } });
      expect(salary.valid_from.toISOString().slice(0, 10)).toBe('2026-11-02');
      expect(salary.monthly_gross).toBe(BigInt(R(30000)));
      const letter = await prisma.letter.findFirstOrThrow({ where: { employee_id: o.employee_id, kind: 'JOINING' } });
      expect(letter.issued_on).not.toBeNull();
      expect(letter.snapshot.employee.joined_on).toBe('2026-11-02');
      expect(letter.snapshot.salary.monthly_gross).toBe(R(30000));
      const done = e.onboarding_tasks.filter((t) => t.done_at).map((t) => t.task_code).sort();
      expect(done).toEqual(['JOINING_LETTER', 'PAY']);
    }
  });

  it('moves nobody if any of them cannot be onboarded', async () => {
    const a = await offer({ name: 'Accepted one' });
    const b = await offer({ name: 'Still on offer' });
    await accept(a);
    const r = await f.agent.post('/api/v1/offers/onboard').send({ offer_ids: [a.offer_id, b.offer_id], joined_on: '2026-11-02' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Still on offer/);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: a.employee_id } })).status).toBe('ACCEPTED');
    expect(await prisma.letter.count({ where: { kind: 'JOINING' } })).toBe(0);
  });

  it('refuses a joining date before the offer was issued', async () => {
    const a = await offer();
    await accept(a);
    const r = await f.agent.post(`/api/v1/offers/${a.offer_id}/onboard`).send({ joined_on: '2020-01-01' });
    expect(r.status).toBe(422);
  });
});
