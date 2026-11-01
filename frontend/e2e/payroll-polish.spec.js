import { expect, test } from '@playwright/test';
import { mockPayrollJourney, YM } from './fixtures/payroll-journey.js';

const reviews = ['Confirm attendance', 'Confirm joiners and exits', 'Confirm employee checks', 'Confirm held salaries', 'Confirm final settlements', 'Confirm adjustments'];

test('one clear payroll journey confirms all reviews, generates, locks and records payment', async ({ page }) => {
  const state = await mockPayrollJourney(page);
  await page.goto(`/payroll/${YM}`);
  await page.getByRole('button', { name: /Attendance.*Ready to review/ }).click();
  for (const label of reviews) await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page).toHaveURL(/step=7/);
  await page.getByRole('button', { name: 'Generate payroll', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payroll reports and payslips', exact: true })).toBeVisible();
  const report = page.getByRole('combobox', { name: 'Choose payroll report' });
  for (const key of ['bank', 'pf', 'esi', 'pt', 'tds', 'settlements', 'payslips']) await report.selectOption(key);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock', exact: true }).click();
  await page.getByRole('button', { name: 'Mark paid', exact: true }).click();
  const payment = page.getByRole('dialog');
  await payment.getByRole('textbox', { name: 'Payment reference', exact: true }).fill('EXAMPLE-NEFT-001');
  await payment.getByRole('button', { name: 'Mark paid', exact: true }).click();
  await expect(page.getByText(`${YM === '2026-09' ? 'September 2026' : YM} paid · ref EXAMPLE-NEFT-001`, { exact: true })).toBeVisible();
  expect(state.writes.filter((item) => item.path.includes('/steps/'))).toHaveLength(6);
  expect(state.writes.at(-1).body.payment_ref).toBe('EXAMPLE-NEFT-001');
  expect(state.period.state).toBe('PAID');
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('generation errors stay visible with the preview and allow a deliberate retry', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, failRun: true });
  await page.goto(`/payroll/${YM}?step=7`);
  await page.getByRole('button', { name: 'Generate payroll', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The statutory rates changed.');
  await expect(page.getByRole('heading', { name: 'Generate payroll', exact: true })).toBeVisible();
  state.failRun = false;
  await page.getByRole('button', { name: 'Generate payroll', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payroll reports and payslips', exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('a failed background job keeps its reason visible after progress ends', async ({ page }) => {
  await mockPayrollJourney(page, { stage: 6, jobFailure: true });
  await page.goto(`/payroll/${YM}?step=7`);
  await page.getByRole('button', { name: 'Generate payroll', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Employee salary data changed.');
  await expect(page.getByRole('button', { name: 'Generate payroll', exact: true })).toBeEnabled();
});

test('failed payment confirmation keeps the reference and can retry without retyping', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, state: 'LOCKED', failTransition: true });
  await page.goto(`/payroll/${YM}?step=7`);
  await page.getByRole('button', { name: 'Mark paid', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Payment reference', exact: true }).fill('EXAMPLE-TRANSFER-014');
  await dialog.getByRole('button', { name: 'Mark paid', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your payment reference has been kept.');
  await expect(dialog.getByRole('textbox')).toHaveValue('EXAMPLE-TRANSFER-014');
  state.failTransition = false;
  await dialog.getByRole('button', { name: 'Mark paid', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.writes.at(-1).body.payment_ref).toBe('EXAMPLE-TRANSFER-014');
  expect(state.errors).toEqual([]);
});

test('payment saving freezes the reference and leaves the dialog open until confirmed', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, state: 'LOCKED', delayTransition: true });
  await page.goto(`/payroll/${YM}?step=7`);
  await page.getByRole('button', { name: 'Mark paid', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('EXAMPLE-TRANSFER-015');
  await dialog.getByRole('button', { name: 'Mark paid', exact: true }).click();
  await expect(dialog.getByRole('textbox')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect.poll(() => !!state.release).toBe(true); state.release();
  await expect(dialog).not.toBeVisible();
  expect(state.writes.filter((item) => item.path.endsWith('/mark-paid'))).toHaveLength(1);
});

test('viewers can read generated payroll without lock or regeneration actions', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, generated: true, readOnly: true });
  await page.goto(`/payroll/${YM}?step=7`);
  await expect(page.getByRole('heading', { name: 'Payroll reports and payslips', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More actions', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('a viewer cannot generate an otherwise ready month', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, readOnly: true });
  await page.goto(`/payroll/${YM}?step=7`);
  await expect(page.getByRole('button', { name: 'Generate payroll', exact: true })).toBeDisabled();
  await expect(page.getByText('View-only access. A payroll manager can generate this month.', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('report download actions wait for a usable report rather than exporting a failed read', async ({ page }) => {
  await mockPayrollJourney(page, { stage: 6, generated: true, reportFailure: true });
  await page.goto(`/payroll/${YM}?step=7&tab=register`);
  await expect(page.getByRole('alert')).toContainText('This report is temporarily unavailable.');
  await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'XLSX', exact: true })).toBeDisabled();
});

test('an unavailable held-salary read prevents confirming a partial review', async ({ page }) => {
  await mockPayrollJourney(page, { stage: 3 });
  await page.route('**/api/v1/held-salaries', (route) => route.fulfill({ status: 503, json: { error: { message: 'Held salaries are temporarily unavailable.' } } }));
  await page.goto(`/payroll/${YM}?step=4`);
  await expect(page.getByText('This review could not be loaded', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm held salaries', exact: true })).toBeDisabled();
});

test('a missing previous payroll is not fetched or displayed as a completed payroll cost', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 2 });
  await page.goto(`/payroll/${YM}`);
  await expect(page.getByRole('button', { name: /September 2026.*In progress/ })).toBeVisible();
  await expect(page.getByText('March 2026–August 2026 · Generated payrolls', { exact: true })).toBeVisible();
  expect(state.reads.filter((path) => path.endsWith('/summary'))).toEqual([`/payroll/periods/${YM}/summary`]);
});

test('an unavailable recovery plan cannot be silently confirmed as zero deductions', async ({ page }) => {
  await mockPayrollJourney(page, { stage: 5 });
  await page.route('**/api/v1/advances-loans', (route) => route.fulfill({ status: 503, json: { error: { message: 'Recovery plans could not be loaded.' } } }));
  await page.goto(`/payroll/${YM}?step=6`);
  await expect(page.getByRole('button', { name: 'Retry loan recoveries', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm adjustments', exact: true })).toBeDisabled();
});

test('viewers are not offered hold, exclusion or adjustment mutations during reviews', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 5, readOnly: true, blocking: true });
  await page.goto(`/payroll/${YM}?step=3`);
  await expect(page.getByRole('button', { name: 'Hold salary', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave out', exact: true })).toHaveCount(0);
  await page.goto(`/payroll/${YM}?step=4`);
  await expect(page.getByRole('button', { name: "Hold someone's salary", exact: true })).toBeDisabled();
  await page.goto(`/payroll/${YM}?step=6`);
  await expect(page.getByRole('button', { name: 'Add item', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('company-filtered review clearly states that confirmations cover both companies', async ({ page }) => {
  await mockPayrollJourney(page, { stage: 0 });
  await page.goto(`/payroll/${YM}?company=AJ&step=1`);
  await expect(page.getByText('Reviews cover both companies. The company view filters overview totals and report downloads.', { exact: true })).toBeVisible();
});

test('less frequent payroll actions explain their effect before changing anything', async ({ page }) => {
  const state = await mockPayrollJourney(page, { stage: 6, generated: true });
  await page.goto(`/payroll/${YM}?step=7`);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Generate again', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('replaces the generated figures');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Back to the steps', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Discard and go back', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
