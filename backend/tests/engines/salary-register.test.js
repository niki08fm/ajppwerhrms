import { describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { assemblePayslip } from '../../src/calculations/index.js';
import { buildReport, reportCSV, reportXLSX } from '../../src/services/reports.service.js';
import { fullMonthTotals, payslipInput, R } from './fixtures.js';

vi.mock('../../src/utils/crypto.js', () => ({ decryptPII: (value) => value }));

/** Basic 50% of gross (PF wage), HRA 25% of gross, Special Allowance the balance. */
const STRUCTURE = [
  { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: true },
  { seq: 2, name: 'HRA', calc_type: 'PCT_GROSS', calc_value: 25, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
  { seq: 3, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
];
const OT_RULES = { base: 'BASIC', multiplier: 2, divisor: null, hours_per_day: 8, after_min: 30, rounding_min: 30, monthly_cap_min: 3000 };

function slip(input) {
  return assemblePayslip(payslipInput({ components: STRUCTURE, divisor: 30, overtime_rules: OT_RULES, ...input }));
}

describe('Payslip: full-month (fixed) employer contributions', () => {
  it('keeps employer PF on the full-month PF wage while the deduction follows earned pay', () => {
    // ₹31,000 gross, 3 days' loss of pay: earned Basic ₹13,950 → PF ₹1,674; full Basic ₹15,500 caps at ₹15,000 → ₹1,800.
    const r = slip({ monthly_gross: R(31000), attendance: fullMonthTotals('2026-09', 30, { paid_days: 27, lop_days: 3, present: 27, absent: 3, day_value_sum: 27 }) });
    expect(r.lines.find((l) => l.code === 'PF').amount).toBe(R(1674));
    expect(r.fixed).toEqual({ gross: R(31000), employer_pf: R(1800), employer_esi: 0, ctc: R(32800) });
  });

  it('works full-month employer ESI out on the fixed ESI wage when ESI applies', () => {
    // 3.25% of ₹24,715.09 = ₹803.24, rounded up to the rupee.
    const r = slip({ monthly_gross: R(24715.09), statutory: { pf_enabled: true, pf_restrict_to_ceiling: true, vpf_pct: 0, esi_applicable: true, pt_applicable: true, pt_state: 'Telangana' } });
    expect(r.fixed.employer_esi).toBe(R(804));
    expect(r.fixed.ctc).toBe(r.fixed.gross + r.fixed.employer_pf + R(804));
  });

  it('records the hours in an overtime day so a register can show OT days', () => {
    const r = slip({ monthly_gross: R(55700), attendance: fullMonthTotals('2026-09', 30, { ot_min: 1200 }) });
    expect(r.ot).toMatchObject({ paid_min: 1200, hours_per_day: 8 });
    // 2.5 OT days × gross ÷ 30
    expect(r.ot.amount).toBe(R(4641.67));
  });
});

// ─── Salary register ──────────────────────────────────────────────────────────

let rowSeq = 0;
/** A stored payslip, as the run writes it, from an engine result. */
function stored(code, name, department, result, extra = {}) {
  rowSeq++;
  return {
    employee_id: `emp-${rowSeq}`,
    employee: { id: `emp-${rowSeq}`, code, name },
    gross: result.gross,
    salary_gross: result.salary_gross,
    total_deductions: result.total_deductions,
    reimbursements: result.reimbursements,
    net: result.net,
    employer_total: result.employer_total,
    paid_days: result.paid_days,
    lop_days: result.lop_days,
    divisor: result.divisor,
    lines: result.lines,
    meta: {
      employee: { code, name, designation: `${name} role`, joined_on: '2024-01-01', last_day: null },
      department: { name: department },
      bank: { account_enc: null, last4: '4321', ifsc: 'DBSS0IN0831', name: 'DBS Bank' },
      ids: { pan_enc: null, uan: '101253592467', esi_number: null },
      ot: result.ot,
      fixed: result.fixed,
      held: null,
      ...extra,
    },
  };
}

function fakeDb(slips) {
  return {
    payrollPeriod: { findUnique: async () => ({ id: 'period-1', period_ym: '2026-09', state: 'RUN', settlement_ids: [] }) },
    payslip: { findMany: async () => slips },
    settlement: { findMany: async () => [] },
    company: { findFirst: async () => ({ name: 'Tulfa Private Limited' }) },
  };
}

function registerSlips() {
  const a = slip({
    monthly_gross: R(103200),
    attendance: fullMonthTotals('2026-09', 30, { ot_min: 1440 }),
    adhoc: [
      { id: 'a1', kind: 'EARNING', name: 'Birthday bonus', amount: R(500), is_taxable: true },
      { id: 'a2', kind: 'REIMBURSEMENT', name: 'Reimbursements', amount: R(3072), is_taxable: false },
    ],
  });
  const b = slip({
    monthly_gross: R(78700),
    adhoc: [
      { id: 'b1', kind: 'EARNING', name: 'Work anniversary', amount: R(7500), is_taxable: true },
      { id: 'b2', kind: 'DEDUCTION', name: 'Canteen', amount: R(250), is_taxable: false },
    ],
  });
  const c = slip({ monthly_gross: R(31000), attendance: fullMonthTotals('2026-09', 30, { paid_days: 27, lop_days: 3, present: 27, absent: 3, day_value_sum: 27 }) });
  // Stored in code order; the register groups by department, then name.
  return [stored('AJ0001', 'Parikh Nitav', 'CGI Team', a), stored('AJ0002', 'Archana Nuthakki', 'Image Process', b), stored('AJ0003', 'Omkar Patil', 'Image Process', c)];
}

describe('Salary register: the payroll statement layout', () => {
  it('groups columns into the statement bands, with one column per component and adhoc name', async () => {
    const r = await buildReport(fakeDb(registerSlips()), '2026-09', 'register', { pii: false });
    expect(r.layout).toBe('register');
    expect(r.groups.map((g) => g.label)).toEqual(['Payroll Statement', 'Fixed Salary', 'Attendance Information', 'Earned Salary', 'Deductions', 'Bank Details']);
    const labels = (group) => r.columns.filter((c) => c.group === group).map((c) => c.label);
    expect(labels('statement')).toEqual(['Name', 'Designation', 'Department', 'Employee ID', 'UAN', 'ESI Number']);
    expect(labels('fixed')).toEqual(['Basic', 'HRA', 'Special Allowance', 'Gross Salary', 'Employer PF', 'Employer ESI', 'CTC']);
    expect(labels('attendance')).toEqual(['Days in Month', 'Payable Days', 'Loss of Pay Days', 'OT Days']);
    expect(labels('earned')).toEqual(['Basic', 'HRA', 'Special Allowance', 'Overtime', 'Birthday bonus', 'Work anniversary', 'Gross Earned Salary']);
    expect(labels('deductions')).toEqual(['Employee PF', 'Employee ESI', 'Professional Tax', 'TDS', 'Canteen', 'Total Deductions', 'Net Salary', 'Reimbursements', 'Net Pay/Bank Transfer']);
    expect(labels('bank')).toEqual(['Bank Name', 'Account Number', 'IFSC Code', 'Name on the Account']);
  });

  it('fills each row from the payslip, grouped by department then name', async () => {
    const r = await buildReport(fakeDb(registerSlips()), '2026-09', 'register', { pii: false });
    expect(r.rows.map((x) => x.code)).toEqual(['AJ0001', 'AJ0002', 'AJ0003']);
    const value = (row, group, label) => row[r.columns.find((c) => c.group === group && c.label === label).key];
    const [parikh, archana, omkar] = r.rows;
    expect(value(parikh, 'attendance', 'OT Days')).toBe(3);
    expect(value(parikh, 'earned', 'Overtime')).toBe(R(10320));
    expect(value(parikh, 'earned', 'Birthday bonus')).toBe(R(500));
    expect(value(parikh, 'earned', 'Work anniversary')).toBe(0);
    expect(value(parikh, 'deductions', 'Reimbursements')).toBe(R(3072));
    expect(value(archana, 'deductions', 'Canteen')).toBe(R(250));
    expect(value(omkar, 'fixed', 'Basic')).toBe(R(15500));
    expect(value(omkar, 'earned', 'Basic')).toBe(R(13950));
    expect(value(omkar, 'fixed', 'Employer PF')).toBe(R(1800));
    expect(value(omkar, 'deductions', 'Employee PF')).toBe(R(1674));
    expect(value(omkar, 'attendance', 'Loss of Pay Days')).toBe(3);
    for (const row of r.rows) {
      expect(value(row, 'deductions', 'Net Salary')).toBe(value(row, 'earned', 'Gross Earned Salary') - value(row, 'deductions', 'Total Deductions'));
      expect(value(row, 'deductions', 'Net Pay/Bank Transfer')).toBe(value(row, 'deductions', 'Net Salary') + value(row, 'deductions', 'Reimbursements'));
    }
    expect(value(parikh, 'bank', 'Account Number')).toBe('XXXXXX4321');
    expect(value(parikh, 'bank', 'Name on the Account')).toBe('Parikh Nitav');
    expect(r.totals[r.columns.find((c) => c.group === 'deductions' && c.label === 'Net Pay/Bank Transfer').key]).toBe(r.rows.reduce((a, x) => a + x[r.columns.find((c) => c.group === 'deductions' && c.label === 'Net Pay/Bank Transfer').key], 0));
    expect(r.file_name).toBe('Payroll_TULFA_PRIVATE_LIMITED_2026-09');
  });

  it('adds VPF, recovery, off-day and payment columns only when the month has them', async () => {
    const r = await buildReport(fakeDb(registerSlips()), '2026-09', 'register', { pii: false });
    const labels = r.columns.map((c) => c.label);
    for (const absent of ['VPF', 'Loan / Advance Recovery', 'Off-day Work', 'Leave Encashment', 'Held Salary Released', 'Payment']) expect(labels).not.toContain(absent);
  });

  it('writes the two-row banded header, data rows and a TOTAL row with sums', async () => {
    const r = await buildReport(fakeDb(registerSlips()), '2026-09', 'register', { pii: false });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await reportXLSX(r));
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe('SEPTEMBER');
    expect(ws.getCell('B1').value).toBe(2026);
    expect(ws.getCell('C1').value).toBe('Payroll Statement');
    expect(ws.getRow(2).getCell(1).value).toBe('Name');
    expect(ws.getRow(2).getCell(4).value).toBe('Employee ID');
    const merges = ws.model.merges;
    expect(merges).toContain('C1:F1');
    expect(merges.length).toBe(6);
    expect(ws.getCell('A3').value).toBe('Parikh Nitav');
    const total = ws.getRow(6);
    expect(total.getCell(1).value).toBe('TOTAL');
    const grossCol = r.columns.findIndex((c) => c.group === 'fixed' && c.label === 'Gross Salary') + 1;
    expect(total.getCell(grossCol).value).toMatchObject({ formula: expect.stringMatching(/^SUM\([A-Z]+3:[A-Z]+5\)$/), result: 103200 + 78700 + 31000 });
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 4, ySplit: 2 });
  });

  it('exports the same columns as a flat CSV', async () => {
    const r = await buildReport(fakeDb(registerSlips()), '2026-09', 'register', { pii: false });
    const [header] = reportCSV(r).split('\n');
    expect(header).toContain('Employee ID');
    expect(header).toContain('Fixed Basic');
    expect(header).toContain('Fixed CTC');
    expect(header).toContain('Birthday bonus');
    expect(header).toContain('Net Pay/Bank Transfer');
  });
});
