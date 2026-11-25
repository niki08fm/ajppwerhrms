import { addDays, firstOfMonth, formatYearMonth, lastOfMonth, ymOf } from '@ajpwer/shared';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';

/*
 * Salary structure versions. A structure is a lineage of versions, one row each, sharing
 * `lineage_id` (the first version's id). The first version applies from the start; each later
 * version from the 1st of a month until the day before the next one starts. So versions never
 * overlap and leave no gaps. Employees point at the lineage; whatever calculates pay for a
 * date uses the version in force on that date.
 *
 * Locked or paid payroll protects history: a change that would alter the components used in
 * a frozen month for someone on this structure is refused.
 */

/** Versions oldest first, each with `valid_from` (null = from the start) and a derived `valid_to`. */
export function withWindows(rows) {
  const sorted = [...rows].sort((a, b) => {
    const af = a.valid_from ? fromDbDate(a.valid_from) : '';
    const bf = b.valid_from ? fromDbDate(b.valid_from) : '';
    return af < bf ? -1 : af > bf ? 1 : a.version - b.version;
  });
  return sorted.map((r, i) => {
    const next = sorted[i + 1];
    const from = r.valid_from ? fromDbDate(r.valid_from) : null;
    return { ...r, valid_from: from, valid_to: next ? addDays(fromDbDate(next.valid_from), -1) : null };
  });
}

/** The version in force on a date: the latest that has started, else the first. */
export function versionOn(versions, date) {
  let pick = versions[0] ?? null;
  for (const v of versions) if (!v.valid_from || v.valid_from <= date) pick = v;
  return pick;
}

/** The lineage a structure id belongs to (deleted rows still name their lineage). */
export async function lineageIdOf(db, structureId) {
  const row = await db.salaryStructure.findFirst({ where: { id: structureId }, select: { lineage_id: true } });
  return row?.lineage_id ?? null;
}

/** A lineage's live versions with their windows. */
export async function lineageVersions(db, lineageId, include = undefined) {
  const rows = await db.salaryStructure.findMany({ where: { lineage_id: lineageId, deleted_at: null }, orderBy: { version: 'asc' }, ...(include ? { include } : {}) });
  return withWindows(rows);
}

/** Every structure id ever in a lineage, deleted versions included: what salaries may point at. */
async function lineageIds(db, lineageId) {
  const rows = await db.salaryStructure.findMany({ where: { lineage_id: lineageId }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * The first locked or paid month, from `from` (null = the start) to `to` (null = open), in
 * which someone was paid on this structure. Null when there is none.
 */
export async function frozenUseBetween(db, lineageId, from, to) {
  const where = { deleted_at: null, state: { in: ['LOCKED', 'PAID'] } };
  const periods = await db.payrollPeriod.findMany({ where, orderBy: { period_ym: 'asc' }, select: { period_ym: true } });
  const months = periods.map((p) => p.period_ym).filter((ym) => (!from || lastOfMonth(ym) >= from) && (!to || firstOfMonth(ym) <= to));
  if (!months.length) return null;
  const ids = await lineageIds(db, lineageId);
  for (const ym of months) {
    const used = await db.employeeSalary.count({
      where: {
        structure_id: { in: ids },
        deleted_at: null,
        valid_from: { lte: toDbDate(lastOfMonth(ym)) },
        OR: [{ valid_to: null }, { valid_to: { gte: toDbDate(firstOfMonth(ym)) } }],
      },
    });
    if (used > 0) return ym;
  }
  return null;
}

/** Refuse a change that would reach a frozen month someone was paid on this structure in. */
export async function assertNoFrozenUse(db, lineageId, from, to, what) {
  const ym = await frozenUseBetween(db, lineageId, from, to);
  if (ym) {
    throw new AppError(
      'PAYROLL_FROZEN',
      `${what} would change the salary structure used in ${formatYearMonth(ym)}, whose payroll is locked or paid. Publish a new version from a later month instead, or unlock that payroll first.`,
      409,
    );
  }
}

/** A later version's start: the 1st of a month. */
export function assertMonthStart(date, field = 'valid_from') {
  if (!date || date !== firstOfMonth(ymOf(date))) throw new AppError('VALIDATION', 'A structure version starts on the first day of a month.', 422, field);
}

/** "From the start" or "2026-12-01", and "to 2027-03-31" or "ongoing". */
export function windowText(v) {
  return `${v.valid_from ?? 'the start'} to ${v.valid_to ?? 'ongoing'}`;
}
