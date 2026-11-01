import { expect, test } from '@playwright/test';
import { mockPayrollJourney, YM } from './fixtures/payroll-journey.js';
import { mkdir } from 'node:fs/promises';

test('restored overview has month cards, separate totals, horizontal steps and visible cost history', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 2 });
  await page.goto(`/payroll/${YM}`);
  await expect(page.getByRole('button', { name: /September 2026.*In progress · 2 of 6/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /August 2026.*Not started/ })).toBeVisible();
  await expect(page.getByText('People in this payroll', { exact: true })).toBeVisible();
  await expect(page.getByText('Gross pay', { exact: true })).toBeVisible();
  const steps = page.getByRole('navigation', { name: 'Payroll steps' });
  await expect(steps.getByRole('button')).toHaveCount(7);
  const boxes = await steps.getByRole('button').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().y));
  expect(new Set(boxes).size).toBe(1);
  await expect(page.getByRole('heading', { name: 'Payroll cost · last six months' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.locator('.payroll-next-action')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  if (process.env.PAYROLL_VISUAL_DIR) {
    await mkdir(process.env.PAYROLL_VISUAL_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.PAYROLL_VISUAL_DIR}/restored-overview.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Continue · step 3, Employee checks', exact: true }).click();
  await expect(page).toHaveURL(/step=3/);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
