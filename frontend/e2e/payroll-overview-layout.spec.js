import { expect, test } from '@playwright/test';
import { mockPayrollJourney, YM } from './fixtures/payroll-journey.js';

test('draft has reviews in place of totals and a visible completed-month history', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 2, blocking: true });
  await page.goto(`/payroll/${YM}`);
  const month = page.locator('.payroll-month-summary');
  await expect(month.getByRole('heading', { name: 'Review this month' })).toBeVisible();
  await expect(month.getByRole('navigation').getByRole('button')).toHaveCount(6);
  await expect(month.locator('dl')).toHaveCount(0);
  await expect(month.getByRole('button', { name: 'Generate payroll', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Payroll cost · last six months' })).toBeVisible();
  await expect(page.getByText('March 2026–August 2026 · Generated payrolls', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page).toHaveURL(/step=3/);
  expect(state.writes).toEqual([]);
});

test('generated month replaces reviews with totals and shows statutory reports', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, generated: true });
  await page.goto(`/payroll/${YM}?company=AJ`);
  await expect(page.locator('.payroll-month-summary dl')).toBeVisible();
  await expect(page.locator('.payroll-checklist')).toHaveCount(0);
  await expect(page.getByText('April 2026–September 2026 · Generated payrolls', { exact: true })).toBeVisible();
  await expect(page.getByText('PF (ECR)', { exact: true })).toBeVisible();
  await expect(page.getByText('TDS / Income tax', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Lock payroll', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Lock September 2026');
  expect(state.writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.writes.filter(w => w.path.endsWith('/lock'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Back to overview', exact: true }).click();
  await expect(page).toHaveURL(/company=AJ/);
  await expect(page.getByRole('button', { name: 'Mark paid', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

for (const action of ['Unlock', 'Mark paid']) {
  test(`locked month ${action} opens the existing confirmation before writing`, async ({ page }) => {
    const state = await mockPayrollJourney(page, { stage: 6, state: 'LOCKED' });
    await page.goto(`/payroll/${YM}`);
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(action === 'Unlock' ? 'Unlock September 2026' : 'Mark September 2026 paid');
    expect(state.writes).toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

test('viewers cannot invoke generated-month mutations from the overview', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, generated: true, readOnly: true });
  await page.goto(`/payroll/${YM}`);
  await expect(page.getByRole('button', { name: 'Open all reports', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock payroll', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
