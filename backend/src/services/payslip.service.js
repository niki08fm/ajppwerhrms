import { esiContributionPeriod, financialYearStart, firstOfMonth, lastOfMonth, maxDate, minDate, addMonths, ymOf } from '@ajpwer/shared';
import { assemblePayslip, calendarDivisor, esiEligibility, pickPolicy, workingDaysInMonth } from '../calculations/index.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { salaryOn, structureComponents } from './rules.service.js';
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

/** Months of the financial year the person is employed — TDS is spread over these. */
export function monthsInFy(ym, joined, lastDay) {
  const fy = financialYearStart(ym);
  const start = maxDate(`${fy}-04-01`, joined);
  const end = lastDay ? minDate(`${fy + 1}-03-31`, lastDay) : `${fy + 1}-03-31`;
  if (end < start) return 1;
  let count = 0;
  for (let m = ymOf(start); m <= ymOf(end); m = addMonths(m, 1)) count++;
  return Math.max(1, count);
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
export async function computePayslip(db, e, ym, month, ctx, recoveries) {
  if (!e.statutory) throw new AppError('VALIDATION', `${e.name} (${e.code}) has no statutory setup.`, 409);
  const monthEnd = lastOfMonth(ym);
  const lastDay = fromDbDate(e.last_day);
  const joined = fromDbDate(e.joined_on);
  // The salary valid on the last day of the month (or the last day of employment) applies to the whole month.
  const salaryDate = lastDay && lastDay < monthEnd ? lastDay : monthEnd;
  const salary = await salaryOn(db, e.id, salaryDate < joined ? joined : salaryDate);
  if (!salary) throw new AppError('VALIDATION', `${e.name} (${e.code}) has no salary record for ${ym}.`, 409);
  const components = await structureComponents(db, salary.structure_id);

  const rules = month.rules;
  const working = workingDaysInMonth(ym, rules.weekly_off, [...month.holidays.keys()]);
  const divisor = calendarDivisor(rules.calendar_method, ym, working);
  const otPolicy = pickPolicy(rules.policies, 'OVERTIME', monthEnd);

  // ESI: decided once per contribution block on fixed gross at the block start.
  const block = esiContributionPeriod(firstOfMonth(ym));
  const blockSalary = await salaryOn(db, e.id, maxDate(block.start, joined));
  const esi = esiEligibility(
    {
      esi_enabled: e.statutory.esi_enabled,
      date: firstOfMonth(ym),
      fixed_gross_at_block_start: blockSalary?.monthly_gross ?? salary.monthly_gross,
      esi_locked_until: fromDbDate(e.statutory.esi_locked_until),
    },
    ctx.rates.esi,
  );

  const regimeCode = e.statutory.tax_regime_code === 'OLD' ? 'OLD' : 'NEW';
  const mify = monthsInFy(ym, joined, lastDay);

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
    statutory: {
      pf_enabled: e.statutory.pf_enabled,
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
    regime: regimeCode,
    pt_state: e.statutory.pt_state,
    months_in_fy: mify,
  };
}
