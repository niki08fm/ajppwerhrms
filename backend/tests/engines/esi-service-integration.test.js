import { describe, expect, it, vi } from 'vitest';
import { computePayslip } from '../../src/services/payslip.service.js';
import { buildReport } from '../../src/services/reports.service.js';
import { NEW_REGIME, OLD_REGIME, PF_ON, PT_SLABS, R, RATES, fullMonthTotals } from './fixtures.js';

// These reports use stored snapshot figures and do not need encryption or a database.
vi.mock('../../src/utils/crypto.js', () => ({ decryptPII: (value) => value }));

const date = (value) => new Date(`${value}T00:00:00Z`);
const component = (seq, name, calc_type, calc_value) => ({
  seq, name, calc_type, calc_value, max_amount: null,
  frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: name === 'Basic',
});
const components = (basicPercent = 50) => [
  component(1, 'Basic', 'PCT_GROSS', basicPercent),
  component(2, 'Special Allowance', 'BALANCE', 0),
];
const salary = (id, structure_id, valid_from, valid_to = null, extra = {}) => ({
  id, structure_id, valid_from: date(valid_from), valid_to: valid_to ? date(valid_to) : null,
  mode: 'GROSS', amount: BigInt(R(30000)), monthly_gross: BigInt(R(30000)), ...extra,
});
function database(salaries, structures) {
  return {
    employeeSalary: { findFirst: vi.fn(async ({ where }) => {
      const at = where.valid_from.lte.toISOString().slice(0, 10);
      return salaries.filter((row) => row.valid_from <= date(at) && (!row.valid_to || row.valid_to >= date(at)))
        .sort((a, b) => b.valid_from - a.valid_from)[0] ?? null;
    }) },
    salaryComponent: { findMany: vi.fn(async ({ where }) => structures[where.structure_id]) },
    // No earlier payslips this tax year: TDS starts from nothing paid.
    payslip: { findMany: vi.fn(async () => []) },
  };
}
async function payslip(db, ym = '2026-08', statutory = {}, rates = RATES) {
  const employee = { id: 'employee-1', code: 'AJ0001', name: 'Employee', gender: 'MALE',
    joined_on: date('2025-01-01'), last_day: null, statutory: {
      ...PF_ON, esi_enabled: true, esi_locked_until: null, pt_applicable: true,
      pt_state: 'Andhra Pradesh', tax_regime_code: 'NEW', decl_metro: false, ...statutory,
    } };
  const month = { rules: { calendar_method: 'FIXED_26', weekly_off: ['SUN'], policies: [] },
    holidays: new Map(), result: { totals: fullMonthTotals(ym, 31), offday_work: [], leave: { types: [] } } };
  const ctx = { rates: { ...rates, recovery_cap_pct: 40 }, pt_slabs: PT_SLABS,
    regimes: { NEW: NEW_REGIME, OLD: OLD_REGIME }, adhoc: [] };
  return computePayslip(db, employee, ym, month, ctx);
}

describe('ESI follows the gross in force at the contribution-period start', () => {
  const pay = (gross) => ({ amount: BigInt(R(gross)), monthly_gross: BigInt(R(gross)) });

  it('a raise mid-period keeps ESI to the period end, on the whole gross; the next period follows the new gross', async () => {
    const db = database([
      salary('earlier', 'structure', '2025-01-01', '2026-07-31', pay(20000)),
      salary('latest', 'structure', '2026-08-01', null, pay(30000)),
    ], { structure: components(50) });
    const august = await payslip(db);
    expect(august.esi).toMatchObject({ applicable: true, locked_until: '2026-09-30' });
    // ESI wages are the whole gross: Basic and Special Allowance alike.
    expect(august.result).toMatchObject({ gross: R(30000), esi_wage: R(30000) });
    expect(august.result.lines.find((line) => line.code === 'ESI').amount).toBe(R(225));

    const october = await payslip(db, '2026-10');
    expect(october.esi.applicable).toBe(false);
    expect(october.result.lines.some((line) => line.code === 'ESI')).toBe(false);
  });

  it('needs no switch: a gross within the ceiling has ESI even with the old switch off', async () => {
    const db = database([salary('only', 'structure', '2025-01-01', null, pay(20000))], { structure: components(50) });
    const august = await payslip(db, '2026-08', { esi_enabled: false });
    expect(august.esi.applicable).toBe(true);
    expect(august.result.esi_wage).toBe(R(20000));
    expect(august.result.lines.find((line) => line.code === 'ESI').amount).toBe(R(150));
  });

  it('a gross above the ceiling at the period start has no ESI', async () => {
    const db = database([salary('only', 'structure', '2025-01-01', null, pay(21500))], { structure: components(50) });
    expect((await payslip(db)).esi.applicable).toBe(false);
  });
});

describe('ESI reports use frozen wage snapshots', () => {
  it('uses selected wages, preserves zero wages, and falls back for historical snapshots', async () => {
    const slip = (code, esi_wage) => ({ employee_id: code, employee: { code }, paid_days: 26,
      esi_applicable: true, lines: [], meta: { employee: { code, name: code }, ids: {},
        statutory_gross: R(30000), ...(esi_wage === undefined ? {} : { esi_wage }) } });
    const db = { payrollPeriod: { findUnique: vi.fn(async () => ({ id: 'period', state: 'PAID' })) },
      payslip: { findMany: vi.fn(async () => [slip('selected', R(15000)), slip('zero', 0), slip('historical')]) } };
    const report = await buildReport(db, '2026-08', 'esi');
    expect(report.rows.map((row) => row.wages)).toEqual([R(15000), 0, R(30000)]);
    expect(report.totals.wages).toBe(R(45000));
  });
});
