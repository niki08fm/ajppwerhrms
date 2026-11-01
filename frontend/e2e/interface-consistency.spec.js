import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createPayrollPreviewState, handlePayrollPreviewApi } from '../../docs/designs/payroll-preview-data.js';
import { mockPayrollJourney, YM, TOTALS } from './fixtures/payroll-journey.js';

const capture = async (page, name) => {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (process.env.INTERFACE_VISUAL_DIR) {
    await mkdir(process.env.INTERFACE_VISUAL_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.INTERFACE_VISUAL_DIR}/${name}.png`, fullPage: true });
  }
};

for (const [name, path, title] of [['employees', '/people', 'Employees'], ['salary-structures', '/setup/structures', 'Salary structures'], ['pay-groups', '/setup/pay-groups', 'Pay groups'], ['salary', 'salary', null]]) {
  test(`shared interface: ${name}`, async ({ page }) => {
    const state = createPayrollPreviewState(), errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.route('**/api/v1/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') writes.push(url.pathname);
      const result = await handlePayrollPreviewApi(state, { method: request.method(), path: url.pathname, searchParams: url.searchParams, body: request.postData() ? request.postDataJSON() : {} });
      await route.fulfill({ status: result?.status ?? 200, json: result?.json ?? { data: [] } });
    });
    await page.goto(path === 'salary' ? `/people/${state.employees[0].id}?tab=salary` : path);
    if (title) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    else await expect(page.getByRole('tab', { name: 'Salary and statutory', exact: true })).toBeVisible();
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await capture(page, name);
    expect(errors).toEqual([]); expect(writes).toEqual([]);
  });
}

for (const generated of [false, true]) {
  test(`payroll dashboard uses live data: ${generated ? 'generated' : 'draft'}`, async ({ page }) => {
    const state = await mockPayrollJourney(page, { stage: generated ? 6 : 2, generated, blocking: !generated });
    await page.route('**/api/v1/payroll/periods', route => route.fulfill({ json: { data: ['2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'].map(period_ym => ({ period_ym, state: 'PAID' })).concat(state.period), meta: { suggested: YM, current: '2026-10' } } }));
    await page.route(/\/api\/v1\/payroll\/periods\/[^/]+\/summary/, route => {
      const month = Number(new URL(route.request().url()).pathname.split('/').at(-2).slice(-2));
      const ratio = .7 + month * .03;
      const totals = Object.fromEntries(Object.entries(TOTALS).map(([key, value]) => [key, ['net','gross','employer','deductions'].includes(key) ? Math.round(value * ratio) : key === 'headcount' ? 6 + Math.floor(month / 3) : value]));
      return route.fulfill({ json: { data: { all: totals, AJ: totals, TP: totals, errors: generated ? 0 : 1 } } });
    });
    await page.goto(`/payroll/${YM}`);
    await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
    await expect(page.locator('.recharts-bar')).toHaveCount(3);
    await expect(page.locator('.recharts-line')).toHaveCount(1);
    await expect(page.getByRole('figure', { name: 'Six months of payroll cost and employee count' })).toBeVisible();
    if (!generated) {
      await expect(page.getByRole('navigation', { name: 'Payroll reviews' }).getByRole('button')).toHaveCount(6);
      await expect(page.getByRole('button', { name: 'Generate payroll', exact: true })).toBeDisabled();
    } else await expect(page.getByText('PF (ECR)', { exact: true })).toBeVisible();
    await capture(page, generated ? 'payroll-generated' : 'payroll-draft');
    expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
  });
}

for (const [mode, viewport] of [['dark', { width: 1600, height: 1120 }], ['tablet', { width: 1024, height: 768 }], ['phone', { width: 390, height: 844 }]]) {
  test(`interface remains usable in ${mode}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = await mockPayrollJourney(page, { stage: 2 });
    if (mode === 'dark') await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto(`/payroll/${YM}`);
    await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
    if (mode === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else if (viewport.width < 1024) {
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await expect(page.getByRole('navigation', { name: 'Main', exact: true }).last()).toBeVisible();
      await page.keyboard.press('Escape');
      // Close the navigation by following the existing payroll link.
      await page.getByRole('link', { name: 'Monthly payroll', exact: true }).last().click();
    }
    await capture(page, `payroll-${mode}`);
    expect(state.errors).toEqual([]); expect(state.writes).toEqual([]);
  });
}
