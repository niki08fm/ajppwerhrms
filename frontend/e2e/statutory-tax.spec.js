import { expect, test } from '@playwright/test';
import { SEED_TAX_REGIMES } from '@ajpwer/shared';
import { compareRegimes } from '../../backend/src/calculations/statutory/incomeTax.js';

const regimes = Object.fromEntries(SEED_TAX_REGIMES.map((regime) => [regime.code, regime]));
const tab = (page) => page.getByRole('tabpanel', { name: 'Salary and statutory' });

async function mockTaxProfile(page, { gross = 180_000_000, noSalary = false, readOnly = false, current = 'NEW' } = {}) {
  const state = {
    requests: [],
    e: {
      id: 'employee-tax', code: 'AJTAX01', name: 'Tax Example', designation: 'Engineer', status: 'ACTIVE',
      joined_on: '2020-01-01', read_only: readOnly, gender: 'FEMALE', phone: '', identity: {},
      department: { id: 'dept', name: 'Engineering', colour: 'chart-1' },
      pay_group: { id: 'group-tax', name: 'Engineering team', calendar_method: 'ACTUAL', weekly_off: ['SUN'] },
      face: { enrolled: false }, onboarding: { required_left: 0 },
      salary: noSalary ? null : { id: 'salary-tax', mode: 'GROSS', amount: gross / 12, monthly_gross: gross / 12, valid_from: '2020-01-01' },
      statutory: {
        pf_enabled: false, esi_enabled: false, pt_applicable: true, pt_state: 'Telangana',
        pf_restrict_to_ceiling: true, vpf_pct: 0, tax_regime_code: current,
        decl_80c: 12_000_000, decl_80d: 2_000_000, decl_rent_monthly: 1_500_000, decl_metro: false,
      },
      rules: { policies: [] },
    },
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    let data = [];
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', permissions: ['people.read', 'people.write', 'salary.read', 'salary.write'] };
    else if (path === '/lookups') data = { today: '2026-10-10', departments: [state.e.department], pt_states: ['Telangana'], pay_groups: [state.e.pay_group], structures: [], sites: [] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/advances-loans') data = { rows: [] };
    else if (path.endsWith('/hold')) data = { current: null, history: [], open_months: [], run_months: [] };
    else if (path.endsWith('/leave-balances')) data = { types: [] };
    else if (path.endsWith('/attendance')) data = { days: [] };
    else if (path.endsWith('/pay')) data = null;
    else if (path.endsWith('/tax')) data = noSalary ? null : {
      current: state.e.statutory.tax_regime_code,
      comparison: compareRegimes({ gross, basic: gross / 2, hra: gross / 5 }, state.e.statutory, regimes),
    };
    else if (path.endsWith('/statutory') && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      state.requests.push(body);
      state.e.statutory = { ...state.e.statutory, ...body };
      data = state.e.statutory;
    } else if (path === '/employees/employee-tax') data = state.e;
    await route.fulfill({ json: { data } });
  });
  await page.goto('/people/employee-tax?tab=salary&section=statutory');
  await expect(tab(page).getByRole('heading', { name: 'Income tax', exact: true })).toBeVisible();
  return state;
}

test('declarations lead the selected tax visual and old-regime savings refresh it', async ({ page }) => {
  const state = await mockTaxProfile(page);
  const salary = tab(page);
  const declarations = salary.getByRole('region', { name: 'Declarations', exact: true });
  const incomeHeading = salary.getByRole('heading', { name: 'Income tax', exact: true });
  expect((await declarations.boundingBox()).y).toBeLessThan((await incomeHeading.boundingBox()).y);
  await expect(declarations.getByLabel('Tax regime', { exact: true })).toHaveValue('NEW');
  await expect(declarations).toContainText('Standard deduction is automatic.');
  await expect(declarations.getByLabel('80C (annual)', { exact: true })).toHaveCount(0);
  await expect(declarations.getByRole('button', { name: 'Save declarations' })).toHaveCount(0);
  await expect(salary.getByRole('heading', { name: 'Old regime', exact: true })).toHaveCount(0);
  await expect(salary.getByRole('heading', { name: 'Pay group rules', exact: true })).toHaveCount(0);
  await expect(salary.locator('details')).not.toHaveAttribute('open');
  const chart = salary.getByRole('img', { name: /^Annual income:/ });
  await expect(chart).toHaveAccessibleName('Annual income: taxable income ₹17,25,000 and allowed deductions ₹75,000, from gross taxable salary ₹18,00,000.');

  await declarations.getByLabel('Tax regime', { exact: true }).selectOption('OLD');
  await expect(declarations.getByLabel('80C (annual)', { exact: true })).toBeVisible();
  await declarations.getByLabel('80C (annual)', { exact: true }).fill('150000');
  await declarations.getByLabel('80D (annual)', { exact: true }).fill('25000');
  await declarations.getByLabel('Rent paid (monthly)', { exact: true }).fill('25000');
  await declarations.getByRole('switch', { name: 'Metro', exact: true }).click();
  await declarations.getByRole('button', { name: 'Save declarations' }).click();
  await expect.poll(() => state.requests.some((body) => body.decl_80c === 15_000_000)).toBe(true);
  expect(state.requests.find((body) => body.decl_80c === 15_000_000)).toEqual({ decl_80c: 15_000_000, decl_80d: 2_500_000, decl_rent_monthly: 2_500_000, decl_metro: true });
  await expect(chart).toHaveAccessibleName('Annual income: taxable income ₹13,65,000 and allowed deductions ₹4,35,000, from gross taxable salary ₹18,00,000.');
  await salary.getByText('Tax breakdown', { exact: true }).click();
  await expect(salary.getByRole('cell', { name: 'HRA exemption', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/payroll-statutory-old.png', fullPage: true });

  await declarations.getByLabel('Tax regime', { exact: true }).selectOption('NEW');
  await expect(declarations.getByLabel('80C (annual)', { exact: true })).toHaveCount(0);
  await expect(chart).toHaveAccessibleName('Annual income: taxable income ₹17,25,000 and allowed deductions ₹75,000, from gross taxable salary ₹18,00,000.');
  expect(state.e.statutory.decl_80c).toBe(15_000_000);
});

test('tax declarations remain selectable without a salary and show no fabricated chart', async ({ page }) => {
  const state = await mockTaxProfile(page, { noSalary: true });
  const salary = tab(page);
  await expect(salary.getByRole('img', { name: /^Annual income:/ })).toHaveCount(0);
  await expect(salary).toContainText('Add a salary agreement to calculate tax.');
  await salary.getByLabel('Tax regime', { exact: true }).selectOption('OLD');
  await expect(salary.getByLabel('80C (annual)', { exact: true })).toBeVisible();
  await salary.getByLabel('80C (annual)', { exact: true }).fill('100000');
  await salary.getByRole('button', { name: 'Save declarations' }).click();
  await expect.poll(() => state.requests.some((body) => body.decl_80c === 10_000_000)).toBe(true);
});

test('zero income tax visual stays finite and read-only declarations cannot change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockTaxProfile(page, { gross: 0, readOnly: true, current: 'OLD' });
  const salary = tab(page);
  await expect(salary.getByRole('img', { name: /^Annual income:/ })).toHaveAccessibleName('Annual income: taxable income ₹0 and allowed deductions ₹0, from gross taxable salary ₹0.');
  await expect(salary.getByLabel('Tax regime', { exact: true })).toBeDisabled();
  await expect(salary.getByLabel('80C (annual)', { exact: true })).toBeDisabled();
  await expect(salary.getByRole('button', { name: 'Save declarations' })).toBeDisabled();
  expect(await salary.getByRole('region', { name: 'Declarations' }).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(state.requests).toHaveLength(0);
  await page.screenshot({ path: '/tmp/payroll-statutory-mobile.png', fullPage: true });
});
