import { describe, expect, it } from 'vitest';
import { renderPayslipPDF } from '../../src/services/payslip-export.service.js';

const snapshot = () => ({
  period: { period_ym: '2026-08', state: 'LOCKED' }, computed_at: new Date('2026-09-01'),
  paid_days: 31, lop_days: 0, divisor: 31, net: 1938250, ctc_month: 2294250,
  meta: { employee: { name: 'Example Employee', code: 'AJ0001', designation: 'Electrical technician', joined_on: '2025-01-01' },
    department: { name: 'Electrical' }, pay_group: { name: 'Employee payroll' },
    ids: { uan: '100000000001', esi_number: '1234567890' }, bank: { last4: '8901', ifsc: 'SBIN0001234' },
    regime: 'NEW', pt_state: 'Andhra Pradesh', attendance: { worked_min: 14580 }, lop_rule_text: 'Calendar month' },
  lines: [['COMPONENT', 'BASIC', 'Basic', 1050000], ['COMPONENT', 'HRA', 'HRA', 420000], ['COMPONENT', 'SPECIAL', 'Special allowance', 630000],
    ['EMPLOYER', 'ER_PF', 'Employer PF', 126000], ['EMPLOYER', 'ER_ESI', 'Employer ESI', 68250],
    ['DEDUCTION', 'PF', 'Employee PF', 126000], ['DEDUCTION', 'ESI', 'Employee ESI', 15750], ['DEDUCTION', 'PT', 'Professional tax', 20000]]
    .map(([kind, code, name, amount], index) => ({ kind, code, name, amount, full_amount: amount, seq: index + 1 })),
});
const pages = (pdf) => [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length;

describe('Payslip PDF pagination', () => {
  it('fits an ordinary payslip on one A4 page without creating a blank footer page', async () => {
    const pdf = await renderPayslipPDF(snapshot(), { name: 'AJ Power Engineering' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBe(1);
    expect(pdf.toString('latin1')).toContain('%%EOF');
  });

  it('continues a long structure onto extra pages while retaining a valid document', async () => {
    const slip = snapshot();
    slip.lines.unshift(...Array.from({ length: 45 }, (_, index) => ({
      kind: 'COMPONENT', code: `CUSTOM_${index}`, name: `Additional earning ${index + 1} with a long label explaining the salary component`,
      amount: 10000, full_amount: 10000, seq: index + 20,
    })));
    const pdf = await renderPayslipPDF(slip, { name: 'AJ Power Engineering' });
    expect(pages(pdf)).toBeGreaterThan(1);
    expect(pages(pdf)).toBeLessThan(8);
    expect(pdf.toString('latin1')).toContain('%%EOF');
  });
});
