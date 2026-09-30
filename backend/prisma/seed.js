/**
 * Development seed. Creates the admin, company, setup (policies, structures, pay
 * groups, statutory rates, PT slabs, tax regimes), sites and projects, and ~34
 * people with three months of punches — including every case spec §20 requires:
 *
 *  - one paid on gross, one on CTC
 *  - one on the old regime with declarations, the rest on the new
 *  - one above the PF ceiling with restrict-to-ceiling off
 *  - people under and above the ESI ceiling
 *  - a cross-site day, a worked holiday, a worked weekly off
 *  - a mid-month joiner and a mid-month leaver
 *  - a loan large enough to hit the recovery cap
 *  - a missing bank account (blocking issue) and an expired document
 *  - two people in the same crew in different PT states
 *
 * Run: npm run db:seed   (on a freshly migrated database)
 */
import {
  generateSitePassword,
  addDays,
  addMonths,
  AJPWER_LEAVE_TYPES,
  AJPWER_RATES,
  dayName,
  firstOfMonth,
  istDate,
  istMidnight,
  lastOfMonth,
  monthDates,
  SEED_PT_SLABS,
  SEED_TAX_REGIMES,
  STATUTORY_MINIMUM_RATES,
  ymOf,
  PERMISSIONS,
} from '@ajpwer/shared';
import { PrismaClient } from '@prisma/client';

process.env.NODE_ENV ??= 'development';
const prisma = new PrismaClient();

// Imported lazily so env validation runs after dotenv has loaded.
const { hashPassword } = await import('../src/services/auth.service.js');
const { encryptPII, maskAadhaar } = await import('../src/utils/crypto.js');
const { ctcForGross } = await import('../src/calculations/index.js');
const { toDbDate } = await import('../src/utils/dbDates.js');

// ─── Deterministic randomness ────────────────────────────────────────────────
let s = 20260930;
const rand = () => {
  s = (s * 1103515245 + 12345) & 0x7fffffff;
  return s / 0x7fffffff;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const digits = (k) => Array.from({ length: k }, () => Math.floor(rand() * 10)).join('');
const letters = (k) => Array.from({ length: k }, () => String.fromCharCode(65 + Math.floor(rand() * 26))).join('');
const R = (rupees) => rupees * 100;

const TODAY = istDate(new Date());
const M0 = ymOf(TODAY);
const M1 = addMonths(M0, -1);
const M2 = addMonths(M0, -2);
const M3 = addMonths(M0, -3);
const START = firstOfMonth(M3);

async function main() {
  const existing = await prisma.appUser.count();
  if (existing > 0 && !process.argv.includes('--force')) {
    console.log(
      'Database already has data, so the sample data is not loaded again. To start over with fresh sample data: `npm run db:reset`, then `npm run db:seed`. Pass --force to add to it anyway.',
    );
    return;
  }

  // ── Access ────────────────────────────────────────────────────────────────
  const role = await prisma.role.upsert({ where: { name: 'HR Admin' }, update: { permissions: [...PERMISSIONS] }, create: { name: 'HR Admin', permissions: [...PERMISSIONS] } });
  await prisma.role.upsert({
    where: { name: 'Accounts (read-only payroll)' },
    update: {},
    create: { name: 'Accounts (read-only payroll)', permissions: ['people.read', 'salary.read', 'payroll.read', 'reports.export', 'attendance.read', 'setup.read'] },
  });
  const email = (process.env.ADMIN_EMAIL ?? 'hr@ajpwer.in').toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? 'change-me-now';
  await prisma.appUser.upsert({
    where: { email },
    update: {},
    create: { email, name: process.env.ADMIN_NAME ?? 'HR Admin', password_hash: await hashPassword(password), role_id: role.id },
  });

  await prisma.company.create({
    data: {
      name: process.env.COMPANY_NAME || 'AJ Power Engineering',
      address: process.env.COMPANY_ADDRESS || 'Plot 12, Industrial Estate, Vijayawada, Andhra Pradesh 520007',
      pan: process.env.COMPANY_PAN || null,
      tan: process.env.COMPANY_TAN || null,
      pf_code: process.env.COMPANY_PF_CODE || null,
      esi_code: process.env.COMPANY_ESI_CODE || null,
    },
  });

  // ── Calendar ──────────────────────────────────────────────────────────────
  const depts = Object.fromEntries(
    await Promise.all(
      [
        ['Electrical', 'chart-1'],
        ['Civil', 'chart-2'],
        ['Mechanical', 'chart-3'],
        ['Planning', 'chart-4'],
        ['Safety', 'chart-5'],
        ['Administration', 'chart-2'],
      ].map(async ([name, colour]) => [name, await prisma.department.create({ data: { name, colour } })]),
    ),
  );
  const general = await prisma.shift.create({ data: { name: 'General 09:00–17:30', start_min: 540, end_min: 1050, break_min: 30 } });
  await prisma.shift.create({ data: { name: 'Early 07:00–15:30', start_min: 420, end_min: 930, break_min: 30 } });
  await prisma.shift.create({ data: { name: 'Night 21:00–05:30', start_min: 1260, end_min: 330, break_min: 30, crosses_midnight: true } });

  const holidays = [
    ['2026-01-26', 'Republic Day'],
    ['2026-03-04', 'Holi'],
    ['2026-04-03', 'Good Friday'],
    ['2026-05-01', 'May Day'],
    ['2026-08-15', 'Independence Day'],
    ['2026-09-14', 'Vinayaka Chavithi'],
    ['2026-10-02', 'Gandhi Jayanti'],
    ['2026-10-20', 'Vijayadashami'],
    ['2026-11-08', 'Deepavali'],
    ['2026-12-25', 'Christmas'],
  ];
  // Make sure the current month has a holiday so a "worked holiday" case exists.
  const m0Holiday =
    holidays.find(([d]) => ymOf(d) === M0)?.[0] ??
    (() => {
      let d = `${M0}-12`;
      while (dayName(d) === 'SUN') d = addDays(d, 1);
      holidays.push([d, 'Company holiday']);
      return d;
    })();
  for (const [date, name] of holidays) await prisma.holiday.upsert({ where: { date: toDbDate(date) }, update: {}, create: { date: toDbDate(date), name } });
  const holidaySet = new Set(holidays.map(([d]) => d));

  // ── Statutory ─────────────────────────────────────────────────────────────
  await prisma.statutoryRates.create({
    data: { valid_from: toDbDate('2025-04-01'), pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi, gratuity: AJPWER_RATES.gratuity, recovery_cap_pct: AJPWER_RATES.recovery_cap_pct },
  });
  void STATUTORY_MINIMUM_RATES;
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
        slabs: { create: r.slabs.map((sl) => ({ upto_amount: sl.upto_amount === null ? null : BigInt(sl.upto_amount), rate: sl.rate })) },
      },
    });
  }

  // ── Salary structures ─────────────────────────────────────────────────────
  const site = await prisma.salaryStructure.create({
    data: {
      name: 'Site staff',
      components: {
        create: [
          { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, is_taxable: true, counts_as_wages: true, colour: 'chart-1' },
          { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 40, is_taxable: true, counts_as_wages: false, colour: 'chart-2' },
          { seq: 3, name: 'Conveyance', calc_type: 'FIXED', calc_value: R(1600), is_taxable: true, counts_as_wages: false, colour: 'chart-3' },
          { seq: 4, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0, is_taxable: true, counts_as_wages: false, colour: 'chart-4' },
        ],
      },
    },
  });
  const office = await prisma.salaryStructure.create({
    data: {
      name: 'Office staff',
      components: {
        create: [
          { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 40, is_taxable: true, counts_as_wages: true, colour: 'chart-1' },
          { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 50, is_taxable: true, counts_as_wages: false, colour: 'chart-2' },
          { seq: 3, name: 'Medical', calc_type: 'FIXED', calc_value: R(1250), is_taxable: true, counts_as_wages: false, colour: 'chart-3' },
          { seq: 4, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0, is_taxable: true, counts_as_wages: false, colour: 'chart-4' },
          { seq: 5, name: 'Annual bonus', calc_type: 'PCT_BASIC', calc_value: 8.33, frequency: 'YEARLY', pay_month: 10, is_taxable: true, counts_as_wages: false, colour: 'chart-5' },
        ],
      },
    },
  });

  // A structure built the other way round, for people hired on a CTC: basic is a
  // share of CTC, HRA is capped, and the Special Allowance takes the rest.
  await prisma.salaryStructure.create({
    data: {
      name: 'Managers (CTC based)',
      components: {
        create: [
          { seq: 1, name: 'Basic', calc_type: 'PCT_CTC', calc_value: 40, is_taxable: true, counts_as_wages: true, colour: 'chart-1' },
          { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 50, max_amount: R(20000), is_taxable: true, counts_as_wages: false, colour: 'chart-2' },
          { seq: 3, name: 'Conveyance', calc_type: 'FIXED', calc_value: R(1600), is_taxable: true, counts_as_wages: false, colour: 'chart-3' },
          { seq: 4, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0, is_taxable: true, counts_as_wages: false, colour: 'chart-4' },
        ],
      },
    },
  });

  // ── Policies (grace changes 15 → 10 minutes on 1 April 2026: two versions) ─
  const key = () => crypto.randomUUID();
  const attKey = key();
  const att1 = await prisma.policy.create({
    data: {
      policy_key: attKey,
      kind: 'ATTENDANCE',
      name: 'Standard 8-hour day',
      version: 1,
      valid_from: toDbDate('2025-04-01'),
      valid_to: toDbDate('2026-03-31'),
      rules: { standard_min: 480, half_day_min: 240, grace_min: 15 },
      created_by: 'seed',
    },
  });
  const att2 = await prisma.policy.create({
    data: {
      policy_key: attKey,
      kind: 'ATTENDANCE',
      name: 'Standard 8-hour day',
      version: 2,
      valid_from: toDbDate('2026-04-01'),
      rules: { standard_min: 480, half_day_min: 240, grace_min: 10 },
      created_by: 'seed',
    },
  });
  const ot = await prisma.policy.create({
    data: {
      policy_key: key(),
      kind: 'OVERTIME',
      name: 'Site overtime 2× basic + HRA',
      version: 1,
      valid_from: toDbDate('2025-04-01'),
      rules: { multiplier: 2, base: 'BASIC_HRA', divisor: null, hours_per_day: 8, after_min: 30, rounding_min: 30, monthly_cap_min: 3000 },
      created_by: 'seed',
    },
  });
  const woff = await prisma.policy.create({
    data: { policy_key: key(), kind: 'WEEKOFF_PAY', name: 'Paid Sunday with sandwich', version: 1, valid_from: toDbDate('2025-04-01'), rules: { paid: true, sandwich: true }, created_by: 'seed' },
  });
  const woffOffice = await prisma.policy.create({
    data: { policy_key: key(), kind: 'WEEKOFF_PAY', name: 'Paid weekly off', version: 1, valid_from: toDbDate('2025-04-01'), rules: { paid: true, sandwich: false }, created_by: 'seed' },
  });
  const hpay = await prisma.policy.create({
    data: { policy_key: key(), kind: 'HOLIDAY_PAY', name: 'Paid holidays', version: 1, valid_from: toDbDate('2025-04-01'), rules: { paid: true, sandwich: false }, created_by: 'seed' },
  });
  const hwork = await prisma.policy.create({
    data: {
      policy_key: key(),
      kind: 'HOLIDAY_WORK',
      name: 'Off-day work 200%',
      version: 1,
      valid_from: toDbDate('2025-04-01'),
      rules: { holiday: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 }, weekly_off: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 } },
      created_by: 'seed',
    },
  });
  const late = await prisma.policy.create({
    data: {
      policy_key: key(),
      kind: 'LATE_PENALTY',
      name: 'Three free, then slabs',
      version: 1,
      valid_from: toDbDate('2025-04-01'),
      rules: {
        free_per_month: 3,
        slabs: [
          { from_min: 1, to_min: 30, deduct_days: 0.25 },
          { from_min: 31, to_min: 120, deduct_days: 0.5 },
          { from_min: 121, to_min: null, deduct_days: 1 },
        ],
      },
      created_by: 'seed',
    },
  });
  const leave = await prisma.policy.create({
    data: { policy_key: key(), kind: 'LEAVE', name: 'AJPWER leave', version: 1, valid_from: toDbDate('2025-04-01'), rules: { types: AJPWER_LEAVE_TYPES }, created_by: 'seed' },
  });

  const siteGroup = await prisma.payGroup.create({
    data: {
      name: 'Site workforce',
      calendar_method: 'FIXED_26',
      weekly_off: ['SUN'],
      shift_id: general.id,
      structure_id: site.id,
      pay_day: 7,
      policies: { create: [att1, att2, ot, woff, hpay, hwork, late, leave].map((p) => ({ policy_id: p.id })) },
    },
  });
  const officeGroup = await prisma.payGroup.create({
    data: {
      name: 'Head office',
      calendar_method: 'ACTUAL',
      weekly_off: ['SUN'],
      shift_id: general.id,
      structure_id: office.id,
      pay_day: 1,
      // No overtime policy: the group card warns that nobody here earns overtime.
      policies: { create: [att1, att2, woffOffice, hpay, late, leave].map((p) => ({ policy_id: p.id })) },
    },
  });

  // ── Projects and sites ────────────────────────────────────────────────────
  const alphaP = await prisma.project.create({
    data: {
      code: 'P-ALPHA',
      name: 'Alpha 132 kV substation',
      client: 'APTRANSCO',
      contract_value: BigInt(R(42_000_000)),
      budget_labour: BigInt(R(6_500_000)),
      material_cost: BigInt(R(24_000_000)),
      other_cost: BigInt(R(2_500_000)),
      started_on: toDbDate('2025-11-01'),
    },
  });
  const betaP = await prisma.project.create({
    data: {
      code: 'P-BETA',
      name: 'Beta 33 kV line',
      client: 'APCPDCL',
      contract_value: BigInt(R(18_000_000)),
      budget_labour: BigInt(R(3_200_000)),
      material_cost: BigInt(R(9_000_000)),
      other_cost: BigInt(R(900_000)),
      started_on: toDbDate('2026-02-15'),
    },
  });
  const sitePasswords = {};
  const mkSite = async (code, name, state, lat, lng, radius, project) => {
    const pw = process.env[`SEED_SITE_PASSWORD_${code.replace(/-/g, '_')}`] ?? generateSitePassword();
    sitePasswords[code] = pw;
    return prisma.site.create({ data: { code, name, state, lat, lng, radius_m: radius, project_id: project, login: `site-${code.toLowerCase()}`, password_hash: await hashPassword(pw) } });
  };
  const alpha = await mkSite('ALPHA', 'Alpha substation', 'Andhra Pradesh', 16.5062, 80.648, 400, alphaP.id);
  const beta = await mkSite('BETA', 'Beta line camp', 'Andhra Pradesh', 16.5731, 80.7101, 500, betaP.id);
  const gamma = await mkSite('GAMMA', 'Gamma stores yard', 'Andhra Pradesh', 16.4807, 80.6011, 250, null);
  const ho = await mkSite('HO', 'Head office', 'Telangana', 17.385, 78.4867, 150, null);

  const firsts = [
    'Ravi',
    'Suresh',
    'Lakshmi',
    'Venkat',
    'Srinivas',
    'Anil',
    'Priya',
    'Mahesh',
    'Ramesh',
    'Kiran',
    'Sravani',
    'Naresh',
    'Gopal',
    'Padma',
    'Rajesh',
    'Satish',
    'Divya',
    'Prasad',
    'Harish',
    'Madhavi',
    'Vamsi',
    'Bhaskar',
    'Anjali',
    'Chandra',
    'Durga',
    'Eswar',
  ];
  const lasts = ['Kumar', 'Reddy', 'Naidu', 'Rao', 'Chowdary', 'Varma', 'Sastry', 'Prasad', 'Babu', 'Murthy'];
  const femaleNames = new Set(['Lakshmi', 'Priya', 'Sravani', 'Padma', 'Divya', 'Madhavi', 'Anjali', 'Durga']);
  const people = [];
  const crew = [
    ['Electrical', 'Lineman', 17000],
    ['Electrical', 'Electrician', 19500],
    ['Electrical', 'Electrician', 21000],
    ['Electrical', 'Foreman', 26000],
    ['Civil', 'Mason', 16500],
    ['Civil', 'Site engineer', 34000],
    ['Mechanical', 'Fitter', 18500],
    ['Mechanical', 'Rigger', 17500],
    ['Safety', 'Safety officer', 28000],
  ];
  for (let i = 0; i < 22; i++) {
    const [dept, designation, gross] = crew[i % crew.length];
    const first = firsts[i % firsts.length];
    people.push({
      name: `${first} ${pick(lasts)}`,
      gender: femaleNames.has(first) ? 'FEMALE' : 'MALE',
      dept,
      designation,
      group: 'site',
      mode: 'GROSS',
      amount: R(gross + Math.floor(rand() * 8) * 250),
      joined: pick(['2021-06-01', '2022-03-14', '2023-01-09', '2024-07-01', '2025-02-10', '2025-09-01']),
      pt_state: 'Andhra Pradesh',
      home: pick(['ALPHA', 'ALPHA', 'BETA', 'BETA', 'GAMMA']),
    });
  }
  // Two in the same crew in different PT states.
  people[1].pt_state = 'Telangana';
  people[1].tag = 'pt-telangana';
  people[10].tag = 'pt-ap-same-crew';
  // Cross-site worker.
  people[3].tag = 'cross-site';
  // Holiday and weekly-off workers.
  people[4].tag = 'holiday-worker';
  people[5].tag = 'weekoff-worker';
  // Loan large enough to hit the recovery cap.
  people[6].tag = 'big-loan';
  // Expired document.
  people[7].tag = 'expired-doc';
  // Near the gratuity threshold (4 years 9 months at the end of this month) — on notice.
  people.push({
    name: 'Bhaskar Rao',
    gender: 'MALE',
    dept: 'Mechanical',
    designation: 'Welder',
    group: 'site',
    mode: 'GROSS',
    amount: R(22000),
    joined: addDays(addMonths(M0, -57) + '-01', 0),
    pt_state: 'Andhra Pradesh',
    home: 'GAMMA',
    tag: 'leaver',
  });
  // Paid on CTC.
  people.push({
    name: 'Kavya Iyer',
    gender: 'FEMALE',
    dept: 'Planning',
    designation: 'Planning engineer',
    group: 'office',
    mode: 'CTC',
    amount: R(780000),
    joined: '2023-06-12',
    pt_state: 'Telangana',
    home: 'HO',
    tag: 'ctc',
  });
  // Old regime with declarations.
  people.push({
    name: 'Sridhar Murthy',
    gender: 'MALE',
    dept: 'Planning',
    designation: 'Senior planning engineer',
    group: 'office',
    mode: 'GROSS',
    amount: R(100000),
    joined: '2020-08-03',
    pt_state: 'Telangana',
    home: 'HO',
    regime: 'OLD',
    tag: 'old-regime',
  });
  // Above the PF ceiling with restrict-to-ceiling off.
  people.push({
    name: 'Arun Venkatesh',
    gender: 'MALE',
    dept: 'Electrical',
    designation: 'Project manager',
    group: 'office',
    mode: 'GROSS',
    amount: R(140000),
    joined: '2019-11-18',
    pt_state: 'Telangana',
    home: 'HO',
    pfOff: true,
    tag: 'pf-full-wages',
  });
  people.push({
    name: 'Meena Kumari',
    gender: 'FEMALE',
    dept: 'Administration',
    designation: 'HR executive',
    group: 'office',
    mode: 'GROSS',
    amount: R(32000),
    joined: '2022-05-02',
    pt_state: 'Telangana',
    home: 'HO',
  });
  people.push({
    name: 'Farhan Ali',
    gender: 'MALE',
    dept: 'Administration',
    designation: 'Accounts executive',
    group: 'office',
    mode: 'GROSS',
    amount: R(29000),
    joined: '2024-01-15',
    pt_state: 'Telangana',
    home: 'HO',
  });
  // Mid-month joiner in the current month, with no bank account yet (blocking issue).
  people.push({
    name: 'Naveen Babu',
    gender: 'MALE',
    dept: 'Electrical',
    designation: 'Lineman',
    group: 'site',
    mode: 'GROSS',
    amount: R(17000),
    joined: `${M0}-15`,
    pt_state: 'Andhra Pradesh',
    home: 'ALPHA',
    noBank: true,
    tag: 'joiner',
  });

  const groupOf = (p) => (p.group === 'site' ? siteGroup : officeGroup);
  const structureOf = (p) => (p.group === 'site' ? site : office);
  const siteByCode = { ALPHA: alpha, BETA: beta, GAMMA: gamma, HO: ho };

  const rates = { pf: AJPWER_RATES.pf, esi: AJPWER_RATES.esi };
  const components = async (structureId) =>
    (await prisma.salaryComponent.findMany({ where: { structure_id: structureId }, orderBy: { seq: 'asc' } })).map((c) => ({
      ...c,
      calc_value: Number(c.calc_value),
      max_amount: c.max_amount === null ? null : Number(c.max_amount),
    }));

  const created = [];
  let seq = 0;
  for (const p of people) {
    seq++;
    const code = `AJ${String(seq).padStart(4, '0')}`;
    const comps = await components(structureOf(p).id);
    const pfChoice = { pf_enabled: true, pf_restrict_to_ceiling: !p.pfOff, vpf_pct: 0 };
    let monthly = p.amount;
    if (p.mode === 'CTC') {
      const { solveGrossFromCtc } = await import('../src/calculations/index.js');
      monthly = solveGrossFromCtc(p.amount, { components: comps, pf: pfChoice, esi_enabled: true, rates }).gross;
    }
    void ctcForGross;
    const pan = `${letters(5)}${digits(4)}${letters(1)}`;
    const aadhaar = digits(12);
    const acct = digits(11);
    const status = p.tag === 'joiner' ? (TODAY >= p.joined ? 'ACTIVE' : 'ONBOARDING') : p.tag === 'leaver' ? 'NOTICE' : 'ACTIVE';
    const e = await prisma.employee.create({
      data: {
        code,
        name: p.name,
        gender: p.gender,
        dob: toDbDate(`${1975 + Math.floor(rand() * 25)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 27)).padStart(2, '0')}`),
        phone: `9${digits(9)}`,
        email: `${p.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.in`,
        address: `${Math.floor(rand() * 200) + 1}, Main Road, ${p.pt_state === 'Telangana' ? 'Hyderabad' : 'Vijayawada'}`,
        blood_group: pick(['A+', 'B+', 'O+', 'AB+', 'O-']),
        department_id: depts[p.dept].id,
        designation: p.designation,
        pay_group_id: groupOf(p).id,
        status,
        joined_on: toDbDate(p.joined),
        activated_at: status === 'ACTIVE' ? new Date() : null,
        notice_days: 30,
        statutory: {
          create: {
            pf_enabled: true,
            pf_restrict_to_ceiling: !p.pfOff,
            esi_enabled: monthly <= AJPWER_RATES.esi.ceiling,
            pt_state: p.pt_state,
            tax_regime_code: p.regime ?? 'NEW',
            decl_80c: BigInt(p.regime === 'OLD' ? R(150000) : 0),
            decl_80d: BigInt(p.regime === 'OLD' ? R(25000) : 0),
            decl_rent_monthly: BigInt(p.regime === 'OLD' ? R(22000) : 0),
            decl_metro: false,
          },
        },
        identity: {
          create: {
            pan_enc: encryptPII(pan),
            aadhaar_enc: encryptPII(aadhaar),
            aadhaar_masked: maskAadhaar(aadhaar),
            uan: `1${digits(11)}`,
            esi_number: monthly <= AJPWER_RATES.esi.ceiling ? digits(10) : null,
            bank_account_enc: p.noBank ? null : encryptPII(acct),
            bank_last4: p.noBank ? null : acct.slice(-4),
            bank_ifsc: p.noBank ? null : pick(['SBIN0001234', 'HDFC0002345', 'ICIC0003456', 'UBIN0804567']),
            bank_name: p.noBank ? null : pick(['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Union Bank of India']),
          },
        },
        salaries: {
          create: {
            valid_from: toDbDate(p.joined),
            mode: p.mode,
            amount: BigInt(p.amount),
            monthly_gross: BigInt(monthly),
            structure_id: structureOf(p).id,
            reason: 'Initial salary',
            created_by: 'seed',
          },
        },
        onboarding_tasks: {
          create: ['PERSONAL', 'IDENTITY', 'BANK', 'PAY', 'JOINING_LETTER', 'FACE', 'STATUTORY']
            .filter((t) => !(p.noBank && t === 'BANK'))
            .map((t) => ({ task_code: t, done_at: new Date(), done_by: 'seed' })),
        },
      },
    });
    // Face embeddings (random, for demo data only — real enrolment happens on the profile).
    const v = Array.from({ length: 128 }, () => rand() * 2 - 1);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    await prisma.employeeFace.create({ data: { employee_id: e.id, embedding: Buffer.from(new Float32Array(v.map((x) => x / norm)).buffer), model_version: 'seed-random', consent_at: new Date() } });
    created.push({ p, id: e.id, code });
  }

  // A salary revision effective the first of last month, for one person (history on the profile).
  const rev = created[2];
  const oldSal = await prisma.employeeSalary.findFirstOrThrow({ where: { employee_id: rev.id } });
  await prisma.employeeSalary.update({ where: { id: oldSal.id }, data: { valid_to: toDbDate(addDays(firstOfMonth(M1), -1)) } });
  const raised = Number(oldSal.monthly_gross) + R(1500);
  await prisma.employeeSalary.create({
    data: {
      employee_id: rev.id,
      valid_from: toDbDate(firstOfMonth(M1)),
      mode: 'GROSS',
      amount: BigInt(raised),
      monthly_gross: BigInt(raised),
      structure_id: oldSal.structure_id,
      reason: 'Annual increment',
      created_by: 'seed',
    },
  });

  // ── Documents ─────────────────────────────────────────────────────────────
  for (const c of created) {
    for (const t of ['PAN', 'AADHAAR', 'BANK_PROOF', 'PHOTO']) {
      if (c.p.noBank && t === 'BANK_PROOF') continue;
      await prisma.document.create({ data: { employee_id: c.id, doc_type: t, collected_on: toDbDate(c.p.joined), verified_at: new Date() } });
    }
    if (c.p.group === 'site') {
      const expired = c.p.tag === 'expired-doc';
      await prisma.document.create({
        data: { employee_id: c.id, doc_type: 'SAFETY_CERT', collected_on: toDbDate('2025-06-01'), expires_on: toDbDate(expired ? addDays(TODAY, -20) : '2027-05-31'), verified_at: new Date() },
      });
    }
  }

  // ── Loans and advances ────────────────────────────────────────────────────
  const loanee = created.find((c) => c.p.tag === 'big-loan');
  await prisma.loan.create({
    data: { employee_id: loanee.id, loan_type: 'Personal loan', principal: BigInt(R(120000)), months: 10, emi: BigInt(R(12000)), started_on: toDbDate(firstOfMonth(M1)), created_by: 'seed' },
  });
  await prisma.advance.create({
    data: { employee_id: created[8].id, amount: BigInt(R(10000)), reason: 'Festival advance', granted_on: toDbDate(firstOfMonth(M1)), instalment: BigInt(R(2500)), created_by: 'seed' },
  });

  // ── Leave ─────────────────────────────────────────────────────────────────
  const onLeave = created[9];
  await prisma.leaveRequest.create({
    data: {
      employee_id: onLeave.id,
      leave_type: 'CL',
      from_date: toDbDate(`${M1}-11`),
      to_date: toDbDate(`${M1}-12`),
      days: 2,
      reason: 'Family function',
      status: 'APPROVED',
      decided_by: email,
      decided_at: new Date(),
    },
  });
  await prisma.leaveRequest.create({
    data: {
      employee_id: created[11].id,
      leave_type: 'SL',
      from_date: toDbDate(`${M0}-08`),
      to_date: toDbDate(`${M0}-08`),
      days: 1,
      reason: 'Fever',
      status: 'APPROVED',
      decided_by: email,
      decided_at: new Date(),
    },
  });
  await prisma.leaveRequest.create({
    data: { employee_id: created[12].id, leave_type: 'PL', from_date: toDbDate(addDays(TODAY, 5)), to_date: toDbDate(addDays(TODAY, 7)), days: 3, reason: 'Travel home', status: 'PENDING' },
  });

  // ── Punches ───────────────────────────────────────────────────────────────
  const at = (date, hhmm) => new Date(istMidnight(date).getTime() + hhmm * 60_000);
  const punches = [];
  const add = (empId, date, min, dir, siteCode) => {
    const t = at(date, min);
    punches.push({
      employee_id: empId,
      punched_at: t,
      client_punched_at: t,
      work_date: toDbDate(date),
      direction: dir,
      site_id: siteByCode[siteCode].id,
      method: 'FACE',
      match_score: Math.round((0.6 + rand() * 0.35) * 1e6) / 1e6,
      distance_m: Math.floor(rand() * 120),
      device_id: `tablet-${siteCode.toLowerCase()}`,
    });
  };
  const leaverLastDay = `${M0}-18`;
  for (const c of created) {
    const from = c.p.joined > START ? c.p.joined : START;
    for (let d = from; d <= TODAY; d = addDays(d, 1)) {
      if (c.p.tag === 'leaver' && d > leaverLastDay) break;
      const off = dayName(d) === 'SUN' || holidaySet.has(d);
      const isToday = d === TODAY;
      // Special off-day workers in the current month.
      if (off) {
        if (c.p.tag === 'holiday-worker' && d === m0Holiday) {
          add(c.id, d, 480 + Math.floor(rand() * 20), 'IN', c.p.home);
          add(c.id, d, 1020 + Math.floor(rand() * 60), 'OUT', c.p.home);
        }
        if (c.p.tag === 'weekoff-worker' && ymOf(d) === M0 && dayName(d) === 'SUN' && d.slice(8) >= '15' && d.slice(8) <= '21') {
          add(c.id, d, 480, 'IN', c.p.home);
          add(c.id, d, 1000, 'OUT', c.p.home);
        }
        continue;
      }
      const leaveDay = (c.id === onLeave.id && (d === `${M1}-11` || d === `${M1}-12`)) || (c.id === created[11].id && d === `${M0}-08`);
      if (leaveDay) continue;
      const r = rand();
      if (r < 0.04) continue; // absent
      const lateArrival = rand() < 0.1;
      const inMin = lateArrival ? 556 + Math.floor(rand() * 40) : 520 + Math.floor(rand() * 18);
      const home = c.p.home;
      if (c.p.tag === 'cross-site' && ymOf(d) >= M1 && rand() < 0.5) {
        // Morning at Alpha, afternoon at Beta: one day, both sites, cost split by minutes.
        add(c.id, d, inMin, 'IN', 'ALPHA');
        add(c.id, d, 780, 'OUT', 'ALPHA');
        add(c.id, d, 830, 'IN', 'BETA');
        if (!isToday) add(c.id, d, 1060 + Math.floor(rand() * 40), 'OUT', 'BETA');
        continue;
      }
      add(c.id, d, inMin, 'IN', home);
      if (isToday) continue; // still on site
      if (rand() < 0.02) continue; // forgot to punch out
      const overtime = c.p.group === 'site' && rand() < 0.18;
      const outMin = overtime ? 1110 + Math.floor(rand() * 90) : rand() < 0.03 ? 780 : 1052 + Math.floor(rand() * 25);
      add(c.id, d, outMin, 'OUT', home);
    }
  }
  for (let i = 0; i < punches.length; i += 2000) await prisma.punch.createMany({ data: punches.slice(i, i + 2000), skipDuplicates: true });

  // A face exception waiting in Approvals.
  await prisma.faceException.create({
    data: { site_id: alpha.id, occurred_at: at(TODAY, 492), best_match_id: created[0].id, score: 0.41, reason: 'Match below confidence threshold (helmet and glare)', direction: 'IN', distance_m: 35 },
  });

  // ── The leaver: on notice, last day mid-month ─────────────────────────────
  const leaver = created.find((c) => c.p.tag === 'leaver');
  await prisma.employee.update({
    where: { id: leaver.id },
    data: { resigned_on: toDbDate(addDays(leaverLastDay, -20)), last_day: toDbDate(leaverLastDay), notice_served_days: 21, exit_reason: 'RESIGNATION' },
  });

  console.log(`Seeded ${created.length} people and ${punches.length} punches from ${START} to ${TODAY}.`);

  // ── Past payroll: run and pay the two months before last, so reports and analytics have data ─
  process.env.LOG_LEVEL = 'warn';
  const payroll = await import('../src/services/payroll.service.js');
  const { upsertSettlement } = await import('../src/services/settlement.service.js');
  const { rebuildAggregates } = await import('../src/services/aggregates.service.js');
  await upsertSettlement(prisma, leaver.id);
  for (const ym of [M3, M2]) {
    await prisma.payrollPeriod.upsert({ where: { period_ym: ym }, update: { steps_submitted: [1, 2, 3, 4] }, create: { period_ym: ym, steps_submitted: [1, 2, 3, 4] } });
    await payroll.executeRun(ym, 'seed');
    await payroll.transition(ym, 'lock', 'seed', null);
    await payroll.transition(ym, 'mark_paid', 'seed', null, { payment_ref: `NEFT-${ym.replace('-', '')}-SEED` });
  }
  await rebuildAggregates(95, TODAY);

  console.log('\nSign in to the admin app with:');
  console.log(`  ${email} / ${process.env.ADMIN_PASSWORD ? '(ADMIN_PASSWORD from .env)' : password}`);
  console.log('\nSite tablet logins (shown once — reset from the site screen):');
  for (const [code, pw] of Object.entries(sitePasswords)) console.log(`  site-${code.toLowerCase()} / ${pw}`);
  console.log(`\n${M3} and ${M2} are paid. ${M1} is ready to run. ${M0} has the §20 cases (joiner, leaver, cross-site, worked holiday and Sunday).`);
  void lastOfMonth;
  void monthDates;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
