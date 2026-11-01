import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockPayrollJourney, YM } from './fixtures/payroll-journey.js';

for (const [name, options, query, heading] of [
  ['overview', { stage: 2 }, '', 'Payroll'],
  ['attendance', { stage: 0 }, '?step=1', 'Step 1 · Attendance'],
  ['employee-checks', { stage: 2, blocking: true }, '?step=3', 'Step 3 · Employee checks'],
  ['adjustments', { stage: 5 }, '?step=6', 'Step 6 · One-time adjustments'],
  ['generation', { stage: 6 }, '?step=7', 'Generate payroll'],
  ['reports', { stage: 6, generated: true }, '?step=7&tab=register', 'Payroll reports and payslips'],
]) {
  test(`visual review: ${name}`, async ({ page }) => {
    const state = await mockPayrollJourney(page, options);
    await page.goto(`/payroll/${YM}${query}`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    expect(state.errors).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.PAYROLL_VISUAL_DIR) {
      await mkdir(process.env.PAYROLL_VISUAL_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.PAYROLL_VISUAL_DIR}/${name}.png`, fullPage: true });
    }
  });
}
