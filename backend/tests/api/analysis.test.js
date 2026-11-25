import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, runAndWait, submitSteps } from './fixture.js';

let f;
beforeAll(async () => {
  f = await buildFixture();
  for (const ym of ['2026-08', '2026-09']) {
    await submitSteps(f.agent, ym, 6);
    expect((await runAndWait(f.agent, ym)).status).toBe('DONE');
  }
});
afterAll(async () => { await prisma.$disconnect(); });

const analysis = async (q = '') => {
  const r = await f.agent.get(`/api/v1/analysis?fy=2026${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
const report = async (key, q = '') => {
  const r = await f.agent.get(`/api/v1/reports/period/${key}?from=2026-08&to=2026-09${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);

describe('Analysis center', () => {
  it('the year is twelve months from April; months run add up to the totals', async () => {
    const d = await analysis();
    expect(d.months.map((m) => m.ym)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    expect(d.months_run).toBe(2);
    for (const k of ['ctc', 'normal', 'ot', 'net', 'gross']) expect(d.totals[k]).toBe(sum(d.months, k));
    for (const m of d.months.filter((x) => x.state)) expect(m.ctc).toBe(m.gross + m.employer);
    // Cost to company matches the period summary.
    expect(d.totals.ctc).toBe((await report('summary')).extra.ctc);
  });

  it('departments and sites each add up to the whole', async () => {
    const d = await analysis();
    expect(sum(d.departments, 'ctc')).toBe(d.totals.ctc);
    // Site shares are rounded per person-month, so allow a few paise.
    expect(Math.abs(sum(d.sites, 'ctc') - d.totals.ctc)).toBeLessThan(d.months_run * 100);
  });

  it('a department filter keeps that department only, and matches the report center', async () => {
    const all = await analysis();
    const dept = all.departments[0];
    const one = await analysis(`&department_id=${dept.id}`);
    expect(one.totals.ctc).toBe(dept.ctc);
    expect(one.departments.map((x) => x.name)).toEqual([dept.name]);
    expect((await report('cost', `&department_id=${dept.id}`)).totals.ctc).toBe(dept.ctc);
  });
});

describe('Report center: cost and OT approval', () => {
  it('full cost to company ends with the total OT cost, and adds up to the summary', async () => {
    const r = await report('cost');
    expect(r.columns.at(-1)).toMatchObject({ key: 'ot', label: 'Total OT cost' });
    expect(r.totals.ctc).toBe((await report('summary')).extra.ctc);
    for (const row of r.rows) expect(row.months).toBeGreaterThan(0);
  });

  it('OT approval has a column per month and totals that match the overtime report', async () => {
    const r = await report('ot_approval');
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['site', 'm:2026-08', 'm:2026-09', 'total', 'amount']));
    const ot = await report('overtime');
    expect(Math.abs(r.totals.total - ot.totals.paid)).toBeLessThan(0.1);
    for (const row of r.rows) expect(Math.abs(row.total - (row['m:2026-08'] + row['m:2026-09']))).toBeLessThan(0.02);
  });

  it('month by month shows normal wages and OT hours', async () => {
    const r = await report('trend');
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['normal', 'ot', 'ot_hours']));
  });
});
