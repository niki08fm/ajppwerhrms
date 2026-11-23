#!/usr/bin/env node
/*
 * TDS check: does payroll deduct exactly the tax an employee owes?
 *
 *   npm run tds:check -- scripts/tds-scenarios/increment.json   one scenario file
 *   npm run tds:check -- --all                                   every file in scripts/tds-scenarios
 *   npm run tds:check -- --employee AJ0001 [--fy 2026] [--month 2026-10]
 *        a real employee's payslips this tax year, checked, then the next month's TDS worked out step by step
 *
 * Scenario mode runs the real payslip engine month by month, carrying the year-to-date
 * figures exactly as a payroll run does. Both modes then work out the tax owed with a
 * separate, plain calculator (below) that shares no code with the engine, and compare.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMonths, daysInMonth, financialYearStart, SEED_PT_SLABS, SEED_TAX_REGIMES, STATUTORY_MINIMUM_RATES } from '@ajpwer/shared';
import { assemblePayslip, EMPTY_YTD } from '../src/calculations/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rupees = (p) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;
const R = (r) => Math.round(r * 100);

// ─── The independent calculator ──────────────────────────────────────────────
// Written from the policy, not from the engine: if both agree, the engine is right.
function taxOwed(income, regime, decl = {}) {
  const r10 = (x) => Math.round(x / 1000) * 1000;
  const gross = income.gross;
  let deductions = Math.min(regime.std_deduction, gross);
  if (regime.allows_hra && income.hra > 0 && decl.rent_monthly > 0) {
    deductions += Math.min(income.hra, Math.max(0, decl.rent_monthly * income.rent_months - income.basic / 10), income.basic * (decl.metro ? 0.5 : 0.4));
  }
  if (regime.allows_80c) deductions += Math.min((decl['80c'] ?? 0) + (income.pf ?? 0), R(150000)) + Math.min(decl['80d'] ?? 0, R(25000));
  const taxable = r10(Math.max(0, gross - deductions));
  let lower = 0;
  let tax = 0;
  for (const s of [...regime.slabs].sort((a, b) => (a.upto_amount ?? Infinity) - (b.upto_amount ?? Infinity))) {
    const top = s.upto_amount ?? Infinity;
    if (taxable > lower) tax += (Math.min(taxable, top) - lower) * s.rate / 100;
    lower = top;
  }
  if (taxable <= regime.rebate_limit) tax -= regime.rebate_max === null ? tax : Math.min(tax, regime.rebate_max);
  else if (regime.marginal_relief) tax = Math.min(tax, taxable - regime.rebate_limit);
  return { taxable, total: r10(Math.max(0, tax) * (1 + regime.cess_pct / 100)) };
}

// ─── Scenario mode ───────────────────────────────────────────────────────────
const STRUCTURE = [
  { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: true },
  { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 40, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
  { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
];

function totals(ym, lopDays) {
  const dim = daysInMonth(ym);
  const paid = dim - lopDays;
  return { days_in_month: dim, days_in_employment: dim, present: paid, half_day: 0, absent: lopDays, short: 0, missing_punch: 0, leave_paid: 0, leave_unpaid: 0, weekly_off: 0, holidays: 0, late_days: 0, early_out_days: 0, ot_min: 0, worked_min: 0, day_value_sum: paid, paid_days: paid, lop_days: lopDays, lop_in_window: lopDays, partial: false, sandwiched: [], overridden_days: 0 };
}

/** Months left from `ym`, this one included: to March, or to the last working day's month once it is known. */
function monthsLeft(ym, lastYm) {
  const fy = financialYearStart(ym);
  const end = lastYm && lastYm < `${fy + 1}-03` ? lastYm : `${fy + 1}-03`;
  let n = 0;
  for (let m = ym; m <= end; m = addMonths(m, 1)) n++;
  return Math.max(1, n);
}

function runScenario(s) {
  const regime = s.regime_rates ?? SEED_TAX_REGIMES.find((r) => r.code === (s.regime ?? 'NEW'));
  const d = s.declarations ?? {};
  const decl = { decl_80c: R(d['80c'] ?? 0), decl_80d: R(d['80d'] ?? 0), decl_rent_monthly: R(d.rent_monthly ?? 0), decl_metro: !!d.metro };
  const previous = { income: R(s.previous?.income ?? 0), tds: R(s.previous?.tds ?? 0) };
  const ot = { multiplier: 2, base: 'GROSS', divisor: null, hours_per_day: 8, after_min: 0, rounding_min: 1, monthly_cap_min: null, ...(s.overtime_rules ?? {}) };
  const lastYm = s.last_month ?? null;
  let ytd = { ...EMPTY_YTD };
  let pf = 0;
  const rows = [];
  for (const m of s.months) {
    const known = !m.resignation_unknown && lastYm && (!s.resignation_known_from || m.month >= s.resignation_known_from);
    const ot_min = Math.round((m.overtime_hours ?? 0) * 60);
    const p = assemblePayslip({
      ym: m.month,
      employee: { id: 'check', gender: 'MALE' },
      monthly_gross: R(m.gross),
      annual_ctc: 0,
      components: STRUCTURE,
      attendance: { ...totals(m.month, m.lop_days ?? 0), ot_min },
      offday_work: [],
      divisor: daysInMonth(m.month),
      overtime_rules: ot_min ? ot : null,
      statutory: { pf_enabled: !!s.pf, eps_enabled: true, pf_restrict_to_ceiling: true, vpf_pct: 0, esi_applicable: false, pt_applicable: false, pt_state: 'Telangana' },
      rates: { pf: STATUTORY_MINIMUM_RATES.pf, esi: STATUTORY_MINIMUM_RATES.esi, recovery_cap_pct: 40 },
      pt_slabs: SEED_PT_SLABS,
      tax: { regime, declarations: decl, months_left: monthsLeft(m.month, known ? lastYm : null), ytd, previous, no_pan: !!s.no_pan },
      adhoc: m.bonus ? [{ id: 'bonus', kind: 'EARNING', name: 'Bonus', amount: R(m.bonus), is_taxable: true }] : [],
      recoveries: [],
    });
    const tds = p.lines.find((l) => l.code === 'TDS')?.amount ?? 0;
    rows.push({ month: m.month, gross: p.gross, taxable: p.tax_ytd.taxable, projected: p.tds.projected_income, annual: p.tds.annual, before: p.tds.tds_to_date, left: p.tds.months_left, tds, capped: p.flags.includes('TDS_CAPPED'), net: p.net });
    ytd = { taxable: ytd.taxable + p.tax_ytd.taxable, tds: ytd.tds + tds, basic: ytd.basic + p.tax_ytd.basic, hra: ytd.hra + p.tax_ytd.hra, pf_80c: ytd.pf_80c + p.tax_ytd.pf_80c, variable: ytd.variable + p.tax_ytd.variable, months: ytd.months + 1 };
    pf += p.tax_ytd.pf_80c;
  }
  const owed = taxOwed({ gross: previous.income + ytd.taxable, basic: ytd.basic, hra: ytd.hra, pf, rent_months: ytd.months }, regime, { ...d, rent_monthly: R(d.rent_monthly ?? 0), '80c': R(d['80c'] ?? 0), '80d': R(d['80d'] ?? 0) });
  const lastRow = s.months.at(-1).month;
  const yearEnded = lastRow === (lastYm ?? `${financialYearStart(lastRow) + 1}-03`);
  return { rows, ytd, previous, owed, yearEnded };
}

function printTable(rows) {
  const head = ['Month', 'Gross paid', 'Taxable', 'Projected income', 'Tax for year', 'TDS before', 'Left', 'TDS this month', 'Net pay'];
  const body = rows.map((r) => [r.month, rupees(r.gross), rupees(r.taxable), rupees(r.projected), rupees(r.annual), rupees(r.before), String(r.left), rupees(r.tds) + (r.capped ? ' (capped)' : ''), rupees(r.net)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const b of body) console.log(line(b));
}

/** PASS when TDS for the year equals the tax owed. Over-deduction is reported, never refunded by payroll. */
function verdict(collected, owed, yearEnded, expectTotal) {
  const diff = collected - owed;
  if (expectTotal !== undefined && Math.abs(collected - R(expectTotal)) > R(10)) return { ok: false, text: `FAIL: expected ${rupees(R(expectTotal))} TDS, payroll deducted ${rupees(collected)}` };
  if (!yearEnded) return { ok: true, text: `IN PROGRESS: ${rupees(collected)} deducted so far; the months left collect the rest of the year's tax` };
  if (Math.abs(diff) <= R(10)) return { ok: true, text: `PASS: TDS ${rupees(collected)} = tax owed ${rupees(owed)}` };
  if (diff > 0) return { ok: true, text: `OVER by ${rupees(diff)}: deducted before the lower income was known. Payroll stops TDS; the employee claims it in their return.` };
  return { ok: false, text: `SHORT by ${rupees(-diff)}: TDS ${rupees(collected)}, tax owed ${rupees(owed)}` };
}

function checkFile(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const r = runScenario(s);
  console.log(`\n=== ${s.name ?? path.basename(file)} (${s.regime ?? 'NEW'} regime) ===`);
  printTable(r.rows);
  const collected = r.ytd.tds + r.previous.tds;
  console.log(`\nIncome for the year: ${rupees(r.previous.income + r.ytd.taxable)}${r.previous.income ? ` (incl. ${rupees(r.previous.income)} earlier this year, TDS ${rupees(r.previous.tds)})` : ''}`);
  console.log(`Tax owed (independent calculation): ${rupees(r.owed.total)} on taxable ${rupees(r.owed.taxable)}`);
  const v = verdict(collected, r.owed.total, r.yearEnded, s.expect_total_tds);
  console.log(v.text);
  return v.ok;
}

// ─── Employee mode (database) ────────────────────────────────────────────────
/** The next month's TDS, worked out live from today's data, step by step. */
async function explainNext(prisma, e, ym) {
  const { computeMonths } = await import('../src/services/attendance.service.js');
  const { computePayslip, loadTaxYtd } = await import('../src/services/payslip.service.js');
  const { payContext, toPayslipEmployee } = await import('../src/services/payroll.service.js');
  const { withReadScope } = await import('../src/utils/read-scope.js');
  const full = await prisma.employee.findUniqueOrThrow({ where: { id: e.id }, include: { statutory: true, identity: true, department: true, pay_group: true } });
  const { p, ytd } = await withReadScope(async () => {
    const [months, ctx, ytdMap] = await Promise.all([computeMonths(prisma, [full], ym), payContext(prisma, ym), loadTaxYtd(prisma, [full.id], ym)]);
    return { p: await computePayslip(prisma, toPayslipEmployee(full), ym, months.get(full.id), ctx, null), ytd: ytdMap.get(full.id) };
  });
  const t = p.result.tds;
  const thisMonth = p.result.tax_ytd.taxable;
  const left = t.months_left;
  const ahead = t.projected_income - t.previous_income - ytd.taxable - thisMonth;
  const step = (label, amount) => console.log(`  ${label.padEnd(76)} ${rupees(amount).padStart(12)}`);
  console.log(`\nNext month ${ym} (live from today's attendance and salary; ${p.regime} regime):`);
  step('1. Taxable pay already paid this tax year (payslips)', ytd.taxable);
  if (t.previous_income) step('   + earlier this tax year outside this payroll (Form 12B)', t.previous_income);
  step(`2. + ${ym} taxable pay (after LOP, with overtime and bonus)`, thisMonth);
  step(`3. + expected pay for ${left - 1} month(s) ahead${t.estimated_months ? ` and ${t.estimated_months} estimated earlier month(s)` : ''}`, ahead);
  step('   = projected income for the year', t.projected_income);
  step('4. Taxable income after deductions (rounded to ₹10)', t.taxable_income);
  step('5. Tax for the year (slabs − rebate/relief + 4% cess)', t.annual);
  step('6. − TDS already deducted this tax year', t.tds_to_date + t.previous_tds);
  step(`7. ÷ ${left} month(s) left = regular TDS`, t.regular);
  if (t.incremental) step('8. + full extra tax on this month\'s one-off payments', t.incremental);
  step(`   TDS on the ${ym} payslip`, t.regular + t.incremental);
  if (t.due_this_month > t.regular + t.incremental) console.log(`  The month's pay covers only part of the ${rupees(t.due_this_month)} due; the rest moves to later months.`);
  if (t.estimated_months) console.log(`  Note: ${t.estimated_months} earlier month(s) have no payroll here and are estimated with no TDS. Record earlier pay on the Tax card if salary was paid outside this system.`);
}

async function checkEmployee(code, fyArg, nextYm) {
  const { prisma } = await import('../src/config/db.js');
  const { regimesOn } = await import('../src/services/rules.service.js');
  const { payslipTaxFigures } = await import('../src/services/payslip.service.js');
  const { withReadScope } = await import('../src/utils/read-scope.js');
  try {
    const e = await prisma.employee.findFirst({ where: { code, deleted_at: null }, include: { statutory: true } });
    if (!e) throw new Error(`No employee with code ${code}`);
    const fy = fyArg ?? financialYearStart(new Date().toISOString().slice(0, 10));
    const slips = await prisma.payslip.findMany({
      where: { employee_id: e.id, deleted_at: null, period: { deleted_at: null, state: { in: ['RUN', 'LOCKED', 'PAID'] }, period_ym: { gte: `${fy}-04`, lte: `${fy + 1}-03` } } },
      include: { lines: true, period: { select: { period_ym: true, state: true } } },
    });
    slips.sort((a, b) => a.period.period_ym.localeCompare(b.period.period_ym));
    console.log(`\n=== ${e.name} (${e.code}), tax year ${fy}-${String(fy + 1).slice(2)} ===`);
    if (!slips.length) {
      console.log('No payroll run for this tax year yet.');
      await explainNext(prisma, e, nextYm ?? `${fy}-04`);
      return true;
    }
    let ok = true;
    let sum = 0;
    let taxable = 0;
    const regimes = await withReadScope(() => regimesOn(prisma, `${fy}-04-01`));
    const rows = [];
    for (const s of slips) {
      const t = s.meta?.tds ?? {};
      const f = payslipTaxFigures(s);
      const problems = [];
      // Each month must start from exactly the TDS deducted before it.
      if (t.tds_to_date !== undefined && t.tds_to_date !== sum) problems.push(`started from ${rupees(t.tds_to_date)} deducted, but earlier payslips deducted ${rupees(sum)}`);
      // The month's tax for the year must match the independent calculation on the same projection.
      if (t.income) {
        const regime = regimes[t.regime ?? s.meta?.regime ?? 'NEW'];
        const decl = { '80c': Number(e.statutory?.decl_80c ?? 0), '80d': Number(e.statutory?.decl_80d ?? 0), rent_monthly: Number(e.statutory?.decl_rent_monthly ?? 0), metro: e.statutory?.decl_metro };
        const independent = taxOwed({ gross: t.income.gross, basic: t.income.basic, hra: t.income.hra, pf: t.income.pf_80c, rent_months: t.income.rent_months }, regime, decl);
        if (!t.no_pan && Math.abs(independent.total - t.annual) > R(10)) problems.push(`tax for the year ${rupees(t.annual)} differs from the independent ${rupees(independent.total)}`);
      } else problems.push('computed before engine 1.7.0: no TDS working stored');
      rows.push({ month: `${s.period.period_ym} ${s.period.state}`, gross: Number(s.gross), taxable: f.taxable, projected: t.projected_income ?? 0, annual: t.annual ?? 0, before: t.tds_to_date ?? 0, left: t.months_left ?? 0, tds: f.tds, capped: s.meta?.flags?.includes('TDS_CAPPED'), net: Number(s.net) });
      if (problems.length) { ok = ok && problems.every((p) => p.startsWith('computed before')); console.log(`  ${s.period.period_ym}: ${problems.join('; ')}`); }
      sum += f.tds;
      taxable += f.taxable;
    }
    printTable(rows);
    const last = slips.at(-1).meta?.tds;
    console.log(`\nTDS deducted so far: ${rupees(sum)} on taxable pay ${rupees(taxable)}`);
    if (last?.annual !== undefined) {
      const still = Math.max(0, last.annual - sum - (last.previous_tds ?? 0));
      console.log(`Latest projection: tax for the year ${rupees(last.annual)}; still to collect ${rupees(still)} over ${Math.max(0, last.months_left - 1)} more month(s).`);
    }
    console.log(ok ? 'PASS: every month starts from the TDS already deducted and its tax matches the independent calculation.' : 'FAIL: see the months listed above.');
    await explainNext(prisma, e, nextYm ?? addMonths(slips.at(-1).period.period_ym, 1));
    return ok;
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let ok = true;
if (args[0] === '--employee') {
  const fyIdx = args.indexOf('--fy');
  const monthIdx = args.indexOf('--month');
  ok = await checkEmployee(args[1], fyIdx > 0 ? Number(args[fyIdx + 1]) : undefined, monthIdx > 0 ? args[monthIdx + 1] : undefined);
} else {
  const files = args[0] === '--all' || !args.length
    ? readdirSync(path.join(here, 'tds-scenarios')).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(here, 'tds-scenarios', f))
    : args;
  for (const f of files) ok = checkFile(f) && ok;
}
process.exitCode = ok ? 0 : 1;
