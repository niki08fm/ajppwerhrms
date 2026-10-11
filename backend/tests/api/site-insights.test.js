import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { istDate, istMidnight } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { siteInsights } from '../../src/services/site-insights.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture, R } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); invalidatePrincipal(); });
afterAll(async () => { await prisma.$disconnect(); });
const endpoint = () => `/api/v1/sites/${f.siteId}/insights`;
const range = { from: '2026-08-01', to: '2026-08-31' };

describe('HR site insights', () => {
  it('requires attendance permission and never exposes payroll to an attendance-only principal', async () => {
    expect((await request(app).get(endpoint()).query(range)).status).toBe(401);
    await prisma.role.updateMany({ data: { permissions: { set: ['attendance.read'] } } });
    invalidatePrincipal();
    const r = await f.agent.get(endpoint()).query(range);
    expect(r.status).toBe(200);
    expect(r.body.data.costs).toBeNull();
    expect(r.body.data.period.people).toBe(3);
    expect(r.body.data.attendance).toHaveLength(31);
    const text = JSON.stringify(r.body);
    for (const privateField of ['monthly_gross', 'amount', 'statutory', 'password', 'token_version', 'salary_gross', 'bank']) expect(text).not.toContain(privateField);
  });

  it('validates real inclusive dates, reversed ranges, a maximum of 366 days, and UUIDs', async () => {
    for (const query of [{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-08-02', to: '2026-08-01' },
      { from: '2025-01-01', to: '2026-01-02' }]) {
      expect((await f.agent.get(endpoint()).query(query)).status).toBe(422);
    }
    expect((await f.agent.get('/api/v1/sites/not-a-uuid/insights').query(range)).status).toBe(422);
    expect((await f.agent.get(`/api/v1/sites/${crypto.randomUUID()}/insights`).query(range)).status).toBe(404);
  });

  it('uses complete-month denominators before filtering; day subdivisions reconcile exactly', async () => {
    const full = (await f.agent.get(endpoint()).query(range)).body.data;
    const first = (await f.agent.get(endpoint()).query({ from: '2026-08-01', to: '2026-08-15' })).body.data;
    const second = (await f.agent.get(endpoint()).query({ from: '2026-08-16', to: '2026-08-31' })).body.data;
    expect(full.costs.source).toBe('estimate');
    expect(full.costs.attribution).toBe('estimated');
    expect(full.costs.normal_wages).toBeGreaterThan(0);
    expect(full.costs.normal_wages).toBeLessThan(R(74000)); // Paid off-days have no invented site.
    expect(first.costs.normal_wages + second.costs.normal_wages).toBe(full.costs.normal_wages);
    expect(full.costs.trend.reduce((s, r) => s + r.total_wages, 0)).toBe(full.costs.total_wages);
    expect(full.costs.departments.reduce((s, r) => s + r.total_wages, 0)).toBe(full.costs.total_wages);
    expect(full.costs.unallocated_wages).toBe(R(74000) - full.costs.normal_wages);
    expect(full.costs.unallocated_scope).toBe('related_payroll_months');
  });

  it('keeps recorded monthly payroll money and department frozen, without live fallback for omitted people', async () => {
    const period = await prisma.payrollPeriod.create({ data: { period_ym: '2026-08', state: 'RUN' } });
    const historicalDepartment = await prisma.department.create({ data: { name: 'Original department', colour: '#13877e' } });
    await prisma.payslip.create({ data: {
      period_id: period.id, employee_id: f.employees.A, gross: BigInt(R(10500)), salary_gross: BigInt(R(10000)),
      adhoc_earnings: BigInt(R(500)), total_deductions: 0n, reimbursements: BigInt(R(9000)), net: BigInt(R(19500)),
      employer_total: 0n, ctc_month: BigInt(R(10000)), pf_wage: 0n, esi_applicable: false, paid_days: 31, lop_days: 0,
      divisor: 26, computed_at: new Date(), engine_version: 'test', meta: { department: { id: historicalDepartment.id, name: historicalDepartment.name }, ot: null },
      lines: { create: [
        { seq: 0, kind: 'COMPONENT', code: 'Basic', name: 'Basic', full_amount: BigInt(R(10000)), amount: BigInt(R(10000)), is_taxable: true, counts_as_wages: true },
        { seq: 1, kind: 'ADHOC', code: 'Bonus', name: 'Bonus', full_amount: BigInt(R(500)), amount: BigInt(R(500)), is_taxable: true, counts_as_wages: false },
        { seq: 2, kind: 'REIMBURSEMENT', code: 'REIMB', name: 'Expense', full_amount: BigInt(R(9000)), amount: BigInt(R(9000)), is_taxable: false, counts_as_wages: false },
      ] },
    } });
    await prisma.payrollPeriod.update({ where: { id: period.id }, data: { state: 'LOCKED' } });
    await prisma.employeeSalary.updateMany({ where: { employee_id: f.employees.A }, data: { amount: BigInt(R(40000)), monthly_gross: BigInt(R(40000)) } });
    const r = await f.agent.get(endpoint()).query(range);
    expect(r.status).toBe(200);
    const costs = r.body.data.costs;
    expect(costs.source).toBe('snapshot');
    expect(costs.normal_wages).toBe(R(10000));
    expect(costs.other_wages).toBe(R(500));
    expect(costs.total_wages).toBe(R(10500));
    expect(costs.uncosted_people).toBe(2);
    expect(costs.departments[0]).toMatchObject({ id: historicalDepartment.id, name: historicalDepartment.name, people: 1 });
  });

  it('keeps attendance visible and explicitly reports people without salary as uncosted', async () => {
    await prisma.employeeSalary.deleteMany({ where: { employee_id: f.employees.A } });
    const r = await f.agent.get(endpoint()).query(range);
    expect(r.status).toBe(200);
    expect(r.body.data.period.people).toBe(3);
    expect(r.body.data.costs.uncosted_people).toBe(1);
    expect(r.body.data.costs.uncosted_min).toBeGreaterThan(0);
  });

  it('counts currently IN departments rather than historical person-days and ignores future/stale punches', async () => {
    const now = new Date();
    const date = istDate(now);
    const records = [
      { id: f.employees.A, at: new Date(now.getTime() - 10 * 60_000) },
      { id: f.employees.B, at: new Date(now.getTime() + 10 * 60_000) },
      { id: f.employees.C, at: new Date(now.getTime() - 17 * 3600_000) },
    ];
    await prisma.punch.createMany({ data: records.map((p) => ({ employee_id: p.id, site_id: f.siteId, direction: 'IN', method: 'FACE',
      punched_at: p.at, client_punched_at: p.at, work_date: toDbDate(istDate(p.at)) })) });
    const data = await siteInsights(prisma, f.siteId, { from: date, to: date, now, financial: false });
    expect(data.on_site_now.map((p) => p.id)).toEqual([f.employees.A]);
    expect(data.departments).toEqual([{ id: f.deptId, name: 'Electrical', colour: expect.any(String), count: 1 }]);
    expect(data.today.on_site_now).toBe(1);
    expect(data.site.project_id).toBeNull();
    expect(data.site).toHaveProperty('created_on');
    expect(data.site).toHaveProperty('tablet_signed_in');
  });

  it('attributes an interval closed at another site to its IN site without inventing attendance there', async () => {
    const beta = await prisma.site.create({ data: { code: 'BETA', name: 'Beta', state: 'Andhra Pradesh', lat: 16, lng: 80, radius_m: 400, login: 'site-beta', password_hash: 'unused' } });
    const date = '2026-09-01';
    const inAt = new Date(istMidnight(date).getTime() + 540 * 60_000);
    const outAt = new Date(istMidnight(date).getTime() + 1080 * 60_000);
    await prisma.punch.createMany({ data: [{ site_id: f.siteId, direction: 'IN', punched_at: inAt }, { site_id: beta.id, direction: 'OUT', punched_at: outAt }]
      .map((p) => ({ ...p, employee_id: f.employees.A, client_punched_at: p.punched_at, work_date: toDbDate(date), method: 'FACE' })) });
    const alpha = (await f.agent.get(endpoint()).query({ from: date, to: date })).body.data;
    const other = (await f.agent.get(`/api/v1/sites/${beta.id}/insights`).query({ from: date, to: date })).body.data;
    expect(alpha.period.worked_min).toBe(540);
    expect(other.period.worked_min).toBe(0);
    expect(other.period.people).toBe(0);
    expect(other.attendance[0].punched_in).toBe(0);
    expect(other.costs.total_wages).toBe(0);
  });
});
