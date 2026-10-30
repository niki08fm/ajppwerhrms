import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { istMidnight } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { hashPassword } from '../../src/services/auth.service.js';
import { expireManualAttendanceSheets } from '../../src/services/manual-attendance.service.js';
import { getPeriod } from '../../src/services/payroll.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture } from './fixture.js';

const DATE = '2026-10-29';
const NOW = new Date('2026-10-30T20:00:00+05:30');
const TABLET = '/api/v1/tablet/manual-attendance-sheets';
const HR = '/api/v1/manual-attendance-sheets';
let f, site;
const payload = (overrides = {}) => ({ client_request_id: randomUUID(), work_date: DATE, reason: 'Site internet was unavailable',
  rows: [{ employee_code: 'T001', in_min: 540, out_min: 1080 }, { employee_code: 'T002', in_min: 540, out_min: 1080 }], ...overrides });
const send = (input) => site.post(TABLET).set('X-Site-Id', f.siteId).send(input);
async function create(input = payload()) {
  const result = await site.post(TABLET).set('X-Site-Id', f.siteId).send(input);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data;
}
const decide = (sheet, decision = 'APPROVED', extra = {}) => f.agent.post(`${HR}/${sheet.id}/decide`).send({ decision, version: sheet.version, ...extra });
async function punch(employeeId, direction, minute, date = DATE, siteId = f.siteId, seconds = 0) {
  const at = new Date(istMidnight(date).getTime() + minute * 60_000 + seconds * 1000);
  return prisma.punch.create({ data: { employee_id: employeeId, site_id: siteId, direction, punched_at: at, client_punched_at: at, work_date: toDbDate(date), method: 'FACE' } });
}
async function expire(sheet, milliseconds = 72 * 3600_000) {
  const submitted = new Date(NOW.getTime() - milliseconds);
  await prisma.manualAttendanceSheet.update({ where: { id: sheet.id }, data: { submitted_at: submitted, expires_at: new Date(submitted.getTime() + 72 * 3600_000) } });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  f = await buildFixture();
  site = request.agent(app);
  expect((await site.post('/api/v1/auth/site-login').send({ login: 'site-alpha', password: 'site-pass-1' })).status).toBe(200);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => { await prisma.$disconnect(); });

describe('Site manual attendance sheets', () => {
  it('requires the appropriate site or HR permissions and isolates site drafts and directory fields', async () => {
    expect((await request(app).get(TABLET)).status).toBe(401);
    expect((await request(app).get(HR)).status).toBe(401);
    expect((await site.get(HR)).status).toBe(401);
    expect((await f.agent.post(TABLET).send(payload())).status).toBe(401);
    const directory = await site.get('/api/v1/tablet/manual-attendance-employees');
    expect(directory.status).toBe(200);
    expect(directory.body.data).toHaveLength(3);
    expect(Object.keys(directory.body.data[0]).sort()).toEqual(['code', 'department', 'designation', 'name']);
    expect((await site.post(TABLET).set('X-Site-Id', randomUUID()).send(payload())).status).toBe(403);
    expect((await site.post(TABLET).send(payload())).status).toBe(428);
    expect((await send({ ...payload(), site_id: randomUUID() })).status).toBe(422);
    const sheet = await create();
    const beta = await prisma.site.create({ data: { code: 'BETA', name: 'Beta', state: 'Andhra Pradesh', lat: 16.5, lng: 80.6, radius_m: 400, login: 'site-beta', password_hash: await hashPassword('beta-pass-1') } });
    const other = request.agent(app);
    expect((await other.post('/api/v1/auth/site-login').send({ login: 'site-beta', password: 'beta-pass-1' })).status).toBe(200);
    expect((await other.get(TABLET)).body.data).toEqual([]);
    expect((await other.get(`${TABLET}/${sheet.id}`)).status).toBe(404);
    expect((await site.get(TABLET).query({ site_id: beta.id })).status).toBe(403);
    const user = await prisma.appUser.findFirst({ where: { email: 'hr@test.in' }, include: { role: true } });
    await prisma.role.update({ where: { id: user.role_id }, data: { permissions: user.role.permissions.filter((permission) => permission !== 'attendance.write') } });
    invalidatePrincipal(user.id);
    expect((await f.agent.get(`${HR}/${sheet.id}`)).status).toBe(200);
    expect((await decide(sheet)).status).toBe(403);
  });

  it('rejects duplicate people, invalid/future times and employees outside employment without recording attendance', async () => {
    for (const input of [
      payload({ rows: [] }), payload({ rows: [{ employee_code: 'T001', in_min: 1080, out_min: 540 }] }),
      payload({ rows: [{ employee_code: 'T001', in_min: 540, out_min: 2000 }] }), payload({ rows: [{ employee_code: 'T001', in_min: 1440, out_min: 1500 }] }),
      payload({ rows: [{ employee_code: 'T001', in_min: 540, out_min: 1080 }, { employee_code: 't001', in_min: 600, out_min: 1100 }] }),
      payload({ work_date: '2026-10-31' }), payload({ work_date: '2026-10-30', rows: [{ employee_code: 'T001', in_min: 1200, out_min: 1260 }] }),
      payload({ rows: [{ employee_code: 'T004', in_min: 540, out_min: 1080 }] }), payload({ rows: [{ employee_code: 'missing', in_min: 540, out_min: 1080 }] }),
    ]) expect((await send(input)).status, JSON.stringify(input)).toBe(422);
    await prisma.employee.update({ where: { id: f.employees.A }, data: { joined_on: toDbDate('2026-10-30') } });
    expect((await send(payload())).status).toBe(422);
    expect(await prisma.manualAttendanceSheet.count()).toBe(0);
    expect(await prisma.punch.count({ where: { work_date: toDbDate(DATE) } })).toBe(0);
  });

  it('submits one file containing all rows, keeps the days absent pending approval and retries the original request safely', async () => {
    const input = payload();
    const sheet = await create(input);
    expect(sheet).toMatchObject({ status: 'PENDING', version: 1, row_count: 2, included_count: 2, work_date: DATE, site: { id: f.siteId } });
    expect(Date.parse(sheet.expires_at) - Date.parse(sheet.submitted_at)).toBe(72 * 3600_000);
    expect(await prisma.punch.count({ where: { work_date: toDbDate(DATE) } })).toBe(0);
    const register = await f.agent.get('/api/v1/attendance').query({ date: DATE });
    expect(register.body.data.find((row) => row.employee.id === f.employees.A).day.status).toBe('ABSENT');
    const replay = await send(input);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(sheet.id);
    expect((await send({ ...input, reason: 'Different request contents' })).status).toBe(409);
    const edits = await f.agent.patch(`${HR}/${sheet.id}`).send({ version: 1, rows: [{ id: sheet.rows[0].id, out_min: 1060 }] });
    expect(edits.status).toBe(200);
    const afterEditReplay = await send(input);
    expect(afterEditReplay.status).toBe(200);
    expect(afterEditReplay.body.data.rows[0]).toMatchObject({ out_min: 1060, original_out_min: 1080 });
    expect(await prisma.manualAttendanceSheet.count()).toBe(1);
  });

  it('edits individual rows with a version, keeps original times and atomically records the whole approved sheet', async () => {
    const sheet = await create();
    const changed = await f.agent.patch(`${HR}/${sheet.id}`).send({ version: 1, rows: [{ id: sheet.rows[0].id, in_min: 550, out_min: 1060, note: 'Supervisor confirmed the actual times' }] });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ version: 2, expires_at: sheet.expires_at });
    expect(changed.body.data.rows[0]).toMatchObject({ in_min: 550, out_min: 1060, original_in_min: 540, original_out_min: 1080 });
    expect((await decide(sheet)).body.error.code).toBe('STALE_SHEET');
    const approved = await decide(changed.body.data);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', version: 3, decided_by: 'hr@test.in' });
    const punches = await prisma.punch.findMany({ where: { work_date: toDbDate(DATE) } });
    expect(punches).toHaveLength(4);
    expect(punches.every((row) => row.method === 'MANUAL' && row.source_ref.startsWith(`manual-sheet:${sheet.id}:`))).toBe(true);
    const overview = await f.agent.get('/api/v1/dashboard/overview').query({ date: DATE });
    expect(overview.body.data.people.find((row) => row.id === f.employees.A).views).toContain('in');
    expect(await prisma.dailyAggregate.count({ where: { date: toDbDate(DATE) } })).toBe(2);
    expect((await decide(approved.body.data)).body.error.code).toBe('SHEET_REVIEWED');
    expect(await prisma.punch.count({ where: { work_date: toDbDate(DATE) } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { entity_id: sheet.id, action: { in: ['manual_attendance.submit', 'manual_attendance.edit', 'manual_attendance.decide'] } } })).toBe(3);
  });

  it('requires an exclusion reason and can approve the remaining employees without marking excluded rows present', async () => {
    const sheet = await create();
    expect((await f.agent.patch(`${HR}/${sheet.id}`).send({ version: 1, rows: [{ id: sheet.rows[1].id, included: false }] })).status).toBe(422);
    const changed = await f.agent.patch(`${HR}/${sheet.id}`).send({ version: 1, rows: [{ id: sheet.rows[1].id, included: false, note: 'This employee did not work at this site' }] });
    expect(changed.status).toBe(200);
    expect((await decide(changed.body.data)).status).toBe(200);
    expect(await prisma.punch.count({ where: { employee_id: f.employees.A, work_date: toDbDate(DATE) } })).toBe(2);
    expect(await prisma.punch.count({ where: { employee_id: f.employees.B, work_date: toDbDate(DATE) } })).toBe(0);
  });

  it('rejects edits to another file, future times, and conflicts without partially changing or recording rows', async () => {
    const sheet = await create();
    const other = await create(payload({ rows: [{ employee_code: 'T003', in_min: 540, out_min: 1080 }] }));
    const bad = await f.agent.patch(`${HR}/${sheet.id}`).send({ version: 1, rows: [{ id: sheet.rows[0].id, out_min: 1060 }, { id: other.rows[0].id, out_min: 1100 }] });
    expect(bad.status).toBe(422);
    const unchanged = (await f.agent.get(`${HR}/${sheet.id}`)).body.data;
    expect(unchanged.version).toBe(1);
    expect(unchanged.rows[0].out_min).toBe(1080);
    await punch(f.employees.B, 'IN', 600);
    const conflict = await decide(sheet);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('ROW_CONFLICT');
    expect(await prisma.punch.count({ where: { employee_id: f.employees.A, work_date: toDbDate(DATE) } })).toBe(0);
    expect((await f.agent.get(`${HR}/${sheet.id}`)).body.data.status).toBe('PENDING');
  });

  it('reuses a face punch at the same minute, retains its seconds and inserts only the missing punch-out', async () => {
    const existing = await punch(f.employees.A, 'IN', 540, DATE, f.siteId, 15);
    const sheet = await create(payload({ rows: [{ employee_code: 'T001', in_min: 540, out_min: 1080 }] }));
    const approved = await decide(sheet);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.rows[0].punch_in_id).toBe(existing.id);
    expect(await prisma.punch.count({ where: { employee_id: f.employees.A, work_date: toDbDate(DATE) } })).toBe(2);
    expect((await prisma.punch.findUnique({ where: { id: existing.id } })).punched_at).toEqual(existing.punched_at);
    expect(await prisma.punch.count({ where: { employee_id: f.employees.A, method: 'MANUAL' } })).toBe(1);
  });

  it('never overwrites an HR correction or approved leave and rejects adjacent overnight overlaps', async () => {
    const sheet = await create(payload({ rows: [{ employee_code: 'T001', in_min: 540, out_min: 1080 }] }));
    const corrected = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: DATE, mode: 'MARK', status: 'PRESENT', reason_text: 'Attendance already confirmed directly by HR' });
    expect(corrected.status).toBe(201);
    expect((await decide(sheet)).body.error.code).toBe('ROW_CONFLICT');
    const onLeave = await create(payload({ rows: [{ employee_code: 'T002', in_min: 540, out_min: 1080 }] }));
    await prisma.leaveRequest.create({ data: { employee_id: f.employees.B, leave_type: 'PL', from_date: toDbDate(DATE), to_date: toDbDate(DATE), days: 1, status: 'APPROVED' } });
    expect((await decide(onLeave)).body.error.code).toBe('ROW_CONFLICT');
    expect(await prisma.punch.count({ where: { employee_id: f.employees.B, work_date: toDbDate(DATE) } })).toBe(0);
    const night = await create(payload({ rows: [{ employee_code: 'T003', in_min: 1320, out_min: 1800 }] }));
    await punch(f.employees.C, 'IN', 1410, '2026-10-28');
    await punch(f.employees.C, 'OUT', 2820, '2026-10-28');
    expect((await decide(night)).body.error.code).toBe('ROW_CONFLICT');
    expect(await prisma.punch.count({ where: { employee_id: f.employees.C, work_date: toDbDate(DATE) } })).toBe(0);
  });

  it('permits a previous shift ending exactly at IN and a next shift starting exactly at OUT', async () => {
    const beta = await prisma.site.create({ data: { code: 'BETA', name: 'Beta', state: 'Andhra Pradesh', lat: 16.5, lng: 80.6, radius_m: 400, login: 'site-beta', password_hash: await hashPassword('beta-pass-1') } });
    await punch(f.employees.A, 'IN', 1320, '2026-10-28', beta.id);
    await punch(f.employees.A, 'OUT', 1980, '2026-10-28', beta.id);
    await punch(f.employees.A, 'IN', 0, '2026-10-30', beta.id);
    await punch(f.employees.A, 'OUT', 120, '2026-10-30', beta.id);
    const sheet = await create(payload({ rows: [{ employee_code: 'T001', in_min: 540, out_min: 1440 }] }));
    const approved = await decide(sheet);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await prisma.punch.count({ where: { employee_id: f.employees.A, work_date: toDbDate(DATE) } })).toBe(2);

    // The database reserves a timestamp for both directions at one site. A
    // same-site boundary needs an employee-specific conflict, never a changed
    // timestamp, duplicate punch or partially approved sheet.
    await punch(f.employees.B, 'IN', 1320, '2026-10-28');
    await punch(f.employees.B, 'OUT', 1980, '2026-10-28');
    const sameSiteIn = await create(payload({ rows: [
      { employee_code: 'T003', in_min: 540, out_min: 1080 },
      { employee_code: 'T002', in_min: 540, out_min: 1080 },
    ] }));
    const inConflict = await decide(sameSiteIn);
    expect(inConflict.status).toBe(409);
    expect(inConflict.body.error).toMatchObject({ code: 'ROW_CONFLICT', details: { employee_id: f.employees.B } });
    expect(inConflict.body.error.message).toContain('T002');
    expect((await f.agent.get(`${HR}/${sameSiteIn.id}`)).body.data.status).toBe('PENDING');
    expect(await prisma.punch.count({ where: { employee_id: f.employees.C, work_date: toDbDate(DATE) } })).toBe(0);

    await punch(f.employees.C, 'IN', 0, '2026-10-30');
    await punch(f.employees.C, 'OUT', 120, '2026-10-30');
    const sameSiteOut = await create(payload({ rows: [{ employee_code: 'T003', in_min: 540, out_min: 1440 }] }));
    const outConflict = await decide(sameSiteOut);
    expect(outConflict.status).toBe(409);
    expect(outConflict.body.error).toMatchObject({ code: 'ROW_CONFLICT', details: { employee_id: f.employees.C } });
    expect(await prisma.punch.count({ where: { employee_id: f.employees.C, work_date: toDbDate(DATE) } })).toBe(0);
  });

  it('records an overnight pair on the sheet work date and respects payroll freeze before approval', async () => {
    const night = await create(payload({ rows: [{ employee_code: 'T001', in_min: 1320, out_min: 1800 }] }));
    expect((await decide(night)).status).toBe(200);
    const punches = await prisma.punch.findMany({ where: { employee_id: f.employees.A, work_date: toDbDate(DATE) }, orderBy: { punched_at: 'asc' } });
    expect(punches.map((row) => row.direction)).toEqual(['IN', 'OUT']);
    expect(punches[1].punched_at.toISOString()).toBe('2026-10-30T00:30:00.000Z');
    const sheet = await create(payload({ rows: [{ employee_code: 'T002', in_min: 540, out_min: 1080 }] }));
    await prisma.payrollPeriod.update({ where: { period_ym: '2026-10' }, data: { steps_submitted: [1] } });
    expect((await decide(sheet)).body.error.code).toBe('PERIOD_LOCKED');
    expect(await prisma.punch.count({ where: { employee_id: f.employees.B, work_date: toDbDate(DATE) } })).toBe(0);
    expect((await send(payload())).body.error.code).toBe('PERIOD_LOCKED');
  });

  it('expires exactly after 72 hours, rejects late approval, and leaves existing valid attendance unchanged', async () => {
    const sheet = await create();
    await expire(sheet, 72 * 3600_000 - 1);
    expect((await f.agent.get(`${HR}/${sheet.id}`)).body.data.status).toBe('PENDING');
    vi.setSystemTime(new Date(NOW.getTime() + 1));
    const expired = await f.agent.get(`${HR}/${sheet.id}`);
    expect(expired.body.data.status).toBe('EXPIRED');
    expect((await decide(expired.body.data)).body.error.code).toBe('SHEET_EXPIRED');
    expect(await prisma.punch.count({ where: { work_date: toDbDate(DATE) } })).toBe(0);
    expect(await expireManualAttendanceSheets(prisma, new Date())).toEqual({ count: 0 });
    const rejected = await create(payload({ rows: [{ employee_code: 'T003', in_min: 540, out_min: 1080 }] }));
    expect((await decide(rejected, 'REJECTED', { note: 'These entries were not confirmed' })).status).toBe(200);
    expect((await site.get(`${TABLET}/${rejected.id}`)).body.data.status).toBe('REJECTED');
  });

  it('serialises concurrent creation and approval so reconnects and two reviewers cannot duplicate attendance', async () => {
    const input = payload({ rows: [{ employee_code: 'T001', in_min: 540, out_min: 1080 }] });
    const [first, second, period] = await Promise.all([send(input), send(input), prisma.$transaction((tx) => getPeriod(tx, '2026-10'))]);
    const sent = [first, second];
    expect(period.period_ym).toBe('2026-10');
    expect(sent.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(sent[0].body.data.id).toBe(sent[1].body.data.id);
    const sheet = sent[0].body.data;
    const approved = await Promise.all([decide(sheet), decide(sheet)]);
    expect(approved.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await prisma.punch.count({ where: { employee_id: f.employees.A, work_date: toDbDate(DATE) } })).toBe(2);
    const retry = await send(input);
    expect(retry.status).toBe(200);
    expect(retry.body.data.status).toBe('APPROVED');
  });

  it('rechecks the deadline after waiting for payroll locks and commits expiry without any attendance', async () => {
    const sheet = await create(payload({ rows: [{ employee_code: 'T001', in_min: 540, out_min: 1080 }] }));
    await expire(sheet, 72 * 3600_000 - 1000);
    let release, acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_period WHERE period_ym = '2026-10' FOR UPDATE`;
      acquired();
      await gate;
    }, { timeout: 10_000 });
    await ready;
    const approval = decide(sheet).then((response) => response);
    try {
      await vi.waitFor(async () => {
        const waiting = await prisma.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%payroll_period%'`;
        expect(waiting[0].count).toBeGreaterThan(0);
      }, { timeout: 3000 });
      vi.setSystemTime(new Date(NOW.getTime() + 1001));
    } finally { release(); }
    await held;
    const response = await approval;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SHEET_EXPIRED');
    expect((await prisma.manualAttendanceSheet.findUnique({ where: { id: sheet.id } })).status).toBe('EXPIRED');
    expect(await prisma.punch.count({ where: { work_date: toDbDate(DATE) } })).toBe(0);
  });

  it('blocks submitting payroll attendance while a manual sheet is pending and clears the block after review or expiry', async () => {
    const sheet = await create();
    const submit = () => f.agent.post('/api/v1/payroll/periods/2026-10/steps/1/submit');
    expect((await submit()).body.error.code).toBe('MANUAL_ATTENDANCE_PENDING');
    expect((await decide(sheet, 'REJECTED')).status).toBe(200);
    expect((await submit()).status).toBe(200);
    await prisma.payrollPeriod.update({ where: { period_ym: '2026-10' }, data: { steps_submitted: [] } });
    const expiring = await create();
    await expire(expiring);
    expect((await submit()).status).toBe(200);
  });
});
