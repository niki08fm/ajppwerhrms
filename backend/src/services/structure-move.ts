import { addMonths, firstOfMonth, formatINR, formatYearMonth, istDate, ymOf, type YearMonth } from '@ajpwer/shared';
import { solveGrossFromCtc } from '../engines';
import { fromDbDate, toDbDate } from '../lib/db-dates';
import { AppError } from '../lib/errors';
import type { Db } from '../lib/prisma';
import { ratesOn, salaryOn, structureComponents } from './rules';

type Who = { id: string; code: string; name: string };

export interface StructureMove {
  employee: Who;
  mode: 'GROSS' | 'CTC';
  amount: number;
  from_structure_id: string;
  from_gross: number;
  to_gross: number;
  /** A CTC in the ESI band has two valid grosses; the one matching today's ESI status is kept */
  esi_band: boolean;
}

export interface StructureMovePlan {
  /** First month everyone moves to the new structure */
  from: YearMonth;
  structure: { id: string; name: string };
  move: StructureMove[];
  skipped: { employee: Who; reason: string }[];
  /** Already on this structure */
  unchanged: number;
}

/**
 * The earliest month a structure change can still reach: the current month,
 * unless it (or a later one) has already been run, in which case the month after.
 */
export async function firstOpenMonth(db: Db): Promise<YearMonth> {
  const ym = ymOf(istDate(new Date()));
  const closed = await db.payrollPeriod.findFirst({ where: { period_ym: { gte: ym }, state: { not: 'DRAFT' } }, orderBy: { period_ym: 'desc' } });
  return closed ? addMonths(closed.period_ym, 1) : ym;
}

async function assertOpen(db: Db, from: YearMonth) {
  const closed = await db.payrollPeriod.findFirst({ where: { period_ym: { gte: from }, state: { not: 'DRAFT' } }, orderBy: { period_ym: 'desc' } });
  if (closed) {
    throw new AppError(
      'PERIOD_LOCKED',
      `${formatYearMonth(closed.period_ym)} has already been run, so a new structure can start from ${formatYearMonth(addMonths(closed.period_ym, 1))} at the earliest.`,
      409,
      'structure_from',
    );
  }
}

/**
 * Who moves when a pay group is attached to a different structure, and who
 * cannot. Nothing is written. Each person keeps their agreed amount: a gross
 * agreement keeps its gross; a CTC agreement keeps its CTC and the gross is
 * solved again on the new structure.
 */
export async function planStructureMove(db: Db, payGroupId: string, structureId: string, from?: YearMonth): Promise<StructureMovePlan> {
  const month = from ?? (await firstOpenMonth(db));
  await assertOpen(db, month);
  const applyDate = firstOfMonth(month);
  const structure = await db.salaryStructure.findFirst({ where: { id: structureId, deleted_at: null }, select: { id: true, name: true } });
  if (!structure) throw new AppError('NOT_FOUND', 'That salary structure does not exist.', 404, 'structure_id');
  const [components, rates] = await Promise.all([structureComponents(db, structureId), ratesOn(db, applyDate)]);

  const people = await db.employee.findMany({
    where: { pay_group_id: payGroupId, deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'ONBOARDING'] }, OR: [{ last_day: null }, { last_day: { gte: toDbDate(applyDate) } }] },
    select: { id: true, code: true, name: true, statutory: true },
    orderBy: { code: 'asc' },
  });

  const plan: StructureMovePlan = { from: month, structure, move: [], skipped: [], unchanged: 0 };
  for (const p of people) {
    const who: Who = { id: p.id, code: p.code, name: p.name };
    const later = await db.employeeSalary.findFirst({ where: { employee_id: p.id, deleted_at: null, valid_from: { gt: toDbDate(applyDate) } }, orderBy: { valid_from: 'asc' } });
    if (later) {
      if (later.structure_id !== structureId) plan.skipped.push({ employee: who, reason: `Has a salary change starting ${fromDbDate(later.valid_from)}, after ${formatYearMonth(month)}. Set the structure on that change.` });
      else plan.unchanged++;
      continue;
    }
    const cur = await salaryOn(db, p.id, applyDate);
    if (!cur) {
      plan.skipped.push({ employee: who, reason: 'Has no salary on record.' });
      continue;
    }
    if (cur.structure_id === structureId) {
      plan.unchanged++;
      continue;
    }
    if (cur.valid_from === applyDate) {
      plan.skipped.push({ employee: who, reason: `Already has a salary change on ${applyDate}. Set the structure on that change.` });
      continue;
    }
    if (cur.mode === 'GROSS') {
      plan.move.push({ employee: who, mode: 'GROSS', amount: cur.amount, from_structure_id: cur.structure_id, from_gross: cur.monthly_gross, to_gross: cur.monthly_gross, esi_band: false });
      continue;
    }
    const st = p.statutory;
    const sol = solveGrossFromCtc(cur.amount, {
      components,
      pf: { pf_enabled: st?.pf_enabled ?? true, pf_restrict_to_ceiling: st?.pf_restrict_to_ceiling ?? true, vpf_pct: Number(st?.vpf_pct ?? 0) },
      esi_enabled: st?.esi_enabled ?? true,
      rates: { pf: rates.pf, esi: rates.esi },
    });
    if (sol.approximate) {
      plan.skipped.push({ employee: who, reason: `No monthly gross on ${structure.name} reproduces their CTC of ${formatINR(cur.amount)}. Revise their salary.` });
      continue;
    }
    // Inside the ESI band, keep them on the side of the ceiling they are on today.
    const onEsiToday = cur.monthly_gross <= rates.esi.ceiling;
    const gross = sol.ambiguous && onEsiToday && sol.alternative ? sol.alternative.gross : sol.gross;
    plan.move.push({ employee: who, mode: 'CTC', amount: cur.amount, from_structure_id: cur.structure_id, from_gross: cur.monthly_gross, to_gross: gross, esi_band: sol.ambiguous });
  }
  return plan;
}
