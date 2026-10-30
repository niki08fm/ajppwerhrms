import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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

async function mockPayslips(page, { rows = periods, today = '2030-10-10', failDetail = false, exportAllowed = true, zipRequests = [], failFirstZip = false, zipReady } = {}) {
  const details = [];
  await page.addInitScript(() => {
    window.downloads = [];
    window.open = (url) => window.downloads.push(url);
    window.zipCredentials = [];
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      if (String(input).includes('/payslips.zip')) window.zipCredentials.push(options?.credentials);
      return originalFetch(input, options);
    };
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    let data = [];
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', permissions: ['people.read', 'salary.read', 'payroll.read', ...(exportAllowed ? ['reports.export'] : [])] };
    else if (path === '/lookups') data = { today, sites: [], departments: [employee.department], pay_groups: [employee.pay_group], structures: [] };
    else if (path === `/employees/${employee.id}`) data = employee;
    else if (path === `/employees/${employee.id}/payslips`) data = rows;
    else if (path === `/employees/${employee.id}/payslips.zip`) {
      zipRequests.push({ employeeId: employee.id, year: url.searchParams.get('year') });
      if (failFirstZip && zipRequests.length === 1) return route.fulfill({ status: 503, json: { error: { message: 'The payslip download could not be prepared. Please try again.' } } });
      if (zipReady) await zipReady;
      return route.fulfill({
        contentType: 'application/zip',
        headers: { 'Content-Disposition': `attachment; filename="payslips-${employee.code}-${url.searchParams.get('year')}.zip"` },
        body: Buffer.from('504b0506000000000000000000000000000000000000', 'hex'),
      });
    }
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

test('year ZIP downloads the selected employee and year with the session cookie without navigation', async ({ page }) => {
  const requests = [];
  await mockPayslips(page, { zipRequests: requests });
  await open(page);
  await expect(tab(page).getByRole('heading', { name: 'September 2026 payslip', exact: true })).toBeVisible();
  await tab(page).getByLabel('Payslip year', { exact: true }).selectOption('2024');
  await expect(tab(page).getByRole('heading', { name: 'December 2024 payslip', exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await tab(page).getByRole('button', { name: 'Download ZIP', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('payslips-AJPAY01-2024.zip');
  expect((await readFile(await file.path())).subarray(0, 4).toString('hex')).toBe('504b0506');
  expect(requests).toEqual([{ employeeId: employee.id, year: '2024' }]);
  expect(await page.evaluate(() => window.zipCredentials)).toEqual(['include']);
  await expect(page).toHaveURL(new RegExp(`/people/${employee.id}\\?tab=payslips$`));
  await expect(page.getByText('PDF payslips downloaded in a ZIP folder', { exact: true })).toBeVisible();
});

test('empty years disable the ZIP action and export permission is required', async ({ page }) => {
  const requests = [];
  await mockPayslips(page, { zipRequests: requests });
  await open(page);
  await tab(page).getByLabel('Payslip year', { exact: true }).selectOption('2025');
  await expect(tab(page).getByRole('button', { name: 'Download ZIP', exact: true })).toBeDisabled();
  expect(requests).toEqual([]);

  const restricted = await page.context().newPage();
  await mockPayslips(restricted, { exportAllowed: false });
  await open(restricted);
  await expect(tab(restricted).getByRole('heading', { name: 'September 2026 payslip', exact: true })).toBeVisible();
  await expect(tab(restricted).getByRole('button', { name: 'Download ZIP', exact: true })).toHaveCount(0);
  await restricted.close();
});

test('a failed ZIP export leaves a clear retryable action and preserves the selected year', async ({ page }) => {
  const requests = [];
  await mockPayslips(page, { zipRequests: requests, failFirstZip: true });
  await open(page);
  const action = tab(page).getByRole('button', { name: 'Download ZIP', exact: true });
  await action.click();
  await expect(page.getByText('The payslip download could not be prepared. Please try again.', { exact: true })).toBeVisible();
  await expect(action).toBeEnabled();
  await expect(tab(page).getByLabel('Payslip year', { exact: true })).toHaveValue('2026');
  const downloaded = page.waitForEvent('download');
  await action.click();
  expect((await downloaded).suggestedFilename()).toBe('payslips-AJPAY01-2026.zip');
  expect(requests).toEqual([{ employeeId: employee.id, year: '2026' }, { employeeId: employee.id, year: '2026' }]);
});

test('ZIP preparation disables repeated downloads and fits a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  let release;
  const zipReady = new Promise((resolve) => { release = resolve; });
  await mockPayslips(page, { zipRequests: requests, zipReady });
  await open(page);
  await expect(tab(page).getByRole('heading', { name: 'September 2026 payslip', exact: true })).toBeVisible();
  const action = tab(page).getByRole('button', { name: 'Download ZIP', exact: true });
  await action.click();
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute('aria-busy', 'true');
  await action.evaluate((button) => button.click());
  expect(requests).toHaveLength(1);
  const box = await action.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const downloaded = page.waitForEvent('download');
  release();
  await downloaded;
  await expect(action).toBeEnabled();
  expect(requests).toHaveLength(1);
});
