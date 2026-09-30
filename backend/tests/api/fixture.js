import request from 'supertest';
import { AJPWER_LEAVE_TYPES, AJPWER_RATES, dayName, istMidnight, monthDates, PERMISSIONS, SEED_PT_SLABS, SEED_TAX_REGIMES } from '@ajpwer/shared';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/auth.service.js';
import { encryptPII, maskAadhaar } from '../../src/utils/crypto.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { prisma } from '../../src/config/db.js';

export const app = createApp();
export const R = (r) => r * 100;
export const YM = '2026-08';
const PASSWORD = 'test-password-1';

/** Wipe every table (the constraints migration's triggers opt out via the retention flag). */
export async function wipe() {
  const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$transaction([prisma.$executeRawUnsafe(`SET LOCAL ajpwer.retention = 'on'`), prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`)]);
}

/** A small company: one pay group, one site, five people with a month of punches. */
export async function buildFixture(opts = {}) {
  await wipe();
  const role = await prisma.role.create({ data: { name: 'HR Admin', permissions: [...PERMISSIONS] } });
  await prisma.appUser.create({ data: { email: 'hr@test.in', name: 'HR', password_hash: await hashPassword(PASSWORD), role_id: role.id } });
  await prisma.company.create({ data: { name: 'Test Co' } });
  await prisma.statutoryRates.create({ data: { valid_from: toDbDate('2025-04-01'), pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi, gratuity: AJPWER_RATES.gratuity, recovery_cap_pct: 40 } });
  await prisma.ptSlab.createMany({
    data: SEED_PT_SLABS.map((p) => ({
      ...p,
      upto_amount: p.upto_amount === null ? null : BigInt(p.upto_amount),
      amount: BigInt(p.amount),
      feb_amount: p.feb_amount === null ? null : BigInt(p.feb_amount),
    })),
  });
  for (const r of SEED_TAX_REGIMES) {
    await prisma.taxRegime.create({
      data: {
        code: r.code,
        name: r.name,
        valid_from: toDbDate('2025-04-01'),
        std_deduction: BigInt(r.std_deduction),
        rebate_limit: BigInt(r.rebate_limit),
        rebate_max: r.rebate_max === null ? null : BigInt(r.rebate_max),
        marginal_relief: r.marginal_relief,
        allows_80c: r.allows_80c,
        allows_hra: r.allows_hra,
        cess_pct: r.cess_pct,
        slabs: { create: r.slabs.map((s) => ({ upto_amount: s.upto_amount === null ? null : BigInt(s.upto_amount), rate: s.rate })) },
      },
    });
  }
  const dept = await prisma.department.create({ data: { name: 'Electrical' } });
  const shift = await prisma.shift.create({ data: { name: 'General', start_min: 540, end_min: 1050, break_min: 30 } });
  const structure = await prisma.salaryStructure.create({
    data: {
      name: 'Site staff',
      components: {
        create: [
          { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, counts_as_wages: true },
          { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 40 },
          { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0 },
        ],
      },
    },
  });
  const pol = (kind, rules) => prisma.policy.create({ data: { policy_key: crypto.randomUUID(), kind, name: kind, version: 1, valid_from: toDbDate('2025-04-01'), rules } });
  const policies = await Promise.all([
    pol('ATTENDANCE', { standard_min: 480, half_day_min: 240, grace_min: 15 }),
    pol('WEEKOFF_PAY', { paid: true, sandwich: false }),
    pol('HOLIDAY_PAY', { paid: true, sandwich: false }),
    pol('LEAVE', { types: AJPWER_LEAVE_TYPES }),
  ]);
  const group = await prisma.payGroup.create({
    data: {
      name: 'Site workforce',
      calendar_method: 'FIXED_26',
      weekly_off: ['SUN'],
      shift_id: shift.id,
      structure_id: structure.id,
      policies: { create: policies.map((p) => ({ policy_id: p.id })) },
    },
  });
  const site = await prisma.site.create({
    data: { code: 'ALPHA', name: 'Alpha', state: 'Andhra Pradesh', lat: 16.5062, lng: 80.648, radius_m: 400, login: 'site-alpha', password_hash: await hashPassword('site-pass-1') },
  });

  const people = [
    ['A', 20000, 'ACTIVE'],
    ['B', 24000, 'ACTIVE'],
    ['C', 30000, 'ACTIVE'],
    ['OFFER', 18000, 'OFFER'],
    ['ONBOARD', 18000, 'ONBOARDING'],
  ];
  const employees = {};
  let i = 0;
  for (const [key, gross, status] of people) {
    i++;
    const noBank = opts.noBankFor?.includes(key);
    const e = await prisma.employee.create({
      data: {
        code: `T${String(i).padStart(3, '0')}`,
        name: `Person ${key}`,
        gender: 'MALE',
        phone: '9000000000',
        department_id: dept.id,
        designation: 'Electrician',
        pay_group_id: group.id,
        status: status,
        joined_on: toDbDate('2025-01-01'),
        statutory: { create: { pt_state: 'Andhra Pradesh', esi_enabled: R(gross) <= AJPWER_RATES.esi.ceiling } },
        identity: {
          create: {
            pan_enc: encryptPII('ABCDE1234F'),
            aadhaar_enc: encryptPII('123412341234'),
            aadhaar_masked: maskAadhaar('123412341234'),
            uan: '100000000001',
            bank_account_enc: noBank ? null : encryptPII('12345678901'),
            bank_last4: noBank ? null : '8901',
            bank_ifsc: noBank ? null : 'SBIN0001234',
          },
        },
        salaries: { create: { valid_from: toDbDate('2025-01-01'), mode: 'GROSS', amount: BigInt(R(gross)), monthly_gross: BigInt(R(gross)), structure_id: structure.id, reason: 'Initial' } },
      },
    });
    employees[key] = e.id;
    if (status === 'ACTIVE') {
      const rows = monthDates(YM)
        .filter((d) => dayName(d) !== 'SUN' && d !== '2026-08-15')
        .flatMap((d) =>
          [
            { dir: 'IN', min: 540 },
            { dir: 'OUT', min: 1050 },
          ].map(({ dir, min }) => {
            const at = new Date(istMidnight(d).getTime() + min * 60_000);
            return { employee_id: e.id, site_id: site.id, direction: dir, punched_at: at, client_punched_at: at, work_date: toDbDate(d), method: 'FACE' };
          }),
        );
      await prisma.punch.createMany({ data: rows });
    }
  }
  await prisma.holiday.create({ data: { date: toDbDate('2026-08-15'), name: 'Independence Day' } });

  const agent = request.agent(app);
  const login = await agent.post('/api/v1/auth/login').send({ email: 'hr@test.in', password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return { agent, payGroupId: group.id, structureId: structure.id, siteId: site.id, deptId: dept.id, employees };
}

export async function submitSteps(agent, ym, upto) {
  for (let s = 1; s <= upto; s++) {
    const r = await agent.post(`/api/v1/payroll/periods/${ym}/steps/${s}/submit`);
    if (r.status !== 200) throw new Error(`step ${s}: ${JSON.stringify(r.body)}`);
  }
}

/** Start a run and wait for its job to finish. */
export async function runAndWait(agent, ym) {
  const r = await agent.post(`/api/v1/payroll/periods/${ym}/run`);
  if (r.status !== 202) throw new Error(`run: ${r.status} ${JSON.stringify(r.body)}`);
  return waitJob(agent, r.body.data.job_id);
}

export async function waitJob(agent, jobId) {
  for (let i = 0; i < 200; i++) {
    const j = await agent.get(`/api/v1/jobs/${jobId}`);
    if (j.body.data.status === 'DONE' || j.body.data.status === 'FAILED') return j.body.data;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('job did not finish');
}
