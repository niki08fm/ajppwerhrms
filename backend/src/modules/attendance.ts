import { Router } from 'express';
import { z } from 'zod';
import {
  bulkOverrideSchema,
  DAY_STATUS_LABELS,
  faceExceptionDecideSchema,
  formatMinutes,
  isoDate,
  istDate,
  overrideCreateSchema,
  yearMonth,
  ymOf,
  type ISODate,
  type OvertimeRules,
} from '@ajpwer/shared';
import { assignWorkDate, overrideDiffers, pickPolicy } from '../engines';
import { audit, who } from '../lib/audit';
import { requirePerm } from '../lib/auth';
import { fromDbDate, toDbDate } from '../lib/db-dates';
import { ah, AppError, notFound } from '../lib/errors';
import { filterOne, filterValues, keysetOrder, keysetWhere, page, parseList, toCSV, type SortSpec } from '../lib/list';
import { Prisma, prisma, type Tx } from '../lib/prisma';
import { attendanceFrozen, computeMonths } from '../services/attendance';
import { computePayslip, loadRecoveries } from '../services/payslip';
import { payContext } from '../services/payroll';
import { dayRegister } from '../services/register';

export const attendanceRouter = Router();
const today = () => istDate(new Date());

// ─── Register: one day, everyone ─────────────────────────────────────────────

attendanceRouter.get(
  '/attendance',
  requirePerm('attendance.read'),
  ah(async (req, res) => {
    const date = isoDate.parse(req.query.date ?? today());
    const p = parseList(req, [
      { key: 'name', field: 'name', type: 'string' },
      { key: 'worked', field: 'worked', type: 'number' },
      { key: 'late', field: 'late', type: 'number' },
      { key: 'ot', field: 'ot', type: 'number' },
      { key: 'in', field: 'in', type: 'number' },
    ], 'name');
    let rows = await dayRegister(prisma, date, undefined, today());
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.day.status] = (counts[r.day.status] ?? 0) + 1;

    // Filters are applied on the server, never in the browser.
    const q = p.q?.toLowerCase();
    if (q) rows = rows.filter((r) => r.employee.name.toLowerCase().includes(q) || r.employee.code.toLowerCase().includes(q));
    const dept = filterValues(p.filter, 'dept');
    if (dept.length) rows = rows.filter((r) => dept.includes(r.employee.department.id));
    const pg = filterValues(p.filter, 'pay_group');
    if (pg.length) rows = rows.filter((r) => pg.includes(r.employee.pay_group_id));
    const status = filterValues(p.filter, 'status');
    if (status.length) rows = rows.filter((r) => status.includes(r.day.status));
    const site = filterValues(p.filter, 'site');
    if (site.length) rows = rows.filter((r) => r.day.sites.some((s) => site.includes(s)));
    if (filterOne(p.filter, 'corrected') === 'yes') rows = rows.filter((r) => r.override);
    if (filterOne(p.filter, 'late') === 'yes') rows = rows.filter((r) => r.day.late_min > 0);
    if (filterOne(p.filter, 'ot') === 'yes') rows = rows.filter((r) => r.day.ot_min > 0);

    const key = (r: (typeof rows)[number]): string | number =>
      p.sort.key === 'name' ? r.employee.name.toLowerCase() : p.sort.key === 'worked' ? r.day.worked_min : p.sort.key === 'late' ? r.day.late_min : p.sort.key === 'ot' ? r.day.ot_min : r.in_min ?? 99999;
    rows.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = ka < kb ? -1 : ka > kb ? 1 : a.employee.id.localeCompare(b.employee.id);
      return p.dir === 'desc' ? -c : c;
    });

    if (req.query.format === 'csv') {
      const sites = await prisma.site.findMany({ select: { id: true, code: true } });
      const code = (id: string) => sites.find((s) => s.id === id)?.code ?? id;
      const csv = toCSV(
        rows.map((r) => ({
          code: r.employee.code,
          name: r.employee.name,
          department: r.employee.department.name,
          status: DAY_STATUS_LABELS[r.day.status],
          in: r.in_min === null ? '' : `${String(Math.floor(r.in_min / 60)).padStart(2, '0')}:${String(r.in_min % 60).padStart(2, '0')}`,
          out: r.out_min === null ? '' : `${String(Math.floor(r.out_min / 60) % 24).padStart(2, '0')}:${String(r.out_min % 60).padStart(2, '0')}`,
          worked: formatMinutes(r.day.worked_min),
          late: r.day.late_min,
          ot: r.day.ot_min,
          sites: r.day.sites.map(code).join(' + '),
          corrected: r.override ? 'yes' : '',
        })),
        [
          { key: 'code', label: 'Employee code' },
          { key: 'name', label: 'Name' },
          { key: 'department', label: 'Department' },
          { key: 'status', label: 'Status' },
          { key: 'in', label: 'In' },
          { key: 'out', label: 'Out' },
          { key: 'worked', label: 'Worked' },
          { key: 'late', label: 'Late (min)' },
          { key: 'ot', label: 'Overtime (min)' },
          { key: 'sites', label: 'Sites' },
          { key: 'corrected', label: 'Corrected' },
        ],
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="attendance-${date}.csv"`);
      return res.send(csv);
    }

    // Keyset over the computed, sorted rows.
    let start = 0;
    if (p.cursor) {
      const idx = rows.findIndex((r) => r.employee.id === p.cursor!.id);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = rows.slice(start, start + p.limit);
    const hasMore = start + p.limit < rows.length;
    const last = slice[slice.length - 1];
    const frozen = await attendanceFrozen(prisma, ymOf(date));
    res.json({
      data: slice,
      meta: {
        total: rows.length,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: null, id: last.employee.id })).toString('base64url') : null,
        counts,
        date,
        frozen,
      },
    });
  }),
);

/** Everything the correction drawer needs for one person-day. */
attendanceRouter.get(
  '/attendance/day',
  requirePerm('attendance.read'),
  ah(async (req, res) => {
    const q = z.object({ employee_id: z.string().uuid(), date: isoDate }).parse(req.query);
    const [row] = await dayRegister(prisma, q.date, [q.employee_id]);
    const punches = await prisma.punch.findMany({
      where: { employee_id: q.employee_id, work_date: toDbDate(q.date) },
      include: { site: { select: { id: true, code: true, name: true } } },
      orderBy: { punched_at: 'asc' },
    });
    const override = await prisma.attendanceOverride.findUnique({ where: { employee_id_work_date: { employee_id: q.employee_id, work_date: toDbDate(q.date) } } });
    const frozen = await attendanceFrozen(prisma, ymOf(q.date));
    const employee = await prisma.employee.findUnique({ where: { id: q.employee_id }, select: { id: true, code: true, name: true } });
    res.json({
      data: {
        employee,
        date: q.date,
        punches: punches.map((p) => ({ ...p, match_score: p.match_score === null ? null : Number(p.match_score), work_date: fromDbDate(p.work_date) })),
        computed: row ? { ...row.computed, flags: row.day.flags.filter((f) => f !== 'OVERRIDDEN'), sites: row.day.sites, pairs: row.day.pairs.length, break_min: row.day.break_min } : null,
        not_in_employment: !row,
        override: override && !override.deleted_at ? { ...override, day_value: Number(override.day_value), work_date: fromDbDate(override.work_date) } : null,
        frozen,
      },
    });
  }),
);

async function assertNotFrozen(date: ISODate) {
  const f = await attendanceFrozen(prisma, ymOf(date));
  if (f.frozen) throw new AppError('ATTENDANCE_FROZEN', f.reason!, 409);
}

async function writeOverride(tx: Tx, b: z.infer<typeof overrideCreateSchema>, actor: string, ip: string | null) {
  const [row] = await dayRegister(tx, b.work_date, [b.employee_id]);
  if (!row) throw new AppError('VALIDATION', 'This person was not employed on that date.', 422);
  const computed = row.computed;
  const proposed = { status: b.status, day_value: b.day_value, worked_min: b.worked_min, ot_min: b.ot_min, late_min: b.late_min };
  // Compare against the current effective values: an override that changes nothing is noise in the audit trail.
  const current = row.override ? { status: row.day.status, day_value: row.day.day_value, worked_min: row.day.worked_min, ot_min: row.day.ot_min, late_min: row.day.late_min } : computed;
  if (!overrideDiffers(current, proposed)) {
    throw new AppError('NO_CHANGE', 'Nothing differs from the current values, so there is nothing to correct.', 422);
  }
  const data = {
    status: b.status,
    day_value: b.day_value,
    worked_min: b.worked_min,
    ot_min: b.ot_min,
    late_min: b.late_min,
    reason_code: b.reason_code,
    reason_text: b.reason_text.trim(),
    created_by: actor,
    computed_snapshot: JSON.parse(JSON.stringify({ ...computed, flags: row.day.flags, sites: row.day.sites })),
    deleted_at: null,
  };
  const o = await tx.attendanceOverride.upsert({
    where: { employee_id_work_date: { employee_id: b.employee_id, work_date: toDbDate(b.work_date) } },
    update: data,
    create: { employee_id: b.employee_id, work_date: toDbDate(b.work_date), ...data },
  });
  await audit(tx, {
    actor,
    ip,
    action: 'attendance.override',
    entity_type: 'attendance_override',
    entity_id: o.id,
    detail: { employee_id: b.employee_id, work_date: b.work_date, computed, overridden: proposed, reason_code: b.reason_code, reason_text: b.reason_text },
  });
  return o;
}

attendanceRouter.post(
  '/attendance/overrides',
  requirePerm('attendance.write'),
  ah(async (req, res) => {
    const b = overrideCreateSchema.parse(req.body);
    await assertNotFrozen(b.work_date);
    const { actor, ip } = who(req);
    const o = await prisma.$transaction((tx) => writeOverride(tx, b, actor, ip));
    res.status(201).json({ data: { ...o, day_value: Number(o.day_value), work_date: fromDbDate(o.work_date) } });
  }),
);

/** The same correction with one reason applied to many days. */
attendanceRouter.post(
  '/attendance/overrides/bulk',
  requirePerm('attendance.write'),
  ah(async (req, res) => {
    const b = bulkOverrideSchema.parse(req.body);
    for (const ym of new Set(b.items.map((i) => ymOf(i.work_date)))) await assertNotFrozen(`${ym}-01`);
    const { actor, ip } = who(req);
    const results = await prisma.$transaction(
      async (tx) => {
        const out: { employee_id: string; work_date: string; ok: boolean; message?: string }[] = [];
        for (const it of b.items) {
          const [row] = await dayRegister(tx, it.work_date, [it.employee_id]);
          if (!row) {
            out.push({ ...it, ok: false, message: 'Not employed on that date' });
            continue;
          }
          try {
            await writeOverride(
              tx,
              {
                employee_id: it.employee_id,
                work_date: it.work_date,
                status: b.status,
                day_value: b.day_value,
                worked_min: b.worked_min ?? row.computed.worked_min,
                ot_min: b.ot_min ?? 0,
                late_min: b.late_min ?? 0,
                reason_code: b.reason_code,
                reason_text: b.reason_text,
              },
              actor,
              ip,
            );
            out.push({ ...it, ok: true });
          } catch (err) {
            out.push({ ...it, ok: false, message: err instanceof Error ? err.message : 'failed' });
          }
        }
        return out;
      },
      { timeout: 120_000 },
    );
    res.json({ data: { applied: results.filter((r) => r.ok).length, results } });
  }),
);

/** Revert: removes the override entirely, restoring the computed values. */
attendanceRouter.delete(
  '/attendance/overrides/:id',
  requirePerm('attendance.write'),
  ah(async (req, res) => {
    const o = await prisma.attendanceOverride.findUnique({ where: { id: req.params.id } });
    if (!o || o.deleted_at) throw notFound('That correction');
    await assertNotFrozen(fromDbDate(o.work_date));
    const { actor, ip } = who(req);
    await prisma.$transaction(async (tx) => {
      await tx.attendanceOverride.delete({ where: { id: o.id } });
      await audit(tx, {
        actor,
        ip,
        action: 'attendance.override.revert',
        entity_type: 'attendance_override',
        entity_id: o.id,
        detail: { employee_id: o.employee_id, work_date: fromDbDate(o.work_date), removed: { status: o.status, day_value: Number(o.day_value), worked_min: o.worked_min, ot_min: o.ot_min, late_min: o.late_min }, restored: o.computed_snapshot },
      });
    });
    res.json({ data: { reverted: true } });
  }),
);

// ─── Manual punch (admin, e.g. device down) ──────────────────────────────────

attendanceRouter.post(
  '/punches/manual',
  requirePerm('attendance.write'),
  ah(async (req, res) => {
    const b = z
      .object({ employee_id: z.string().uuid(), site_id: z.string().uuid(), direction: z.enum(['IN', 'OUT']), punched_at: z.string().datetime({ offset: true }), reason: z.string().min(8) })
      .strict()
      .parse(req.body);
    const at = new Date(b.punched_at);
    await assertNotFrozen(istDate(at));
    const last = await prisma.punch.findFirst({ where: { employee_id: b.employee_id, punched_at: { lt: at } }, orderBy: { punched_at: 'desc' } });
    const work_date = assignWorkDate(at, b.direction, last ? { direction: last.direction, work_date: fromDbDate(last.work_date), at: last.punched_at.getTime() } : null);
    const { actor, ip } = who(req);
    const p = await prisma.$transaction(async (tx) => {
      const created = await tx.punch.create({
        data: { employee_id: b.employee_id, site_id: b.site_id, direction: b.direction, punched_at: at, client_punched_at: at, work_date: toDbDate(work_date), method: 'MANUAL', device_id: `admin:${actor}`, flagged: true, flag_reason: b.reason },
      });
      await audit(tx, { actor, ip, action: 'punch.manual', entity_type: 'punch', entity_id: created.id, detail: { employee_id: b.employee_id, work_date, direction: b.direction, reason: b.reason } });
      return created;
    });
    res.status(201).json({ data: p });
  }),
);

// ─── Punch log ───────────────────────────────────────────────────────────────

const PUNCH_SORTS: SortSpec[] = [{ key: 'time', field: 'punched_at', type: 'date' }];

attendanceRouter.get(
  '/punches',
  requirePerm('attendance.read'),
  ah(async (req, res) => {
    const p = parseList(req, PUNCH_SORTS, '-time');
    const and: Prisma.PunchWhereInput[] = [];
    const from = filterOne(p.filter, 'from');
    const to = filterOne(p.filter, 'to');
    if (from) and.push({ work_date: { gte: toDbDate(from) } });
    if (to) and.push({ work_date: { lte: toDbDate(to) } });
    const site = filterValues(p.filter, 'site');
    if (site.length) and.push({ site_id: { in: site } });
    const emp = filterValues(p.filter, 'employee');
    if (emp.length) and.push({ employee_id: { in: emp } });
    const method = filterValues(p.filter, 'method');
    if (method.length) and.push({ method: { in: method as never } });
    if (filterOne(p.filter, 'flagged') === 'yes') and.push({ flagged: true });
    if (p.q) and.push({ employee: { OR: [{ name: { contains: p.q, mode: 'insensitive' } }, { code: { contains: p.q, mode: 'insensitive' } }] } });
    const where: Prisma.PunchWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      prisma.punch.findMany({
        where: { AND: [where, keysetWhere(p) ?? {}] },
        orderBy: keysetOrder(p) as Prisma.PunchOrderByWithRelationInput[],
        take: p.limit + 1,
        include: { employee: { select: { id: true, code: true, name: true } }, site: { select: { id: true, code: true, name: true } } },
      }),
      prisma.punch.count({ where }),
    ]);
    res.json(page(rows, p, total, (r) => ({ ...r, work_date: fromDbDate(r.work_date), match_score: r.match_score === null ? null : Number(r.match_score) })));
  }),
);

// ─── Overtime ────────────────────────────────────────────────────────────────

attendanceRouter.get(
  '/overtime',
  requirePerm('attendance.read'),
  ah(async (req, res) => {
    const month = yearMonth.parse(req.query.month ?? ymOf(today()));
    const employees = await prisma.employee.findMany({
      where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] }, joined_on: { lte: toDbDate(`${month}-28`) }, OR: [{ last_day: null }, { last_day: { gte: toDbDate(`${month}-01`) } }] },
      include: { statutory: true, department: { select: { id: true, name: true } } },
    });
    const months = await computeMonths(prisma, employees, month);
    const withOt = employees.filter((e) => (months.get(e.id)?.result.totals.ot_min ?? 0) > 0 || (months.get(e.id)?.result.offday_work.length ?? 0) > 0);
    const ctx = await payContext(prisma, month);
    const rec = await loadRecoveries(prisma, withOt.map((e) => e.id), month);
    const rows = [];
    for (const e of withOt) {
      const m = months.get(e.id)!;
      try {
        const ps = await computePayslip(prisma, e, month, m, ctx, rec.get(e.id) ?? null);
        const pol = pickPolicy(m.rules.policies, 'OVERTIME', `${month}-28`);
        const r = pol?.rules as OvertimeRules | undefined;
        rows.push({
          employee: { id: e.id, code: e.code, name: e.name, department: e.department },
          ot_min: m.result.totals.ot_min,
          paid_min: ps.result.ot?.paid_min ?? 0,
          excess_min: ps.result.ot?.excess_min ?? 0,
          hourly: ps.result.ot?.hourly ?? 0,
          multiplier: r?.multiplier ?? null,
          base: r?.base ?? null,
          policy: pol ? { name: pol.name, version: pol.version } : null,
          amount: ps.result.ot?.amount ?? 0,
          offday_days: m.result.offday_work.length,
          offday_amount: ps.result.lines.filter((l) => l.kind === 'OFFDAY').reduce((s, l) => s + l.amount, 0),
          over_cap: (ps.result.ot?.excess_min ?? 0) > 0,
        });
      } catch {
        // someone without a salary or statutory row: surfaced in payroll issues instead
      }
    }
    rows.sort((a, b) => b.amount + b.offday_amount - (a.amount + a.offday_amount));
    res.json({ data: rows, meta: { total: rows.length, nextCursor: null, month } });
  }),
);

// ─── Face exceptions (Approvals) ─────────────────────────────────────────────

attendanceRouter.get(
  '/face-exceptions',
  requirePerm('attendance.read'),
  ah(async (req, res) => {
    const status = (req.query.status as string) || 'PENDING';
    const rows = await prisma.faceException.findMany({
      where: { status: status as never, deleted_at: null },
      include: { site: { select: { id: true, code: true, name: true } } },
      orderBy: { occurred_at: 'asc' },
      take: 200,
    });
    const ids = [...new Set(rows.flatMap((r) => [r.best_match_id, r.claimed_employee_id, r.decided_employee_id]).filter(Boolean) as string[])];
    const people = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, designation: true } });
    const person = (id: string | null) => (id ? people.find((p) => p.id === id) ?? null : null);
    res.json({
      data: rows.map((r) => ({
        ...r,
        score: r.score === null ? null : Number(r.score),
        best_match: person(r.best_match_id),
        claimed: person(r.claimed_employee_id),
        decided_employee: person(r.decided_employee_id),
        has_snapshot: !!r.snapshot_key,
      })),
      meta: { total: rows.length, nextCursor: null },
    });
  }),
);

/**
 * Approving writes the punch at the time of the attempt, not the time of the
 * decision — someone at the gate at 08:04 reviewed at 16:30 gets an 08:04 punch.
 */
attendanceRouter.post(
  '/face-exceptions/:id/decide',
  requirePerm('attendance.write'),
  ah(async (req, res) => {
    const b = faceExceptionDecideSchema.parse(req.body);
    const fx = await prisma.faceException.findUnique({ where: { id: req.params.id } });
    if (!fx) throw notFound('That exception');
    if (fx.status !== 'PENDING') throw new AppError('CONFLICT', 'This exception has already been decided.', 409);
    const { actor, ip } = who(req);
    const result = await prisma.$transaction(async (tx) => {
      let punchId: string | null = null;
      if (b.decision === 'APPROVE') {
        const at = fx.occurred_at;
        const last = await tx.punch.findFirst({ where: { employee_id: b.employee_id!, punched_at: { lt: at } }, orderBy: { punched_at: 'desc' } });
        const direction = b.direction ?? fx.direction ?? (!last || last.direction === 'OUT' ? 'IN' : 'OUT');
        const work_date = assignWorkDate(at, direction, last ? { direction: last.direction, work_date: fromDbDate(last.work_date), at: last.punched_at.getTime() } : null);
        const frozen = await attendanceFrozen(tx, ymOf(work_date));
        if (frozen.frozen) throw new AppError('ATTENDANCE_FROZEN', frozen.reason!, 409);
        const p = await tx.punch.create({
          data: {
            employee_id: b.employee_id!,
            site_id: fx.site_id,
            direction,
            punched_at: at,
            client_punched_at: at,
            work_date: toDbDate(work_date),
            method: 'EXCEPTION',
            match_score: fx.score,
            distance_m: fx.distance_m,
            device_id: `exception:${fx.id}`,
            source_ref: fx.id,
          },
        });
        punchId = p.id;
      }
      const updated = await tx.faceException.update({
        where: { id: fx.id },
        data: {
          status: b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decided_by: actor,
          decided_at: new Date(),
          decision_reason: b.reason ?? null,
          decided_employee_id: b.employee_id ?? null,
          punch_id: punchId,
        },
      });
      await audit(tx, { actor, ip, action: `face_exception.${b.decision.toLowerCase()}`, entity_type: 'face_exception', entity_id: fx.id, detail: { employee_id: b.employee_id, reason: b.reason, punch_id: punchId, occurred_at: fx.occurred_at } });
      return updated;
    });
    res.json({ data: result });
  }),
);

