import { addMonths, COMPANIES, companyOf, formatYearMonth, lastOfMonth, ymOf } from '@ajpwer/shared';
import { n, toDbDate, fromDbDate } from '../utils/dbDates.js';
import { AppError } from '../utils/errors.js';
import { buildReport } from './reports.service.js';

/*
 * Reports over a period of months: every monthly payroll report added up across the months
 * chosen, plus reports that only make sense over a period (month by month, joiners, exits,
 * overtime hours). Figures come from the saved payroll of each month, as the monthly reports do;
 * a month never run is listed as missing, not estimated.
 */

export const PERIOD_REPORTS = [
  { key: 'summary', label: 'Summary', group: 'Payroll' },
  { key: 'trend', label: 'Month by month', group: 'Payroll' },
  { key: 'payslips', label: 'Pay by employee', group: 'Payroll' },
  { key: 'register', label: 'Salary register', group: 'Payroll' },
  { key: 'bank', label: 'Bank transfers', group: 'Payroll' },
  { key: 'pf', label: 'PF (ECR)', group: 'Statutory' },
  { key: 'esi', label: 'ESI', group: 'Statutory' },
  { key: 'pt', label: 'Professional tax', group: 'Statutory' },
  { key: 'tds', label: 'Income tax (TDS)', group: 'Statutory' },
  { key: 'joiners', label: 'Joiners', group: 'People' },
  { key: 'exits', label: 'Exits', group: 'People' },
  { key: 'overtime', label: 'Overtime hours', group: 'People' },
  { key: 'revisions', label: 'Salary revisions', group: 'People' },
  { key: 'department', label: 'By department', group: 'Analysis' },
  { key: 'settlements', label: 'Settlements', group: 'Analysis' },
  { key: 'adhoc', label: 'One-time adjustments', group: 'Analysis' },
];

const MAX_MONTHS = 36;

/** The months from `from` to `to`, inclusive. */
export function monthsBetween(from, to) {
  const out = [];
  for (let m = from; m <= to && out.length <= MAX_MONTHS; m = addMonths(m, 1)) out.push(m);
  return out;
}

function periodLabel(from, to) {
  return from === to ? formatYearMonth(from) : `${formatYearMonth(from)} – ${formatYearMonth(to)}`;
}

/** A row's identity when the same report is added up over months. */
const rowKey = (r) => [r.employee_id ?? r.code ?? r.uan ?? r.ip_number ?? r.department ?? '', r.state ?? '', r.item ?? '', r.kind ?? '', r.type ?? '', r.last_day ?? ''].join('|');

/**
 * Add up the same report over several months. Money and day columns are summed per row; text
 * (names, designations, bank details) comes from the latest month the row appears in. Columns
 * are the union of every month's, in the latest month's order, grouped as the register groups them.
 */
export function combineReports(reports, { withMonths = true } = {}) {
  const latestFirst = [...reports].reverse();
  const columns = [];
  const seen = new Set();
  for (const r of latestFirst) for (const c of r.columns) if (!seen.has(c.key)) { seen.add(c.key); columns.push({ ...c }); }
  // Keep register-style groups together, in the order they first appear.
  if (columns.some((c) => c.group)) {
    const order = [...new Set(columns.map((c) => c.group))];
    columns.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  }
  const numeric = new Set(columns.filter((c) => c.money || c.days || reports.some((r) => r.rows.some((row) => typeof row[c.key] === 'number'))).map((c) => c.key));
  const rows = new Map();
  for (const r of reports) {
    for (const row of r.rows) {
      const id = rowKey(row);
      const cur = rows.get(id);
      if (!cur) {
        rows.set(id, { ...row, months: 1 });
        continue;
      }
      for (const [k, v] of Object.entries(row)) {
        if (numeric.has(k)) cur[k] = Math.round(((cur[k] ?? 0) + (typeof v === 'number' ? v : 0)) * 100) / 100;
        else if (v !== undefined && v !== null && v !== '') cur[k] = v;
      }
      cur.months += 1;
    }
  }
  const out = [...rows.values()];
  for (const row of out) for (const k of numeric) if (row[k] === undefined) row[k] = 0;
  if (withMonths && out.some((r) => r.employee_id || r.code)) {
    const at = Math.max(0, columns.findIndex((c) => c.key === 'name')) + 1;
    columns.splice(at, 0, { key: 'months', label: 'Months', ...(columns[at - 1]?.group ? { group: columns[at - 1].group } : {}) });
  }
  // Totals: every month's totals added up; a count in the label becomes the row count.
  let totals;
  const monthly = reports.map((r) => r.totals).filter(Boolean);
  if (monthly.length) {
    totals = {};
    for (const t of monthly) for (const [k, v] of Object.entries(t)) totals[k] = typeof v === 'number' ? (totals[k] ?? 0) + v : v;
    for (const [k, v] of Object.entries(totals)) if (typeof v === 'string' && /^\d+ /.test(v)) totals[k] = v.replace(/^\d+/, String(out.length)).replace(/^1 (\w+)s\b/, '1 $1');
  }
  return { columns, rows: out, totals };
}

async function runMonths(db, from, to) {
  const months = monthsBetween(from, to);
  const periods = await db.payrollPeriod.findMany({ where: { period_ym: { in: months }, deleted_at: null, state: { not: 'DRAFT' } }, orderBy: { period_ym: 'asc' } });
  const ran = periods.map((p) => p.period_ym);
  return {
    months,
    periods,
    coverage: {
      from,
      to,
      months: months.length,
      included: periods.map((p) => ({ ym: p.period_ym, state: p.state })),
      missing: months.filter((m) => !ran.includes(m)),
      provisional: periods.filter((p) => p.state === 'RUN').map((p) => p.period_ym),
    },
  };
}

async function periodSlips(db, periods, company) {
  if (!periods.length) return [];
  const slips = await db.payslip.findMany({
    where: { period_id: { in: periods.map((p) => p.id) } },
    include: { lines: true, period: { select: { period_ym: true } } },
    orderBy: { employee_id: 'asc' },
  });
  return company ? slips.filter((s) => companyOf(s.meta.employee.code) === company) : slips;
}

const sumKind = (s, k) => s.lines.filter((l) => l.kind === k).reduce((a, l) => a + n(l.amount), 0);
const hours = (min) => Math.round((min / 60) * 100) / 100;
const count = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/**
 * Build a report over `from`–`to` (YYYY-MM, inclusive). Payroll reports add up the saved
 * payroll of each month run; people reports read joining and exit dates.
 */
export async function buildPeriodReport(db, from, to, key, opts = {}) {
  if (!PERIOD_REPORTS.some((r) => r.key === key)) throw new AppError('NOT_FOUND', 'That report was not found.', 404);
  if (from > to) throw new AppError('VALIDATION', 'The first month must not be after the last.', 422, 'from');
  if (monthsBetween(from, to).length > MAX_MONTHS) throw new AppError('VALIDATION', `Choose at most ${MAX_MONTHS} months.`, 422, 'from');
  const company = COMPANIES.find((c) => c.key === opts.company);
  const label = PERIOD_REPORTS.find((r) => r.key === key).label;
  const title = `${label} — ${periodLabel(from, to)}${company ? ` — ${company.name}` : ''}`;
  const { periods, coverage } = await runMonths(db, from, to);
  const head = { key, title, period: { from, to, label: periodLabel(from, to) }, coverage };
  const note = coverage.missing.length
    ? `${coverage.missing.length} month${coverage.missing.length === 1 ? '' : 's'} in this period ${coverage.missing.length === 1 ? 'has' : 'have'} no payroll run and ${coverage.missing.length === 1 ? 'is' : 'are'} not included: ${coverage.missing.map(formatYearMonth).join(', ')}.`
    : null;
  const provisional = coverage.provisional.length ? `${coverage.provisional.map(formatYearMonth).join(', ')} ${coverage.provisional.length === 1 ? 'is' : 'are'} generated but not locked yet; figures can still change.` : null;
  const baseNotes = [note, provisional].filter(Boolean);

  // People reports: from employee records, whether or not payroll ran.
  if (key === 'joiners' || key === 'exits') return { ...head, ...(await peopleReport(db, from, to, key, company)), notes: [] };
  if (key === 'revisions') return { ...head, ...(await revisionsReport(db, from, to, company)), notes: ['Salary changes that take effect in the period. A joining salary is not a revision; restating an agreement with pay unchanged is left out.'] };

  if (!periods.length) return { ...head, columns: [], rows: [], notes: [note ?? 'No payroll has been run in this period.'], empty: true };

  switch (key) {
    case 'summary': {
      const monthly = await Promise.all(periods.map((p) => buildReport(db, p.period_ym, 'summary', opts)));
      const rows = monthly[0].rows.map((step, i) => ({ ...step, amount: monthly.reduce((a, r) => a + (r.rows[i]?.amount ?? 0), 0) }));
      const slips = await periodSlips(db, periods, opts.company);
      const people = new Set(slips.map((s) => s.employee_id));
      const sum = (k) => monthly.reduce((a, r) => a + (r.extra[k] ?? 0), 0);
      const otMin = slips.reduce((a, s) => a + (s.meta.ot?.paid_min ?? 0), 0);
      return {
        ...head,
        columns: [{ key: 'step', label: 'Step' }, { key: 'amount', label: 'Amount', money: true }],
        rows,
        notes: baseNotes,
        extra: {
          headcount: people.size,
          payslips: slips.length,
          months_run: periods.length,
          gross: sum('gross'),
          net: sum('net'),
          employer: sum('employer'),
          ctc: sum('ctc'),
          ot_hours: hours(otMin),
          ot_amount: slips.reduce((a, s) => a + sumKind(s, 'OT'), 0),
          joiners: (await peopleRows(db, from, to, 'joiners', company)).length,
          exits: (await peopleRows(db, from, to, 'exits', company)).length,
          trend: (await trendRows(db, periods, opts.company)),
        },
      };
    }
    case 'trend': {
      const rows = await trendRows(db, periods, opts.company);
      const total = (k) => rows.reduce((a, r) => a + r[k], 0);
      return {
        ...head,
        columns: [
          { key: 'month', label: 'Month' },
          { key: 'state', label: 'Payroll' },
          { key: 'people', label: 'People' },
          { key: 'gross', label: 'Gross', money: true },
          { key: 'ot', label: 'Overtime', money: true },
          { key: 'deductions', label: 'Deductions', money: true },
          { key: 'net', label: 'Net pay', money: true },
          { key: 'employer', label: 'Employer contributions', money: true },
          { key: 'ctc', label: 'Cost to company', money: true },
        ],
        rows,
        totals: { month: 'TOTAL', state: '', people: '', gross: total('gross'), ot: total('ot'), deductions: total('deductions'), net: total('net'), employer: total('employer'), ctc: total('ctc') },
        notes: baseNotes,
      };
    }
    case 'department': {
      const slips = await periodSlips(db, periods, opts.company);
      const depts = new Map();
      for (const s of slips) {
        const d = s.meta.department.name;
        const row = depts.get(d) ?? { department: d, ids: new Set(), gross: 0, net: 0, employer: 0, ctc: 0 };
        row.ids.add(s.employee_id);
        row.gross += n(s.gross);
        row.net += n(s.net);
        row.employer += n(s.employer_total);
        row.ctc += n(s.ctc_month);
        depts.set(d, row);
      }
      const rows = [...depts.values()].map(({ ids, ...r }) => ({ ...r, people: ids.size })).sort((a, b) => b.ctc - a.ctc);
      const total = (k) => rows.reduce((a, r) => a + r[k], 0);
      return {
        ...head,
        columns: [
          { key: 'department', label: 'Department' },
          { key: 'people', label: 'People paid' },
          { key: 'gross', label: 'Gross', money: true },
          { key: 'net', label: 'Net', money: true },
          { key: 'employer', label: 'Employer statutory', money: true },
          { key: 'ctc', label: 'Cost to company', money: true },
        ],
        rows,
        totals: { department: 'TOTAL', people: new Set(slips.map((s) => s.employee_id)).size, gross: total('gross'), net: total('net'), employer: total('employer'), ctc: total('ctc') },
        notes: baseNotes,
      };
    }
    case 'overtime':
      return { ...head, ...(await overtimeReport(db, periods, opts.company)), notes: baseNotes };
    default: {
      const monthly = await Promise.all(periods.map((p) => buildReport(db, p.period_ym, key, opts)));
      const combined = combineReports(monthly);
      const latest = monthly.at(-1);
      if (key === 'register') {
        for (const c of combined.columns) {
          if (c.key === 'days_in_month') c.label = 'Days in Period';
          if (c.group === 'fixed') c.flat_label = `Fixed ${c.label}`;
        }
      }
      const notes = [...baseNotes, 'Amounts and days are totals for the period. Text such as designation and bank details is from the latest month.'];
      if (key === 'pf' && combined.totals?.challan !== undefined) notes.push(`Total challans for the period including admin: ₹${(combined.totals.challan / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
      const extra = {};
      if (key === 'pt') {
        const byState = new Map();
        for (const r of combined.rows) {
          const s = byState.get(r.state) ?? { state: r.state, people: 0, amount: 0 };
          s.people += 1;
          s.amount += r.pt ?? 0;
          byState.set(r.state, s);
        }
        extra.by_state = [...byState.values()];
      }
      if (key === 'bank') for (const k of ['recoverable', 'held', 'separate']) extra[k] = monthly.flatMap((m) => m.extra?.[k] ?? []);
      return {
        ...head,
        columns: combined.columns,
        rows: combined.rows,
        ...(combined.totals ? { totals: combined.totals } : {}),
        ...(latest.groups ? { groups: latest.groups } : {}),
        ...(latest.pii ? { pii: true } : {}),
        notes,
        extra,
      };
    }
  }
}

/** One row a month: people paid, gross, overtime, deductions, net, employer contributions and CTC. */
async function trendRows(db, periods, company) {
  const slips = await periodSlips(db, periods, company);
  return periods.map((p) => {
    const mine = slips.filter((s) => s.period.period_ym === p.period_ym);
    const sum = (f) => mine.reduce((a, s) => a + f(s), 0);
    const gross = sum((s) => n(s.gross));
    const employer = sum((s) => n(s.employer_total));
    return {
      month: formatYearMonth(p.period_ym),
      ym: p.period_ym,
      state: p.state === 'RUN' ? 'Generated' : p.state === 'LOCKED' ? 'Locked' : p.state === 'PAID' ? 'Paid' : p.state,
      people: mine.length,
      gross,
      ot: sum((s) => sumKind(s, 'OT')),
      deductions: sum((s) => n(s.total_deductions)),
      net: sum((s) => n(s.net)),
      employer,
      ctc: sum((s) => n(s.ctc_month)),
    };
  });
}

/** Overtime by person over the period: hours worked, hours paid, hours over the caps, and the pay. */
async function overtimeReport(db, periods, company) {
  const slips = await periodSlips(db, periods, company);
  const people = new Map();
  for (const s of slips) {
    const ot = s.meta.ot;
    const worked = ot?.minutes ?? s.meta.attendance?.ot_min ?? 0;
    const amount = sumKind(s, 'OT');
    if (!worked && !amount) continue;
    const row = people.get(s.employee_id) ?? {
      employee_id: s.employee_id, code: s.meta.employee.code, name: s.meta.employee.name, department: s.meta.department.name,
      months: 0, worked_min: 0, paid_min: 0, over_min: 0, amount: 0,
    };
    row.code = s.meta.employee.code;
    row.name = s.meta.employee.name;
    row.department = s.meta.department.name;
    row.months += 1;
    row.worked_min += worked;
    row.paid_min += ot?.paid_min ?? worked;
    row.over_min += (ot?.excess_min ?? 0) + (ot?.daily_capped_min ?? 0);
    row.amount += amount;
    people.set(s.employee_id, row);
  }
  const rows = [...people.values()]
    .map(({ worked_min, paid_min, over_min, ...r }) => ({ ...r, worked: hours(worked_min), paid: hours(paid_min), over_cap: hours(over_min), per_month: hours(paid_min / Math.max(1, r.months)) }))
    .sort((a, b) => b.paid - a.paid);
  const total = (k) => Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;
  return {
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'department', label: 'Department' },
      { key: 'months', label: 'Months with OT' },
      { key: 'paid', label: 'OT hours paid' },
      { key: 'per_month', label: 'Hours a month' },
      { key: 'over_cap', label: 'Hours over caps (unpaid)' },
      { key: 'amount', label: 'OT pay', money: true },
    ],
    rows,
    totals: { code: '', name: count(rows.length, 'person', 'people'), department: '', months: '', paid: total('paid'), per_month: '', over_cap: total('over_cap'), amount: rows.reduce((a, r) => a + r.amount, 0) },
  };
}

async function peopleRows(db, from, to, key, company) {
  const range = { gte: toDbDate(`${from}-01`), lte: toDbDate(lastOfMonth(to)) };
  const rows = await db.employee.findMany({
    where: { deleted_at: null, ...(key === 'joiners' ? { joined_on: range } : { last_day: range }) },
    include: { department: { select: { name: true } }, pay_group: { select: { name: true } } },
    orderBy: key === 'joiners' ? { joined_on: 'asc' } : { last_day: 'asc' },
  });
  return company ? rows.filter((e) => companyOf(e.code) === company.key) : rows;
}

const EXIT_LABELS = { RESIGNATION: 'Resignation', TERMINATION: 'Termination', CONTRACT_END: 'Contract end', RETIREMENT: 'Retirement', ABSCONDING: 'Absconding', DEATH: 'Death', OTHER: 'Other' };
const STATUS_LABELS = { ONBOARDING: 'Onboarding', ACTIVE: 'Active', NOTICE: 'Serving notice', EXITED: 'Exited' };

function serviceText(fromDate, toDate) {
  if (!fromDate || !toDate) return '';
  const [y1, m1, d1] = fromDate.split('-').map(Number);
  const [y2, m2, d2] = toDate.split('-').map(Number);
  let months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  if (months < 0) months = 0;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} yr` : '', m || !y ? `${m} mo` : ''].filter(Boolean).join(' ');
}

/** Joiners or exits in the period, with the month of each. */
async function peopleReport(db, from, to, key, company) {
  const rows = await peopleRows(db, from, to, key, company);
  const month = (d) => formatYearMonth(ymOf(d));
  if (key === 'joiners') {
    return {
      columns: [
        { key: 'month', label: 'Month' },
        { key: 'code', label: 'Code', mono: true },
        { key: 'name', label: 'Name' },
        { key: 'designation', label: 'Designation' },
        { key: 'department', label: 'Department' },
        { key: 'pay_group', label: 'Pay group' },
        { key: 'joined_on', label: 'Joined on' },
        { key: 'status', label: 'Status now' },
      ],
      rows: rows.map((e) => {
        const joined = fromDbDate(e.joined_on);
        return { employee_id: e.id, month: month(joined), code: e.code, name: e.name, designation: e.designation, department: e.department.name, pay_group: e.pay_group.name, joined_on: joined, status: STATUS_LABELS[e.status] ?? e.status };
      }),
      totals: { month: count(rows.length, 'joiner') },
      extra: { by_month: byMonth(rows.map((e) => ymOf(fromDbDate(e.joined_on)))) },
    };
  }
  const settlements = rows.length ? await db.settlement.findMany({ where: { employee_id: { in: rows.map((e) => e.id) }, deleted_at: null }, orderBy: { created_at: 'desc' } }) : [];
  const fnf = (id) => settlements.find((s) => s.employee_id === id);
  const FNF = { OPEN: 'Open', INCLUDED: 'In payroll', PAID: 'Paid' };
  return {
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'designation', label: 'Designation' },
      { key: 'department', label: 'Department' },
      { key: 'joined_on', label: 'Joined on' },
      { key: 'last_day', label: 'Last day' },
      { key: 'service', label: 'Service' },
      { key: 'reason', label: 'Reason' },
      { key: 'fnf', label: 'F&F' },
      { key: 'fnf_net', label: 'F&F net', money: true },
    ],
    rows: rows.map((e) => {
      const joined = fromDbDate(e.joined_on);
      const last = fromDbDate(e.last_day);
      const s = fnf(e.id);
      return {
        employee_id: e.id, month: month(last), code: e.code, name: e.name, designation: e.designation, department: e.department.name,
        joined_on: joined ?? '', last_day: last, service: serviceText(joined, last), reason: EXIT_LABELS[e.exit_reason] ?? e.exit_reason ?? '',
        fnf: s ? FNF[s.state] ?? s.state : 'Not started', fnf_net: s ? n(s.net) : 0,
      };
    }),
    totals: { month: count(rows.length, 'exit'), fnf_net: settlements.filter((s, i, all) => all.findIndex((x) => x.employee_id === s.employee_id) === i).reduce((a, s) => a + n(s.net), 0) },
    extra: { by_month: byMonth(rows.map((e) => ymOf(fromDbDate(e.last_day)))) },
  };
}

function byMonth(yms) {
  const counts = new Map();
  for (const ym of yms) counts.set(ym, (counts.get(ym) ?? 0) + 1);
  return [...counts].sort().map(([ym, count]) => ({ ym, month: formatYearMonth(ym), count }));
}

/**
 * Salary revisions taking effect in the period: each salary record that replaces an earlier
 * one, with the pay before and after. Restatements (pay unchanged) are left out.
 */
async function revisionsReport(db, from, to, company) {
  const range = { gte: toDbDate(`${from}-01`), lte: toDbDate(lastOfMonth(to)) };
  const changed = await db.employeeSalary.findMany({
    where: { deleted_at: null, valid_from: range, employee: { deleted_at: null } },
    include: { employee: { select: { id: true, code: true, name: true, designation: true, department: { select: { name: true } } } } },
    orderBy: { valid_from: 'asc' },
  });
  const mine = company ? changed.filter((r) => companyOf(r.employee.code) === company.key) : changed;
  const ids = [...new Set(mine.map((r) => r.employee_id))];
  const history = ids.length ? await db.employeeSalary.findMany({ where: { employee_id: { in: ids }, deleted_at: null }, orderBy: { valid_from: 'asc' } }) : [];
  const rows = [];
  for (const r of mine) {
    const own = history.filter((h) => h.employee_id === r.employee_id);
    const prev = own.filter((h) => h.valid_from < r.valid_from).at(-1);
    if (!prev) continue; // the joining salary
    const before = n(prev.monthly_gross);
    const after = n(r.monthly_gross);
    if (before === after && /^Restated/i.test(r.reason)) continue;
    const effective = fromDbDate(r.valid_from);
    const annual = (x) => (x.mode === 'CTC' ? n(x.amount) : null);
    rows.push({
      employee_id: r.employee_id,
      month: formatYearMonth(ymOf(effective)),
      code: r.employee.code,
      name: r.employee.name,
      designation: r.employee.designation,
      department: r.employee.department.name,
      effective_from: effective,
      old_gross: before,
      new_gross: after,
      increase: after - before,
      increase_pct: before ? Math.round(((after - before) / before) * 10000) / 100 : null,
      old_ctc: annual(prev) ?? 0,
      new_ctc: annual(r) ?? 0,
      reason: r.reason,
    });
  }
  const pct = rows.filter((r) => r.increase_pct !== null);
  return {
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'department', label: 'Department' },
      { key: 'effective_from', label: 'Effective from' },
      { key: 'old_gross', label: 'Gross before (month)', money: true },
      { key: 'new_gross', label: 'Gross after (month)', money: true },
      { key: 'increase', label: 'Change a month', money: true },
      { key: 'increase_pct', label: 'Change %' },
      { key: 'old_ctc', label: 'Annual CTC before', money: true },
      { key: 'new_ctc', label: 'Annual CTC after', money: true },
      { key: 'reason', label: 'Reason' },
    ],
    rows: rows.map((r) => ({ ...r, increase_pct: r.increase_pct ?? '' })),
    totals: {
      month: count(rows.length, 'revision'),
      old_gross: rows.reduce((a, r) => a + r.old_gross, 0),
      new_gross: rows.reduce((a, r) => a + r.new_gross, 0),
      increase: rows.reduce((a, r) => a + r.increase, 0),
      increase_pct: pct.length ? Math.round((pct.reduce((a, r) => a + r.increase_pct, 0) / pct.length) * 100) / 100 : '',
    },
    extra: { by_month: byMonth(rows.map((r) => ymOf(r.effective_from))), average_pct: pct.length ? Math.round((pct.reduce((a, r) => a + r.increase_pct, 0) / pct.length) * 100) / 100 : null },
  };
}

