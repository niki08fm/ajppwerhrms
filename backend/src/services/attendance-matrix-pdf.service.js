import PDFDocument from 'pdfkit';
import { monthDates } from '@ajpwer/shared';

const COLOURS = {
  ink: '#092733', teal: '#148B80', muted: '#607784', line: '#D7E5E9', white: '#FFFFFF', pale: '#E8F5F2',
  working: '#EAF7F1', absent: '#FCECEE', leave: '#EAF3FD', off: '#F0F4F6', neutral: '#F8FAFB', missing: '#FFF0CF',
  red: '#BE383E', amber: '#986318', blue: '#3273A5',
};
const number = (value) => Math.round(Number(value ?? 0) * 100) / 100;
const hours = (minutes) => number(Number(minutes ?? 0) / 60);
const duration = (minutes) => `${Math.floor(Number(minutes ?? 0) / 60)}h ${Math.round(Number(minutes ?? 0) % 60)}m`;
const dayLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const weekday = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

/** Shared XLSX/PDF matrix cells. Preserve actual timestamps and flag only missing evidence. */
export function matrixDayCells(day = {}) {
  const key = day.status_key ?? '';
  const notes = String(day.notes ?? '');
  const open = /still punched in/i.test(notes);
  const outside = ['FUTURE', 'NOT_JOINED', 'EXITED'].includes(key);
  const off = ['WEEKLY_OFF', 'HOLIDAY'].includes(key);
  const leave = /LEAVE/.test(key);
  const tone = outside ? 'neutral' : off ? 'off' : leave ? 'leave' : key === 'ABSENT' ? 'absent' : 'working';
  const comment = [day.status, notes, day.in ? `Recorded IN: ${day.in}` : '', day.out ? `Recorded OUT: ${day.out}` : ''].filter(Boolean).join(' — ');
  const inMissing = !outside && !open && (/missing punch-in/i.test(notes) || (day.missing && !day.in));
  const outMissing = !outside && !open && (/missing punch-out/i.test(notes) || (day.missing && !day.out));
  const unmatched = !outside && !open && day.missing && !inMissing && !outMissing;
  const statusOnly = !day.missing && ['ABSENT', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY'].includes(key);
  const blankStatus = statusOnly || (!day.in && !day.out && !inMissing && !outMissing && !open);
  return [
    { value: inMissing ? 'Missing' : blankStatus ? day.status ?? '' : day.in ?? '', tone: inMissing || unmatched ? 'missing' : tone, comment },
    { value: open ? 'Open' : outMissing ? 'Missing' : statusOnly ? '' : day.out ?? '', tone: outMissing || unmatched ? 'missing' : tone, comment },
    { value: outside || (blankStatus && !Number(day.ot_min)) ? '' : hours(day.ot_min), tone, comment },
  ];
}

export function matrixDateGroups(report) {
  const dates = monthDates(report.period);
  return Array.from({ length: Math.ceil(dates.length / 7) }, (_, i) => dates.slice(i * 7, i * 7 + 7));
}

const SUMMARY = [
  { key: 'code', label: 'Code', span: 43 }, { key: 'name', label: 'Employee', span: 108 }, { key: 'department', label: 'Department', span: 75 },
  { key: 'working_days', label: 'Working\ndays', span: 48 }, { key: 'present_days', label: 'Present\ndays', span: 45 },
  { key: 'absent_days', label: 'Absent\ndays', span: 45 }, { key: 'paid_leave_days', label: 'Paid leave\napplied', span: 52 },
  { key: 'auto_leave_days', label: 'Auto paid\nleave', span: 47 }, { key: 'unpaid_leave_days', label: 'Unpaid\nleave', span: 47 },
  { key: 'paid_days', label: 'Final paid\ndays', span: 46 },
  { key: 'lop_days', label: 'Final LOP\ndays', span: 45 }, { key: 'missing_punch', label: 'Missing\npunches', span: 48 },
  { key: 'ot_hours', label: 'OT\nhours', span: 43 }, { key: 'late_minutes', label: 'Late\nminutes', span: 49 },
];

/** Landscape monthly matrix with repeated date groups, followed by all employee month totals. */
export function renderAttendanceMatrixPDF(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 26, bufferPages: true,
      info: { Title: `${report.title} - ${report.label}`, Author: 'AJPWER Workforce', Subject: `Monthly matrix; final LOP ${report.lop} days` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const left = 26;
    const width = doc.page.width - left * 2;
    const bottom = doc.page.height - 43;
    const rows = report.rows ?? [];
    let started = false;

    function text(value, x, y, span, { bold = false, size = 7, colour = COLOURS.ink, align = 'left', height } = {}) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(colour)
        .text(String(value ?? ''), x, y, { width: Math.max(1, span), ...(height ? { height } : {}), align, lineBreak: true });
    }
    function pageHead(section) {
      if (started) doc.addPage();
      started = true;
      doc.rect(0, 0, doc.page.width, 6).fill(COLOURS.teal);
      text(report.title, left, 20, width - 245, { bold: true, size: 15, height: 20 });
      text(report.company, left + width - 235, 24, 235, { colour: COLOURS.muted, size: 9, align: 'right', height: 16 });
      text(`${report.label} | ${rows.length} employees | ${report.filters ?? 'All employees'}`, left, 44, width, { colour: COLOURS.muted, size: 8.5, height: 14 });
      doc.roundedRect(left, 62, width, 27, 4).fill(COLOURS.pale);
      text(`TOTAL FINAL LOP: ${number(report.lop)} days     |     OT: ${duration(report.ot_min)}     |     Missing punches: ${number(report.missing)}     |     Late minutes: ${number(report.late)}`,
        left + 9, 71, width - 18, { bold: true, size: 9.3, colour: COLOURS.teal, height: 15 });
      text(section, left, 100, width, { bold: true, size: 11, height: 17 });
      return 124;
    }
    function line(y) {
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.35).strokeColor(COLOURS.line).stroke();
    }
    function matrixHeader(dates, y) {
      const ids = [{ label: 'Code', span: 43 }, { label: 'Employee', span: 110 }, { label: 'Department', span: 87 }];
      const dateWidth = (width - 240) / dates.length;
      const topHeight = 26;
      const subHeight = 20;
      doc.rect(left, y, width, topHeight + subHeight).fill(COLOURS.teal);
      let x = left;
      ids.forEach((c) => { text(c.label, x + 4, y + 17, c.span - 8, { bold: true, colour: COLOURS.white, size: 7.5, height: 20 }); x += c.span; });
      dates.forEach((date) => {
        text(`${dayLabel(date)} · ${weekday(date)}`, x + 2, y + 6, dateWidth - 4, { bold: true, colour: COLOURS.white, align: 'center', size: 7.1, height: 16 });
        ['IN', 'OUT', 'OT h'].forEach((label, i) => text(label, x + i * dateWidth / 3 + 2, y + topHeight + 4, dateWidth / 3 - 4,
          { bold: true, colour: COLOURS.white, align: 'center', size: 6.8, height: 12 }));
        doc.moveTo(x, y).lineTo(x, y + topHeight + subHeight).lineWidth(0.5).strokeColor('#6EB8AF').stroke();
        x += dateWidth;
      });
      return { ids, dateWidth, y: y + topHeight + subHeight };
    }
    function matrixRow(person, dates, y, meta) {
      const days = new Map((person.details ?? []).map((d) => [d.date, d]));
      const name = person.employee.name ?? '';
      const department = person.employee.department?.name ?? '';
      doc.font('Helvetica').fontSize(7.2);
      const h = Math.max(32, doc.heightOfString(name, { width: 102 }) + 12, doc.heightOfString(department, { width: 79 }) + 12,
        ...dates.flatMap((date) => matrixDayCells(days.get(date)).map((cell) => {
          const value = String(cell.value).replace(/ \(\+(\d+)d\)/g, '\n(+$1d)');
          return doc.heightOfString(value, { width: meta.dateWidth / 3 - 5 }) + 10;
        })));
      return { h, paint() {
        doc.rect(left, y, 240, h).fill(COLOURS.white);
        const values = [person.employee.code, name, department];
        let x = left;
        meta.ids.forEach((c, i) => { text(values[i], x + 4, y + 6, c.span - 8, { bold: i === 1, size: 7.2, height: h - 10 }); x += c.span; });
        dates.forEach((date) => {
          const day = days.get(date) ?? { status: 'No data', status_key: 'NOT_JOINED' };
          const cells = matrixDayCells(day);
          // A non-working date has one clear status across the date group.
          // Keeping it inside the narrow IN column would split words such as
          // "Weekly off" even though the other two timestamp cells are empty.
          const statusOnly = cells[0].value !== 'Missing' && cells[1].value === '' && cells[2].value === '';
          if (statusOnly) {
            doc.rect(x, y, meta.dateWidth, h).fill(COLOURS[cells[0].tone] ?? COLOURS.white);
            text(cells[0].value, x + 4, y + 6, meta.dateWidth - 8,
              { size: 7, colour: cells[0].tone === 'absent' ? COLOURS.red : COLOURS.ink, align: 'center', height: h - 10 });
          } else cells.forEach((cell, i) => {
            const cx = x + i * meta.dateWidth / 3;
            doc.rect(cx, y, meta.dateWidth / 3, h).fill(COLOURS[cell.tone] ?? COLOURS.white);
            const value = String(cell.value).replace(/ \(\+(\d+)d\)/g, '\n(+$1d)');
            doc.font(cell.tone === 'missing' ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.7);
            const size = value === 'Missing' ? Math.min(6.7, 6.7 * (meta.dateWidth / 3 - 5) / doc.widthOfString(value)) : 6.7;
            text(value, cx + 2.5, y + 6, meta.dateWidth / 3 - 5,
              { size: size - 0.05, bold: cell.tone === 'missing', colour: cell.tone === 'missing' ? COLOURS.amber : cell.tone === 'absent' ? COLOURS.red : COLOURS.ink, align: 'center', height: h - 10 });
          });
          doc.moveTo(x, y).lineTo(x, y + h).lineWidth(0.4).strokeColor(COLOURS.line).stroke();
          x += meta.dateWidth;
        });
        line(y + h);
      } };
    }

    if (!rows.length) {
      const y = pageHead('Monthly attendance matrix');
      text('No employees match the selected month and filters.', left, y, width, { colour: COLOURS.muted, size: 10 });
    } else {
      for (const dates of matrixDateGroups(report)) {
        const section = `${dayLabel(dates[0])} – ${dayLabel(dates.at(-1))} | Daily IN / OUT / OT hours`;
        let meta = matrixHeader(dates, pageHead(section));
        let y = meta.y;
        for (const person of rows) {
          let row = matrixRow(person, dates, y, meta);
          if (y + row.h > bottom) { meta = matrixHeader(dates, pageHead(`${section} | Continued`)); y = meta.y; row = matrixRow(person, dates, y, meta); }
          row.paint();
          y += row.h;
        }
      }
      const factor = width / SUMMARY.reduce((sum, c) => sum + c.span, 0);
      const columns = SUMMARY.map((c) => ({ ...c, span: c.span * factor }));
      function summaryHeader(y) {
        doc.rect(left, y, width, 33).fill(COLOURS.teal);
        let x = left;
        columns.forEach((c) => { text(c.label, x + 4, y + 7, c.span - 8, { bold: true, colour: COLOURS.white, size: 6.9, height: 25, align: c.key === 'name' || c.key === 'department' || c.key === 'code' ? 'left' : 'right' }); x += c.span; });
        return y + 33;
      }
      function summaryData(person) {
        return { ...person.summary, code: person.employee.code, name: person.employee.name,
          department: person.employee.department?.name ?? '', ot_hours: hours(person.summary.ot_min) };
      }
      function summaryHeight(data) {
        doc.font('Helvetica').fontSize(7.2);
        return Math.max(27, ...columns.map((c) => doc.heightOfString(String(data[c.key] ?? ''), { width: c.span - 8 }) + 10));
      }
      function summaryRow(data, y, h, index, totals = false) {
        doc.rect(left, y, width, h).fill(totals ? COLOURS.pale : index % 2 ? COLOURS.neutral : COLOURS.white);
        let x = left;
        columns.forEach((c) => {
          const numeric = !['code', 'name', 'department'].includes(c.key);
          const colour = c.key === 'lop_days' && data[c.key] > 0 ? COLOURS.red : c.key === 'missing_punch' && data[c.key] > 0 ? COLOURS.amber : COLOURS.ink;
          text(data[c.key], x + 4, y + 5, c.span - 8, { bold: totals || c.key === 'lop_days', size: 7.2, colour, height: h - 8, align: numeric ? 'right' : 'left' });
          x += c.span;
        });
        line(y + h);
      }
      let y = summaryHeader(pageHead('Monthly employee totals | Final LOP after paid leave cover'));
      rows.forEach((person, index) => {
        const data = summaryData(person);
        const h = summaryHeight(data);
        if (y + h > bottom - 32) y = summaryHeader(pageHead('Monthly employee totals | Continued'));
        summaryRow(data, y, h, index);
        y += h;
      });
      const aggregate = { name: 'MONTH TOTAL', ot_hours: hours(report.ot_min) };
      SUMMARY.filter((c) => !['code', 'name', 'department', 'ot_hours'].includes(c.key)).forEach((c) => { aggregate[c.key] = number(rows.reduce((sum, person) => sum + Number(person.summary[c.key] ?? 0), 0)); });
      const h = summaryHeight(aggregate);
      if (y + h > bottom) y = summaryHeader(pageHead('Monthly employee totals | Continued'));
      summaryRow(aggregate, y, h, 0, true);
    }
    const pages = doc.bufferedPageRange();
    for (let page = pages.start; page < pages.start + pages.count; page++) {
      doc.switchToPage(page);
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      text('IST | Amber: missing punch | Red: absent | Blue: leave | Grey: off / future | Late minutes: shift shortfall', left, doc.page.height - 25, width - 85, { colour: COLOURS.muted, size: 7, height: 14 });
      text(`Page ${page + 1} of ${pages.count}`, left + width - 80, doc.page.height - 25, 80, { colour: COLOURS.muted, size: 7, align: 'right', height: 14 });
      doc.page.margins.bottom = margin;
    }
    doc.end();
  });
}
