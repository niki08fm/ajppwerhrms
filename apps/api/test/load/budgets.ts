/**
 * Performance budgets (spec §15), measured against the load-test database.
 * These are failing tests, not aspirations: the script exits 1 if any budget is missed.
 *
 *   DATABASE_URL=…/ajpwer_load npm run test:load --workspace=@ajpwer/api
 */
import request from 'supertest';
import { addMonths, istDate, ymOf } from '@ajpwer/shared';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../../src/app');
const { prisma } = await import('../../src/lib/prisma');
const { hashPassword } = await import('../../src/lib/auth');

const app = createApp();
const agent = request.agent(app);

// A dedicated login for the run, so the seeded admin's password is not needed.
const role = await prisma.role.findFirstOrThrow({ where: { name: 'HR Admin' } });
const email = 'load-test@ajpwer.local';
const password = 'load-test-password';
await prisma.appUser.upsert({ where: { email }, update: { password_hash: await hashPassword(password) }, create: { email, name: 'Load test', password_hash: await hashPassword(password), role_id: role.id } });
const login = await agent.post('/api/v1/auth/login').send({ email, password });
if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);

const today = istDate(new Date());
const lastMonth = addMonths(ymOf(today), -1);
const anyEmployee = (await prisma.employee.findFirstOrThrow({ where: { status: 'ACTIVE' } })).id;

interface Result {
  action: string;
  budgetMs: number;
  ms: number;
  ok: boolean;
}
const results: Result[] = [];

async function measure(action: string, budgetMs: number, fn: () => Promise<{ status: number } | unknown>, runs = 3) {
  await fn(); // warm
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = (await fn()) as { status?: number };
    times.push(performance.now() - t);
    if (r && typeof r.status === 'number' && r.status >= 400) throw new Error(`${action}: HTTP ${r.status}`);
  }
  const ms = Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]);
  results.push({ action, budgetMs, ms, ok: ms <= budgetMs });
}

await measure('Any list first page (people)', 400, () => agent.get('/api/v1/employees?limit=50'));
await measure('Any list first page (punch log)', 400, () => agent.get('/api/v1/punches?limit=50'));
await measure('Any list first page (audit)', 400, () => agent.get('/api/v1/audit?limit=50'));
await measure('Search keystroke to results', 500, () => agent.get('/api/v1/employees?limit=50&q=kum'));
await measure('Employee profile open', 600, () => agent.get(`/api/v1/employees/${anyEmployee}`));
await measure('Attendance register, one month, 200 people', 1500, () => agent.get(`/api/v1/payroll/periods/${lastMonth}/attendance`), 2);
await measure('Attendance register, one day', 1500, () => agent.get(`/api/v1/attendance?date=${addMonths(ymOf(today), 0)}-02`));
await measure('Dashboard (today card)', 1000, () => agent.get('/api/v1/dashboard/today'));
await measure('Dashboard (trend, cached aggregates)', 1000, () => agent.get('/api/v1/dashboard/trend'));

// Payroll run: 200 payslips, in the background job, one transaction.
const { executeRun, transition } = await import('../../src/services/payroll');
await prisma.payrollPeriod.upsert({ where: { period_ym: lastMonth }, update: {}, create: { period_ym: lastMonth } });
const p = await prisma.payrollPeriod.findUniqueOrThrow({ where: { period_ym: lastMonth } });
if (p.state === 'PAID') await transition(lastMonth, 'unmark_paid', 'load', null);
if (p.state === 'PAID' || p.state === 'LOCKED') await transition(lastMonth, 'unlock', 'load', null);
await prisma.payrollPeriod.update({ where: { period_ym: lastMonth }, data: { steps_submitted: [1, 2, 3, 4] } });
{
  const t = performance.now();
  const { totals } = await executeRun(lastMonth, 'load-test');
  const ms = Math.round(performance.now() - t);
  results.push({ action: `Payroll run, ${totals.headcount} payslips`, budgetMs: 30_000, ms, ok: ms <= 30_000 });
}
await measure('Report export, register CSV', 3000, () => agent.get(`/api/v1/payroll/periods/${lastMonth}/report/register?format=csv`));

const width = Math.max(...results.map((r) => r.action.length));
console.log('\nPerformance budgets (median)\n');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.action.padEnd(width)}  ${String(r.ms).padStart(6)} ms  (budget ${r.budgetMs} ms)`);
const punches = await prisma.punch.count();
const employees = await prisma.employee.count();
console.log(`\nAgainst ${employees} employees and ${punches.toLocaleString('en-IN')} punches.`);
await prisma.$disconnect();
process.exit(results.every((r) => r.ok) ? 0 : 1);
