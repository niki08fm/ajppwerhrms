import {
  esiContributionPeriod,
  financialYearStart,
  firstOfMonth,
  lastOfMonth,
  maxDate,
  minDate,
  addMonths,
  ymOf,
  type ISODate,
  type PtSlab,
  type StatutoryRates,
  type TaxRegime,
  type OvertimeRules,
} from '@ajpwer/shared';
import {
  assemblePayslip,
  calendarDivisor,
  esiEligibility,
  pickPolicy,
  workingDaysInMonth,
  type AdhocForEmployee,
  type PayslipResult,
  type RecoveryItem,
} from '../engines';
import { fromDbDate, n, toDbDate } from '../lib/db-dates';
import type { Db } from '../lib/prisma';
import { AppError } from '../lib/errors';
import type { EmployeeMonth } from './attendance';
import { salaryOn, structureComponents } from './rules';
import { ctcBasisOf } from './salary';

export interface PayslipEmployee {
  id: string;
  code: string;
  name: string;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  joined_on: Date;
  last_day: Date | null;
  status: string;
  department_id: string;
  pay_group_id: string;
  statutory: {
    pf_enabled: boolean;
    pf_restrict_to_ceiling: boolean;
    vpf_pct: unknown;
    esi_enabled: boolean;
    esi_locked_until: Date | null;
    pt_applicable: boolean;
    pt_state: string;
    tax_regime_code: string;
    decl_80c: bigint;
    decl_80d: bigint;
    decl_rent_monthly: bigint;
    decl_metro: boolean;
  } | null;
}

export interface PayContext {
  rates: StatutoryRates & { id: string };
  pt_slabs: PtSlab[];
  regimes: { NEW: TaxRegime; OLD: TaxRegime };
  adhoc: { id: string; kind: 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION'; name: string; amount: bigint; is_taxable: boolean; target_type: string; target_ids: string[] }[];
}

/** Adhoc targets resolve at run time: a list of employees, a pay group, a department, or everyone. */
export function adhocFor(e: Pick<PayslipEmployee, 'id' | 'pay_group_id' | 'department_id'>, items: PayContext['adhoc']): AdhocForEmployee[] {
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
export function monthsInFy(ym: string, joined: ISODate, lastDay: ISODate | null): number {
  const fy = financialYearStart(ym);
  const start = maxDate(`${fy}-04-01`, joined);
  const end = lastDay ? minDate(`${fy + 1}-03-31`, lastDay) : `${fy + 1}-03-31`;
  if (end < start) return 1;
  let count = 0;
  for (let m = ymOf(start); m <= ymOf(end); m = addMonths(m, 1)) count++;
  return Math.max(1, count);
}

export interface RecoverySource {
  carry: { amount: bigint } | null;
  loans: { id: string; loan_type: string; principal: bigint; emi: bigint; recovered: bigint }[];
  advances: { id: string; reason: string; amount: bigint; instalment: bigint; recovered: bigint }[];
}

export function recoveryItems(src: RecoverySource): RecoveryItem[] {
  const items: RecoveryItem[] = [];
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

export async function loadRecoveries(db: Db, employeeIds: string[], ym: string): Promise<Map<string, RecoverySource>> {
  const [carries, loans, advances] = await Promise.all([
    db.recoveryCarry.findMany({ where: { employee_id: { in: employeeIds }, period_ym: ym, deleted_at: null } }),
    db.loan.findMany({ where: { employee_id: { in: employeeIds }, status: 'ACTIVE', deleted_at: null, started_on: { lte: toDbDate(lastOfMonth(ym)) } } }),
    db.advance.findMany({ where: { employee_id: { in: employeeIds }, status: 'ACTIVE', deleted_at: null, granted_on: { lte: toDbDate(lastOfMonth(ym)) } } }),
  ]);
  const out = new Map<string, RecoverySource>();
  for (const id of employeeIds) {
    out.set(id, {
      carry: carries.find((c) => c.employee_id === id) ?? null,
      loans: loans.filter((l) => l.employee_id === id),
      advances: advances.filter((a) => a.employee_id === id),
    });
  }
  return out;
}

export interface ComputedPayslip {
  employee_id: string;
  result: PayslipResult;
  attendance: EmployeeMonth['result']['totals'];
  salary: { mode: string; amount: number; monthly_gross: number; structure_id: string; salary_id: string };
  esi: { applicable: boolean; locked_until: ISODate | null; reason: string };
  regime: string;
  pt_state: string;
  months_in_fy: number;
}

/**
 * Compute one person's payslip for a month from live data. Pure engines do the
 * arithmetic; this gathers their inputs.
 */
export async function computePayslip(
  db: Db,
  e: PayslipEmployee,
  ym: string,
  month: EmployeeMonth,
  ctx: PayContext,
  recoveries: RecoverySource | null,
): Promise<ComputedPayslip> {
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
  const working = workingDaysInMonth(ym, rules.weekly_off as never, [...month.holidays.keys()]);
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
    overtime_rules: (otPolicy?.rules as OvertimeRules | undefined) ?? null,
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
  });

  return {
    employee_id: e.id,
    result,
    attendance: month.result.totals,
    salary: { mode: salary.mode, amount: salary.amount, monthly_gross: salary.monthly_gross, structure_id: salary.structure_id, salary_id: salary.id },
    esi: { applicable: esi.applicable, locked_until: esi.esi_locked_until, reason: esi.reason },
    regime: regimeCode,
    pt_state: e.statutory.pt_state,
    months_in_fy: mify,
  };
}
