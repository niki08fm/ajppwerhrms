import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, runAndWait, submitSteps } from './fixture.js';

// Two months of payroll; every period report must equal the months added up.
let f;
beforeAll(async () => {
  f = await buildFixture();
  for (const ym of ['2026-08', '2026-09']) {
    await submitSteps(f.agent, ym, 6);
    expect((await runAndWait(f.agent, ym)).status).toBe('DONE');
  }
});
afterAll(async () => { await prisma.$disconnect(); });

const monthly = async (ym, key) => (await f.agent.get(`/api/v1/payroll/periods/${ym}/report/${key}`)).body.data;
const period = async (key, from = '2026-08', to = '2026-09', extra = '') => {
  const r = await f.agent.get(`/api/v1/reports/period/${key}?from=${from}&to=${to}${extra}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);

describe('Report center: reports over a period of months', () => {
  it('lists every report, grouped', async () => {
    const r = await f.agent.get('/api/v1/reports/period');
    expect(r.body.data.map((x) => x.key)).toEqual(expect.arrayContaining(['summary', 'trend', 'payslips', 'register', 'bank', 'pf', 'esi', 'pt', 'tds', 'joiners', 'exits', 'overtime', 'department', 'settlements', 'adhoc']));
  });

  it('pay by employee adds up each person over the months, with how many months they were paid', async () => {
    const [aug, sep, both] = [await monthly('2026-08', 'payslips'), await monthly('2026-09', 'payslips'), await period('payslips')];
    expect(sum(both.rows, 'gross')).toBe(sum(aug.rows, 'gross') + sum(sep.rows, 'gross'));
    expect(sum(both.rows, 'net')).toBe(sum(aug.rows, 'net') + sum(sep.rows, 'net'));
    const one = both.rows[0];
    const a = aug.rows.find((x) => x.employee_id === one.employee_id);
    const s = sep.rows.find((x) => x.employee_id === one.employee_id);
    expect(one).toMatchObject({ months: 2, gross: a.gross + s.gross, paid_days: a.paid_days + s.paid_days });
    expect(both.columns.map((c) => c.key)).toContain('months');
  });

  it('statutory and register reports add up the same way, totals included', async () => {
    for (const key of ['register', 'pf', 'esi', 'pt', 'tds', 'bank']) {
      const [aug, sep, both] = [await monthly('2026-08', key), await monthly('2026-09', key), await period(key)];
      const money = both.columns.filter((c) => c.money).map((c) => c.key);
      for (const k of money) expect(sum(both.rows, k), `${key}.${k}`).toBe(sum(aug.rows, k) + sum(sep.rows, k));
      if (aug.totals) for (const k of money) if (typeof aug.totals[k] === 'number') expect(both.totals[k], `${key} total ${k}`).toBe(aug.totals[k] + sep.totals[k]);
    }
  });

  it('summary and month by month agree; people are counted once', async () => {
    const summary = await period('summary');
    const trend = await period('trend');
    const [aug, sep] = [await monthly('2026-08', 'summary'), await monthly('2026-09', 'summary')];
    expect(summary.extra.gross).toBe(aug.extra.gross + sep.extra.gross);
    expect(summary.extra.net).toBe(aug.extra.net + sep.extra.net);
    expect(trend.totals.gross).toBe(summary.extra.gross);
    expect(trend.rows.map((r) => r.ym)).toEqual(['2026-08', '2026-09']);
    expect(summary.extra).toMatchObject({ months_run: 2, headcount: aug.extra.headcount, payslips: aug.extra.headcount + sep.extra.headcount });
    const dept = await period('department');
    expect(dept.totals.people).toBe(summary.extra.headcount);
  });

  it('says which months have no payroll instead of estimating them', async () => {
    const r = await period('payslips', '2026-06', '2026-09');
    expect(r.coverage).toMatchObject({ months: 4, missing: ['2026-06', '2026-07'] });
    expect(r.notes[0]).toMatch(/June 2026, July 2026/);
    expect(sum(r.rows, 'gross')).toBe(sum((await period('payslips')).rows, 'gross'));
    const none = await period('payslips', '2025-01', '2025-03');
    expect(none.empty).toBe(true);
  });

  it('joiners and exits come from joining and last-day dates; overtime hours per person', async () => {
    const e = await prisma.employee.findFirstOrThrow({ where: { deleted_at: null, status: 'ACTIVE' } });
    await prisma.employee.update({ where: { id: e.id }, data: { joined_on: new Date('2026-09-10T00:00:00Z') } });
    const joiners = await period('joiners');
    expect(joiners.rows.map((r) => r.code)).toContain(e.code);
    expect(joiners.rows.find((r) => r.code === e.code)).toMatchObject({ month: 'September 2026', joined_on: '2026-09-10' });
    await prisma.employee.update({ where: { id: e.id }, data: { last_day: new Date('2026-09-30T00:00:00Z'), exit_reason: 'RESIGNATION' } });
    const exits = await period('exits');
    expect(exits.rows.find((r) => r.code === e.code)).toMatchObject({ last_day: '2026-09-30', reason: 'Resignation' });
    const ot = await period('overtime');
    expect(ot.columns.map((c) => c.key)).toEqual(['code', 'name', 'department', 'months', 'paid', 'per_month', 'over_cap', 'amount']);
  });

  it('refuses a backwards or too-long period, and exports CSV', async () => {
    expect((await f.agent.get('/api/v1/reports/period/payslips?from=2026-09&to=2026-08')).status).toBe(422);
    expect((await f.agent.get('/api/v1/reports/period/payslips?from=2020-01&to=2026-09')).status).toBe(422);
    const csv = await f.agent.get('/api/v1/reports/period/payslips?from=2026-08&to=2026-09&format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toMatch(/report-payslips-2026-08-to-2026-09\.csv/);
  });
});
