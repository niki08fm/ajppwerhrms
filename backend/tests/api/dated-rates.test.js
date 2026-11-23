import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AJPWER_RATES, SEED_TAX_REGIMES } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { ptSlabs, regimesOn } from '../../src/services/rules.service.js';
import { withReadScope } from '../../src/utils/read-scope.js';
import { buildFixture, R, runAndWait, submitSteps, YM } from './fixture.js';

let f;
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  f = await buildFixture();
});

async function lockAugust() {
  await submitSteps(f.agent, YM, 6);
  expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
  expect((await f.agent.post(`/api/v1/payroll/periods/${YM}/lock`)).status).toBe(200);
}

const ratesBody = (valid_from) => ({ valid_from, pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi, recovery_cap_pct: 40 });

describe('PT slabs are dated', () => {
  it('a new set after locked payroll applies from the next month; earlier months keep the old set', async () => {
    await lockAugust();
    const r = await f.agent.patch('/api/v1/pt-slabs').send({ state: 'Andhra Pradesh', slabs: [{ state: 'Andhra Pradesh', gender_scope: 'ALL', upto_amount: null, amount: R(250), feb_amount: null }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.valid_from).toBe('2026-09-01');
    const ap = (rows) => rows.filter((x) => x.state === 'Andhra Pradesh').map((x) => x.amount);
    const august = await withReadScope(() => ptSlabs(prisma, '2026-08-31'));
    const september = await withReadScope(() => ptSlabs(prisma, '2026-09-30'));
    expect(ap(august)).not.toEqual([R(250)]);
    expect(ap(september)).toEqual([R(250)]);
    const list = (await f.agent.get('/api/v1/pt-slabs')).body.data.find((x) => x.state === 'Andhra Pradesh');
    expect(list.versions.map((v) => v.valid_from)).toEqual(['2026-09-01', '2000-01-01']);
  });

  it('refuses a set dated inside locked payroll', async () => {
    await lockAugust();
    const r = await f.agent.patch('/api/v1/pt-slabs').send({ state: 'Andhra Pradesh', valid_from: '2026-08-01', slabs: [] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PAYROLL_FROZEN');
  });
});

describe('Statutory rates cannot be back-dated into frozen payroll', () => {
  it('refuses a new row dated inside locked payroll and allows one after it', async () => {
    await lockAugust();
    const back = await f.agent.patch('/api/v1/statutory-rates').send(ratesBody('2026-07-01'));
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('PAYROLL_FROZEN');
    const later = await f.agent.patch('/api/v1/statutory-rates').send(ratesBody('2026-10-01'));
    expect(later.status, JSON.stringify(later.body)).toBe(200);
  });

  it('deletes an unused later row, but never the earliest or one a run used', async () => {
    const later = await f.agent.patch('/api/v1/statutory-rates').send(ratesBody('2026-10-01'));
    expect((await f.agent.delete(`/api/v1/statutory-rates/${later.body.data.id}`)).status).toBe(200);
    const earliest = await prisma.statutoryRates.findFirstOrThrow({ where: { deleted_at: null }, orderBy: { valid_from: 'asc' } });
    const r = await f.agent.delete(`/api/v1/statutory-rates/${earliest.id}`);
    expect(r.status).toBe(409);
    // Re-publishing a deleted date restores it.
    expect((await f.agent.patch('/api/v1/statutory-rates').send(ratesBody('2026-10-01'))).status).toBe(200);
  });
});

describe('Tax regimes for a new tax year', () => {
  const next = () => {
    const r = SEED_TAX_REGIMES.find((x) => x.code === 'NEW');
    return { code: 'NEW', name: 'New regime 2027-28', valid_from: '2027-04-01', std_deduction: R(100000), rebate_limit: r.rebate_limit, rebate_max: null, marginal_relief: true, allows_80c: false, allows_hra: false, cess_pct: 4, slabs: r.slabs };
  };

  it('publishes next year’s slabs, which payroll reads from 1 April', async () => {
    const r = await f.agent.post('/api/v1/tax-regimes').send(next());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const before = await withReadScope(() => regimesOn(prisma, '2027-03-31'));
    const after = await withReadScope(() => regimesOn(prisma, '2027-04-01'));
    expect(before.NEW.std_deduction).not.toBe(R(100000));
    expect(after.NEW.std_deduction).toBe(R(100000));
    // Correcting the same year replaces its slabs.
    const fixed = await f.agent.post('/api/v1/tax-regimes').send({ ...next(), std_deduction: R(90000) });
    expect(fixed.status).toBe(201);
    expect((await withReadScope(() => regimesOn(prisma, '2027-04-01'))).NEW.std_deduction).toBe(R(90000));
  });

  it('validates the tax-year start and slabs, and refuses a year with locked payroll', async () => {
    expect((await f.agent.post('/api/v1/tax-regimes').send({ ...next(), valid_from: '2027-05-01' })).status).toBe(422);
    expect((await f.agent.post('/api/v1/tax-regimes').send({ ...next(), slabs: [{ upto_amount: R(400000), rate: 0 }] })).status).toBe(422);
    await lockAugust();
    const r = await f.agent.post('/api/v1/tax-regimes').send({ ...next(), valid_from: '2026-04-01' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PAYROLL_FROZEN');
  });
});
