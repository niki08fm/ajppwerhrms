import ExcelJS from 'exceljs';
import { addMonths, COMPANIES, companyOf, formatYearMonth } from '@ajpwer/shared';
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

/** A month's payslips, optionally only one company's (told apart by the employee code). */
async function loadSlips(db, periodId, company) {
  const slips = await db.payslip.findMany({
    where: { period_id: periodId },
    include: { lines: { orderBy: { seq: 'asc' } }, employee: { select: { id: true, code: true, name: true } } },
    orderBy: { employee: { code: 'asc' } },
  });
  return company ? slips.filter((s) => companyOf(s.employee.code) === company) : slips;
}

const meta = (s) => s.meta;
const line = (s, code) => s.lines.filter((l) => l.code === code).reduce((a, l) => a + n(l.amount), 0);
const kind = (s, k) => s.lines.filter((l) => l.kind === k).reduce((a, l) => a + n(l.amount), 0);
const base = (s) => ({ code: meta(s).employee.code, name: meta(s).employee.name, employee_id: s.employee_id });

export async function buildReport(db, ym, key, opts) {
  const period = await db.payrollPeriod.findUnique({ where: { period_ym: ym } });
  if (!period || period.state === 'DRAFT') throw new AppError('STEP_NOT_SUBMITTED', `${formatYearMonth(ym)} has not been run yet. Reports are available once it is.`, 409);
  const slips = await loadSlips(db, period.id, opts?.company);
  const company = COMPANIES.find((c) => c.key === opts?.company);
  const title = `${REPORTS.find((r) => r.key === key).label} — ${formatYearMonth(ym)}${company ? ` — ${company.name}` : ''}`;

  switch (key) {
    case 'summary': {
      const full = slips.reduce((a, s) => a + s.lines.filter((l) => l.kind === 'COMPONENT').reduce((b, l) => b + n(l.full_amount), 0), 0);
      const earned = slips.reduce((a, s) => a + kind(s, 'COMPONENT'), 0);
      const yearly = slips.reduce((a, s) => a + kind(s, 'YEARLY'), 0);
      const ot = slips.reduce((a, s) => a + kind(s, 'OT'), 0);
      const off = slips.reduce((a, s) => a + kind(s, 'OFFDAY'), 0);
      const leaveOut = slips.reduce((a, s) => a + kind(s, 'LEAVE'), 0);
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
        { step: 'Leave encashment', amount: leaveOut },
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
    case 'register':
      return registerReport(db, period, slips, { ...opts, title, company });
    case 'bank': {
      const settlements = period.settlement_ids.length ? await db.settlement.findMany({ where: { id: { in: period.settlement_ids } } }) : [];
      const recoverable = [];
      const held = [];
      const separate = [];
      const rows = [];
      for (const s of slips) {
        const m = meta(s);
        const st = settlements.find((x) => x.employee_id === s.employee_id);
        // Held: calculated, not paid until HR releases it.
        if (m.held && !st) {
          held.push({ ...base(s), amount: n(s.net) });
          continue;
        }
        // An F&F paid separately is recorded in this payroll and never in a bank file.
        if (st?.paid_separately) {
          separate.push({ ...base(s), amount: n(st.net), payment_ref: st.paid_separately.payment_ref });
          continue;
        }
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
      const notes = [];
      if (held.length) notes.push(`${held.length} salar${held.length === 1 ? 'y is' : 'ies are'} on hold and not in this file.`);
      if (separate.length) notes.push(`${separate.length} F&F${separate.length === 1 ? ' was' : 's were'} paid separately and ${separate.length === 1 ? 'is' : 'are'} not in this file.`);
      if (recoverable.length) notes.push(`${recoverable.length} settlement(s) are recoverable and are not in this file.`);
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
        notes,
        extra: { recoverable, held, separate },
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
            eps_wage: meta(s).eps_wage ?? Math.min(pfWage, 15_000_00),
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
        .map((s) => ({ ...base(s), ip_number: meta(s).ids.esi_number ?? '', days: Number(s.paid_days), wages: meta(s).esi_wage ?? meta(s).statutory_gross, employee: line(s, 'ESI'), employer: line(s, 'ER_ESI') }));
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
      const prevSlips = prev && prev.state !== 'DRAFT' ? await loadSlips(db, prev.id, opts?.company) : [];
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
          if (kind(p, 'LEAVE') !== kind(s, 'LEAVE')) reasons.push('Leave paid out');
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

// ─── Salary register: the payroll statement layout ───────────────────────────

/** The register's bands, in order, with their header colours (band row, column-header row). */
const REGISTER_GROUPS = [
  { key: 'statement', label: 'Payroll Statement', fill: 'FF2C5282', header: 'FFD9E1F2' },
  { key: 'fixed', label: 'Fixed Salary', fill: 'FF1F5276', header: 'FFBDD7EE' },
  { key: 'attendance', label: 'Attendance Information', fill: 'FF2E75B6', header: 'FFFCE4D6' },
  { key: 'earned', label: 'Earned Salary', fill: 'FF1F5276', header: 'FFE2EFDA' },
  { key: 'deductions', label: 'Deductions', fill: 'FF833C00', header: 'FFFFD7C8' },
  { key: 'bank', label: 'Bank Details', fill: 'FF375623', header: 'FFD4E6C3' },
];

/** Names in the order they first appear on the month's payslips. */
function namesOf(slips, test) {
  const names = [];
  for (const s of slips) for (const l of s.lines) if (test(l) && !names.includes(l.name)) names.push(l.name);
  return names;
}
const sumLines = (s, test) => s.lines.filter(test).reduce((a, l) => a + n(l.amount), 0);
const isComponent = (l) => l.kind === 'COMPONENT';
const isEarnedComponent = (l) => l.kind === 'COMPONENT' || l.kind === 'YEARLY';
const isAdhocDeduction = (l) => l.code.startsWith('ADHOC_DED:');
const isRecovery = (l) => ['LOAN', 'ADVANCE', 'CARRY'].includes(l.code);
const days = (v) => Math.round(v * 100) / 100;

/**
 * One row per person: fixed salary, attendance, earned salary, deductions and bank details.
 * Components and adhoc items get a column each, named as they are in the month; columns a
 * month does not use (VPF, recoveries, off-day pay…) are left out.
 */
async function registerReport(db, period, slips, opts) {
  const fixedNames = namesOf(slips, isComponent);
  const earnedNames = namesOf(slips, isEarnedComponent);
  const earningNames = namesOf(slips, (l) => l.kind === 'ADHOC');
  const deductionNames = namesOf(slips, isAdhocDeduction);
  const reimbursementNames = namesOf(slips, (l) => l.kind === 'REIMBURSEMENT');
  const any = (test) => slips.some((s) => s.lines.some(test));
  const settled = period.settlement_ids.length ? await db.settlement.findMany({ where: { id: { in: period.settlement_ids } } }) : [];

  const col = (group, key, label, extra = {}) => ({ group, key, label, ...extra });
  const money = { money: true };
  const columns = [
    col('statement', 'name', 'Name', { width: 26 }),
    col('statement', 'designation', 'Designation', { width: 22 }),
    col('statement', 'department', 'Department', { width: 18 }),
    col('statement', 'code', 'Employee ID', { mono: true, width: 12 }),
    col('statement', 'uan', 'UAN', { width: 15 }),
    col('statement', 'esi_number', 'ESI Number', { width: 14 }),
    ...fixedNames.map((c) => col('fixed', `fixed:${c}`, c, money)),
    col('fixed', 'fixed_gross', 'Gross Salary', money),
    col('fixed', 'fixed_er_pf', 'Employer PF', money),
    col('fixed', 'fixed_er_esi', 'Employer ESI', money),
    col('fixed', 'fixed_ctc', 'CTC', money),
    col('attendance', 'days_in_month', 'Days in Month', { days: true }),
    col('attendance', 'paid_days', 'Payable Days', { days: true }),
    col('attendance', 'lop_days', 'Loss of Pay Days', { days: true }),
    col('attendance', 'ot_days', 'OT Days', { days: true }),
    ...earnedNames.map((c) => col('earned', `earned:${c}`, c, money)),
    col('earned', 'ot', 'Overtime', money),
    ...(any((l) => l.kind === 'OFFDAY') ? [col('earned', 'offday', 'Off-day Work', money)] : []),
    ...(any((l) => l.kind === 'LEAVE') ? [col('earned', 'leave', 'Leave Encashment', money)] : []),
    ...earningNames.map((a) => col('earned', `adhoc:${a}`, a, money)),
    col('earned', 'gross', 'Gross Earned Salary', money),
    col('deductions', 'pf', 'Employee PF', money),
    ...(any((l) => l.code === 'VPF') ? [col('deductions', 'vpf', 'VPF', money)] : []),
    col('deductions', 'esi', 'Employee ESI', money),
    col('deductions', 'pt', 'Professional Tax', money),
    col('deductions', 'tds', 'TDS', money),
    ...(any(isRecovery) ? [col('deductions', 'recovery', 'Loan / Advance Recovery', money)] : []),
    ...deductionNames.map((a) => col('deductions', `ded:${a}`, a, money)),
    col('deductions', 'total_deductions', 'Total Deductions', money),
    col('deductions', 'net_salary', 'Net Salary', money),
    ...reimbursementNames.map((a) => col('deductions', `reimb:${a}`, a, money)),
    ...(any((l) => l.kind === 'HELD') ? [col('deductions', 'held_released', 'Held Salary Released', money)] : []),
    col('deductions', 'net', 'Net Pay/Bank Transfer', money),
    col('bank', 'bank_name', 'Bank Name', { width: 18 }),
    col('bank', 'account', 'Account Number', { width: 20 }),
    col('bank', 'ifsc', 'IFSC Code', { width: 14 }),
    col('bank', 'account_name', 'Name on the Account', { width: 26 }),
  ];

  const rows = slips.map((s) => {
    const m = meta(s);
    const componentFull = (name) => s.lines.filter((l) => isComponent(l) && l.name === name).reduce((a, l) => a + n(l.full_amount), 0);
    // Payslips from before the fixed figures were stored fall back to the earned month.
    const fixedGross = m.fixed?.gross ?? fixedNames.reduce((a, c) => a + componentFull(c), 0);
    const erPf = m.fixed?.employer_pf ?? line(s, 'ER_EPF') + line(s, 'ER_EPS');
    const erEsi = m.fixed?.employer_esi ?? line(s, 'ER_ESI');
    const st = settled.find((x) => x.employee_id === s.employee_id);
    const r = {
      ...base(s),
      designation: m.employee.designation ?? '',
      department: m.department?.name ?? '',
      uan: m.ids?.uan ?? '',
      esi_number: m.ids?.esi_number ?? '',
      fixed_gross: fixedGross,
      fixed_er_pf: erPf,
      fixed_er_esi: erEsi,
      fixed_ctc: m.fixed?.ctc ?? fixedGross + erPf + erEsi,
      days_in_month: s.divisor,
      paid_days: Number(s.paid_days),
      lop_days: Number(s.lop_days),
      ot_days: m.ot?.paid_min ? days(m.ot.paid_min / 60 / (m.ot.hours_per_day ?? 8)) : 0,
      ot: kind(s, 'OT'),
      offday: kind(s, 'OFFDAY'),
      leave: kind(s, 'LEAVE'),
      gross: n(s.gross),
      pf: line(s, 'PF'),
      vpf: line(s, 'VPF'),
      esi: line(s, 'ESI'),
      pt: line(s, 'PT'),
      tds: line(s, 'TDS'),
      recovery: sumLines(s, isRecovery),
      total_deductions: n(s.total_deductions),
      net_salary: n(s.gross) - n(s.total_deductions),
      held_released: kind(s, 'HELD'),
      net: n(s.net),
      bank_name: m.bank?.name ?? '',
      account: opts.pii && m.bank?.account_enc ? decryptPII(m.bank.account_enc) : m.bank?.last4 ? `XXXXXX${m.bank.last4}` : '',
      ifsc: m.bank?.ifsc ?? '',
      // The account holder's name is not recorded separately; salary accounts are in the employee's name.
      account_name: m.employee.name,
      payment: m.held
        ? 'On hold'
        : st
          ? `F&F${st.paid_separately ? ', paid separately' : ''}${m.final_month_ym ? ` (final month ${formatYearMonth(m.final_month_ym)})` : ''}`
          : 'Bank',
    };
    for (const c of fixedNames) r[`fixed:${c}`] = componentFull(c);
    for (const c of earnedNames) r[`earned:${c}`] = sumLines(s, (l) => isEarnedComponent(l) && l.name === c);
    for (const a of earningNames) r[`adhoc:${a}`] = sumLines(s, (l) => l.kind === 'ADHOC' && l.name === a);
    for (const a of deductionNames) r[`ded:${a}`] = sumLines(s, (l) => isAdhocDeduction(l) && l.name === a);
    for (const a of reimbursementNames) r[`reimb:${a}`] = sumLines(s, (l) => l.kind === 'REIMBURSEMENT' && l.name === a);
    return r;
  });
  rows.sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  // Held pay and settlements change how a row is paid; show it only when a month has them.
  if (rows.some((r) => r.payment !== 'Bank')) columns.push(col('bank', 'payment', 'Payment', { width: 16 }));

  // A one-row header (on screen, CSV) needs fixed and earned columns told apart: "Fixed Basic" beside "Basic".
  for (const c of columns) if (c.group === 'fixed') c.flat_label = `Fixed ${c.label}`;
  const totals = { code: '', name: 'TOTAL' };
  for (const c of columns) if (c.money) totals[c.key] = rows.reduce((a, r) => a + r[c.key], 0);
  const companyName = opts.company?.name ?? (await db.company.findFirst())?.name ?? 'Company';
  return {
    key: 'register',
    title: opts.title,
    layout: 'register',
    ym: period.period_ym,
    groups: REGISTER_GROUPS.filter((g) => columns.some((c) => c.group === g.key)),
    columns,
    rows,
    totals,
    pii: true,
    file_name: `Payroll_${companyName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_${period.period_ym}`,
  };
}

const columnLetter = (index) => {
  let s = '';
  for (let i = index; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};
const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/** Two header rows (bands, then column names), one row per person and a TOTAL row of sums. */
async function registerXLSX(r) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AJPWER Workforce';
  const ws = wb.addWorksheet('Salary Sheet');
  ws.columns = r.columns.map((c) => ({ key: c.key, width: c.width ?? Math.max(12, Math.min(20, c.label.length + 4)) }));
  const groupOf = (key) => REGISTER_GROUPS.find((g) => g.key === key);
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

  // Row 1: month and year over the first two columns, then each band merged across its columns.
  const [year, month] = r.ym.split('-').map(Number);
  const band = ws.getRow(1);
  band.height = 22;
  const white = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
  for (const [i, value] of [[1, MONTHS[month - 1]], [2, year]]) {
    Object.assign(band.getCell(i), { value, font: white, fill: fill('FF1B3A5C'), alignment: { horizontal: 'center', vertical: 'middle' } });
  }
  for (const g of r.groups) {
    const indexes = r.columns.map((c, i) => (c.group === g.key ? i + 1 : null)).filter(Boolean);
    // The first band starts after the month and year cells.
    const from = Math.max(indexes[0], g.key === 'statement' ? 3 : 1);
    const to = indexes[indexes.length - 1];
    if (from > to) continue;
    for (let i = from; i <= to; i++) Object.assign(band.getCell(i), { font: white, fill: fill(g.fill), alignment: { horizontal: 'center', vertical: 'middle' } });
    band.getCell(from).value = g.label;
    if (to > from) ws.mergeCells(1, from, 1, to);
  }

  // Row 2: column names.
  const header = ws.getRow(2);
  header.height = 30;
  r.columns.forEach((c, i) => {
    Object.assign(header.getCell(i + 1), {
      value: c.label,
      font: { bold: true, size: 9, name: 'Calibri' },
      fill: fill(groupOf(c.group).header),
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
      border: BORDER,
    });
  });

  const cellValue = (c, row) => {
    const v = row[c.key];
    if (c.money) return Number(v ?? 0) / 100;
    if (c.days) return v ? v : null;
    return v ?? '';
  };
  const style = (cell, c) => {
    cell.border = BORDER;
    if (c.money) Object.assign(cell, { numFmt: '#,##0.00', alignment: { horizontal: 'right', vertical: 'middle' } });
    else if (c.days) cell.alignment = { horizontal: 'center', vertical: 'middle' };
    else cell.alignment = { vertical: 'middle' };
  };
  for (const row of r.rows) {
    const added = ws.addRow(r.columns.map((c) => cellValue(c, row)));
    r.columns.forEach((c, i) => style(added.getCell(i + 1), c));
  }

  // TOTAL: a sum of each money column, with the computed figure cached for viewers that do not recalculate.
  const first = 3;
  const last = 2 + r.rows.length;
  const total = ws.addRow(r.columns.map((c, i) => {
    if (i === 0) return 'TOTAL';
    if (!c.money) return '';
    const letter = columnLetter(i + 1);
    return r.rows.length ? { formula: `SUM(${letter}${first}:${letter}${last})`, result: Number(r.totals[c.key] ?? 0) / 100 } : 0;
  }));
  total.height = 18;
  r.columns.forEach((c, i) => {
    const cell = total.getCell(i + 1);
    style(cell, c);
    Object.assign(cell, { font: { bold: true, size: 11, name: 'Calibri' }, fill: fill('FFE2EFDA') });
  });

  // Names and IDs stay in view while scrolling across; both header rows stay in view down.
  ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 2 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
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
  const cols = r.columns.map((c) => (c.flat_label ? { ...c, label: c.flat_label } : c));
  if (!cols.some((c) => c.key === 'code') && r.rows[0] && 'code' in r.rows[0]) cols.unshift({ key: 'code', label: 'Employee code' });
  return toCSV(rows, cols);
}

export async function reportXLSX(r) {
  if (r.layout === 'register') return registerXLSX(r);
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
