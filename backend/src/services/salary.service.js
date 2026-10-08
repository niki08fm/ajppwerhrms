import { addDays, addMonths, firstOfMonth, formatINR, formatYearMonth, lastOfMonth } from '@ajpwer/shared';
import { ctcForGross, salaryPreview } from '../calculations/index.js';
import { AppError } from '../utils/errors.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { ptSlabs, ratesOn, regimesOn, structureComponents } from './rules.service.js';

export async function previewSalary(db, r) {
  await requireSalaryStructure(db, r.structure_id);
  const [components, rates, slabs, regimes] = await Promise.all([structureComponents(db, r.structure_id), ratesOn(db, r.date), ptSlabs(db), regimesOn(db, r.date)]);
  if (components.length === 0) throw new AppError('VALIDATION', 'That salary structure has no components.', 422);
  return salaryPreview({
    mode: r.mode,
    amount: r.amount,
    components,
    pf: { pf_enabled: r.pf_enabled ?? true, pf_restrict_to_ceiling: r.pf_restrict_to_ceiling ?? true, vpf_pct: r.vpf_pct ?? 0 },
    esi_enabled: r.esi_enabled ?? true,
    pt: { pt_applicable: r.pt_applicable ?? true, pt_state: r.pt_state, gender: r.gender },
    rates: { pf: rates.pf, esi: rates.esi },
    pt_slabs: slabs,
    regime: r.tax_regime_code === 'OLD' ? regimes.OLD : regimes.NEW,
    declarations: r.declarations ?? { decl_80c: 0, decl_80d: 0, decl_rent_monthly: 0, decl_metro: false },
    chosen_gross: r.chosen_gross,
    month: Number(r.date.slice(5, 7)),
  });
}

/**
 * The monthly gross a salary agreement resolves to. A CTC inside the ESI band
 * has two valid grosses; the caller must choose one (CTC_AMBIGUOUS otherwise).
 */
export async function resolveMonthlyGross(db, r) {
  // A gross agreement states the monthly amount directly. Saving its history
  // need not invent old tax rules merely to reproduce that entered amount.
  if (r.mode === 'GROSS' && r.requirePreview === false) {
    await requireSalaryStructure(db, r.structure_id);
    if (!(await structureComponents(db, r.structure_id)).length) throw new AppError('VALIDATION', 'That salary structure has no components.', 422, 'structure_id');
    return { monthly_gross: r.amount };
  }
  const preview = await previewSalary(db, r);
  if (r.mode === 'CTC') {
    const sol = preview.solution;
    if (sol.ambiguous) {
      const options = [sol.gross, sol.alternative.gross];
      if (r.chosen_gross === undefined || !options.includes(r.chosen_gross)) {
        throw new AppError(
          'CTC_AMBIGUOUS',
          `This CTC has two valid monthly grosses: ${formatINR(sol.gross)} without ESI and ${formatINR(sol.alternative.gross)} with ESI. Pick one, or move the CTC out of the band.`,
          409,
          'amount',
          {
            options: [
              { gross: sol.gross, esi: false },
              { gross: sol.alternative.gross, esi: true },
            ],
          },
        );
      }
    }
    if (sol.approximate) {
      throw new AppError('VALIDATION', 'No monthly gross reproduces this CTC within ₹2 a month on this structure. Adjust the amount.', 422, 'amount');
    }
  }
  return { monthly_gross: preview.gross, preview };
}

async function requireSalaryStructure(db, id) {
  if (!id) throw new AppError('VALIDATION', 'Choose a salary structure for this employee.', 422, 'structure_id');
  const structure = await db.salaryStructure.findFirst({ where: { id, deleted_at: null }, select: { id: true } });
  if (!structure) throw new AppError('NOT_FOUND', 'That salary structure was not found.', 404, 'structure_id');
}

/**
 * The annual CTC a salary's "% of CTC" components are worked out on. On a CTC
 * agreement it is the agreed figure; on a gross agreement it is the CTC that
 * gross works out to for this person (their PF and ESI choices), the same figure
 * the profile and offer screens show.
 */
export function ctcBasisOf(salary, components, st, rates) {
  if (salary.mode === 'CTC') return salary.amount;
  return ctcForGross(salary.monthly_gross, {
    components,
    pf: { pf_enabled: st.pf_enabled, pf_restrict_to_ceiling: st.pf_restrict_to_ceiling, vpf_pct: Number(st.vpf_pct) },
    esi_enabled: st.esi_enabled,
    rates,
  }).ctc_basis;
}

/**
 * A revision inserts, never updates: the current record is closed the day
 * before the new effective date and a new one is inserted.
 */
export async function insertSalary(tx, employeeId, validFrom, row, actor) {
  await lockSalaryHistory(tx, employeeId);
  const before = await salaryRows(tx, employeeId);
  const current = await tx.employeeSalary.findFirst({
    where: { employee_id: employeeId, deleted_at: null, valid_from: { lte: toDbDate(validFrom) }, OR: [{ valid_to: null }, { valid_to: { gte: toDbDate(validFrom) } }] },
    orderBy: { valid_from: 'desc' },
  });
  const later = await tx.employeeSalary.findFirst({ where: { employee_id: employeeId, deleted_at: null, valid_from: { gt: toDbDate(validFrom) } } });
  if (later) throw new AppError('SALARY_OVERLAP', `A salary record already starts on ${fromDbDate(later.valid_from)}, after this date. Revise from a later date.`, 409, 'valid_from');
  if (current && fromDbDate(current.valid_from) === validFrom) {
    throw new AppError('SALARY_OVERLAP', `A salary record already starts on ${validFrom}. Edit that revision, or pick another effective date.`, 409, 'valid_from');
  }
  const after = before.map((salary) => salary.id === current?.id ? { ...salary, valid_to: toDbDate(addDays(validFrom, -1)) } : salary);
  after.push({ id: 'new', valid_from: toDbDate(validFrom), valid_to: null, ...row });
  await assertSalaryChangesAllowed(tx, employeeId, before, after);
  if (current) await tx.employeeSalary.update({ where: { id: current.id }, data: { valid_to: toDbDate(addDays(validFrom, -1)) } });
  const created = await tx.employeeSalary.create({
    data: {
      employee_id: employeeId,
      valid_from: toDbDate(validFrom),
      mode: row.mode,
      amount: BigInt(row.amount),
      monthly_gross: BigInt(row.monthly_gross),
      structure_id: row.structure_id,
      reason: row.reason,
      created_by: actor,
    },
  });
  return { current, created };
}

async function salaryRows(db, employeeId) {
  return db.employeeSalary.findMany({ where: { employee_id: employeeId, deleted_at: null }, orderBy: { valid_from: 'asc' } });
}

/** Serialise salary mutations and payroll transitions while checking frozen pay. */
async function lockSalaryHistory(tx, employeeId) {
  // Payroll payment transitions lock the period before updating an employee on
  // settlement. Keep that order here to avoid a period/employee deadlock.
  await tx.$queryRaw`
    SELECT p.id FROM payroll_period p
    WHERE EXISTS (SELECT 1 FROM payslip s WHERE s.period_id = p.id AND s.employee_id = ${employeeId}::uuid)
    ORDER BY p.id FOR UPDATE`;
  const [employee] = await tx.$queryRaw`
    SELECT id, status FROM employee WHERE id = ${employeeId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (!employee) throw new AppError('NOT_FOUND', 'That employee was not found.', 404);
  // The status may have changed after the controller loaded the profile while
  // this request waited for a payment transition to finish.
  if (employee.status === 'EXITED') throw new AppError('FORBIDDEN', 'This employee has exited. Their profile is read-only.', 403);
}

async function protectedPayslips(db, employeeId) {
  return db.payslip.findMany({
    where: { employee_id: employeeId, deleted_at: null, period: { deleted_at: null, state: { in: ['LOCKED', 'PAID'] } } },
    select: { meta: true, period: { select: { period_ym: true, state: true } } },
  });
}

const salaryFrom = (row) => fromDbDate(row.valid_from);
const salaryTo = (row) => fromDbDate(row.valid_to);
const overlaps = (a, b) => (!a.to || a.to >= b.from) && (!b.to || b.to >= a.from);
const payMonth = (slip) => slip.meta?.final_month_ym ?? slip.period.period_ym;
const protectedReason = (slip) => `Used by ${slip.period.state.toLowerCase()} payroll for ${formatYearMonth(slip.period.period_ym)}. Unlock that payroll before changing this salary history.`;

/** Permission hints; changes that move a date also receive a fresh server check. */
export async function salaryHistoryProtection(db, employeeId, rows) {
  const slips = await protectedPayslips(db, employeeId);
  const latestStart = rows.reduce((latest, row) => salaryFrom(row) > latest ? salaryFrom(row) : latest, '');
  return new Map(rows.map((row) => {
    const affected = slips.filter((item) => item.meta?.salary?.salary_id === row.id || overlaps(
      { from: salaryFrom(row), to: salaryTo(row) },
      { from: firstOfMonth(payMonth(item)), to: lastOfMonth(payMonth(item)) },
    ));
    const slip = affected[0];
    // A protected latest agreement can still be revised for later pay without
    // changing its frozen snapshot. Older rows must not suggest a new revision
    // before a later agreement already in the employee's history.
    const lastProtectedMonth = affected.reduce((latest, item) => payMonth(item) > latest ? payMonth(item) : latest, salaryFrom(row).slice(0, 7));
    return [row.id, {
      can_edit: !slip,
      can_delete: !slip && rows.length > 1,
      protection_reason: slip ? protectedReason(slip) : null,
      deletion_reason: slip ? protectedReason(slip) : rows.length === 1 ? 'Keep at least one salary revision.' : null,
      next_revision_month: slip && salaryFrom(row) === latestStart ? addMonths(lastProtectedMonth, 1) : null,
    }];
  }));
}

function salaryAt(rows, date) {
  return rows.find((row) => salaryFrom(row) <= date && (!salaryTo(row) || salaryTo(row) >= date));
}

const salarySignature = (row) => row ? [row.id, row.mode, String(row.amount), String(row.monthly_gross), row.structure_id].join('|') : null;

/** Compare only intervals where the agreement changes, allowing future revisions. */
function changedSalaryRanges(before, after) {
  const boundaries = [...new Set([...before, ...after].flatMap((row) => [salaryFrom(row), ...(salaryTo(row) ? [addDays(salaryTo(row), 1)] : [])]))].sort();
  return boundaries.flatMap((from, index) => salarySignature(salaryAt(before, from)) === salarySignature(salaryAt(after, from)) ? [] : [{
    from, to: boundaries[index + 1] ? addDays(boundaries[index + 1], -1) : null,
  }]);
}

async function assertSalaryChangesAllowed(tx, employeeId, before, after, changedIds = []) {
  const ranges = changedSalaryRanges(before, after);
  const slips = await protectedPayslips(tx, employeeId);
  const protectedSlip = slips.find((slip) => {
    const month = { from: firstOfMonth(payMonth(slip)), to: lastOfMonth(payMonth(slip)) };
    return changedIds.includes(slip.meta?.salary?.salary_id)
      || before.some((row) => changedIds.includes(row.id) && overlaps({ from: salaryFrom(row), to: salaryTo(row) }, month))
      || ranges.some((range) => overlaps(range, month));
  });
  if (protectedSlip) throw new AppError('SALARY_PROTECTED', protectedReason(protectedSlip), 409);
}

function rebuildDates(rows) {
  const sorted = [...rows].sort((a, b) => salaryFrom(a).localeCompare(salaryFrom(b)));
  for (let index = 0; index < sorted.length; index++) {
    if (index && salaryFrom(sorted[index]) === salaryFrom(sorted[index - 1])) {
      throw new AppError('SALARY_OVERLAP', 'Another revision already starts on that date.', 409, 'valid_from');
    }
    sorted[index] = { ...sorted[index], valid_to: sorted[index + 1] ? toDbDate(addDays(salaryFrom(sorted[index + 1]), -1)) : null };
  }
  return sorted;
}

const storedSignature = (row) => JSON.stringify([salarySignature(row), salaryFrom(row), salaryTo(row), row.reason]);

/** Exclude changing intervals temporarily so PostgreSQL's immediate exclusion stays valid. */
async function saveSalaryChanges(tx, before, after) {
  const changed = before.filter((row) => !after.some((next) => next.id === row.id && storedSignature(next) === storedSignature(row)));
  await tx.employeeSalary.updateMany({ where: { id: { in: changed.map((row) => row.id) } }, data: { deleted_at: new Date() } });
  for (const row of after.filter((next) => changed.some((old) => old.id === next.id))) {
    await tx.employeeSalary.update({ where: { id: row.id }, data: {
      valid_from: row.valid_from, valid_to: row.valid_to,
      mode: row.mode, amount: BigInt(row.amount), monthly_gross: BigInt(row.monthly_gross),
      structure_id: row.structure_id, reason: row.reason, deleted_at: null,
    } });
  }
}

export async function editSalary(tx, employeeId, salaryId, validFrom, values) {
  await lockSalaryHistory(tx, employeeId);
  const before = await salaryRows(tx, employeeId);
  const previous = before.find((row) => row.id === salaryId);
  if (!previous) throw new AppError('NOT_FOUND', 'That salary revision was not found.', 404);
  const after = rebuildDates(before.map((row) => row.id === salaryId ? { ...row, ...values, valid_from: toDbDate(validFrom) } : row));
  await assertSalaryChangesAllowed(tx, employeeId, before, after, [salaryId]);
  await saveSalaryChanges(tx, before, after);
  return { previous, updated: after.find((row) => row.id === salaryId), neighbors: after.filter((row) => row.id !== salaryId && storedSignature(row) !== storedSignature(before.find((old) => old.id === row.id))) };
}

export async function deleteSalary(tx, employeeId, salaryId) {
  await lockSalaryHistory(tx, employeeId);
  const before = await salaryRows(tx, employeeId);
  const previous = before.find((row) => row.id === salaryId);
  if (!previous) throw new AppError('NOT_FOUND', 'That salary revision was not found.', 404);
  if (before.length === 1) throw new AppError('LAST_SALARY', 'Keep at least one salary revision.', 409);
  const remaining = before.filter((row) => row.id !== salaryId);
  // Deleting the first agreement keeps the original configured coverage start.
  if (before[0].id === salaryId) remaining[0] = { ...remaining[0], valid_from: before[0].valid_from };
  const after = rebuildDates(remaining);
  await assertSalaryChangesAllowed(tx, employeeId, before, after, [salaryId]);
  await saveSalaryChanges(tx, before, after);
  return { previous, neighbors: after.filter((row) => storedSignature(row) !== storedSignature(before.find((old) => old.id === row.id))) };
}
