import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { companyOf, formatYearMonth } from '@ajpwer/shared';
import { AppError, notFound } from '../utils/errors.js';

const C = { ink: '#092733', teal: '#148B80', muted: '#607784', line: '#D7E5E9', pale: '#E8F5F2', amber: '#FFF0CF' };
const amount = (value) => `Rs. ${(Number(value ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (rows) => rows.reduce((total, row) => total + Number(row.amount), 0);
const safePart = (value) => String(value ?? '').normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'employee';
const isAdhocDeduction = (line) => line.kind === 'DEDUCTION' && line.code.startsWith('ADHOC_DED:');

/** Render only explicit, safe snapshot fields; encrypted identity/bank fields never reach a document. */
export function renderPayslipPDF(slip, company) {
  return new Promise((resolve, reject) => {
    const m = slip.meta ?? {};
    const month = formatYearMonth(slip.period.period_ym);
    const provisional = !['LOCKED', 'PAID'].includes(slip.period.state);
    const doc = new PDFDocument({ size: 'A4', margin: 38, bufferPages: true, compress: true,
      info: { Title: `Payslip - ${m.employee?.code ?? ''} - ${month}`, Author: company?.name ?? 'AJPWER Workforce', Subject: provisional ? 'Provisional payslip - payroll is not locked' : 'Final payslip' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const left = 38, width = doc.page.width - left * 2;
    let y = 0;

    function text(value, x, top, span, { bold = false, size = 9, colour = C.ink, align = 'left', height, lineBreak = true } = {}) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(colour)
        .text(String(value ?? ''), x, top, { width: span, ...(height ? { height } : {}), align, lineBreak });
    }
    function head(continued = false) {
      if (continued) doc.addPage();
      doc.rect(0, 0, doc.page.width, 6).fill(C.teal);
      text(company?.name ?? 'AJ Power Engineering', left, 28, width - 160, { bold: true, size: 16 });
      text('PAYSLIP', left + width - 155, 29, 155, { bold: true, size: 13, align: 'right' });
      text(month, left + width - 155, 48, 155, { size: 10, align: 'right' });
      y = 77;
      if (!continued && company?.address) {
        text(company.address, left, 52, width - 170, { size: 8, colour: C.muted, height: 23 });
      }
      if (provisional) {
        doc.roundedRect(left, y, width, 27, 4).fill(C.amber);
        text('PROVISIONAL - This payroll is not locked. A rerun can change these figures.', left + 9, y + 8, width - 18, { bold: true, size: 8 });
        y += 39;
      }
      if (continued) { text(`${m.employee?.name ?? ''} | ${m.employee?.code ?? ''} | continued`, left, y, width, { size: 9, colour: C.muted }); y += 25; }
    }
    function space(height) { if (y + height > doc.page.height - 70) head(true); }
    function note(value, tone = C.muted) {
      doc.font('Helvetica').fontSize(8);
      const h = doc.heightOfString(String(value), { width: width - 18 }) + 14;
      space(h);
      doc.roundedRect(left, y, width, h, 3).fill(C.pale);
      text(value, left + 9, y + 7, width - 18, { size: 8, colour: tone });
      y += h + 9;
    }
    function row(name, value, { bold = false, full } = {}) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      const h = Math.max(20, doc.heightOfString(String(name), { width: width - 190 }) + 7);
      space(h + 3);
      text(name, left + 8, y + 6, width - 190, { bold, size: 9 });
      if (full != null) text(amount(full), left + width - 185, y + 6, 85, { size: 8, colour: C.muted, align: 'right' });
      text(amount(value), left + width - 95, y + 6, 87, { bold, size: 9, align: 'right' });
      y += h;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.4).strokeColor(C.line).stroke();
    }
    function block(number, title, rows, totalLabel) {
      space(52);
      doc.rect(left, y, width, 20).fill(C.pale);
      text(`${number}  ${title.toUpperCase()}`, left + 8, y + 6, width - 16, { bold: true, size: 8, colour: C.teal });
      y += 20;
      if (!rows.length) { text('None', left + 8, y + 5, width - 16, { colour: C.muted }); y += 20; }
      for (const line of rows) row(line.name, line.amount, { full: ['COMPONENT', 'YEARLY'].includes(line.kind) && Number(line.full_amount) !== Number(line.amount) ? line.full_amount : undefined });
      if (totalLabel) row(totalLabel, sum(rows), { bold: true });
      y += 8;
    }

    head();
    const fields = [
      ['Employee', m.employee?.name], ['Employee code', m.employee?.code],
      ['Designation', m.employee?.designation], ['Department', m.department?.name],
      ['Pay group', m.pay_group?.name], ['Joined', m.employee?.joined_on],
      ['UAN', m.ids?.uan], ['ESI number', m.ids?.esi_number],
      ['Bank', m.bank?.last4 ? `XXXXXX${m.bank.last4} ${m.bank.ifsc ?? ''}` : 'Not available'],
      ['Tax regime', m.regime === 'OLD' ? 'Old' : 'New'],
      ['PT state', m.pt_state],
      ['Worked', `${Math.floor(Number(m.attendance?.worked_min ?? 0) / 60)}h ${Number(m.attendance?.worked_min ?? 0) % 60}m`],
    ];
    for (let i = 0; i < fields.length; i += 2) {
      const pair = fields.slice(i, i + 2);
      const span = width / 2 - 12;
      doc.font('Helvetica').fontSize(9);
      const h = Math.max(...pair.map(([label, value]) => doc.heightOfString(`${label}: ${value || '-'}`, { width: span }))) + 10;
      pair.forEach(([label, value], index) => text(`${label}: ${value || '-'}`, left + index * width / 2, y, span));
      y += h;
    }
    y += 7;
    note(`Paid days: ${Number(slip.paid_days)}  |  Loss of pay: ${Number(slip.lop_days)}  |  Divisor: ${slip.divisor}. ${m.lop_rule_text ?? ''}`);
    if (m.held) note('Salary on hold: calculated for this month and paid when it is released.');
    if (m.final_month_ym) note("Final month's salary, paid with the full and final settlement.");

    const lines = slip.lines;
    block(1, 'Gross', lines.filter((line) => ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'LEAVE'].includes(line.kind)), 'Gross salary');
    block(2, 'Employer contributions', lines.filter((line) => line.kind === 'EMPLOYER'), 'Paid by the company on top');
    block(3, 'Employee deductions', lines.filter((line) => line.kind === 'DEDUCTION' && !isAdhocDeduction(line)), 'Total deductions');
    block(4, 'Adhoc additions', lines.filter((line) => ['ADHOC', 'REIMBURSEMENT', 'HELD'].includes(line.kind)));
    block(5, 'Adhoc deductions', lines.filter(isAdhocDeduction));
    space(65);
    doc.roundedRect(left, y, width, 39, 4).fill(C.pale);
    text('6  NET PAY', left + 11, y + 13, width / 2, { bold: true, size: 12, colour: C.teal });
    text(amount(slip.net), left + width / 2, y + 11, width / 2 - 11, { bold: true, size: 15, colour: C.teal, align: 'right' });
    y += 48;
    text(`Cost to company this month: ${amount(slip.ctc_month)}. Grey figures show full amounts before loss of pay.`, left, y, width, { size: 8, colour: C.muted });
    y += 22;
    if (Number(m.ot?.excess_min) > 0) note(`${Math.floor(m.ot.excess_min / 60)}h ${m.ot.excess_min % 60}m of overtime above the monthly cap is unpaid.`);

    const pages = doc.bufferedPageRange();
    for (let page = pages.start; page < pages.start + pages.count; page++) {
      doc.switchToPage(page);
      text(`Computed ${new Date(slip.computed_at).toISOString().slice(0, 10)} | Computer-generated payslip | Page ${page + 1} of ${pages.count}`, left, doc.page.height - 55, width, { size: 7, colour: C.muted, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

/** One consistent snapshot read; PDF generation never recalculates or updates payroll. */
export async function buildPayslipArchive(db, { employeeId, year, ym, company, q }) {
  const source = await db.$transaction(async (tx) => {
    const employee = employeeId ? await tx.employee.findFirst({ where: { id: employeeId, deleted_at: null }, select: { id: true, code: true } }) : null;
    if (employeeId && !employee) throw notFound('That employee');
    const period = ym ? await tx.payrollPeriod.findUnique({ where: { period_ym: ym } }) : null;
    if (ym && !period) throw notFound('That payroll month');
    const slips = await tx.payslip.findMany({
      where: { deleted_at: null, ...(employeeId ? { employee_id: employeeId } : {}),
        period: { state: { in: ['RUN', 'LOCKED', 'PAID'] }, ...(ym ? { period_ym: ym } : { period_ym: { gte: `${year}-01`, lte: `${year}-12` } }) } },
      include: { period: { select: { period_ym: true, state: true } }, lines: { where: { deleted_at: null }, orderBy: { seq: 'asc' } } },
      orderBy: [{ period: { period_ym: 'asc' } }, { employee_id: 'asc' }],
    });
    const search = q?.trim().toLowerCase();
    return { slips: slips.filter((slip) => (!company || companyOf(slip.meta?.employee?.code) === company)
      && (!search || [slip.meta?.employee?.name, slip.meta?.employee?.code].some((value) => String(value ?? '').toLowerCase().includes(search)))), employee,
      company: await tx.company.findFirst() };
  }, { isolationLevel: 'RepeatableRead' });
  if (!source.slips.length) throw new AppError('NO_PAYSLIPS', employeeId ? `No generated payslips are available for ${year}.` : 'No generated payslips are available for this payroll selection. Generate payroll first.', 404);
  const zip = new JSZip();
  const folders = new Map();
  const usedFolders = new Set();
  for (const slip of source.slips) {
    const code = safePart(slip.meta?.employee?.code ?? source.employee?.code ?? slip.employee_id);
    const key = `${slip.employee_id}:${code}`;
    if (!folders.has(key)) {
      let folder = code;
      let suffix = 1;
      // Keep folders readable while resolving any historical/sanitised-code collision.
      while (usedFolders.has(folder)) folder = `${code}_${++suffix}`;
      usedFolders.add(folder);
      folders.set(key, folder);
    }
    const folder = folders.get(key);
    zip.file(`${folder}/${code}-${slip.period.period_ym}.pdf`, await renderPayslipPDF(slip, source.company), { date: new Date(slip.computed_at) });
  }
  const code = source.employee ? `-${safePart(source.employee.code)}` : '';
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    filename: `payslips${code}-${ym ?? year}${company ? `-${company.toLowerCase()}` : ''}.zip`, count: source.slips.length };
}
