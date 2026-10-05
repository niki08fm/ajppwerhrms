import { EXIT_CHECKLIST, formatYearMonth } from '@ajpwer/shared';
import { AppError } from '../utils/errors.js';

/** The exit checklist — the same tasks for every exit — with what has been ticked, by whom and when. */
export async function exitChecklist(db, employeeId) {
  const rows = await db.exitTask.findMany({ where: { employee_id: employeeId, deleted_at: null } });
  return EXIT_CHECKLIST.map((t) => {
    const r = rows.find((x) => x.task_code === t.code);
    return { ...t, done_at: r?.done_at ?? null, done_by: r?.done_by ?? null, note: r?.note ?? null };
  });
}

/** The person's current settlement row, if there is one. */
export function currentSettlement(db, employeeId) {
  return db.settlement.findFirst({ where: { employee_id: employeeId, deleted_at: null }, orderBy: { created_at: 'desc' } });
}

/**
 * A settlement can be changed until it is paid, and once processed into a month's payroll
 * only until that payroll's F&F step (step 4) is submitted.
 */
export async function assertSettlementEditable(db, s) {
  if (!s) return;
  if (s.state === 'PAID') throw new AppError('CONFLICT', 'This settlement has been paid and is frozen.', 409);
  if (s.state === 'INCLUDED' && s.period_id) {
    const p = await db.payrollPeriod.findUnique({ where: { id: s.period_id } });
    if (p && (p.state !== 'DRAFT' || p.steps_submitted.includes(4))) {
      throw new AppError('PERIOD_LOCKED', `It is processed in the ${formatYearMonth(p.period_ym)} payroll, which has moved past its F&F step. Reopen step 4 there to change it.`, 409);
    }
  }
}
