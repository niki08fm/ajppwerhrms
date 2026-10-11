import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { istMidnight } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { buildMonthlyAttendanceReport, renderAttendanceReport } from '../../src/services/attendance-reports.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture, YM } from './fixture.js';

let f;
const PATH = '/api/v1/attendance/reports';
const binary = (res, done) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};
async function download(path, query) {
  const response = await f.agent.get(`${PATH}/${path}`).query(query).buffer(true).parse(binary);
  expect(response.status).toBe(200);
  return response;
}
async function workbook(response) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(response.body);
  return book;
}
const col = (sheet, label) => sheet.getRow(6).values.findIndex((v) => v === label);
const pageCount = (buffer) => [...buffer.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length;
async function mutatePunches(fn) {
  // Production punches are immutable; fixture edits explicitly use the retention
  // switch inside an isolated test-database transaction.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ajpwer.retention = 'on'");
    await fn(tx);
  });
}
function punch(employeeId, direction, date, minute) {
  const at = new Date(istMidnight(date).getTime() + minute * 60_000);
  return { employee_id: employeeId, site_id: f.siteId, direction, punched_at: at, client_punched_at: at, work_date: toDbDate(date), method: 'FACE' };
}

beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

describe('Downloadable attendance registers', () => {
  it('requires both attendance read and report export, and rejects malformed periods and formats', async () => {
    const query = { ym: YM, report: 'summary', format: 'xlsx' };
    expect((await request(app).get(`${PATH}/monthly`).query(query)).status).toBe(401);
    const user = await prisma.appUser.findFirst({ where: { email: 'hr@test.in' }, include: { role: true } });
    for (const permission of ['reports.export', 'attendance.read']) {
      await prisma.role.update({ where: { id: user.role_id }, data: { permissions: user.role.permissions.filter((p) => p !== permission) } });
      invalidatePrincipal(user.id);
      expect((await f.agent.get(`${PATH}/monthly`).query(query)).status).toBe(403);
    }
    await prisma.role.update({ where: { id: user.role_id }, data: { permissions: user.role.permissions } });
    invalidatePrincipal(user.id);
    for (const bad of [{ ym: '2026-13' }, { report: 'something' }, { format: 'html' }, { dept: 'not-a-department-id' }]) {
      expect((await f.agent.get(`${PATH}/monthly`).query({ ...query, ...bad })).status).toBe(422);
    }
    expect((await f.agent.get(`${PATH}/daily`).query({ date: 'bad-date', format: 'pdf' })).status).toBe(422);
  });

  it('exports all filtered employees, not only the current page', async () => {
    const report = await download('monthly', { ym: YM, report: 'summary', format: 'xlsx', page: 99, limit: 1 });
    expect(report.headers['content-type']).toMatch(/spreadsheetml/);
    expect(report.headers['content-disposition']).toContain(`attendance-summary-${YM}.xlsx`);
    expect(report.headers['cache-control']).toBe('no-store');
    const sheet = (await workbook(report)).getWorksheet('Monthly summary');
    expect(sheet.getRow(6).getCell(13).value).toBe('Late minutes');
    expect([7, 8, 9].map((i) => sheet.getRow(i).getCell(1).value)).toEqual(['T001', 'T002', 'T003']);
    expect(sheet.getRow(10).getCell(2).value).toBe('TOTAL');
    const filtered = await download('monthly', { ym: YM, report: 'summary', format: 'xlsx', q: 'Person B', dept: f.deptId, pay_group: f.payGroupId, site: f.siteId });
    const filteredSheet = (await workbook(filtered)).getWorksheet('Monthly summary');
    expect(filteredSheet.getRow(7).getCell(1).value).toBe('T002');
    expect(filteredSheet.getRow(8).getCell(2).value).toBe('TOTAL');
  });

  it('reports corrected shift shortfall independently of arrival delays and totals OT', async () => {
    const policy = await prisma.policy.findFirst({ where: { kind: 'ATTENDANCE' } });
    await prisma.policy.update({ where: { id: policy.id }, data: { rules: { ...policy.rules, standard_min: 540 } } });
    await mutatePunches(async (tx) => {
      const outs = await tx.punch.findMany({ where: { direction: 'OUT' }, select: { id: true, employee_id: true, work_date: true } });
      await tx.punch.deleteMany({ where: { direction: 'OUT' } });
      await tx.punch.createMany({ data: outs.map((p) => punch(p.employee_id, 'OUT', p.work_date.toISOString().slice(0, 10), 1080)) });
    });
    const overtime = await prisma.policy.create({ data: { policy_key: crypto.randomUUID(), kind: 'OVERTIME', name: 'Report OT', version: 1, valid_from: toDbDate('2025-04-01'), rules: { multiplier: 2, base: 'BASIC', divisor: null, hours_per_day: 9, after_min: 0, rounding_min: 1, monthly_cap_min: null, counts_from: 'STANDARD_DAY' } } });
    await prisma.payGroupPolicy.create({ data: { pay_group_id: f.payGroupId, policy_id: overtime.id } });
    const corrected = async (date, inMin, outMin) => {
      const response = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: date, mode: 'TIMES', in_min: inMin, out_min: outMin, reason_text: 'Actual times confirmed by HR' });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    };
    await corrected(`${YM}-03`, 540, 1060); // 8h40m: 20m short.
    await corrected(`${YM}-04`, 540, 1065); // 8h45m: 15m short.
    await corrected(`${YM}-05`, 600, 1140); // Late arrival, full 9h: no shortfall.
    await corrected(`${YM}-06`, 540, 1200); // 11h: 2h OT.
    const report = await download('monthly', { ym: YM, report: 'summary', format: 'xlsx', q: 'Person A' });
    const sheet = (await workbook(report)).getWorksheet('Monthly summary');
    const summary = (await f.agent.get('/api/v1/attendance/month').query({ ym: YM })).body.data.rows.find((r) => r.employee.id === f.employees.A).attendance_summary;
    expect(sheet.getRow(7).getCell(col(sheet, 'Late minutes')).value).toBe(summary.late_minutes);
    expect(summary.late_minutes).toBe(35);
    const detailed = await buildMonthlyAttendanceReport(prisma, { ym: YM, report: 'detailed', q: 'Person A' }, '2026-09-01');
    expect(detailed.rows[0].details.find((d) => d.date === `${YM}-03`).late_minutes).toBe(20);
    expect(detailed.rows[0].details.find((d) => d.date === `${YM}-04`).late_minutes).toBe(15);
    expect(detailed.rows[0].details.find((d) => d.date === `${YM}-05`).late_minutes).toBe(0);
    expect(detailed.rows[0].details.find((d) => d.date === `${YM}-06`).ot_min).toBe(120);
    expect(sheet.getRow(7).getCell(col(sheet, 'OT hours')).value).toBe(2);
  });

  it('uses applied and automatic paid leave before the final LOP, while retaining raw absent days', async () => {
    for (const day of ['03', '04', '05', '06']) {
      expect((await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: `${YM}-${day}`, mode: 'MARK', status: 'ABSENT', reason_text: 'Confirmed absence' })).status).toBe(201);
    }
    for (const [employee, type, days] of [['A', 'PL', 2], ['B', 'SL', 2]]) {
      expect((await f.agent.post('/api/v1/leave/adjustments').send({ employee_id: f.employees[employee], leave_type: type, date: `${YM}-01`, days, reason: 'Opening leave balance' })).status).toBe(201);
    }
    const applied = await f.agent.post('/api/v1/leave').send({ employee_id: f.employees.B, leave_type: 'SL', from_date: `${YM}-10`, to_date: `${YM}-11`, days: 2, reason: 'Approved sick leave' });
    expect(applied.status).toBe(201);
    expect((await f.agent.post(`/api/v1/leave/${applied.body.data.id}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const report = await download('monthly', { ym: YM, report: 'summary', format: 'xlsx' });
    const sheet = (await workbook(report)).getWorksheet('Monthly summary');
    const a = sheet.getRow(7), b = sheet.getRow(8);
    expect(a.getCell(col(sheet, 'Absent days')).value).toBe(4);
    expect(a.getCell(col(sheet, 'Auto paid leave')).value).toBe(3);
    expect(a.getCell(col(sheet, 'Final LOP')).value).toBe(1);
    expect(b.getCell(col(sheet, 'Absent days')).value).toBe(2);
    expect(b.getCell(col(sheet, 'Paid leave applied')).value).toBe(2);
    expect(b.getCell(col(sheet, 'Final LOP')).value).toBe(0);
    expect(sheet.getRow(3).getCell(1).value).toContain('TOTAL FINAL LOP: 1 days');
  });

  it('exports employees as rows, every month date as IN/OUT/OT columns, missing highlights and final attendance totals', async () => {
    // This fixture intentionally separates an unpaid absence from an approved
    // paid leave day; automatic cover is tested by the earlier leave case.
    const leavePolicy = await prisma.policy.findFirst({ where: { kind: 'LEAVE' } });
    await prisma.policy.update({ where: { id: leavePolicy.id }, data: { rules: { ...leavePolicy.rules, types: leavePolicy.rules.types.map((type) => ({ ...type, auto_apply: false })) } } });
    await mutatePunches(async (tx) => {
      await tx.punch.deleteMany({ where: { employee_id: f.employees.A, work_date: toDbDate(`${YM}-03`), direction: 'OUT' } });
      await tx.punch.deleteMany({ where: { employee_id: f.employees.B, work_date: toDbDate(`${YM}-04`), direction: 'IN' } });
    });
    // Effective absence must be obvious even when original physical punches are
    // retained underneath HR's correction for audit.
    expect((await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.C, work_date: `${YM}-05`, mode: 'MARK', status: 'ABSENT', reason_text: 'Original punches do not count for this day' })).status).toBe(201);
    expect((await f.agent.post('/api/v1/leave/adjustments').send({ employee_id: f.employees.C, leave_type: 'SL', date: `${YM}-01`, days: 1, reason: 'Available paid sick leave' })).status).toBe(201);
    const paid = await f.agent.post('/api/v1/leave').send({ employee_id: f.employees.C, leave_type: 'SL', from_date: `${YM}-06`, to_date: `${YM}-06`, days: 1, reason: 'Approved paid leave supersedes original punches' });
    expect(paid.status).toBe(201);
    expect((await f.agent.post(`/api/v1/leave/${paid.body.data.id}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const response = await download('monthly', { ym: YM, report: 'detailed', format: 'xlsx' });
    const book = await workbook(response);
    const sheet = book.getWorksheet('Monthly register');
    expect(book.worksheets).toHaveLength(1);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 3, ySplit: 7 });
    expect(sheet.columnCount).toBe(3 + 31 * 3 + 9);
    expect(sheet.rowCount).toBe(7 + 3 + 1);
    expect([8, 9, 10].map((i) => sheet.getRow(i).getCell(1).value)).toEqual(['T001', 'T002', 'T003']);
    for (let day = 1; day <= 31; day++) {
      const start = 4 + (day - 1) * 3;
      expect(sheet.getRow(6).getCell(start).value).toContain(`${String(day).padStart(2, '0')} Aug 2026`);
      expect([0, 1, 2].map((offset) => sheet.getRow(7).getCell(start + offset).value)).toEqual(['IN', 'OUT', 'OT hours']);
      for (const row of [8, 9, 10]) {
        expect(sheet.getRow(row).getCell(start).value).not.toBeNull();
        expect(sheet.getRow(row).getCell(start + 2).value === '' || typeof sheet.getRow(row).getCell(start + 2).value === 'number').toBe(true);
      }
    }
    const a = sheet.getRow(8), b = sheet.getRow(9);
    expect(a.getCell(10).value).toBe('09:00');
    expect(a.getCell(11).value).toBe('Missing');
    expect(a.getCell(11).fill.fgColor.argb).toBe('FFF3D7');
    expect(a.getCell(11).note).toContain('Missing punch-out');
    expect(a.getCell(10).fill.fgColor.argb).not.toBe('FFF3D7');
    expect(b.getCell(13).value).toBe('Missing');
    expect(b.getCell(13).fill.fgColor.argb).toBe('FFF3D7');
    expect(b.getCell(14).value).toBe('17:30');
    const c = sheet.getRow(10);
    expect(c.getCell(16).value).toBe('Absent');
    expect(c.getCell(17).value).toBe('');
    expect(c.getCell(18).value).toBe('');
    expect(c.getCell(16).fill.fgColor.argb).toBe('FCECEE');
    expect(c.getCell(16).note).toContain('Recorded IN: 09:00');
    expect(c.getCell(19).value).toBe('On leave');
    expect(c.getCell(20).value).toBe('');
    expect(c.getCell(21).value).toBe('');
    expect(c.getCell(19).fill.fgColor.argb).toBe('E5F5FC');
    expect(c.getCell(19).note).toContain('SL paid leave');
    const totalCol = (label) => sheet.getRow(7).values.findIndex((value) => value === label);
    expect(sheet.getRow(7).getCell(sheet.columnCount).value).toBe('Late minutes');
    expect(a.getCell(totalCol('Final paid days')).value).toBe(30.5);
    expect(a.getCell(totalCol('Final LOP')).value).toBe(0.5);
    expect(a.getCell(totalCol('Working days')).value).toBe(25);
    expect(c.getCell(totalCol('Paid leave applied')).value).toBe(1);
    expect(c.getCell(totalCol('Final paid days')).value).toBe(30);
    expect(c.getCell(totalCol('Final LOP')).value).toBe(1);
    expect(sheet.getRow(11).getCell(2).value).toBe('TOTAL');
    expect(sheet.getRow(11).getCell(totalCol('Final LOP')).value).toBe(2);
  });

  it('keeps future and non-employed dates clear instead of reporting them as absences', async () => {
    await prisma.employee.update({ where: { id: f.employees.C }, data: { joined_on: toDbDate(`${YM}-05`) } });
    const report = await buildMonthlyAttendanceReport(prisma, { ym: YM, report: 'detailed', q: 'Person C' }, `${YM}-10`);
    const person = report.rows[0];
    expect(person.details).toHaveLength(31);
    expect(person.details[0]).toMatchObject({ status: 'Not joined', in: '', out: '', lop: null });
    expect(person.details[10]).toMatchObject({ status: 'Future', in: '', out: '', lop: null, late_minutes: null });
    expect(person.summary.days).toBe(6);
    expect(person.summary.lop_days).toBe(0);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await renderAttendanceReport(report, 'xlsx'));
    const row = book.getWorksheet('Monthly register').getRow(8);
    expect(row.getCell(4).value).toBe('Not joined');
    expect(row.getCell(34).value).toBe('Future'); // Day 11, IN/status column.
    expect(row.getCell(35).value).toBe('');
    expect(row.getCell(36).value).toBe('');
  });

  it('exports a daily register with overnight times, missing-punch highlights and day-only totals', async () => {
    const date = `${YM}-03`;
    await mutatePunches(async (tx) => {
      await tx.punch.deleteMany({ where: { employee_id: f.employees.A, work_date: toDbDate(date), direction: 'OUT' } });
      await tx.punch.deleteMany({ where: { employee_id: f.employees.B, work_date: toDbDate(date) } });
      await tx.punch.createMany({ data: [punch(f.employees.B, 'IN', date, 1380), punch(f.employees.B, 'OUT', date, 1680)] });
      await tx.punch.deleteMany({ where: { employee_id: f.employees.C, work_date: toDbDate(date), direction: 'IN' } });
    });
    const report = await download('daily', { date, format: 'xlsx' });
    const sheet = (await workbook(report)).getWorksheet('Daily register');
    expect(sheet.getRow(7).getCell(col(sheet, 'Notes')).value).toContain('Missing punch-out');
    expect(sheet.getRow(8).getCell(col(sheet, 'OUT')).value).toBe('04:00 (+1d)');
    expect(sheet.getRow(9).getCell(col(sheet, 'Notes')).value).toContain('Missing punch-in');
    // This fixture pays a full day above its 4-hour half-day cutoff: the 5-hour
    // overnight day is present, while the two missing punches each lose 0.5d.
    expect(sheet.getRow(10).getCell(col(sheet, 'Final LOP')).value).toBe(1);
    expect(sheet.getRow(10).getCell(col(sheet, 'Late minutes')).value).toBe(180);
    const filtered = await download('daily', { date, format: 'xlsx', 'filter[view]': 'nopunch', 'filter[site]': f.siteId });
    const selected = (await workbook(filtered)).getWorksheet('Daily register');
    expect(selected.getRow(7).getCell(1).value).toBe('T001');
    expect(selected.getRow(8).getCell(1).value).toBe('T003');
    expect(selected.getRow(9).getCell(2).value).toBe('TOTAL');
  });

  it('produces real PDF pages with repeated headers and footers without extra blank pages', async () => {
    for (const [path, query, expectedPages] of [
      ['monthly', { ym: YM, report: 'summary', format: 'pdf' }, 1],
      ['monthly', { ym: YM, report: 'detailed', format: 'pdf' }, 6], // Five date groups, then all employee month totals.
      ['daily', { date: `${YM}-03`, format: 'pdf' }, 1],
    ]) {
      const response = await download(path, query);
      expect(response.headers['content-type']).toMatch(/application\/pdf/);
      expect(response.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(response.body.toString('latin1')).toContain('%%EOF');
      expect(pageCount(response.body)).toBe(expectedPages);
      const pdf = response.body.toString('latin1');
      expect(pdf).toMatch(/\/Title\s+\d+\s+0\s+R/);
      expect(pdf).toContain(`(${path === 'daily' ? 'Daily attendance register' : query.report === 'summary' ? 'Monthly attendance summary' : 'Monthly attendance details'} -`);
    }
    const detailed = await buildMonthlyAttendanceReport(prisma, { ym: YM, report: 'detailed' }, '2026-09-01');
    detailed.rows = Array.from({ length: 90 }, (_, i) => ({ ...detailed.rows[i % 3], employee: { ...detailed.rows[i % 3].employee, name: `Employee with a long name number ${i}` } }));
    detailed.kind = 'summary';
    const pages = await renderAttendanceReport(detailed, 'pdf');
    expect(pageCount(pages)).toBeGreaterThan(1);
  });
});
