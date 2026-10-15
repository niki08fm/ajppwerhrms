import { describe, expect, it, vi } from 'vitest';
import { computePayslip } from '../../src/services/payslip.service.js';
import { buildReport } from '../../src/services/reports.service.js';
import { NEW_REGIME, OLD_REGIME, PF_ON, PT_SLABS, R, RATES, fullMonthTotals } from './fixtures.js';

// These reports use stored snapshot figures and do not need encryption or a database.
vi.mock('../../src/utils/crypto.js', () => ({ decryptPII: (value) => value }));

const date = (value) => new Date(`${value}T00:00:00Z`);
const component = (seq, name, calc_type, calc_value, counts_as_esi_wages) => ({
  seq, name, calc_type, calc_value, counts_as_esi_wages, max_amount: null,
  frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: name === 'Basic',
});
const components = (basicPercent = 50) => [
  component(1, 'Basic', 'PCT_GROSS', basicPercent, true),
  component(2, 'Special Allowance', 'BALANCE', 0, false),
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
    // No TDS entered before AJPWER and no earlier AJPWER payslips: TDS is the even spread.
    employeeOpeningTds: { findFirst: vi.fn(async () => null) },
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

describe('Selected ESI wages are resolved with the salary effective at contribution-period start', () => {
  it('uses the earlier structure and agreed CTC basis, while contributions use current earned wages', async () => {
    const original = [component(1, 'Basic', 'PCT_CTC', 40, true), component(2, 'Special Allowance', 'BALANCE', 0, false)];
    const db = database([
      salary('earlier', 'original', '2025-01-01', '2026-07-31', { mode: 'CTC', amount: BigInt(R(600000)) }),
      salary('latest', 'revised', '2026-08-01'),
    ], { original, revised: components(80) });
    const august = await payslip(db);
    expect(august.esi).toMatchObject({ applicable: true, locked_until: '2026-09-30' });
    expect(august.result).toMatchObject({ gross: R(30000), statutory_gross: R(30000), esi_wage: R(24000) });
    expect(august.result.lines.find((line) => line.code === 'ESI').amount).toBe(R(180));
    expect(db.salaryComponent.findMany.mock.calls.map(([query]) => query.where.structure_id)).toEqual(['revised', 'original']);

    const october = await payslip(db, '2026-10');
    expect(october.esi.applicable).toBe(false);
    expect(october.result.lines.some((line) => line.code === 'ESI')).toBe(false);
  });

  it('does not enroll mid-period merely because a later structure excludes more earnings', async () => {
    const db = database([
      salary('earlier', 'original', '2025-01-01', '2026-07-31'),
      salary('latest', 'revised', '2026-08-01'),
    ], { original: components(80), revised: components(50) });
    expect((await payslip(db)).esi.applicable).toBe(false);
    const october = await payslip(db, '2026-10');
    expect(october.esi.applicable).toBe(true);
    expect(october.result.esi_wage).toBe(R(15000));
  });

  it('reconstructs gross-agreement % of CTC wages with the rates at contribution-period entry', async () => {
    const structure = [component(1, 'Basic', 'PCT_CTC', 50, true), component(2, 'Special Allowance', 'BALANCE', 0, false)];
    const db = database([salary('original', 'structure', '2025-01-01')], { structure });
    db.statutoryRates = { findFirst: vi.fn(async () => ({ id: 'entry-rates', valid_from: date('2025-04-01'),
      pf: RATES.pf, esi: RATES.esi, recovery_cap_pct: 40 })) };
    const currentRates = { ...RATES, pf: { ...RATES.pf, employer_pct: 90 } };
    const august = await payslip(db, '2026-08', {}, currentRates);
    expect(db.statutoryRates.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { valid_from: { lte: date('2026-04-01') }, deleted_at: null },
    }));
    expect(august.esi.applicable).toBe(true);
    expect(august.result.esi_wage).toBeGreaterThan(R(21000));
  });

  it('preserves a paid contribution-period lock when the employee setting is switched off', async () => {
    const db = database([salary('original', 'structure', '2025-01-01')], { structure: components(80) });
    const august = await payslip(db, '2026-08', { esi_enabled: false, esi_locked_until: date('2026-09-30') });
    expect(august.esi).toMatchObject({ applicable: true, locked_until: '2026-09-30' });
    expect(august.result.lines.find((line) => line.code === 'ESI').amount).toBe(R(180));
    expect((await payslip(db, '2026-10', { esi_enabled: false, esi_locked_until: date('2026-09-30') })).esi.applicable).toBe(false);
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
