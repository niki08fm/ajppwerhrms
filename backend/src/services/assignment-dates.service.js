import { addDays, addMonths, firstOfMonth, formatYearMonth, ymOf } from '@ajpwer/shared';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { flagRerun } from './payroll-staleness.service.js';

/*
 * Dated assignments: which policies a pay group uses, and which pay group a person is in.
 * A change applies from a date and never reaches back into payroll that is locked or paid.
 */

const BEGINNING = '1900-01-01';

/** The latest month whose payroll is locked or paid, or null. */
export async function lastFrozenMonth(db) {
  const row = await db.payrollPeriod.findFirst({ where: { deleted_at: null, state: { in: ['LOCKED', 'PAID'] } }, orderBy: { period_ym: 'desc' }, select: { period_ym: true } });
  return row?.period_ym ?? null;
}

/**
 * The date a change takes effect. Without a request: the first day after the last locked
 * or paid payroll month, or null (no frozen payroll: the change may apply throughout).
 * A requested date must fall after that month; `monthStart` requires the 1st of a month.
 */
export async function effectiveFrom(db, requested, { monthStart = false, field = 'effective_from' } = {}) {
  const frozen = await lastFrozenMonth(db);
  const earliest = frozen ? firstOfMonth(addMonths(frozen, 1)) : null;
  if (!requested) return earliest;
  if (monthStart && requested !== firstOfMonth(ymOf(requested))) {
    throw new AppError('VALIDATION', 'A pay group change starts on the first day of a month.', 422, field);
  }
  if (earliest && requested < earliest) {
    throw new AppError('PAYROLL_FROZEN', `Payroll up to ${formatYearMonth(frozen)} is locked or paid. Choose a date from ${earliest}, or unlock that payroll first.`, 409, field);
  }
  return requested;
}

/**
 * The first locked or paid payroll month between two dates (null = open-ended), or null.
 * For company-wide dated settings (statutory rates, PT slabs, tax rates): changing what
 * applies on those dates would change finalised pay.
 */
export async function frozenMonthBetween(db, from, to) {
  const rows = await db.payrollPeriod.findMany({
    where: { deleted_at: null, state: { in: ['LOCKED', 'PAID'] }, period_ym: { gte: from ? ymOf(from) : '0000-01', lte: to ? ymOf(to) : '9999-12' } },
    orderBy: { period_ym: 'asc' },
    select: { period_ym: true },
    take: 1,
  });
  return rows[0]?.period_ym ?? null;
}

/** Refuse a change to dated settings that would reach locked or paid payroll. */
export async function assertNoFrozenMonth(db, from, to, what) {
  const ym = await frozenMonthBetween(db, from, to);
  if (ym) throw new AppError('PAYROLL_FROZEN', `${what} would change ${formatYearMonth(ym)}, whose payroll is locked or paid. Unlock that payroll first, or publish a new version from a later date.`, 409);
}

/** Each employee's pay group history, oldest first. */
export async function loadPayGroupHistory(db, employeeIds) {
  const out = new Map(employeeIds.map((id) => [id, []]));
  if (!employeeIds.length || !db.employeePayGroup) return out;
  const rows = await db.employeePayGroup.findMany({ where: { employee_id: { in: employeeIds } }, orderBy: { valid_from: 'asc' } });
  for (const r of rows) out.get(r.employee_id)?.push({ pay_group_id: r.pay_group_id, from: fromDbDate(r.valid_from), to: fromDbDate(r.valid_to) });
  return out;
}

/** The pay group a person was in on a date: their history, else their current group. */
export function groupOn(history, employee, date) {
  const rows = history?.get(employee.id) ?? [];
  const row = rows.find((r) => r.from <= date && (!r.to || r.to >= date));
  return row?.pay_group_id ?? employee.pay_group_id;
}

/** Employees as they stood in a month: each one's pay group on its first day. */
export async function employeesForMonth(db, employees, ym, history) {
  const h = history ?? await loadPayGroupHistory(db, employees.map((e) => e.id));
  const date = firstOfMonth(ym);
  return employees.map((e) => {
    const id = groupOn(h, e, date);
    return id === e.pay_group_id ? e : { ...e, pay_group_id: id };
  });
}

/**
 * Move a person to another pay group from `from` (the 1st of a month, or null to apply
 * throughout when no payroll is frozen). The previous row closes the day before; later
 * rows that the move supersedes go. The employee's current group becomes the new one.
 */
export async function movePayGroup(tx, employee, toGroupId, from, actor = null) {
  if (employee.pay_group_id === toGroupId && !from) return;
  if (!from) {
    await tx.employeePayGroup.deleteMany({ where: { employee_id: employee.id } });
  } else {
    const rows = await tx.employeePayGroup.findMany({ where: { employee_id: employee.id }, orderBy: { valid_from: 'asc' } });
    const dayBefore = addDays(from, -1);
    if (!rows.length) {
      await tx.employeePayGroup.create({ data: { employee_id: employee.id, pay_group_id: employee.pay_group_id, valid_from: toDbDate(BEGINNING), valid_to: toDbDate(dayBefore), created_by: actor } });
    } else {
      for (const r of rows) {
        const start = fromDbDate(r.valid_from);
        const end = fromDbDate(r.valid_to);
        if (start >= from) await tx.employeePayGroup.delete({ where: { id: r.id } });
        else if (!end || end >= from) await tx.employeePayGroup.update({ where: { id: r.id }, data: { valid_to: toDbDate(dayBefore) } });
      }
    }
    await tx.employeePayGroup.create({ data: { employee_id: employee.id, pay_group_id: toGroupId, valid_from: toDbDate(from), created_by: actor } });
  }
  await tx.employee.update({ where: { id: employee.id }, data: { pay_group_id: toGroupId } });
  await flagRerun(tx, { from, reason: `${employee.name ?? 'an employee'} moved pay group` });
}

/** A pay-group policy link's window as dates. */
export function linkWindow(link) {
  return { from: fromDbDate(link.effective_from), to: fromDbDate(link.effective_to) };
}

/**
 * A policy version as a pay group uses it: the version's own dates clipped to the link's
 * window. Null when they do not meet.
 */
export function clipToLink(policy, link) {
  const w = linkWindow(link);
  const from = w.from && w.from > policy.valid_from ? w.from : policy.valid_from;
  const to = w.to && (!policy.valid_to || w.to < policy.valid_to) ? w.to : policy.valid_to;
  if (to && to < from) return null;
  return from === policy.valid_from && to === policy.valid_to ? policy : { ...policy, valid_from: from, valid_to: to };
}
