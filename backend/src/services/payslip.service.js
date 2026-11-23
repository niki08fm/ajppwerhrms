import { esiContributionPeriod, financialYearStart, firstOfMonth, lastOfMonth, maxDate, minDate, addMonths, ymOf } from '@ajpwer/shared';
import { assemblePayslip, calendarDivisor, esiEligibility, expandStructure, isBasic, isHra, isOffStatus, pickPolicy, usesCtc, workingDaysInMonth } from '../calculations/index.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { ratesOn, salaryOn, structureComponents } from './rules.service.js';
import { ctcBasisOf } from './salary.service.js';

/** Adhoc targets resolve at run time: a list of employees, a pay group, a department, or everyone. */
export function adhocFor(e, items) {
  return items
    .filter(
      (a) =>
        a.target_type === 'ALL' ||
        (a.target_type === 'EMPLOYEE' && a.target_ids.includes(e.id)) ||
        (a.target_type === 'PAY_GROUP' && a.target_ids.includes(e.pay_group_id)) ||
        (a.target_type === 'DEPARTMENT' && a.target_ids.includes(e.department_id)),
    )
    .map((a) => ({ id: a.id, kind: a.kind, name: a.name, amount: n(a.amount), is_taxable: a.is_taxable }));
}

/** Months of the financial year the person is employed. */
export function monthsInFy(ym, joined, lastDay) {
  const fy = financialYearStart(ym);
  const start = maxDate(`${fy}-04-01`, joined);
  const end = lastDay ? minDate(`${fy + 1}-03-31`, lastDay) : `${fy + 1}-03-31`;
  if (end < start) return 1;
  let count = 0;
  for (let m = ymOf(start); m <= ymOf(end); m = addMonths(m, 1)) count++;
  return Math.max(1, count);
}

/** Months left in the tax year from `ym`, this month included: to March, or to the last working day's month. */
export function monthsLeftInFy(ym, lastDay) {
  const fy = financialYearStart(ym);
  const end = lastDay ? minDate(`${fy + 1}-03-31`, lastDay) : `${fy + 1}-03-31`;
  if (ymOf(end) < ym) return 1;
  let count = 0;
  for (let m = ym; m <= ymOf(end); m = addMonths(m, 1)) count++;
  return Math.max(1, count);
}

/** Months employed earlier this tax year, before `ym`. */
export function monthsEmployedBefore(ym, joined) {
  const fy = financialYearStart(ym);
  let count = 0;
  for (let m = ymOf(maxDate(`${fy}-04-01`, joined)); m < ym; m = addMonths(m, 1)) count++;
  return count;
}

const EARNING_KINDS = ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'LEAVE', 'ADHOC'];

/** One payslip's contribution to the year-to-date tax figures. Older payslips are read from their lines. */
export function payslipTaxFigures(slip) {
  const amount = (l) => n(l.amount);
  const saved = slip.meta?.tax_ytd;
  const tds = slip.lines.filter((l) => l.code === 'TDS').reduce((a, l) => a + amount(l), 0);
  if (saved) return { ...saved, tds };
  const lines = slip.lines;
  const component = (test) => lines.filter((l) => l.kind === 'COMPONENT' && test({ name: l.name })).reduce((a, l) => a + amount(l), 0);
  return {
    taxable: lines.filter((l) => EARNING_KINDS.includes(l.kind) && l.is_taxable).reduce((a, l) => a + amount(l), 0),
    basic: component(isBasic),
    hra: component(isHra),
    pf_80c: lines.filter((l) => l.code === 'PF' || l.code === 'VPF').reduce((a, l) => a + amount(l), 0),
    variable: lines.filter((l) => l.kind === 'OT' || l.kind === 'OFFDAY').reduce((a, l) => a + amount(l), 0),
    tds,
  };
}

/**
 * What each person was paid and had deducted earlier this tax year, from the payslips of
 * months already run (generated, locked or paid). The regime is the one the year's first
 * payslip used: it holds until March.
 */
export async function loadTaxYtd(db, employeeIds, ym) {
  const fy = financialYearStart(ym);
  const slips = employeeIds.length ? await db.payslip.findMany({
    where: { employee_id: { in: employeeIds }, deleted_at: null, period: { deleted_at: null, state: { in: ['RUN', 'LOCKED', 'PAID'] }, period_ym: { gte: `${fy}-04`, lt: ym } } },
    select: { employee_id: true, meta: true, period: { select: { period_ym: true } }, lines: { select: { kind: true, code: true, name: true, amount: true, is_taxable: true } } },
  }) : [];
  slips.sort((a, b) => a.period.period_ym.localeCompare(b.period.period_ym));
  const out = new Map(employeeIds.map((id) => [id, { taxable: 0, tds: 0, basic: 0, hra: 0, pf_80c: 0, variable: 0, months: 0, regime: null }]));
  for (const slip of slips) {
    const y = out.get(slip.employee_id);
    const f = payslipTaxFigures(slip);
    for (const k of ['taxable', 'tds', 'basic', 'hra', 'pf_80c', 'variable']) y[k] += f[k] ?? 0;
    y.months++;
    y.regime ??= slip.meta?.regime ?? null;
  }
  return out;
}

/**
 * Overtime minutes grouped by the overtime policy version in force on each day, in date
 * order. Null when one version covers the whole month (the month-end version is used),
 * or when the days do not add up to the month's total (after HR corrections).
 */
export function overtimeByVersion(policies, days, total) {
  if (!days?.length || !total) return null;
  const groups = [];
  for (const d of days) {
    if (isOffStatus(d.status) || !(d.ot_min > 0)) continue;
    const p = pickPolicy(policies, 'OVERTIME', d.date);
    const last = groups.at(-1);
    if (last && last.id === (p?.id ?? null)) {
      last.ot_min += d.ot_min;
      last.to = d.date;
    } else groups.push({ id: p?.id ?? null, rules: p?.rules ?? null, ot_min: d.ot_min, from: d.date, to: d.date });
  }
  if (groups.length < 2 || groups.reduce((a, g) => a + g.ot_min, 0) !== total) return null;
  return groups;
}

export function recoveryItems(src) {
  const items = [];
  if (src.carry && n(src.carry.amount) > 0) items.push({ type: 'CARRY', ref_id: null, label: 'Recovery carried from last month', due: n(src.carry.amount) });
  for (const l of src.loans) {
    const due = Math.min(n(l.emi), n(l.principal) - n(l.recovered));
    if (due > 0) items.push({ type: 'LOAN', ref_id: l.id, label: `Loan EMI — ${l.loan_type}`, due });
  }
  for (const a of src.advances) {
    const due = Math.min(n(a.instalment), n(a.amount) - n(a.recovered));
    if (due > 0) items.push({ type: 'ADVANCE', ref_id: a.id, label: `Advance — ${a.reason}`, due });
  }
  return items;
}

export async function loadRecoveries(db, employeeIds, ym) {
  const [carries, loans, advances] = await Promise.all([
    db.recoveryCarry.findMany({ where: { employee_id: { in: employeeIds }, period_ym: ym, deleted_at: null } }),
    db.loan.findMany({ where: { employee_id: { in: employeeIds }, status: 'ACTIVE', deleted_at: null, started_on: { lte: toDbDate(lastOfMonth(ym)) } } }),
    db.advance.findMany({ where: { employee_id: { in: employeeIds }, status: 'ACTIVE', deleted_at: null, granted_on: { lte: toDbDate(lastOfMonth(ym)) } } }),
  ]);
  const out = new Map();
  for (const id of employeeIds) {
    out.set(id, {
      carry: carries.find((c) => c.employee_id === id) ?? null,
      loans: loans.filter((l) => l.employee_id === id),
      advances: advances.filter((a) => a.employee_id === id),
    });
  }
  return out;
}

/**
 * Compute one person's payslip for a month from live data. Pure engines do the
 * arithmetic; this gathers their inputs.
 */
export async function computePayslip(db, e, ym, month, ctx, recoveries, inputs) {
  const salaryAt = inputs ? inputs.salaryOn : (id, date) => salaryOn(db, id, date);
  const componentsFor = inputs ? inputs.components : id => structureComponents(db, id);
  if (!e.statutory) throw new AppError('VALIDATION', `${e.name} (${e.code}) has no statutory setup.`, 409);
  const monthEnd = lastOfMonth(ym);
  const lastDay = fromDbDate(e.last_day);
  const joined = fromDbDate(e.joined_on);
  // The salary valid on the last day of the month (or the last day of employment) applies to the whole month.
  const salaryDate = lastDay && lastDay < monthEnd ? lastDay : monthEnd;
  const salary = await salaryAt(e.id, salaryDate < joined ? joined : salaryDate);
  if (!salary) throw new AppError('VALIDATION', `${e.name} (${e.code}) has no salary record for ${ym}.`, 409);
  const components = await componentsFor(salary.structure_id);

  const rules = month.rules;
  const working = workingDaysInMonth(ym, rules.weekly_off, [...month.holidays.keys()]);
  const divisor = calendarDivisor(rules.calendar_method, ym, working);
  const otPolicy = pickPolicy(rules.policies, 'OVERTIME', monthEnd);
  const overtimeSegments = overtimeByVersion(rules.policies, month.result.days, month.result.totals.ot_min);

  // ESI: decided once per contribution block on the selected fixed wages in
  // the salary structure effective at its start. A later revision cannot
  // change that period's entry decision.
  const block = esiContributionPeriod(firstOfMonth(ym));
  const eligibilityDate = maxDate(block.start, joined);
  const blockSalary = await salaryAt(e.id, eligibilityDate);
  const eligibilitySalary = blockSalary ?? salary;
  const eligibilityComponents = eligibilitySalary.structure_id === salary.structure_id
    ? components : await componentsFor(eligibilitySalary.structure_id);
  // A gross agreement with % of CTC earnings needs the rates at entry to
  // reconstruct those earnings. Later statutory rate changes must not move
  // its contribution-period eligibility; CTC agreements keep their saved basis.
  const eligibilityRates = eligibilitySalary.mode === 'GROSS' && usesCtc(eligibilityComponents)
    ? await ratesOn(db, eligibilityDate) : ctx.rates;
  const eligibilityWage = expandStructure(
    eligibilityComponents,
    eligibilitySalary.monthly_gross,
    ctcBasisOf(eligibilitySalary, eligibilityComponents, e.statutory, eligibilityRates),
  ).esi_base;
  const esi = esiEligibility(
    {
      esi_enabled: e.statutory.esi_enabled,
      date: firstOfMonth(ym),
      fixed_gross_at_block_start: eligibilityWage,
      esi_locked_until: fromDbDate(e.statutory.esi_locked_until),
    },
    ctx.rates.esi,
  );

  // Tax: what was paid and deducted earlier this tax year, the regime the year started
  // on, the previous employer's Form 12B figures, and the months left to spread over.
  const ytdRow = inputs?.taxYtd?.ym === ym ? inputs.taxYtd.map.get(e.id) : (await loadTaxYtd(db, [e.id], ym)).get(e.id);
  const ytd = ytdRow ?? { taxable: 0, tds: 0, basic: 0, hra: 0, pf_80c: 0, variable: 0, months: 0, regime: null };
  const declaredRegime = e.statutory.tax_regime_code === 'OLD' ? 'OLD' : 'NEW';
  const regimeCode = ytd.regime === 'OLD' || ytd.regime === 'NEW' ? ytd.regime : declaredRegime;
  const mify = monthsInFy(ym, joined, lastDay);
  const monthsLeft = monthsLeftInFy(ym, lastDay);
  // Salary and TDS earlier this tax year outside this payroll (a previous employer, or
  // months before AJPWER Workforce). Once recorded, those months are not estimated;
  // until then, months employed with no payroll on record are estimated at the current salary.
  const fy = financialYearStart(ym);
  const recorded = e.statutory.prev_employer_fy === fy;
  const previous = recorded
    ? { income: n(e.statutory.prev_employer_income ?? 0), tds: n(e.statutory.prev_employer_tds ?? 0) }
    : { income: 0, tds: 0 };
  const missing = recorded ? 0 : Math.max(0, monthsEmployedBefore(ym, joined) - ytd.months);
  // No PAN on file: the higher TDS rate applies. Only when identity was loaded.
  const noPan = e.has_pan === false || (e.has_pan === undefined && e.identity !== undefined && !e.identity?.pan_enc);

  const result = assemblePayslip({
    ym,
    employee: { id: e.id, gender: e.gender },
    monthly_gross: salary.monthly_gross,
    annual_ctc: ctcBasisOf(salary, components, e.statutory, ctx.rates),
    components,
    attendance: month.result.totals,
    offday_work: month.result.offday_work,
    divisor,
    overtime_rules: otPolicy?.rules ?? null,
    overtime_segments: overtimeSegments,
    statutory: {
      pf_enabled: e.statutory.pf_enabled,
      eps_enabled: e.statutory.eps_enabled ?? true,
      pf_restrict_to_ceiling: e.statutory.pf_restrict_to_ceiling,
      vpf_pct: Number(e.statutory.vpf_pct),
      esi_applicable: esi.applicable,
      pt_applicable: e.statutory.pt_applicable,
      pt_state: e.statutory.pt_state,
    },
    rates: { pf: ctx.rates.pf, esi: ctx.rates.esi, recovery_cap_pct: ctx.rates.recovery_cap_pct },
    pt_slabs: ctx.pt_slabs,
    tax: {
      regime: ctx.regimes[regimeCode],
      declarations: {
        decl_80c: n(e.statutory.decl_80c),
        decl_80d: n(e.statutory.decl_80d),
        decl_rent_monthly: n(e.statutory.decl_rent_monthly),
        decl_metro: e.statutory.decl_metro,
      },
      months_in_fy: mify,
      months_left: monthsLeft,
      ytd: { ...ytd, missing },
      previous,
      no_pan: noPan,
    },
    adhoc: adhocFor(e, ctx.adhoc),
    recoveries: recoveries ? recoveryItems(recoveries) : [],
    // Leave paid out when the leave year closes in this month (never for someone leaving: the settlement pays theirs).
    leave_encashment: (month.result.leave?.types ?? [])
      .filter((t) => t.encashed > 0)
      .map((t) => ({ code: t.code, name: t.name, days: t.encashed, base: t.encash_base, divisor: t.encash_divisor })),
  });

  return {
    employee_id: e.id,
    result,
    attendance: month.result.totals,
    leave: month.result.leave,
    salary: { mode: salary.mode, amount: salary.amount, monthly_gross: salary.monthly_gross, structure_id: salary.structure_id, salary_id: salary.id },
    esi: { applicable: esi.applicable, locked_until: esi.esi_locked_until, reason: esi.reason },
    pay_group: rules?.id ? { id: rules.id, name: rules.name } : null,
    regime: regimeCode,
    declared_regime: declaredRegime,
    pt_state: e.statutory.pt_state,
    months_in_fy: mify,
    months_left: monthsLeft,
    tax_ytd_estimated_months: missing,
    previous_employer: previous,
  };
}
