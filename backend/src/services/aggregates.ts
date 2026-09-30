import { addDays, type ISODate } from '@ajpwer/shared';
import { toEnginePunch } from './attendance';
import { pairPunches } from '../engines';
import { toDbDate } from '../lib/db-dates';
import { prisma, type Db } from '../lib/prisma';

/**
 * Cached daily aggregates for the dashboard and analytics: written by the
 * nightly job and refreshed incrementally on each punch. A 60-day trend is
 * never computed across the workforce on a dashboard load.
 */
export async function recomputeDay(db: Db, date: ISODate, siteId: string | null) {
  const punches = await db.punch.findMany({
    where: { work_date: toDbDate(date), ...(siteId ? { site_id: siteId } : {}) },
    select: { id: true, employee_id: true, punched_at: true, work_date: true, direction: true, site_id: true, method: true },
    orderBy: { punched_at: 'asc' },
  });
  const byEmp = new Map<string, typeof punches>();
  for (const p of punches) byEmp.set(p.employee_id, [...(byEmp.get(p.employee_id) ?? []), p]);
  let worked = 0;
  for (const list of byEmp.values()) worked += pairPunches(list.map(toEnginePunch)).worked_min;
  const headcount = siteId
    ? byEmp.size
    : await db.employee.count({
        where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] }, joined_on: { lte: toDbDate(date) }, OR: [{ last_day: null }, { last_day: { gte: toDbDate(date) } }] },
      });
  const existing = await db.dailyAggregate.findFirst({ where: { date: toDbDate(date), site_id: siteId } });
  const data = { present: byEmp.size, worked_min: worked, headcount };
  if (existing) await db.dailyAggregate.update({ where: { id: existing.id }, data });
  else await db.dailyAggregate.create({ data: { date: toDbDate(date), site_id: siteId, ...data } });
}

export async function bumpAggregate(date: ISODate, siteId: string) {
  await recomputeDay(prisma, date, siteId);
  await recomputeDay(prisma, date, null);
}

/** Nightly: rebuild the last `days` days for every site and the company row. */
export async function rebuildAggregates(days = 60, until: ISODate) {
  const sites = await prisma.site.findMany({ where: { deleted_at: null }, select: { id: true } });
  for (let i = 0; i < days; i++) {
    const d = addDays(until, -i);
    await recomputeDay(prisma, d, null);
    for (const s of sites) await recomputeDay(prisma, d, s.id);
  }
}
