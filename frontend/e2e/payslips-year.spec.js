import { expect, test } from '@playwright/test';

const employee = {
  id: 'employee-payslips', code: 'AJPAY01', name: 'Payslip Example', designation: 'Coordinator',
  status: 'ACTIVE', joined_on: '2019-01-01', read_only: false, salary: null,
  department: { id: 'dept', name: 'Operations', colour: 'chart-1' },
  pay_group: { id: 'group', name: 'General' }, onboarding: { required_left: 0 },
  rules: {}, face: { enrolled: false }, identity: {}, statutory: {},
};
const periods = ['2020-01', '2026-01', '2024-12', '2026-09'].map((period_ym) => ({
  id: `period-${period_ym}`, period_ym, paid_days: 30, net: 3_223_000, state: 'PAID',
}));

async function mockPayslips(page, { rows = periods, today = '2030-10-10', failDetail = false } = {}) {
  const details = [];
  await page.addInitScript(() => {
    window.downloads = [];
    window.open = (url) => window.downloads.push(url);
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let data = [];
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', permissions: ['people.read', 'salary.read'] };
    else if (path === '/lookups') data = { today, sites: [], departments: [employee.department], pay_groups: [employee.pay_group], structures: [] };
    else if (path === `/employees/${employee.id}`) data = employee;
    else if (path === `/employees/${employee.id}/payslips`) data = rows;
    else if (path.startsWith('/payroll/periods/')) {
      const month = path.split('/')[3];
      details.push(month);
      if (failDetail) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'This payslip could not be found.' } } });
      data = {
        divisor: 31, paid_days: 30, lop_days: 1, net: 3_223_000,
        period: { state: 'PAID', period_ym: month },
        lines: [
          { seq: 1, code: 'basic', name: `Snapshot basic ${month}`, kind: 'COMPONENT', amount: 1_725_000 },
          { seq: 2, code: 'pf', name: 'PF employee share', kind: 'DEDUCTION', amount: 207_000 },
        ], meta: { lop_rule_text: 'Exact saved payroll values.' },
      };
    } else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/advances-loans') data = { rows: [] };
    else if (path.endsWith('/hold')) data = { current: null, history: [], open_months: [], run_months: [] };
    else if (path.endsWith('/leave-balances')) data = { types: [] };
    else if (path.endsWith('/attendance')) data = { days: [] };
    await route.fulfill({ json: { data } });
  });
  return details;
}
const tab = (page) => page.getByRole('tabpanel', { name: 'Payslips', exact: true });
const open = (page) => page.goto(`/people/${employee.id}?tab=payslips`);

test('defaults to the latest available year and month, and preserves snapshot details and PDF action', async ({ page }) => {
  const details = await mockPayslips(page);
  await open(page);
  await expect(tab(page).getByLabel('Payslip year', { exact: true })).toHaveValue('2026');
  await expect(tab(page).getByRole('heading', { name: 'September 2026 payslip', exact: true })).toBeVisible();
  await expect(tab(page).getByRole('button', { name: /January 2026/ })).toBeVisible();
  await expect(tab(page).getByRole('button', { name: /December 2024/ })).toHaveCount(0);
  await expect(tab(page).getByRole('button', { name: 'Next year', exact: true })).toBeDisabled();
  await expect(tab(page)).toContainText('Snapshot basic 2026-09');
  await expect(tab(page)).toContainText('Exact saved payroll values.');
  await tab(page).getByRole('button', { name: /January 2026/ }).click();
  await expect(tab(page).getByRole('heading', { name: 'January 2026 payslip', exact: true })).toBeVisible();
  await expect(tab(page)).toContainText('Snapshot basic 2026-01');
  await tab(page).getByRole('button', { name: 'Download PDF', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.downloads)).toEqual(['/print/payslip/2026-01/employee-payslips']);
  expect(details).toEqual(['2026-09', '2026-01']);
});

test('year arrows and picker handle interior empty years without fetching an unrelated payslip', async ({ page }) => {
  const details = await mockPayslips(page);
  await open(page);
  await expect(tab(page).getByRole('heading', { name: 'September 2026 payslip', exact: true })).toBeVisible();
  await tab(page).getByRole('button', { name: 'Previous year', exact: true }).click();
  await expect(tab(page).getByLabel('Payslip year', { exact: true })).toHaveValue('2025');
  await expect(tab(page).getByRole('heading', { name: 'No payslips in 2025', exact: true })).toBeVisible();
  await expect(tab(page).getByRole('button', { name: 'Download PDF', exact: true })).toHaveCount(0);
  expect(details).toEqual(['2026-09']);
  await tab(page).getByRole('button', { name: 'Previous year', exact: true }).click();
  await expect(tab(page).getByRole('heading', { name: 'December 2024 payslip', exact: true })).toBeVisible();
  await tab(page).getByLabel('Payslip year', { exact: true }).selectOption('2020');
  await expect(tab(page).getByRole('heading', { name: 'January 2020 payslip', exact: true })).toBeVisible();
  await expect(tab(page).getByRole('button', { name: 'Previous year', exact: true })).toBeDisabled();
  await tab(page).getByLabel('Payslip year', { exact: true }).selectOption('2026');
  await expect(tab(page).getByRole('heading', { name: 'September 2026 payslip', exact: true })).toBeVisible();
  await expect(tab(page).getByRole('button', { name: 'Next year', exact: true })).toBeDisabled();
});

test('an employee with no payslips shows the server year and a useful empty state', async ({ page }) => {
  const details = await mockPayslips(page, { rows: [], today: '2026-10-10' });
  await open(page);
  await expect(tab(page).getByLabel('Payslip year', { exact: true })).toHaveValue('2026');
  await expect(tab(page).getByRole('heading', { name: 'No payslips yet', exact: true })).toBeVisible();
  await expect(tab(page).getByRole('button', { name: 'Previous year', exact: true })).toBeDisabled();
  await expect(tab(page).getByRole('button', { name: 'Next year', exact: true })).toBeDisabled();
  expect(details).toEqual([]);
});

test('a failed snapshot shows the error rather than an indefinite loading block', async ({ page }) => {
  await mockPayslips(page, { failDetail: true });
  await open(page);
  await expect(tab(page).getByRole('alert')).toContainText('This payslip could not be found.');
  await expect(tab(page).getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
});
