import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { DAY_STATUS_LABELS, firstOfMonth, istMidnight, lastOfMonth, monthDates, ymOf } from '@ajpwer/shared';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { filterOne, filterValues } from '../utils/list.js';
import { computeMonths } from './attendance.service.js';
import { attendanceSummary } from './attendance-summary.service.js';
import { inView, liveFigures, minutesNow } from './dayview.service.js';
import { monthRows } from './monthgrid.service.js';
import { dayRegister } from './register.service.js';
import { matrixDayCells, renderAttendanceMatrixPDF } from './attendance-matrix-pdf.service.js';

const C = { ink: '092733', teal: '148B80', green: '21A86F', cyan: '25B7C7', pale: 'E8F5F2', line: 'D7E5E9', muted: '607784', red: 'BE383E', redBg: 'FCECEE', amber: '986318', amberBg: 'FFF3D7', grey: 'F3F7F9', white: 'FFFFFF' };
const OUT = ['NOT_JOINED', 'EXITED'];
const round2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;
const total = (rows, key) => round2(rows.reduce((n, r) => n + Number(r.summary[key] ?? 0), 0));
const asHours = (min) => round2(Number(min ?? 0) / 60);
const duration = (min) => `${Math.floor(Number(min ?? 0) / 60)}h ${String(Number(min ?? 0) % 60).padStart(2, '0')}m`;
const time = (min) => min === null || min === undefined ? '' : `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}${min >= 1440 ? ` (+${Math.floor(min / 1440)}d)` : ''}`;
const dateLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (ym) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const weekday = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

function scopeEmployee(e, query) {
  const needle = query.q?.trim().toLowerCase();
  if (needle && !`${e.name} ${e.code}`.toLowerCase().includes(needle)) return false;
  const dept = query.dept ? [query.dept] : filterValues(query.filter ?? {}, 'dept');
  const group = query.pay_group ? [query.pay_group] : filterValues(query.filter ?? {}, 'pay_group');
  return (!dept.length || dept.includes(e.department?.id)) && (!group.length || group.includes(e.pay_group_id));
}

/** Read all employees in the employment window, never the current screen's page. */
export async function buildMonthlyAttendanceReport(db, query, today) {
  const ym = query.ym;
  const [allEmployees, company] = await Promise.all([
    db.employee.findMany({
      where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'EXITED'] }, joined_on: { lte: toDbDate(lastOfMonth(ym)) }, OR: [{ last_day: null }, { last_day: { gte: toDbDate(firstOfMonth(ym)) } }] },
      select: { id: true, code: true, name: true, joined_on: true, last_day: true, pay_group_id: true, department: { select: { id: true, name: true, colour: true } } },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    }),
    db.company.findFirst({ select: { name: true } }),
  ]);
  const employees = allEmployees.filter((e) => scopeEmployee(e, query));
  const ids = employees.map((e) => e.id);
  const bounds = { gte: toDbDate(firstOfMonth(ym)), lte: toDbDate(lastOfMonth(ym)) };
  const [months, punches, overrides, sites] = await Promise.all([
    computeMonths(db, employees, ym, { today }),
    db.punch.findMany({ where: { employee_id: { in: ids }, work_date: bounds }, select: { employee_id: true, work_date: true, direction: true, punched_at: true, method: true, site_id: true }, orderBy: { punched_at: 'asc' } }),
    db.attendanceOverride.findMany({ where: { employee_id: { in: ids }, work_date: bounds, deleted_at: null }, select: { employee_id: true, work_date: true, in_min: true, out_min: true } }),
    db.site.findMany({ select: { id: true, name: true } }),
  ]);
  const groupedPunches = new Map();
  for (const p of punches) {
    const key = `${p.employee_id}/${fromDbDate(p.work_date)}`;
    const list = groupedPunches.get(key) ?? [];
    list.push(p);
    groupedPunches.set(key, list);
  }
  const corrections = new Map(overrides.map((o) => [`${o.employee_id}/${fromDbDate(o.work_date)}`, o]));
  const siteNames = new Map(sites.map((s) => [s.id, s.name]));
  const selectedSites = query.site ? [query.site] : filterValues(query.filter ?? {}, 'site');
  const grid = monthRows(employees, months, ym, today);
  const rows = grid.map((r) => {
    const effective = months.get(r.employee.id)?.result.days ?? [];
    const effectiveByDate = new Map(effective.map((d) => [d.date, d]));
    const summary = r.attendance_summary ?? attendanceSummary(effective, { today });
    const details = monthDates(ym).map((date) => {
      const day = effectiveByDate.get(date);
      const raw = groupedPunches.get(`${r.employee.id}/${date}`) ?? [];
      const correction = corrections.get(`${r.employee.id}/${date}`);
      return reportDay(day, date, today, raw, correction, siteNames);
    });
    return { employee: r.employee, summary, details };
  }).filter((r) => !selectedSites.length || r.details.some((d) => d.site_ids.some((id) => selectedSites.includes(id))));
  const cutoff = lastOfMonth(ym) < today ? lastOfMonth(ym) : today;
  return { kind: query.report, period: ym, title: `Monthly attendance ${query.report === 'detailed' ? 'details' : 'summary'}`, label: monthLabel(ym), company: company?.name ?? 'AJPWER Workforce', today, cutoff, rows, lop: total(rows, 'lop_days'), missing: total(rows, 'missing_punch'), late: total(rows, 'late_minutes'), ot_min: total(rows, 'ot_min'), filters: scopeDescription(query) };
}

function reportDay(day, date, today, punches, correction, siteNames) {
  const future = date > today;
  const outside = !day || OUT.includes(day.status);
  const inPunch = punches.find((p) => p.direction === 'IN');
  const outPunch = punches.findLast((p) => p.direction === 'OUT');
  const minute = (p) => p ? Math.floor((p.punched_at.getTime() - istMidnight(date).getTime()) / 60_000) : null;
  const inMin = correction?.in_min ?? minute(inPunch);
  const outMin = correction?.out_min ?? minute(outPunch);
  const correctedTimes = correction?.in_min !== null && correction?.in_min !== undefined && correction?.out_min !== null && correction?.out_min !== undefined;
  const flags = day?.flags ?? [];
  const autoOut = flags.some((f) => ['AUTOPUNCHED', 'AUTO_PUNCH', 'AUTO_PUNCHED', 'AUTO_OUT'].includes(f)) || punches.some((p) => ['AUTO', 'AUTO_OUT', 'AUTOPUNCHED'].includes(p.method));
  const missing = !future && !outside && !correction && (day?.missing_punch || day?.status === 'MISSING_PUNCH' || autoOut || flags.includes('UNMATCHED_IN') || flags.includes('ORPHAN_OUT'));
  const notes = [];
  if (missing) {
    if (!inPunch) notes.push('Missing punch-in');
    if (!outPunch || autoOut || flags.includes('UNMATCHED_IN')) notes.push('Missing punch-out');
    if (!notes.length) notes.push('Unmatched punch');
    if (autoOut) notes.push('Automatic punch-out: needs review');
  }
  if (date === today && flags.includes('UNMATCHED_IN') && !correction) notes.splice(0, notes.length, 'Still punched in');
  if (correction) notes.push(correctedTimes ? 'Times corrected by HR' : 'Status corrected by HR');
  if (day?.auto_leave > 0) notes.push(`Automatic paid leave: ${day.auto_leave}d`);
  if (day?.applied) notes.push(`${day.applied.leave_type} ${day.applied.paid ? 'paid' : 'unpaid'} leave${day.applied.portion === 0.5 ? ' (half day)' : ''}`);
  if (flags.includes('SANDWICHED')) notes.push('Unpaid off day: sandwich policy');
  const siteIds = [...new Set(punches.map((p) => p.site_id).filter(Boolean))];
  return {
    date, weekday: weekday(date), status: future ? 'Future' : outside ? (day?.status === 'EXITED' ? 'After exit' : 'Not joined') : DAY_STATUS_LABELS[day.status] ?? day.status,
    status_key: future ? 'FUTURE' : day?.status ?? 'NOT_JOINED',
    in: future || outside ? '' : time(inMin), out: future || outside ? '' : time(outMin),
    worked_min: future || outside ? null : Number(day.worked_min ?? 0), ot_min: future || outside ? null : Number(day.ot_min ?? 0),
    lop: future || outside ? null : round2(Math.max(0, 1 - Number(day.day_value ?? 0))),
    late_minutes: future || outside ? null : Number(day.shift_shortfall_min ?? 0),
    missing: !!missing, notes: notes.join('; '), site_ids: siteIds, sites: siteIds.map((id) => siteNames.get(id) ?? id).join(', '),
  };
}

function scopeDescription(query) {
  const pieces = [];
  if (query.q?.trim()) pieces.push(`Search: ${query.q.trim()}`);
  if (query.dept || filterValues(query.filter ?? {}, 'dept').length) pieces.push('Selected departments');
  if (query.pay_group || filterValues(query.filter ?? {}, 'pay_group').length) pieces.push('Selected pay groups');
  if (query.site || filterValues(query.filter ?? {}, 'site').length) pieces.push('Selected sites');
  if (query.filter?.view) pieces.push(`View: ${query.filter.view}`);
  return pieces.join(' | ') || 'All employees';
}

/** A day report has the register's employee scope, with the month's settled leave credit. */
export async function buildDailyAttendanceReport(db, query, today) {
  const nowMin = query.date === today ? minutesNow(query.date) : 0;
  let registered = (await dayRegister(db, query.date, undefined, today)).filter((r) => scopeEmployee(r.employee, query));
  const f = query.filter ?? {};
  const sites = query.site ? [query.site] : filterValues(f, 'site');
  const view = filterOne(f, 'view');
  if (sites.length && !['absent', 'leave'].includes(view)) registered = registered.filter((r) => r.day.sites.some((id) => sites.includes(id)));
  if (view) registered = registered.filter((r) => inView(view, r, liveFigures(r, nowMin)));
  const statuses = filterValues(f, 'status');
  if (statuses.length) registered = registered.filter((r) => statuses.includes(r.day.status));
  if (f.corrected === 'yes') registered = registered.filter((r) => !!r.override);
  if (f.late === 'yes') registered = registered.filter((r) => r.day.late_min > 0);
  if (f.early === 'yes') registered = registered.filter((r) => r.day.early_min > 0);
  if (f.ot === 'yes') registered = registered.filter((r) => r.day.ot_min > 0);
  const month = await buildMonthlyAttendanceReport(db, { ym: ymOf(query.date), report: 'detailed', q: query.q, dept: query.dept, pay_group: query.pay_group, filter: { dept: f.dept, pay_group: f.pay_group } }, today);
  const ids = new Set(registered.map((r) => r.employee.id));
  const rows = month.rows.filter((r) => ids.has(r.employee.id)).map((r) => ({ ...r, details: r.details.filter((d) => d.date === query.date) }));
  return { ...month, kind: 'daily', period: query.date, title: 'Daily attendance register', label: dateLabel(query.date), rows, lop: round2(rows.reduce((n, r) => n + (r.details[0]?.lop ?? 0), 0)), missing: rows.filter((r) => r.details[0]?.missing).length, ot_min: rows.reduce((n, r) => n + (r.details[0]?.ot_min ?? 0), 0), late: rows.reduce((n, r) => n + (r.details[0]?.late_minutes ?? 0), 0), filters: scopeDescription(query) };
}

const SUMMARY_COLUMNS = [
  { label: 'Code', width: 12, pdf: 48, key: 'code' }, { label: 'Employee', width: 28, pdf: 116, key: 'name' }, { label: 'Department', width: 22, pdf: 78, key: 'department' },
  { label: 'Working days', width: 14, pdf: 47, key: 'working_days', number: true }, { label: 'Present days', width: 14, pdf: 47, key: 'present_days', number: true },
  { label: 'Absent days', width: 14, pdf: 47, key: 'absent_days', number: true }, { label: 'Paid leave applied', width: 16, pdf: 49, key: 'paid_leave_days', number: true },
  { label: 'Auto paid leave', width: 16, pdf: 49, key: 'auto_leave_days', number: true }, { label: 'Unpaid leave', width: 14, pdf: 47, key: 'unpaid_leave_days', number: true },
  { label: 'Final LOP', width: 14, pdf: 46, key: 'lop_days', number: true, tone: 'lop' }, { label: 'Missing punches', width: 16, pdf: 48, key: 'missing_punch', number: true, tone: 'missing' },
  { label: 'OT hours', width: 14, pdf: 46, key: 'ot_hours', number: true }, { label: 'Late minutes', width: 16, pdf: 47, key: 'late_minutes', number: true },
];
const MATRIX_TOTAL_COLUMNS = [
  ...SUMMARY_COLUMNS.filter((c) => ['working_days', 'present_days', 'absent_days', 'paid_leave_days', 'auto_leave_days'].includes(c.key)),
  { label: 'Final paid days', width: 15, key: 'paid_days', number: true },
  ...SUMMARY_COLUMNS.filter((c) => ['lop_days', 'ot_hours', 'late_minutes'].includes(c.key)),
];
const DAILY_COLUMNS = [
  { label: 'Code', width: 12, pdf: 43, key: 'code' }, { label: 'Employee', width: 26, pdf: 103, key: 'name' }, { label: 'Department', width: 20, pdf: 70, key: 'department' },
  { label: 'Status', width: 18, pdf: 72, key: 'status' }, { label: 'IN', width: 16, pdf: 52, key: 'in' }, { label: 'OUT', width: 16, pdf: 52, key: 'out' },
  { label: 'Worked', width: 12, pdf: 48, key: 'worked' }, { label: 'Notes', width: 48, pdf: 170, key: 'notes' },
  { label: 'OT hours', width: 12, pdf: 42, key: 'ot_hours', number: true }, { label: 'Final LOP', width: 13, pdf: 42, key: 'lop', number: true, tone: 'lop' }, { label: 'Late minutes', width: 15, pdf: 48, key: 'late_minutes', number: true },
];

function summaryRow(row) {
  return { ...row.summary, code: row.employee.code, name: row.employee.name, department: row.employee.department?.name ?? '', ot_hours: asHours(row.summary.ot_min) };
}
function detailRow(day) {
  return { ...day, date: dateLabel(day.date), worked: day.worked_min === null ? '' : duration(day.worked_min), ot_hours: day.ot_min === null ? null : asHours(day.ot_min) };
}
const reportNote = 'Late minutes = required shift hours not completed; arrival delay is separate. Absent days include applied and automatic leave before paid cover. Final LOP uses effective leave and off-day rules.';

export async function renderAttendanceReport(report, format) {
  return format === 'pdf' ? report.kind === 'detailed' ? renderAttendanceMatrixPDF(report) : pdfReport(report) : xlsxReport(report);
}

function fill(colour) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } }; }
function titleRow(sheet, row, text, count, colour = C.ink, size = 18) {
  sheet.mergeCells(row, 1, row, count);
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  cell.font = { name: 'Calibri', size, bold: size > 12, color: { argb: colour } };
  cell.alignment = { vertical: 'middle', wrapText: true };
  sheet.getRow(row).height = size > 12 ? 31 : 30;
}
function initSheet(book, name, report, columns) {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 6 }], properties: { defaultRowHeight: 24 }, pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:6' } });
  sheet.columns = columns.map((c) => ({ width: c.width }));
  titleRow(sheet, 1, `${report.company} | ${report.title}`, columns.length);
  titleRow(sheet, 2, `${report.label} | ${report.rows.length} employees | ${report.filters}${report.period.length === 7 && report.cutoff < lastOfMonth(report.period) ? ` | Through ${dateLabel(report.cutoff)}` : ''}`, columns.length, C.muted, 11);
  titleRow(sheet, 3, `TOTAL FINAL LOP: ${report.lop} days    |    OT: ${duration(report.ot_min)}    |    Missing punches: ${report.missing}    |    Late minutes: ${report.late}`, columns.length, C.teal, 12);
  sheet.getRow(3).eachCell((cell) => { cell.fill = fill(C.pale); cell.font.bold = true; });
  titleRow(sheet, 4, reportNote, columns.length, C.muted, 10);
  sheet.getRow(4).height = 34;
  titleRow(sheet, 5, 'Amber = missing / unmatched punch. Red = unpaid absence or LOP. Grey = off day, future or outside employment. Times are IST; +1d indicates next day.', columns.length, C.muted, 10);
  sheet.getRow(5).height = 26;
  writeHeader(sheet, 6, columns);
  sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: columns.length } };
  sheet.headerFooter.oddFooter = '&LAttendance | Times in IST&CPage &P of &N&R&A';
  sheet.pageSetup.margins = { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 };
  return sheet;
}
function writeHeader(sheet, row, columns) {
  const r = sheet.getRow(row);
  r.values = columns.map((c) => c.label);
  r.height = 34;
  r.eachCell((cell) => { cell.fill = fill(C.teal); cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.white } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
}
function writeData(sheet, rowNo, columns, data, { totals = false } = {}) {
  const row = sheet.getRow(rowNo);
  row.values = columns.map((c) => data[c.key] ?? '');
  const lines = Math.max(1, ...columns.map((c) => String(data[c.key] ?? '').split('\n').reduce((n, text) => n + Math.max(1, Math.ceil(text.length / Math.max(1, c.width - 2))), 0)));
  row.height = Math.max(totals ? 34 : 25, lines * 14 + 8);
  const background = totals ? C.pale : data.missing ? C.amberBg : data.status_key === 'ABSENT' ? C.redBg : ['FUTURE', 'NOT_JOINED', 'EXITED', 'WEEKLY_OFF', 'HOLIDAY'].includes(data.status_key) ? C.grey : rowNo % 2 ? C.grey : C.white;
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.fill = fill(background);
    cell.font = { name: 'Calibri', size: 11, bold: totals, color: { argb: c.tone === 'lop' && Number(data[c.key]) > 0 ? C.red : c.tone === 'missing' && Number(data[c.key]) > 0 ? C.amber : C.ink } };
    cell.alignment = { vertical: 'middle', wrapText: true, horizontal: c.number ? 'right' : 'left' };
    cell.border = { bottom: { style: 'hair', color: { argb: C.line } } };
    if (c.number) cell.numFmt = '0.##';
  });
}

async function xlsxReport(report) {
  const book = new ExcelJS.Workbook();
  book.creator = 'AJPWER Workforce';
  book.subject = `${report.title} | ${report.label}`;
  book.created = new Date();
  if (report.kind === 'detailed') {
    matrixSheet(book, report);
  } else if (report.kind === 'daily') {
    const sheet = initSheet(book, 'Daily register', report, DAILY_COLUMNS);
    // Use day figures, not the employee's month totals, on a daily register.
    report.rows.forEach((r, i) => writeData(sheet, i + 7, DAILY_COLUMNS, { ...summaryRow(r), ...detailRow(r.details[0]) }));
    writeData(sheet, report.rows.length + 7, DAILY_COLUMNS, { name: 'TOTAL', ot_hours: asHours(report.ot_min), lop: report.lop, late_minutes: report.late }, { totals: true });
  } else {
    const summary = initSheet(book, 'Monthly summary', report, SUMMARY_COLUMNS);
    report.rows.forEach((r, i) => writeData(summary, i + 7, SUMMARY_COLUMNS, summaryRow(r)));
    const aggregate = { name: 'TOTAL', ot_hours: asHours(report.ot_min) };
    for (const c of SUMMARY_COLUMNS.filter((c) => c.number && c.key !== 'ot_hours')) aggregate[c.key] = total(report.rows, c.key);
    writeData(summary, report.rows.length + 7, SUMMARY_COLUMNS, aggregate, { totals: true });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** A single employee row, with three time/OT columns beneath every month date. */
function matrixSheet(book, report) {
  const dates = monthDates(report.period);
  const identities = SUMMARY_COLUMNS.slice(0, 3);
  const columns = [...identities, ...dates.flatMap(() => [{ label: 'IN', width: 12 }, { label: 'OUT', width: 12 }, { label: 'OT hours', width: 9, number: true }]), ...MATRIX_TOTAL_COLUMNS];
  const sheet = initSheet(book, 'Monthly register', report, columns);
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 7, topLeftCell: 'D8' }];
  sheet.pageSetup.printTitlesRow = '1:7';
  sheet.pageSetup.printTitlesColumn = 'A:C';
  sheet.pageSetup.fitToPage = false;
  sheet.pageSetup.fitToWidth = 0;
  sheet.autoFilter = undefined;
  sheet.getRow(6).values = [];
  sheet.getRow(6).height = 27;
  sheet.getRow(7).height = 35;
  const header = (cell, value, background = C.teal) => {
    cell.value = value;
    cell.fill = fill(background);
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.white } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { right: { style: 'thin', color: { argb: C.line } } };
  };
  identities.forEach((c, i) => { sheet.mergeCells(6, i + 1, 7, i + 1); header(sheet.getCell(6, i + 1), c.label); });
  dates.forEach((date, i) => {
    const start = 4 + i * 3;
    const background = i % 2 ? C.teal : '126A75';
    sheet.mergeCells(6, start, 6, start + 2);
    header(sheet.getCell(6, start), `${dateLabel(date)} | ${weekday(date)}`, background);
    ['IN', 'OUT', 'OT hours'].forEach((label, offset) => header(sheet.getCell(7, start + offset), label, background));
  });
  const totalsStart = 4 + dates.length * 3;
  sheet.mergeCells(6, totalsStart, 6, columns.length);
  header(sheet.getCell(6, totalsStart), 'MONTHLY ATTENDANCE TOTALS', '13754E');
  MATRIX_TOTAL_COLUMNS.forEach((c, i) => header(sheet.getCell(7, totalsStart + i), c.label, '13754E'));
  const colours = { working: 'EFF9F3', absent: C.redBg, leave: 'E5F5FC', off: C.grey, neutral: C.white, missing: C.amberBg };
  for (const [i, person] of report.rows.entries()) {
    const rowNo = i + 8;
    const data = summaryRow(person);
    writeData(sheet, rowNo, columns, data);
    const byDate = new Map(person.details.map((d) => [d.date, d]));
    for (const [dateIndex, date] of dates.entries()) {
      const day = byDate.get(date) ?? { status: 'Future', status_key: 'FUTURE' };
      const cells = matrixDayCells(day);
      cells.forEach((entry, offset) => {
        const cell = sheet.getCell(rowNo, 4 + dateIndex * 3 + offset);
        cell.value = entry.value;
        cell.fill = fill(colours[entry.tone] ?? C.white);
        cell.font = { name: 'Calibri', size: 10, bold: entry.tone === 'missing' || entry.tone === 'absent', color: { argb: entry.tone === 'missing' ? C.amber : entry.tone === 'absent' ? C.red : C.ink } };
        cell.alignment = { horizontal: offset === 2 ? 'right' : 'center', vertical: 'middle', wrapText: true };
        cell.border = { bottom: { style: 'hair', color: { argb: C.line } }, ...(offset === 2 ? { right: { style: 'thin', color: { argb: C.line } } } : {}) };
        if (offset === 2) cell.numFmt = '0.##';
        if (entry.comment) cell.note = entry.comment;
      });
    }
    MATRIX_TOTAL_COLUMNS.forEach((c, offset) => {
      const cell = sheet.getCell(rowNo, totalsStart + offset);
      cell.value = data[c.key] ?? 0;
      cell.fill = fill(c.key === 'lop_days' && Number(data[c.key]) > 0 ? C.redBg : C.pale);
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: c.key === 'lop_days' && Number(data[c.key]) > 0 ? C.red : C.teal } };
      cell.numFmt = '0.##';
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });
    sheet.getRow(rowNo).height = Math.max(sheet.getRow(rowNo).height, 34);
  }
  const rowNo = report.rows.length + 8;
  const aggregate = { name: 'TOTAL', ot_hours: asHours(report.ot_min) };
  for (const c of MATRIX_TOTAL_COLUMNS.filter((c) => c.key !== 'ot_hours')) aggregate[c.key] = total(report.rows, c.key);
  writeData(sheet, rowNo, columns, aggregate, { totals: true });
  dates.forEach((date, index) => {
    const values = report.rows.map((r) => r.details.find((d) => d.date === date)?.ot_min).filter((v) => v !== null && v !== undefined);
    const cell = sheet.getCell(rowNo, 6 + index * 3);
    cell.value = values.length ? asHours(values.reduce((n, min) => n + min, 0)) : '';
    cell.numFmt = '0.##';
  });
}

function pdfReport(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 26, bufferPages: true, info: { Title: `${report.title} - ${report.label}`, Author: 'AJPWER Workforce', Subject: `Final LOP ${report.lop} days` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const page = { width: doc.page.width, height: doc.page.height, left: 26, right: doc.page.width - 26, bottom: doc.page.height - 35 };
    const head = (subtitle = '') => {
      doc.rect(0, 0, page.width, 6).fill(`#${C.teal}`);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(`#${C.ink}`).text(report.title, page.left, 20, { width: 520, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(`#${C.muted}`).text(report.company, page.right - 235, 24, { width: 235, align: 'right', lineBreak: false });
      doc.fontSize(9).text(`${report.label} | ${report.rows.length} employees | ${report.filters}${subtitle ? ` | ${subtitle}` : ''}`, page.left, 44, { width: page.width - 52, lineBreak: false });
      doc.roundedRect(page.left, 60, page.width - 52, 25, 4).fill(`#${C.pale}`);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(`#${C.teal}`).text(`FINAL LOP ${report.lop} days     |     OT ${duration(report.ot_min)}     |     Missing punches ${report.missing}     |     Late minutes ${report.late}`, page.left + 10, 68, { width: page.width - 72, lineBreak: false });
      return 94;
    };
    const columnsFor = (columns) => {
      const sum = columns.reduce((n, c) => n + c.pdf, 0);
      return columns.map((c) => ({ ...c, span: c.pdf / sum * (page.width - 52) }));
    };
    const drawHeader = (cols, y) => {
      const h = cols.length > 11 ? 34 : 28;
      doc.rect(page.left, y, page.width - 52, h).fill(`#${C.teal}`);
      let x = page.left;
      for (const c of cols) {
        doc.font('Helvetica-Bold').fontSize(7.7).fillColor(`#${C.white}`).text(c.label, x + 5, y + 6, { width: c.span - 10, height: h - 8, align: c.number ? 'right' : 'left' });
        x += c.span;
      }
      return y + h;
    };
    const drawRow = (cols, y, data, index, { totals = false, minHeight = 20, fontSize = 8, padding = 4 } = {}) => {
      doc.font(totals ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      const h = Math.max(minHeight, ...cols.map((c) => doc.heightOfString(String(data[c.key] ?? ''), { width: c.span - 10 }) + padding * 2));
      const background = totals ? C.pale : data.missing ? C.amberBg : data.status_key === 'ABSENT' ? C.redBg : ['FUTURE', 'NOT_JOINED', 'EXITED', 'WEEKLY_OFF', 'HOLIDAY'].includes(data.status_key) ? C.grey : index % 2 ? C.grey : C.white;
      doc.rect(page.left, y, page.width - 52, h).fill(`#${background}`);
      let x = page.left;
      for (const c of cols) {
        const colour = c.tone === 'lop' && Number(data[c.key]) > 0 ? C.red : c.tone === 'missing' && Number(data[c.key]) > 0 ? C.amber : C.ink;
        doc.font(totals ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(`#${colour}`).text(String(data[c.key] ?? ''), x + 5, y + padding, { width: c.span - 10, height: h - padding * 2 + 1, align: c.number ? 'right' : 'left' });
        x += c.span;
      }
      doc.moveTo(page.left, y + h).lineTo(page.right, y + h).lineWidth(0.25).strokeColor(`#${C.line}`).stroke();
      return y + h;
    };
    const summaryCols = columnsFor(SUMMARY_COLUMNS);
    const dailyCols = columnsFor(DAILY_COLUMNS);
    let y = head(report.period.length === 7 && report.cutoff < lastOfMonth(report.period) ? `Through ${dateLabel(report.cutoff)}` : '');
    if (report.kind === 'summary' || report.kind === 'daily') {
      const cols = report.kind === 'daily' ? dailyCols : summaryCols;
      y = drawHeader(cols, y);
      for (const [i, person] of report.rows.entries()) {
        const data = report.kind === 'daily' ? { ...summaryRow(person), ...detailRow(person.details[0]) } : summaryRow(person);
        doc.font('Helvetica').fontSize(8);
        const h = Math.max(22, ...cols.map((c) => doc.heightOfString(String(data[c.key] ?? ''), { width: c.span - 10 }) + 8));
        if (y + h > page.bottom - 32) { doc.addPage(); y = drawHeader(cols, head('continued')); }
        y = drawRow(cols, y, data, i, { minHeight: 22 });
      }
      const aggregate = { name: 'TOTAL', ot_hours: asHours(report.ot_min), lop: report.lop, late_minutes: report.late };
      if (report.kind === 'summary') for (const c of SUMMARY_COLUMNS.filter((c) => c.number && c.key !== 'ot_hours')) aggregate[c.key] = total(report.rows, c.key);
      if (y + 28 > page.bottom) { doc.addPage(); y = drawHeader(cols, head('continued')); }
      y = drawRow(cols, y, aggregate, 0, { totals: true, minHeight: 26 });
    }
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      // A footer is intentionally inside the bottom margin. PDFKit otherwise
      // starts a new page even for positioned, non-wrapping footer text.
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor(`#${C.muted}`).text('Times in IST | Amber: missing punch | Late minutes: required shift shortfall | Final LOP after leave cover', page.left, page.height - 23, { width: page.width - 125, lineBreak: false });
      doc.text(`Page ${i + 1} of ${pages.count}`, page.right - 70, page.height - 23, { width: 70, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}
