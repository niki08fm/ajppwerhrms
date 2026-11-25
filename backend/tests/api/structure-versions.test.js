import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { structureComponents } from '../../src/services/rules.service.js';
import { buildFixture } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

const structure = async () => (await f.agent.get(`/api/v1/structures/${f.structureId}`)).body.data;
const editable = (components) => components.filter((c) => c.calc_type !== 'BALANCE')
  .map(({ seq, name, calc_type, calc_value, max_amount, frequency, pay_month, is_taxable, counts_as_wages, colour }) => ({ seq, name, calc_type, calc_value, max_amount, frequency, pay_month, is_taxable, counts_as_wages, colour }));
const withBasic = (components, pct) => editable(components).map((c) => (c.name === 'Basic' ? { ...c, calc_value: pct } : c));
const windows = (s) => s.versions.map((v) => [v.version, v.valid_from, v.valid_to]);
const basicOn = async (date) => (await structureComponents(prisma, f.structureId, date)).find((c) => c.name === 'Basic').calc_value;

async function publish(valid_from, pct, expectStatus = 201) {
  const s = await structure();
  const r = await f.agent.post(`/api/v1/structures/${f.structureId}/versions`).send({ valid_from, components: withBasic(s.versions.at(-1).components, pct) });
  expect(r.status, JSON.stringify(r.body)).toBe(expectStatus);
  return r.body;
}

describe('Salary structure versions', () => {
  it('a new version starts on the 1st of a month; the one before ends the day before; payroll reads each by date', async () => {
    const before = await structure();
    expect(windows(before)).toEqual([[1, null, null]]);
    const s = (await publish('2026-12-01', 60)).data;
    expect(windows(s)).toEqual([[1, null, '2026-11-30'], [2, '2026-12-01', null]]);
    expect(s.id).toBe(f.structureId);
    expect(await basicOn('2026-11-30')).toBe(before.components.find((c) => c.name === 'Basic').calc_value);
    expect(await basicOn('2026-12-01')).toBe(60);
    // The list shows one structure, not one per version.
    const list = (await f.agent.get('/api/v1/structures')).body.data.filter((x) => x.id === f.structureId);
    expect(list).toHaveLength(1);
  });

  it('never overlaps: a version must start after the latest, on a month start', async () => {
    await publish('2026-12-01', 60);
    expect((await publish('2026-12-01', 70, 422)).error.message).toMatch(/must start after/);
    expect((await publish('2026-11-01', 70, 422)).error.message).toMatch(/must start after/);
    expect((await publish('2027-01-15', 70, 422)).error.message).toMatch(/first day of a month/);
  });

  it('an edited start stays between its neighbours', async () => {
    await publish('2026-12-01', 60);
    const v3 = (await publish('2027-04-01', 65)).data.versions.at(-1);
    const v2 = (await structure()).versions[1];
    expect((await f.agent.patch(`/api/v1/structure-versions/${v2.id}`).send({ valid_from: '2027-04-01' })).status).toBe(422);
    const moved = await f.agent.patch(`/api/v1/structure-versions/${v2.id}`).send({ valid_from: '2027-01-01' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(windows(moved.body.data)).toEqual([[1, null, '2026-12-31'], [2, '2027-01-01', '2027-03-31'], [3, '2027-04-01', null]]);
    expect(v3.version).toBe(3);
  });

  it('deleting a later version lets the one before run on; deleting the first moves the next back to the start', async () => {
    await publish('2026-12-01', 60);
    await publish('2027-04-01', 65);
    const [v1, v2] = (await structure()).versions;
    const later = await f.agent.delete(`/api/v1/structure-versions/${v2.id}`);
    expect(windows(later.body.data)).toEqual([[1, null, '2027-03-31'], [3, '2027-04-01', null]]);
    const first = await f.agent.delete(`/api/v1/structure-versions/${v1.id}`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(windows(first.body.data)).toEqual([[3, null, null]]);
    // Salaries still point at the structure and now read version 3 throughout.
    expect(await basicOn('2026-06-30')).toBe(65);
    const only = first.body.data.versions[0];
    expect((await f.agent.delete(`/api/v1/structure-versions/${only.id}`)).status).toBe(409);
  });

  it('locked or paid payroll protects the version it used', async () => {
    await prisma.payrollPeriod.create({ data: { period_ym: '2026-08', state: 'PAID' } });
    expect((await publish('2026-08-01', 70, 409)).error.message).toMatch(/locked or paid/);
    const s = (await publish('2026-12-01', 60)).data;
    const detail = await structure();
    expect(detail.versions[0]).toMatchObject({ can_edit: false, can_delete: false });
    expect(detail.versions[1]).toMatchObject({ can_edit: true, can_delete: true });
    const v1 = s.versions[0];
    const edit = await f.agent.patch(`/api/v1/structure-versions/${v1.id}`).send({ components: withBasic(detail.versions[0].components, 55) });
    expect(edit.status).toBe(409);
    expect(edit.body.error.message).toMatch(/August 2026/);
    expect((await f.agent.delete(`/api/v1/structure-versions/${v1.id}`)).status).toBe(409);
    expect((await f.agent.patch(`/api/v1/structure-versions/${s.versions[1].id}`).send({ valid_from: '2026-08-01' })).status).toBe(409);
    // Renaming changes no pay and is always allowed.
    expect((await f.agent.patch(`/api/v1/structure-versions/${v1.id}`).send({ name: 'Renamed' })).status).toBe(200);
  });

  it('flags a generated, unlocked month for regeneration', async () => {
    await prisma.payrollPeriod.create({ data: { period_ym: '2026-12', state: 'RUN' } });
    await publish('2026-12-01', 60);
    expect((await prisma.payrollPeriod.findFirst({ where: { period_ym: '2026-12' } })).rerun_reason).toMatch(/v2 published/);
  });
});
