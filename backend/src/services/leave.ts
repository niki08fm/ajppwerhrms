import { maxDate, type ISODate, type LeaveRules, type LeaveType } from '@ajpwer/shared';
import { pickPolicy } from '../engines';
import { fromDbDate, toDbDate } from '../lib/db-dates';
import type { Db } from '../lib/prisma';
import { payGroupRules } from './rules';

export interface LeaveBalanceRow {
  leave_type: string;
  name: string;
  paid: boolean;
  encashable: boolean;
  entitlement: number;
  accrued: number;
  used: number;
  pending: number;
  balance: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function monthsBetween(from: ISODate, to: ISODate): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

/**
 * Balances are derived from the leave policy and the request records — a
 * convenience recomputed on demand, never the source of truth.
 * Accruing types (paid leave) accrue monthly; others are granted for the
 * months of the calendar year the person is employed.
 */
export async function leaveBalances(db: Db, employee: { id: string; joined_on: Date; pay_group_id: string }, asOf: ISODate): Promise<LeaveBalanceRow[]> {
  const rules = await payGroupRules(db, employee.pay_group_id);
  const policy = pickPolicy(rules.policies, 'LEAVE', asOf);
  const types: LeaveType[] = (policy?.rules as LeaveRules | undefined)?.types ?? [];
  const year = Number(asOf.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const start = maxDate(yearStart, fromDbDate(employee.joined_on));
  const requests = await db.leaveRequest.findMany({
    where: { employee_id: employee.id, deleted_at: null, status: { in: ['APPROVED', 'PENDING'] }, from_date: { gte: toDbDate(yearStart), lte: toDbDate(`${year}-12-31`) } },
  });
  return types.map((t) => {
    const monthsSoFar = start > asOf ? 0 : monthsBetween(start, asOf);
    const monthsInYear = start > `${year}-12-31` ? 0 : monthsBetween(start, `${year}-12-31`);
    const accrued = t.accrues ? round2((t.annual_days / 12) * monthsSoFar) : round2((t.annual_days / 12) * monthsInYear);
    const used = round2(requests.filter((r) => r.leave_type === t.code && r.status === 'APPROVED').reduce((s, r) => s + Number(r.days), 0));
    const pending = round2(requests.filter((r) => r.leave_type === t.code && r.status === 'PENDING').reduce((s, r) => s + Number(r.days), 0));
    return {
      leave_type: t.code,
      name: t.name,
      paid: t.paid,
      encashable: t.encashable,
      entitlement: t.annual_days,
      accrued,
      used,
      pending,
      balance: t.annual_days === 0 ? 0 : round2(accrued - used),
    };
  });
}
