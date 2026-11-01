import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { env } from '../../src/config/env.js';
import { buildFixture } from './fixture.js';
let fixture,
  reads = null;
prisma.$use(async (params, next) => {
  if (reads) {
    reads.push(`${params.model ?? 'raw'}.${params.action}`);
    if (process.env.READ_LATENCY_MS) await new Promise(r => setTimeout(r, Number(process.env.READ_LATENCY_MS)));
  }
  return next(params);
});
beforeEach(async () => {
  fixture = await buildFixture();
});
afterEach(() => {
  reads = null;
});
afterAll(() => prisma.$disconnect());
describe('Action read performance', () => {
  for (const action of ['profile', 'pay', 'payroll-preview']) it(`keeps ${action} reads bounded`, async () => {
    reads = [];
    const start = performance.now();
    const route = action === 'profile' ? `/employees/${fixture.employees.A}` : action === 'pay' ? `/employees/${fixture.employees.A}/pay` : '/payroll/periods/2026-08/preview';
    const result = await fixture.agent.get('/api/v1' + route);
    const time = Math.round(performance.now() - start),
      captured = reads;
    reads = null;
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const count = Object.fromEntries([...new Set(captured)].sort().map(k => [k, captured.filter(x => x === k).length]));
    console.log(JSON.stringify({
      action,
      ms: time,
      queries: captured.length,
      count
    }));
    if (action === 'pay') expect(count['StatutoryRates.findFirst']).toBe(1);
    if (action === 'payroll-preview') {
      expect(count['EmployeeSalary.findFirst'] ?? 0).toBe(0);
      expect(count['EmployeeSalary.findMany']).toBe(1);
      expect(count['SalaryComponent.findMany']).toBe(1);
    }
  });
});
it('allows browsers to reuse preflight permission for JSON mutations', async () => {
  const origin = env.WEB_ORIGIN.split(',')[0];
  const result = await fixture.agent.options('/api/v1/employees').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
  expect(result.status).toBe(204);
  expect(result.headers['access-control-max-age']).toBe('600');
  expect(result.headers['access-control-allow-origin']).toBe(origin);
  expect(result.headers['access-control-allow-credentials']).toBe('true');
});
