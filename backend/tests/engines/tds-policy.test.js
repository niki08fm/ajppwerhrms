import { describe, expect, it } from 'vitest';
import { assemblePayslip, computeAnnualTax, EMPTY_YTD, policyTds } from '../../src/calculations/index.js';
import { fullMonthTotals, NEW_REGIME, NO_DECL, OLD_REGIME, payslipInput, PF_ON, R } from './fixtures.js';

/*
 * The scenarios of the AJPWER Income Tax (TDS on Salary) Policy, tax year 2026-27.
 * Salary splits Basic 50%, HRA 20%, Special 30%. Each month's TDS is computed with the
 * year-to-date figures of the months before it, as payroll does.
 */
const FY = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];

/** A month at `gross` a month (rupees), with optional LOP share, variable pay and one-off. */
function month(gross, { lop = 0, variable = 0, oneOff = 0, pf = 0 } = {}) {
  const earned = (x) => Math.round(R(x) * (1 - lop));
  return {
    actual: { taxable: earned(gross), variable: R(variable), one_off: R(oneOff), basic: earned(gross * 0.5), hra: earned(gross * 0.2), pf_80c: Math.round(R(pf) * (1 - lop)) },
    ahead: { taxable: R(gross), basic: R(gross * 0.5), hra: R(gross * 0.2), pf_80c: R(pf), known: 0 },
  };
}

/** Run TDS month by month. `lastIndex` is the last month employed (0 = April). */
function runYear(months, { regime = NEW_REGIME, decl = NO_DECL, previous, lastIndex = months.length - 1, knownFrom = 0 } = {}) {
  let ytd = { ...EMPTY_YTD };
  const tds = [];
  months.forEach((m, i) => {
    const t = policyTds({ month: m.actual, ahead: m.ahead, monthsLeft: (i < knownFrom ? 11 : lastIndex) - i + 1, ytd, previous, decl, regime });
    tds.push(t.total);
    ytd = {
      taxable: ytd.taxable + m.actual.taxable + m.actual.variable + m.actual.one_off,
      tds: ytd.tds + t.total,
      basic: ytd.basic + m.actual.basic,
      hra: ytd.hra + m.actual.hra,
      pf_80c: ytd.pf_80c + m.actual.pf_80c,
      variable: ytd.variable + m.actual.variable,
      months: ytd.months + 1,
    };
  });
  return { tds, total: tds.reduce((a, b) => a + b, 0), ytd };
}

/** The tax actually owed on what was paid. */
function liability(ytd, { regime = NEW_REGIME, decl = NO_DECL, previous = { income: 0 } } = {}) {
  return computeAnnualTax({ gross: previous.income + ytd.taxable, basic: ytd.basic, hra: ytd.hra, pf_80c: ytd.pf_80c, rent_months: ytd.months }, decl, regime).total;
}

describe('TDS policy scenarios (2026-27)', () => {
  it('A. ₹1,00,000 a month all year: nothing is owed and nothing is deducted', () => {
    const r = runYear(FY.map(() => month(100000)));
    expect(r.total).toBe(0);
  });

  it('B. raised from ₹1,00,000 to ₹1,50,000 in October: ₹16,250 a month from October, ₹97,500 in all', () => {
    const r = runYear(FY.map((_, i) => month(i < 6 ? 100000 : 150000)));
    expect(r.tds.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.tds.slice(6)).toEqual(Array(6).fill(R(16250)));
    expect(r.total).toBe(R(97500));
    expect(liability(r.ytd)).toBe(R(97500));
  });

  it('C. ₹2,00,000 a month, leaves 31 December (known from October): ₹1,50,800, the tax owed on nine months', () => {
    const months = FY.slice(0, 9).map(() => month(200000));
    const r = runYear(months, { lastIndex: 8, knownFrom: 6 });
    expect(r.tds.slice(0, 6)).toEqual(Array(6).fill(R(24375)));
    expect(r.total).toBe(R(150800));
    expect(liability(r.ytd)).toBe(R(150800));
  });

  it('D. joins in October at ₹2,00,000 with ₹6,00,000 from a previous employer: ₹25,133 a month', () => {
    const previous = { income: R(600000), tds: 0 };
    const r = runYear(FY.slice(6).map(() => month(200000)), { previous });
    expect(r.tds[0]).toBe(R(25133));
    expect(r.total).toBe(R(150800));
    expect(liability(r.ytd, { previous })).toBe(R(150800));
  });

  it('E. ₹95,000 + ₹15,000 overtime every month: an even ₹3,900 a month, ₹46,800 in all', () => {
    const r = runYear(FY.map(() => month(95000, { variable: 15000 })));
    expect(r.tds).toEqual(Array(12).fill(R(3900)));
    expect(r.total).toBe(R(46800));
  });

  it('F. ₹1,40,000 with a third of June and December lost to LOP: TDS matches the tax on actual pay', () => {
    const r = runYear(FY.map((_, i) => month(140000, { lop: i === 2 || i === 8 ? 1 / 3 : 0 })));
    expect(r.tds[2]).toBe(R(9733));
    expect(r.total).toBe(liability(r.ytd));
    expect(Math.abs(r.total - R(111020))).toBeLessThanOrEqual(R(10));
  });

  it('G. old regime with PF, 80C ₹1,00,000, 80D ₹25,000, rent ₹30,000 metro: ₹1,22,740; PF counts under 80C', () => {
    const decl = { decl_80c: R(100000), decl_80d: R(25000), decl_rent_monthly: R(30000), decl_metro: true };
    const r = runYear(FY.map(() => month(125000, { pf: 1800 })), { regime: OLD_REGIME, decl });
    expect(r.total).toBe(R(122740));
    const w = computeAnnualTax({ gross: R(1500000), basic: R(750000), hra: R(300000), pf_80c: R(21600) }, decl, OLD_REGIME);
    expect(w.hra_exemption).toBe(R(285000));
    expect(w.deduction_80c).toBe(R(121600));
    expect(w.taxable).toBe(R(1018400));
  });

  it('H. ₹1,00,000 bonus in October on ₹1,10,000: ₹38,220 bonus tax that month, ₹3,900 regular around it', () => {
    const r = runYear(FY.map((_, i) => month(110000, { oneOff: i === 6 ? 100000 : 0 })));
    expect(r.tds[6]).toBe(R(42120));
    expect(r.tds.filter((_, i) => i !== 6)).toEqual(Array(11).fill(R(3900)));
    expect(r.total).toBe(R(85020));
  });

  it('I. ₹20,000 bonus in March on ₹1,06,000: marginal relief leaves ₹17,680 tax', () => {
    const r = runYear(FY.map((_, i) => month(106000, { oneOff: i === 11 ? 20000 : 0 })));
    expect(r.tds.slice(0, 11)).toEqual(Array(11).fill(0));
    expect(r.tds[11]).toBe(R(17680));
  });

  it('over-deduction is never refunded: TDS stops at zero', () => {
    const t = policyTds({ ...month(50000), month: month(50000).actual, ahead: month(50000).ahead, monthsLeft: 3, ytd: { ...EMPTY_YTD, taxable: R(900000), tds: R(90000), months: 9 }, decl: NO_DECL, regime: NEW_REGIME });
    expect(t.total).toBe(0);
  });

  it('no PAN: the higher of the average rate or 20% where tax is due; nothing where none is', () => {
    const due = computeAnnualTax({ gross: R(1500000), basic: 0, hra: 0 }, NO_DECL, NEW_REGIME, { no_pan: true });
    expect(due.total).toBe(R(285000));
    const none = computeAnnualTax({ gross: R(1000000), basic: 0, hra: 0 }, NO_DECL, NEW_REGIME, { no_pan: true });
    expect(none.total).toBe(0);
  });

  it('HRA rent counts only for the months employed', () => {
    const decl = { ...NO_DECL, decl_rent_monthly: R(5000) };
    const w = computeAnnualTax({ gross: R(240000), basic: R(120000), hra: R(60000), rent_months: 3 }, decl, OLD_REGIME);
    expect(w.hra_exemption).toBe(R(3000));
  });
});

describe('TDS on the payslip', () => {
  const statutory = { ...PF_ON, pf_enabled: false, esi_applicable: false, pt_applicable: false, pt_state: 'Telangana' };
  const base = (gross, tax) => payslipInput({ ym: '2026-10', monthly_gross: R(gross), divisor: 31, attendance: fullMonthTotals('2026-10', 31), statutory, tax: { regime: NEW_REGIME, declarations: NO_DECL, ...tax } });

  it('nets TDS already deducted and spreads the rest over the months left', () => {
    // October after six months at ₹1,00,000 with nothing deducted.
    const ytd = { ...EMPTY_YTD, taxable: R(600000), basic: R(300000), hra: R(120000), months: 6 };
    const p = assemblePayslip(base(150000, { months_left: 6, ytd }));
    expect(p.lines.find((l) => l.code === 'TDS').amount).toBe(R(16250));
    expect(p.tds.annual).toBe(R(97500));
    expect(p.tds.months_left).toBe(6);
    expect(p.tax_ytd.taxable).toBe(R(150000));
  });

  it('never takes more TDS than the month pays; the shortfall stays due for later months', () => {
    const ytd = { ...EMPTY_YTD, taxable: R(1200000), basic: R(600000), hra: R(240000), months: 6 };
    const p = assemblePayslip({ ...base(200000, { months_left: 6, ytd }), attendance: fullMonthTotals('2026-10', 31, { lop_days: 30, paid_days: 1 }) });
    expect(p.net).toBeGreaterThanOrEqual(0);
    expect(p.flags).toContain('TDS_CAPPED');
    expect(p.tds.due_this_month).toBeGreaterThan(p.tds.regular + p.tds.incremental);
  });

  it('taxes the earned pay after LOP, not the full salary', () => {
    const full = assemblePayslip(base(140000, { months_left: 12 }));
    const lop = assemblePayslip({ ...base(140000, { months_left: 12 }), attendance: fullMonthTotals('2026-10', 31, { lop_days: 10, paid_days: 21 }) });
    expect(lop.tds.regular).toBeLessThan(full.tds.regular);
    expect(lop.tax_ytd.taxable).toBeLessThan(R(140000));
  });
});

describe('Settlement taxable payments', () => {
  it('taxes HR-added earnings in full and gratuity or leave encashment only above their exemptions', async () => {
    const { settlementTaxable } = await import('../../src/calculations/index.js');
    const earnings = [
      { code: 'FINAL_SALARY', amount: R(100000) },
      { code: 'GRATUITY', amount: R(2100000) },
      { code: 'LEAVE_ENCASH:EL', amount: R(400000) },
      { code: 'ADJ:x', amount: R(50000), added: true },
      { code: 'ADJ:y', amount: R(99999), added: true, excluded: true },
    ];
    // Ten months' basic of ₹30,000 = ₹3,00,000 exempt for leave encashment.
    const t = settlementTaxable(earnings, R(30000));
    expect(t).toEqual({ added: R(50000), gratuity: R(100000), leave: R(100000), total: R(250000) });
  });
});
