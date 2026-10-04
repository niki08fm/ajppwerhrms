import { addDays, istDate, ymOf } from '@ajpwer/shared';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { attendanceFrozen, effectiveTravel } from './attendance.service.js';
import { leaveTypesInUse } from './leave.service.js';
import { dayRegister } from './register.service.js';

/**
 * Everything that waits on HR, as one list — the Approvals screen shows it and the
 * Today screen counts it, so both always agree.
 *
 *   face   a punch the camera could not confirm (pending face exception)
 *   miss   a day closed by the 2 AM auto punch-out that HR has not settled
 *   short  a closed day under the standard hours that HR has not settled
 *   move   a site change whose travel time HR has not reviewed
 *   leave  a pending leave request
 *
 * Missing punch-outs and short days are looked for over the last WINDOW_DAYS days, and
 * never in a month whose attendance payroll has already frozen (nothing can change there).
 * A day is settled once HR saves a correction for it.
 */
export const KINDS = ['face', 'miss', 'short', 'move', 'leave'];
export const WINDOW_DAYS = 7;

const TTL_MS = 10_000;
let memo = null;

const dept = (d) => (d ? { id: d.id, name: d.name, colour: d.colour ?? null } : null);
const person = (e) => (e ? { id: e.id, code: e.code, name: e.name, department: dept(e.department) } : null);

/**
 * The waiting items, newest first. Cached for a few seconds; pass fresh=true right after a
 * decision. `register` is there for tests.
 */
export async function waitingItems(db, now, { fresh = false, register = dayRegister } = {}) {
  if (!fresh && memo && memo.now === now && Date.now() - memo.at < TTL_MS) return memo.items;
  const items = await build(db, now, register);
  memo = { now, at: Date.now(), items };
  return items;
}

async function build(db, now, register) {
  const dates = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(now, -i));
  const frozen = new Map();
  for (const ym of new Set(dates.map(ymOf))) frozen.set(ym, (await attendanceFrozen(db, ym)).frozen);
  const open = dates.filter((d) => !frozen.get(ymOf(d)));

  const [registers, sites, faces, changes, leaves, types] = await Promise.all([
    Promise.all(open.map((d) => register(db, d, undefined, now).then((rows) => [d, rows]))),
    db.site.findMany({ select: { id: true, name: true } }),
    db.faceException.findMany({ where: { status: 'PENDING', deleted_at: null }, include: { site: { select: { id: true, name: true } } }, orderBy: { occurred_at: 'desc' }, take: 300 }),
    db.siteChange.findMany({ where: { reviewed_at: null, status: { not: 'PENDING' }, work_date: { gte: toDbDate(addDays(now, -60)) } }, orderBy: { left_at: 'desc' }, take: 300 }),
    db.leaveRequest.findMany({
      where: { status: 'PENDING', deleted_at: null },
      include: { employee: { select: { id: true, code: true, name: true, department: { select: { id: true, name: true, colour: true } } } } },
      orderBy: { created_at: 'desc' },
      take: 300,
    }),
    leaveTypesInUse(db, now),
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const siteOf = (id) => (id ? { id, name: siteName.get(id) ?? 'Unknown site' } : null);

  // People named by face exceptions and site changes, with their department.
  const ids = [...new Set([...faces.flatMap((f) => [f.claimed_employee_id, f.best_match_id]), ...changes.map((c) => c.employee_id)].filter(Boolean))];
  const people = new Map(
    (await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, department: { select: { id: true, name: true, colour: true } } } })).map((e) => [e.id, person(e)]),
  );

  const items = [];

  for (const f of faces) {
    const who = people.get(f.claimed_employee_id) ?? people.get(f.best_match_id) ?? null;
    items.push({
      id: `face:${f.id}`,
      kind: 'face',
      at: f.occurred_at.toISOString(),
      day: istDate(f.occurred_at),
      employee: who,
      site: f.site ? { id: f.site.id, name: f.site.name } : null,
      detail: {
        exception_id: f.id,
        exception_kind: f.kind,
        reason: f.reason,
        occurred_at: f.occurred_at.toISOString(),
        score: f.score === null ? null : Number(f.score),
        distance_m: f.distance_m,
        direction: f.direction,
        crops: f.crop_keys?.length ?? 0,
        has_snapshot: !!f.snapshot_key,
        best_match: people.get(f.best_match_id) ?? null,
        claimed: people.get(f.claimed_employee_id) ?? null,
        claimed_name: f.claimed_name,
      },
    });
  }

  for (const [date, rows] of registers) {
    for (const r of rows) {
      if (r.override || r.open_now) continue;
      const base = {
        day: date,
        employee: person(r.employee),
        site: siteOf(r.day.sites?.[0]),
        detail: {
          work_date: date,
          status: r.day.status,
          in_min: r.in_min,
          out_min: r.out_min,
          worked_min: r.day.worked_min,
          early_min: r.day.early_min,
          late_min: r.day.late_min,
          standard_min: r.context.standard_min,
          sites: (r.day.sites ?? []).map((id) => siteName.get(id) ?? 'Unknown site'),
        },
      };
      // A day still open at 2 AM tonight is not missing yet.
      if (r.day.status === 'MISSING_PUNCH' && date < now) {
        items.push({ ...base, id: `miss:${r.employee.id}:${date}`, kind: 'miss', at: new Date(`${date}T23:59:00+05:30`).toISOString() });
      } else if (r.day.status !== 'MISSING_PUNCH' && r.day.early_min > 0) {
        items.push({ ...base, id: `short:${r.employee.id}:${date}`, kind: 'short', at: new Date(`${date}T23:58:00+05:30`).toISOString() });
      }
    }
  }

  for (const c of changes) {
    const date = fromDbDate(c.work_date);
    items.push({
      id: `move:${c.id}`,
      kind: 'move',
      at: c.left_at.toISOString(),
      day: date,
      employee: people.get(c.employee_id) ?? null,
      site: siteOf(c.from_site_id),
      detail: {
        site_change_id: c.id,
        work_date: date,
        from_site: siteOf(c.from_site_id),
        to_site: siteOf(c.to_site_id),
        left_at: c.left_at.toISOString(),
        arrived_at: c.arrived_at?.toISOString() ?? null,
        status: c.status,
        travel_min: effectiveTravel(c),
      },
    });
  }

  const typeName = (code) => types.find((t) => t.code === code)?.name ?? code;
  for (const l of leaves) {
    items.push({
      id: `leave:${l.id}`,
      kind: 'leave',
      at: l.created_at.toISOString(),
      day: istDate(l.created_at),
      employee: person(l.employee),
      site: null,
      detail: {
        leave_id: l.id,
        leave_type: l.leave_type,
        leave_name: typeName(l.leave_type),
        from_date: fromDbDate(l.from_date),
        to_date: fromDbDate(l.to_date),
        days: Number(l.days),
        reason: l.reason,
      },
    });
  }

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
