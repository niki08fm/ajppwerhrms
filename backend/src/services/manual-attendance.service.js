import { createHash, randomUUID } from 'node:crypto';
import { addDays, firstOfMonth, istDate, istMidnight, lastOfMonth, ymOf } from '@ajpwer/shared';
import { Prisma } from '../config/db.js';
import { audit } from '../utils/audit.js';
import { AppError, notFound } from '../utils/errors.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { attendanceFrozen } from './attendance.service.js';

export const MANUAL_SHEET_LIFETIME_MS = 72 * 60 * 60_000;
const personSelect = { id: true, code: true, name: true, designation: true, department: { select: { id: true, name: true } } };
const sheetInclude = { site: { select: { id: true, code: true, name: true } }, rows: { include: { employee: { select: personSelect } }, orderBy: { seq: 'asc' } } };
const codeKey = (code) => code.trim().toLowerCase();
const expiryMessage = 'Not approved within three days. No attendance was recorded from this sheet.';

async function expireLocked(tx, sheet, now) {
  if (sheet.expires_at > now) return false;
  await tx.manualAttendanceSheet.update({ where: { id: sheet.id }, data: { status: 'EXPIRED', version: { increment: 1 }, decided_by: 'system:expiry', decided_at: now, decision_note: expiryMessage } });
  return true;
}

export function manualAttendanceSheetReply(sheet, details = true) {
  return { id: sheet.id, site: sheet.site, work_date: fromDbDate(sheet.work_date),
    status: sheet.status, reason: sheet.reason, client_request_id: sheet.client_request_id,
    submitted_at: sheet.submitted_at.toISOString(), expires_at: sheet.expires_at.toISOString(), version: sheet.version,
    row_count: sheet.rows.length, included_count: sheet.rows.filter((row) => row.included).length,
    decided_by: sheet.decided_by, decided_at: sheet.decided_at?.toISOString() ?? null, decision_note: sheet.decision_note,
    ...(details ? { rows: sheet.rows.map((row) => ({ id: row.id, employee: row.employee,
      in_min: row.in_min, out_min: row.out_min, original_in_min: row.original_in_min, original_out_min: row.original_out_min,
      included: row.included, note: row.note, punch_in_id: row.punch_in_id, punch_out_id: row.punch_out_id })) } : {}),
  };
}

/** Expiry only closes the request. The ordinary attendance/leave rules decide the day. */
export async function expireManualAttendanceSheets(db, now = new Date()) {
  const result = await db.manualAttendanceSheet.updateMany({
    where: { status: 'PENDING', expires_at: { lte: now } },
    data: { status: 'EXPIRED', version: { increment: 1 }, decided_by: 'system:expiry', decided_at: now, decision_note: expiryMessage },
  });
  return { count: result.count };
}

export async function listManualAttendanceSheets(db, { siteId, status, ym, now = new Date() } = {}) {
  await expireManualAttendanceSheets(db, now);
  const rows = await db.manualAttendanceSheet.findMany({ where: { ...(siteId ? { site_id: siteId } : {}), ...(status ? { status } : {}), ...(ym ? { work_date: { gte: toDbDate(firstOfMonth(ym)), lte: toDbDate(lastOfMonth(ym)) } } : {}) },
    include: { site: sheetInclude.site, rows: { select: { included: true } } }, orderBy: [{ submitted_at: 'desc' }, { id: 'desc' }], take: 300 });
  return rows.map((row) => manualAttendanceSheetReply(row, false));
}

export async function manualAttendanceSheet(db, id, { siteId, now = new Date() } = {}) {
  await expireManualAttendanceSheets(db, now);
  const row = await db.manualAttendanceSheet.findFirst({ where: { id, ...(siteId ? { site_id: siteId } : {}) }, include: sheetInclude });
  if (!row) throw notFound('That manual attendance sheet');
  return manualAttendanceSheetReply(row);
}

function requestHash(input) {
  const rows = input.rows.map((row) => ({ employee_code: codeKey(row.employee_code), in_min: row.in_min, out_min: row.out_min, note: row.note?.trim() || '' }))
    .sort((a, b) => a.employee_code.localeCompare(b.employee_code));
  return createHash('sha256').update(JSON.stringify({ work_date: input.work_date, reason: input.reason.trim(), rows })).digest('hex');
}

function assertTimes(row, workDate, now) {
  if (!Number.isInteger(row.in_min) || row.in_min < 0 || row.in_min > 1439 || !Number.isInteger(row.out_min)
    || row.out_min <= row.in_min || row.out_min > 2879 || row.out_min - row.in_min > 1440) {
    throw new AppError('VALIDATION', 'Enter punch-in and punch-out times in order, for a shift no longer than 24 hours.', 422, 'rows');
  }
  const midnight = istMidnight(workDate).getTime();
  if (midnight + row.out_min * 60_000 > now.getTime()) throw new AppError('VALIDATION', 'Punch times cannot be in the future.', 422, 'rows');
}

function assertEmployment(employee, date) {
  if (!employee || employee.deleted_at || !['ACTIVE', 'NOTICE', 'EXITED'].includes(employee.status)
    || !employee.joined_on || fromDbDate(employee.joined_on) > date || (employee.last_day && fromDbDate(employee.last_day) < date)) {
    throw new AppError('EMPLOYEE_NOT_ELIGIBLE', 'Choose an employee who was active on the sheet date.', 422, 'rows');
  }
}

async function assertOpenMonth(db, ym) {
  const frozen = await attendanceFrozen(db, ym);
  if (frozen.frozen) throw new AppError('PERIOD_LOCKED', frozen.reason, 409);
}

async function lockMonth(tx, ym) {
  // Prisma's read-then-create upsert can race when two manual sheets introduce
  // the first period together. PostgreSQL resolves that insertion atomically.
  await tx.$executeRaw`INSERT INTO payroll_period (period_ym) VALUES (${ym}) ON CONFLICT (period_ym) DO NOTHING`;
  await tx.$queryRaw`SELECT id FROM payroll_period WHERE period_ym = ${ym} FOR UPDATE`;
  await assertOpenMonth(tx, ym);
}

export async function createManualAttendanceSheet(db, site, input, actor, ip, now = new Date()) {
  const hash = requestHash(input);
  const key = { site_id_client_request_id: { site_id: site.id, client_request_id: input.client_request_id } };
  // An acknowledged request can be replayed after HR edits it: compare with its
  // original request hash, never with the current reviewer-edited rows.
  const replay = async () => {
    const existing = await db.manualAttendanceSheet.findUnique({ where: key, include: sheetInclude });
    if (!existing) return null;
    if (existing.request_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This saved request was already sent with different times. Refresh its sheet instead of sending it again.', 409);
    return manualAttendanceSheetReply(existing);
  };
  await expireManualAttendanceSheets(db, now);
  const prior = await replay();
  if (prior) return { sheet: prior, replayed: true };
  if (input.work_date > istDate(now)) throw new AppError('VALIDATION', 'Choose today or an earlier attendance date.', 422, 'work_date');
  const seen = new Set();
  for (const row of input.rows) {
    if (seen.has(codeKey(row.employee_code))) throw new AppError('VALIDATION', 'Add each employee only once to a sheet.', 422, 'rows');
    seen.add(codeKey(row.employee_code));
    assertTimes(row, input.work_date, now);
  }
  await assertOpenMonth(db, ymOf(input.work_date));
  try {
    const created = await db.$transaction(async (tx) => {
      const ym = ymOf(input.work_date);
      await lockMonth(tx, ym);
      const duplicate = await tx.manualAttendanceSheet.findUnique({ where: key, include: sheetInclude });
      if (duplicate) {
        if (duplicate.request_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This saved request was already sent with different times. Refresh its sheet instead of sending it again.', 409);
        return { sheet: manualAttendanceSheetReply(duplicate), replayed: true };
      }
      const employees = await tx.employee.findMany({ where: { OR: input.rows.map((row) => ({ code: { equals: row.employee_code.trim(), mode: 'insensitive' } })) } });
      const byCode = new Map(employees.map((employee) => [codeKey(employee.code), employee]));
      for (const row of input.rows) assertEmployment(byCode.get(codeKey(row.employee_code)), input.work_date);
      const sheet = await tx.manualAttendanceSheet.create({ data: {
        site_id: site.id, client_request_id: input.client_request_id, request_hash: hash, work_date: toDbDate(input.work_date), reason: input.reason.trim(),
        submitted_by: actor, submitted_at: now, expires_at: new Date(now.getTime() + MANUAL_SHEET_LIFETIME_MS),
        rows: { create: input.rows.map((row, index) => ({ employee_id: byCode.get(codeKey(row.employee_code)).id, seq: index + 1,
          original_in_min: row.in_min, original_out_min: row.out_min, in_min: row.in_min, out_min: row.out_min, note: row.note?.trim() || null })) },
      }, include: sheetInclude });
      await audit(tx, { actor, ip, action: 'manual_attendance.submit', entity_type: 'manual_attendance_sheet', entity_id: sheet.id,
        detail: { site_id: site.id, work_date: input.work_date, row_count: input.rows.length, expires_at: sheet.expires_at, client_request_id: input.client_request_id } });
      return { sheet: manualAttendanceSheetReply(sheet), replayed: false };
    });
    return created;
  } catch (error) {
    if (error.code === 'P2002') {
      const existing = await replay();
      if (existing) return { sheet: existing, replayed: true };
    }
    throw error;
  }
}

/** The expiry transition must commit even when an attempted late decision fails. */
async function mutatePending(db, id, version, actor, ip, change) {
  await expireManualAttendanceSheets(db);
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM manual_attendance_sheet WHERE id = ${id}::uuid FOR UPDATE`;
    const sheet = await tx.manualAttendanceSheet.findUnique({ where: { id }, include: sheetInclude });
    if (!sheet) throw notFound('That manual attendance sheet');
    if (sheet.status !== 'PENDING') throw new AppError(sheet.status === 'EXPIRED' ? 'SHEET_EXPIRED' : 'SHEET_REVIEWED',
      sheet.status === 'EXPIRED' ? expiryMessage : 'This sheet has already been reviewed. Refresh to see the result.', 409);
    const now = new Date();
    if (await expireLocked(tx, sheet, now)) return { expired: true };
    if (sheet.version !== version) throw new AppError('STALE_SHEET', 'This sheet changed while you were reviewing it. Refresh before saving or approving.', 409);
    return change(tx, sheet, now);
  }, { timeout: 30_000 });
  if (result?.expired) throw new AppError('SHEET_EXPIRED', expiryMessage, 409);
  return result;
}

export async function editManualAttendanceSheet(db, id, input, actor, ip) {
  return mutatePending(db, id, input.version, actor, ip, async (tx, sheet, now) => {
    const workDate = fromDbDate(sheet.work_date);
    await assertOpenMonth(tx, ymOf(workDate));
    const seen = new Set();
    const changes = [];
    for (const patch of input.rows) {
      const current = sheet.rows.find((row) => row.id === patch.id);
      if (!current || seen.has(patch.id)) throw new AppError('VALIDATION', 'Choose each row from this sheet only once.', 422, 'rows');
      seen.add(patch.id);
      const next = { ...current, ...patch, note: patch.note === undefined ? current.note : patch.note.trim() || null };
      assertTimes(next, workDate, now);
      if (!next.included && (!next.note || next.note.length < 3)) throw new AppError('VALIDATION', 'Add a reason when excluding an employee.', 422, 'rows');
      const data = { in_min: next.in_min, out_min: next.out_min, included: next.included, note: next.note };
      changes.push({ id: current.id, employee_id: current.employee_id, before: { in_min: current.in_min, out_min: current.out_min, included: current.included, note: current.note }, after: data });
      await tx.manualAttendanceSheetRow.update({ where: { id: patch.id }, data });
    }
    const updated = await tx.manualAttendanceSheet.update({ where: { id }, data: { version: { increment: 1 } }, include: sheetInclude });
    await audit(tx, { actor, ip, action: 'manual_attendance.edit', entity_type: 'manual_attendance_sheet', entity_id: id, detail: { changes, version: updated.version } });
    return manualAttendanceSheetReply(updated);
  });
}

const minuteOn = (punch, date) => Math.floor((punch.punched_at.getTime() - istMidnight(date).getTime()) / 60_000);
const rowConflict = (row, message) => new AppError('ROW_CONFLICT', `${row.employee.name} (${row.employee.code}): ${message}`, 409, 'rows', { row_id: row.id, employee_id: row.employee_id });

/** One atomic sheet decision; nothing is recorded if any included row conflicts. */
export async function decideManualAttendanceSheet(db, id, input, actor, ip) {
  return mutatePending(db, id, input.version, actor, ip, async (tx, sheet, now) => {
    const date = fromDbDate(sheet.work_date);
    const selected = sheet.rows.filter((row) => row.included);
    if (input.decision === 'APPROVED') {
      if (!selected.length) throw new AppError('VALIDATION', 'Include at least one employee, or reject the sheet.', 422);
      // Payroll submission takes this same lock. Lock both calendar months for an
      // overnight shift, while every punch retains the original work date.
      const months = [...new Set([ymOf(date), ...selected.map((row) => ymOf(istDate(new Date(istMidnight(date).getTime() + row.out_min * 60_000))))])].sort();
      for (const ym of months) {
        await lockMonth(tx, ym);
      }
      const ids = selected.map((row) => row.employee_id).sort();
      await tx.$queryRaw(Prisma.sql`SELECT id FROM employee WHERE id IN (${Prisma.join(ids.map((employeeId) => Prisma.sql`${employeeId}::uuid`))}) ORDER BY id FOR UPDATE`);
      now = new Date();
      if (await expireLocked(tx, sheet, now)) return { expired: true };
      const employees = new Map((await tx.employee.findMany({ where: { id: { in: ids } } })).map((employee) => [employee.id, employee]));
      // Punch identity is unique by employee, site and client time, including
      // other work dates and retained soft-deleted records. A same-site handover
      // can be non-overlapping yet still reserve the exact timestamp; do not
      // change its time or let that surface as an unexplained database error.
      const midnight = istMidnight(date).getTime();
      const requestedTimes = [...new Set(selected.flatMap((row) => [row.in_min, row.out_min]))]
        .map((minute) => new Date(midnight + minute * 60_000));
      const reserved = await tx.punch.findMany({
        where: { employee_id: { in: ids }, site_id: sheet.site_id, client_punched_at: { in: requestedTimes } },
        select: { employee_id: true, client_punched_at: true },
      });
      const reservedTimes = new Set(reserved.map((punch) => `${punch.employee_id}:${punch.client_punched_at.getTime()}`));
      const punches = [];
      const links = [];
      for (const row of selected) {
        assertEmployment(employees.get(row.employee_id), date);
        assertTimes(row, date, now);
        const [existing, correction, leave, previous] = await Promise.all([
          tx.punch.findMany({ where: { employee_id: row.employee_id, deleted_at: null,
            OR: [{ work_date: toDbDate(date) }, { punched_at: { gte: istMidnight(addDays(date, -1)), lte: istMidnight(addDays(date, 3)) } }] }, orderBy: { punched_at: 'asc' } }),
          tx.attendanceOverride.findFirst({ where: { employee_id: row.employee_id, work_date: toDbDate(date), deleted_at: null } }),
          tx.leaveRequest.findFirst({ where: { employee_id: row.employee_id, status: 'APPROVED', deleted_at: null, from_date: { lte: toDbDate(date) }, to_date: { gte: toDbDate(date) } } }),
          tx.punch.findFirst({ where: { employee_id: row.employee_id, deleted_at: null, work_date: { not: toDbDate(date) }, punched_at: { lt: new Date(istMidnight(date).getTime() + row.in_min * 60_000) } }, orderBy: { punched_at: 'desc' } }),
        ]);
        if (previous && !existing.some((punch) => punch.id === previous.id)) existing.unshift(previous);
        if (correction) throw rowConflict(row, 'HR has already corrected this day. Review that correction instead.');
        if (leave) throw rowConflict(row, 'approved leave already covers this day. Review the leave before adding punches.');
        const sameDay = existing.filter((punch) => fromDbDate(punch.work_date) === date);
        const matching = {};
        for (const punch of sameDay) {
          const minute = punch.direction === 'IN' ? row.in_min : row.out_min;
          if (punch.site_id !== sheet.site_id || minuteOn(punch, date) !== minute || matching[punch.direction]) {
            throw rowConflict(row, 'other punches already exist for this day. Match the recorded times or exclude this row.');
          }
          matching[punch.direction] = punch;
        }
        const start = matching.IN?.punched_at ?? new Date(istMidnight(date).getTime() + row.in_min * 60_000);
        const end = matching.OUT?.punched_at ?? new Date(istMidnight(date).getTime() + row.out_min * 60_000);
        let open = null;
        for (const punch of existing) {
          if (sameDay.some((same) => same.id === punch.id)) continue;
          if (punch.punched_at > start && punch.punched_at < end) throw rowConflict(row, 'another work date overlaps these times.');
          if (punch.direction === 'IN') open = punch;
          else {
            if (open && open.punched_at < end && punch.punched_at > start) throw rowConflict(row, 'another shift overlaps these times.');
            open = null;
          }
        }
        if (open && open.punched_at < end) throw rowConflict(row, 'an earlier punch-in is still open. Complete it before approving this row.');
        const pair = {};
        for (const direction of ['IN', 'OUT']) {
          if (matching[direction]) { pair[direction] = matching[direction].id; continue; }
          const punchId = randomUUID();
          const punchedAt = direction === 'IN' ? start : end;
          if (reservedTimes.has(`${row.employee_id}:${punchedAt.getTime()}`)) {
            throw rowConflict(row, 'a punch at this site already uses that exact time for another attendance record. Review the recorded shift or exclude this row.');
          }
          pair[direction] = punchId;
          punches.push({ id: punchId, employee_id: row.employee_id, site_id: sheet.site_id, work_date: sheet.work_date, direction,
            punched_at: punchedAt, client_punched_at: punchedAt, method: 'MANUAL', device_id: `sheet:${sheet.id}`,
            source_ref: `manual-sheet:${sheet.id}:${row.id}`, flagged: true, flag_reason: `HR-approved manual sheet: ${sheet.reason}` });
        }
        links.push({ row, pair });
      }
      // Row validation can itself take time on a large sheet. The deadline is
      // checked again immediately before any attendance is inserted.
      now = new Date();
      if (await expireLocked(tx, sheet, now)) return { expired: true };
      if (punches.length) await tx.punch.createMany({ data: punches });
      for (const { row, pair } of links) await tx.manualAttendanceSheetRow.update({ where: { id: row.id }, data: { punch_in_id: pair.IN, punch_out_id: pair.OUT } });
      for (const punch of punches) await audit(tx, { actor, ip, action: 'punch.manual', entity_type: 'punch', entity_id: punch.id,
        detail: { employee_id: punch.employee_id, site_id: sheet.site_id, work_date: date, direction: punch.direction, sheet_id: sheet.id, reason: sheet.reason } });
    }
    const result = await tx.manualAttendanceSheet.update({ where: { id }, data: { status: input.decision, version: { increment: 1 }, decided_by: actor,
      decided_at: now, decision_note: input.note?.trim() || null }, include: sheetInclude });
    await audit(tx, { actor, ip, action: 'manual_attendance.decide', entity_type: 'manual_attendance_sheet', entity_id: sheet.id,
      detail: { decision: input.decision, row_count: sheet.rows.length, included_count: selected.length, work_date: date, note: input.note || null } });
    return manualAttendanceSheetReply(result);
  });
}
