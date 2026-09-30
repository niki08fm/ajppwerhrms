import ExcelJS from 'exceljs';
import { addMonths, formatYearMonth } from '@ajpwer/shared';
import { decryptPII } from '../utils/crypto.js';
import { n } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { rupeesOut, toCSV } from '../utils/list.js';

export const REPORTS = [
  { key: 'summary', label: 'Summary' },
  { key: 'payslips', label: 'Payslips' },
  { key: 'register', label: 'Salary register' },
  { key: 'bank', label: 'Bank transfer' },
  { key: 'pf', label: 'PF (ECR)' },
  { key: 'esi', label: 'ESI' },
  { key: 'pt', label: 'Professional tax' },
  { key: 'tds', label: 'Income tax' },
  { key: 'department', label: 'By department' },
  { key: 'change', label: 'Change vs last month' },
  { key: 'settlements', label: 'Settlements' },
  { key: 'adhoc', label: 'Adhoc' },
];

async function loadSlips(db, periodId) {
  return db.payslip.findMany({
    where: { period_id: periodId },
    include: { lines: { orderBy: { seq: 'asc' } }, employee: { select: { id: true, code: true, name: true } } },
    orderBy: { employee: { code: 'asc' } },
  });
}

const meta = (s) => s.meta;
const line = (s, code) => s.lines.filter((l) => l.code === code).reduce((a, l) => a + n(l.amount), 0);
const kind = (s, k) => s.lines.filter((l) => l.kind === k).reduce((a, l) => a + n(l.amount), 0);
const base = (s) => ({ code: meta(s).employee.code, name: meta(s).employee.name, employee_id: s.employee_id });

export async function buildReport(db, ym, key, opts) {
  const period = await db.payrollPeriod.findUnique({ where: { period_ym: ym } });
  if (!period || period.state === 'DRAFT') throw new AppError('STEP_NOT_SUBMITTED', `${formatYearMonth(ym)} has not been run yet. Reports are available once it is.`, 409);
  const slips = await loadSlips(db, period.id);
  const title = `${REPORTS.find((r) => r.key === key).label} — ${formatYearMonth(ym)}`;

  switch (key) {
    case 'summary': {
      const full = slips.reduce((a, s) => a + s.lines.filter((l) => l.kind === 'COMPONENT').reduce((b, l) => b + n(l.full_amount), 0), 0);
      const earned = slips.reduce((a, s) => a + kind(s, 'COMPONENT'), 0);
      const yearly = slips.reduce((a, s) => a + kind(s, 'YEARLY'), 0);
      const ot = slips.reduce((a, s) => a + kind(s, 'OT'), 0);
      const off = slips.reduce((a, s) => a + kind(s, 'OFFDAY'), 0);
      const adhoc = slips.reduce((a, s) => a + kind(s, 'ADHOC'), 0);
      const gross = slips.reduce((a, s) => a + n(s.gross), 0);
      const sumCode = (c) => slips.reduce((a, s) => a + line(s, c), 0);
      const recov = slips.reduce((a, s) => a + s.lines.filter((l) => ['LOAN', 'ADVANCE', 'CARRY'].includes(l.code)).reduce((b, l) => b + n(l.amount), 0), 0);
      const adhocDed = slips.reduce((a, s) => a + s.lines.filter((l) => l.code.startsWith('ADHOC_DED:')).reduce((b, l) => b + n(l.amount), 0), 0);
      const reimb = slips.reduce((a, s) => a + n(s.reimbursements), 0);
      const net = slips.reduce((a, s) => a + n(s.net), 0);
      const employer = slips.reduce((a, s) => a + n(s.employer_total), 0);
      const bridge = [
        { step: 'Full salary', amount: full },
        { step: 'Loss of pay', amount: earned - full },
        { step: 'Yearly components', amount: yearly },
        { step: 'Overtime', amount: ot },
        { step: 'Off-day work', amount: off },
        { step: 'Adhoc earnings', amount: adhoc },
        { step: 'Gross', amount: gross, total: true },
        { step: 'Provident fund', amount: -(sumCode('PF') + sumCode('VPF')) },
        { step: 'ESI', amount: -sumCode('ESI') },
        { step: 'Professional tax', amount: -sumCode('PT') },
        { step: 'Income tax', amount: -sumCode('TDS') },
        { step: 'Loan and advance recovery', amount: -recov },
        { step: 'Adhoc deductions', amount: -adhocDed },
        { step: 'Reimbursements', amount: reimb },
        { step: 'Net pay', amount: net, total: true },
      ];
      return {
        key,
        title,
        columns: [
          { key: 'step', label: 'Step' },
          { key: 'amount', label: 'Amount', money: true },
        ],
        rows: bridge,
        extra: {
          headcount: slips.length,
          gross,
          net,
          employer,
          ctc: gross + employer - adhoc,
          state: period.state,
          run_at: period.run_at,
          statutory_rates_id: period.statutory_rates_id,
          engine_version: slips[0]?.engine_version ?? null,
        },
      };
    }
    case 'payslips':
      return {
        key,
        title,
        columns: [
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Name' },
          { key: 'department', label: 'Department' },
          { key: 'paid_days', label: 'Paid days' },
          { key: 'gross', label: 'Gross', money: true },
          { key: 'deductions', label: 'Deductions', money: true },
          { key: 'reimbursements', label: 'Reimbursements', money: true },
          { key: 'net', label: 'Net', money: true },
        ],
        rows: slips.map((s) => ({
          ...base(s),
          department: meta(s).department.name,
          paid_days: Number(s.paid_days),
          gross: n(s.gross),
          deductions: n(s.total_deductions),
          reimbursements: n(s.reimbursements),
          net: n(s.net),
        })),
      };
    case 'register': {
      const compNames = [];
      for (const s of slips) for (const l of s.lines) if ((l.kind === 'COMPONENT' || l.kind === 'YEARLY') && !compNames.includes(l.name)) compNames.push(l.name);
      const columns = [
        { key: 'code', label: 'Code', mono: true },
        { key: 'name', label: 'Name' },
        { key: 'paid_days', label: 'Paid days' },
        ...compNames.map((c) => ({ key: `c:${c}`, label: c, money: true })),
        { key: 'ot', label: 'Overtime', money: true },
        { key: 'offday', label: 'Off-day', money: true },
        { key: 'gross_salary', label: 'Gross', money: true },
        { key: 'er', label: 'Employer contributions', money: true },
        { key: 'pf', label: 'PF', money: true },
        { key: 'vpf', label: 'VPF', money: true },
        { key: 'esi', label: 'ESI', money: true },
        { key: 'pt', label: 'PT', money: true },
        { key: 'tds', label: 'TDS', money: true },
        { key: 'recovery', label: 'Loan / advance', money: true },
        { key: 'adhoc_add', label: 'Adhoc additions', money: true },
        { key: 'adhoc_ded', label: 'Adhoc deductions', money: true },
        { key: 'net', label: 'Net pay', money: true },
      ];
      const rows = slips.map((s) => {
        const r = { ...base(s), paid_days: Number(s.paid_days) };
        for (const c of compNames) r[`c:${c}`] = s.lines.filter((l) => (l.kind === 'COMPONENT' || l.kind === 'YEARLY') && l.name === c).reduce((a, l) => a + n(l.amount), 0);
        r.ot = kind(s, 'OT');
        r.offday = kind(s, 'OFFDAY');
        r.gross_salary = n(s.salary_gross);
        r.er = n(s.employer_total);
        r.pf = line(s, 'PF');
        r.vpf = line(s, 'VPF');
        r.esi = line(s, 'ESI');
        r.pt = line(s, 'PT');
        r.tds = line(s, 'TDS');
        r.recovery = s.lines.filter((l) => ['LOAN', 'ADVANCE', 'CARRY'].includes(l.code)).reduce((a, l) => a + n(l.amount), 0);
        r.adhoc_add = kind(s, 'ADHOC') + kind(s, 'REIMBURSEMENT');
        r.adhoc_ded = s.lines.filter((l) => l.code.startsWith('ADHOC_DED:')).reduce((a, l) => a + n(l.amount), 0);
        r.net = n(s.net);
        return r;
      });
      const totals = { code: '', name: 'Total' };
      for (const c of columns) if (c.money) totals[c.key] = rows.reduce((a, r) => a + r[c.key], 0);
      return { key, title, columns, rows, totals };
    }
    case 'bank': {
      const settlements = period.settlement_ids.length ? await db.settlement.findMany({ where: { id: { in: period.settlement_ids } } }) : [];
      const recoverable = [];
      const rows = [];
      for (const s of slips) {
        const m = meta(s);
        const st = settlements.find((x) => x.employee_id === s.employee_id);
        // A settling leaver is paid the settlement's payable (which includes the final month). Negative never enters the file.
        const amount = st ? Math.max(0, n(st.net)) : n(s.net);
        if (st && n(st.net) < 0) {
          recoverable.push({ ...base(s), recoverable: -n(st.net) });
          continue;
        }
        if (amount <= 0) continue;
        rows.push({
          ...base(s),
          account: opts.pii ? decryptPII(m.bank.account_enc) : m.bank.last4 ? `XXXXXX${m.bank.last4}` : '',
          ifsc: m.bank.ifsc,
          bank: m.bank.name,
          amount,
          type: st ? 'Settlement' : 'Salary',
        });
      }
      return {
        key,
        title,
        pii: true,
        columns: [
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Beneficiary' },
          { key: 'account', label: 'Account', mono: true },
          { key: 'ifsc', label: 'IFSC', mono: true },
          { key: 'bank', label: 'Bank' },
          { key: 'type', label: 'Type' },
          { key: 'amount', label: 'Amount', money: true },
        ],
        rows,
        totals: { name: `${rows.length} payees`, amount: rows.reduce((a, r) => a + r.amount, 0) },
        notes: recoverable.length ? [`${recoverable.length} settlement(s) are recoverable and are not in this file.`] : [],
        extra: { recoverable },
      };
    }
    case 'pf': {
      const rows = slips
        .filter((s) => line(s, 'PF') > 0)
        .map((s) => {
          const pfWage = n(s.pf_wage);
          return {
            ...base(s),
            uan: meta(s).ids.uan ?? '',
            gross_wages: n(s.salary_gross),
            pf_wage: pfWage,
            eps_wage: Math.min(pfWage, 15_000_00),
            employee: line(s, 'PF') + line(s, 'VPF'),
            employer_epf: line(s, 'ER_EPF'),
            eps: line(s, 'ER_EPS'),
            // EDLI and admin are paid with the challan but are not company contributions on the payslip
            // (engine 1.2.0 on); payslips from earlier engines carry them as lines.
            edli: meta(s).pf_charges?.edli ?? line(s, 'ER_EDLI'),
            admin: meta(s).pf_charges?.admin ?? line(s, 'ER_ADMIN'),
            ncp_days: Number(s.lop_days),
          };
        });
      const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
      const challan = sum('employee') + sum('employer_epf') + sum('eps') + sum('edli') + sum('admin');
      return {
        key,
        title,
        columns: [
          { key: 'uan', label: 'UAN', mono: true },
          { key: 'name', label: 'Member name' },
          { key: 'gross_wages', label: 'Gross wages', money: true },
          { key: 'pf_wage', label: 'EPF wages', money: true },
          { key: 'eps_wage', label: 'EPS wages', money: true },
          { key: 'employee', label: 'Employee EPF', money: true },
          { key: 'employer_epf', label: 'Employer EPF', money: true },
          { key: 'eps', label: 'EPS', money: true },
          { key: 'edli', label: 'EDLI', money: true },
          { key: 'admin', label: 'Admin', money: true },
          { key: 'ncp_days', label: 'NCP days' },
        ],
        rows,
        totals: { name: 'Total challan', employee: sum('employee'), employer_epf: sum('employer_epf'), eps: sum('eps'), edli: sum('edli'), admin: sum('admin'), challan },
        notes: [`Total challan including admin: ₹${(challan / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      };
    }
    case 'esi': {
      const rows = slips
        .filter((s) => s.esi_applicable)
        .map((s) => ({ ...base(s), ip_number: meta(s).ids.esi_number ?? '', days: Number(s.paid_days), wages: meta(s).statutory_gross, employee: line(s, 'ESI'), employer: line(s, 'ER_ESI') }));
      const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
      return {
        key,
        title,
        columns: [
          { key: 'ip_number', label: 'IP number', mono: true },
          { key: 'name', label: 'Insured person' },
          { key: 'days', label: 'Days' },
          { key: 'wages', label: 'Wages', money: true },
          { key: 'employee', label: 'Employee 0.75%', money: true },
          { key: 'employer', label: 'Employer 3.25%', money: true },
        ],
        rows,
        totals: { name: `${rows.length} insured`, wages: sum('wages'), employee: sum('employee'), employer: sum('employer') },
      };
    }
    case 'pt': {
      const rows = slips.filter((s) => line(s, 'PT') > 0).map((s) => ({ ...base(s), state: meta(s).pt_state, gross: meta(s).statutory_gross, pt: line(s, 'PT') }));
      rows.sort((a, b) => a.state.localeCompare(b.state) || a.code.localeCompare(b.code));
      const byState = [...new Set(rows.map((r) => r.state))].map((st) => ({
        state: st,
        people: rows.filter((r) => r.state === st).length,
        amount: rows.filter((r) => r.state === st).reduce((a, r) => a + r.pt, 0),
      }));
      return {
        key,
        title,
        columns: [
          { key: 'state', label: 'State' },
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Name' },
          { key: 'gross', label: 'Gross', money: true },
          { key: 'pt', label: 'Professional tax', money: true },
        ],
        rows,
        notes: ['Each state is a separate remittance.'],
        extra: { by_state: byState },
      };
    }
    case 'tds':
      return {
        key,
        title,
        pii: true,
        columns: [
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Name' },
          { key: 'pan', label: 'PAN', mono: true },
          { key: 'regime', label: 'Regime' },
          { key: 'gross', label: 'Gross', money: true },
          { key: 'tds', label: 'TDS', money: true },
        ],
        rows: slips.map((s) => {
          const pan = decryptPII(meta(s).ids.pan_enc);
          return { ...base(s), pan: pan ? (opts.pii ? pan : `${pan.slice(0, 2)}XXX${pan.slice(5)}`) : 'PAN missing', regime: meta(s).regime, gross: n(s.gross), tds: line(s, 'TDS') };
        }),
      };
    case 'department': {
      const depts = new Map();
      for (const s of slips) {
        const d = meta(s).department.name;
        const row = depts.get(d) ?? { department: d, people: 0, gross: 0, net: 0, employer: 0, ctc: 0 };
        row.people++;
        row.gross += n(s.gross);
        row.net += n(s.net);
        row.employer += n(s.employer_total);
        row.ctc += n(s.ctc_month);
        depts.set(d, row);
      }
      const rows = [...depts.values()].sort((a, b) => b.ctc - a.ctc);
      return {
        key,
        title,
        columns: [
          { key: 'department', label: 'Department' },
          { key: 'people', label: 'People' },
          { key: 'gross', label: 'Gross', money: true },
          { key: 'net', label: 'Net', money: true },
          { key: 'employer', label: 'Employer statutory', money: true },
          { key: 'ctc', label: 'Cost to company', money: true },
        ],
        rows,
      };
    }
    case 'change': {
      const prevYm = addMonths(ym, -1);
      const prev = await db.payrollPeriod.findUnique({ where: { period_ym: prevYm } });
      const prevSlips = prev && prev.state !== 'DRAFT' ? await loadSlips(db, prev.id) : [];
      const rows = [];
      for (const s of slips) {
        const p = prevSlips.find((x) => x.employee_id === s.employee_id);
        const delta = n(s.net) - (p ? n(p.net) : 0);
        if (Math.abs(delta) < 500_00) continue;
        const reasons = [];
        if (!p) reasons.push('Not paid last month (joiner or held back)');
        else {
          if (Number(p.paid_days) !== Number(s.paid_days)) reasons.push(`Paid days ${Number(p.paid_days)} → ${Number(s.paid_days)}`);
          if (kind(p, 'OT') !== kind(s, 'OT')) reasons.push('Overtime changed');
          if (kind(p, 'OFFDAY') !== kind(s, 'OFFDAY')) reasons.push('Off-day work changed');
          if (meta(p).salary.monthly_gross !== meta(s).salary.monthly_gross) reasons.push('Salary revised');
          if (kind(p, 'ADHOC') + kind(p, 'YEARLY') !== kind(s, 'ADHOC') + kind(s, 'YEARLY')) reasons.push('One-off pay');
          if (n(p.reimbursements) !== n(s.reimbursements)) reasons.push('Reimbursement');
          const rec = (x) => x.lines.filter((l) => ['LOAN', 'ADVANCE', 'CARRY'].includes(l.code)).reduce((a, l) => a + n(l.amount), 0);
          if (rec(p) !== rec(s)) reasons.push('Loan or advance recovery changed');
          if (line(p, 'TDS') !== line(s, 'TDS')) reasons.push('Income tax changed');
          if (!reasons.length) reasons.push('Statutory or rounding');
        }
        rows.push({ ...base(s), last: p ? n(p.net) : 0, now: n(s.net), delta, reason: reasons.join('; ') });
      }
      for (const p of prevSlips)
        if (!slips.some((s) => s.employee_id === p.employee_id)) rows.push({ ...base(p), last: n(p.net), now: 0, delta: -n(p.net), reason: 'Not in this run (left, or held back)' });
      rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      return {
        key,
        title,
        columns: [
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Name' },
          { key: 'last', label: formatYearMonth(prevYm), money: true },
          { key: 'now', label: formatYearMonth(ym), money: true },
          { key: 'delta', label: 'Change', money: true },
          { key: 'reason', label: 'Why' },
        ],
        rows,
        notes: ['Everyone whose net moved by ₹500 or more. Read this before locking.'],
      };
    }
    case 'settlements': {
      const rows = period.settlement_ids.length
        ? (await db.settlement.findMany({ where: { id: { in: period.settlement_ids } }, include: { employee: { select: { id: true, code: true, name: true } } } })).map((s) => ({
            code: s.employee.code,
            name: s.employee.name,
            employee_id: s.employee.id,
            last_day: s.last_day.toISOString().slice(0, 10),
            earnings: n(s.total_earnings),
            deductions: n(s.total_deductions),
            net: n(s.net),
            state: n(s.net) < 0 ? 'Recoverable' : s.state,
          }))
        : [];
      return {
        key,
        title,
        columns: [
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Name' },
          { key: 'last_day', label: 'Last day' },
          { key: 'earnings', label: 'Earnings', money: true },
          { key: 'deductions', label: 'Deductions', money: true },
          { key: 'net', label: 'Net', money: true },
          { key: 'state', label: 'State' },
        ],
        rows,
      };
    }
    case 'adhoc': {
      const rows = [];
      for (const s of slips) {
        for (const l of s.lines) {
          if (l.kind === 'ADHOC' || l.kind === 'REIMBURSEMENT' || l.code.startsWith('ADHOC_DED:')) {
            rows.push({
              ...base(s),
              item: l.name,
              kind: l.kind === 'ADHOC' ? 'Earning' : l.kind === 'REIMBURSEMENT' ? 'Reimbursement' : 'Deduction',
              taxable: l.is_taxable ? 'Taxable' : 'Exempt',
              amount: n(l.amount),
            });
          }
        }
      }
      return {
        key,
        title,
        columns: [
          { key: 'item', label: 'Item' },
          { key: 'kind', label: 'Kind' },
          { key: 'taxable', label: 'Tax' },
          { key: 'code', label: 'Code', mono: true },
          { key: 'name', label: 'Name' },
          { key: 'amount', label: 'Amount', money: true },
        ],
        rows,
      };
    }
  }
}

function plain(r) {
  return r.rows.map((row) => {
    const o = {};
    for (const c of r.columns) o[c.key] = c.money ? rupeesOut(row[c.key]) : row[c.key];
    return o;
  });
}

export function reportCSV(r) {
  const rows = plain(r);
  if (r.totals) {
    const t = {};
    for (const c of r.columns) t[c.key] = c.money && typeof r.totals[c.key] === 'number' ? rupeesOut(r.totals[c.key]) : (r.totals[c.key] ?? '');
    rows.push(t);
  }
  const cols = [...r.columns];
  if (!cols.some((c) => c.key === 'code') && r.rows[0] && 'code' in r.rows[0]) cols.unshift({ key: 'code', label: 'Employee code' });
  return toCSV(rows, cols);
}

export async function reportXLSX(r) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AJPWER Workforce';
  const ws = wb.addWorksheet(r.key);
  ws.columns = r.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 2), style: c.money ? { numFmt: '#,##,##0.00' } : undefined }));
  for (const row of r.rows) {
    const o = {};
    for (const c of r.columns) o[c.key] = c.money ? Number(row[c.key] ?? 0) / 100 : row[c.key];
    ws.addRow(o);
  }
  if (r.totals) {
    const o = {};
    for (const c of r.columns) o[c.key] = c.money && typeof r.totals[c.key] === 'number' ? r.totals[c.key] / 100 : r.totals[c.key];
    const tr = ws.addRow(o);
    tr.font = { bold: true };
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
