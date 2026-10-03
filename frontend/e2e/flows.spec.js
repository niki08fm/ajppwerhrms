import { expect, test } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL ?? 'hr@ajpwer.in';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Admin@12345';

async function signIn(page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** Put a month back to DRAFT with no steps submitted, whatever state an earlier run left it in. */
async function resetMonth(page, ym) {
  await page.evaluate(async (m) => {
    const post = (p, body = {}) => fetch(`/api/v1/payroll/periods/${m}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const state = async () => (await (await fetch(`/api/v1/payroll/periods/${m}`)).json()).data.state;
    if ((await state()) === 'PAID') await post('unmark-paid');
    if ((await state()) === 'LOCKED') await post('unlock');
    if ((await state()) === 'RUN') await post('back-to-steps');
    await post('steps/1/reopen');
  }, ym);
}

test('the dashboard shows today at a glance', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('Headcount', { exact: true })).toBeVisible();
  await expect(page.getByText('Site network')).toBeVisible();
  await expect(page.getByRole('img', { name: /Site network/ })).toBeVisible();
});

test('a month runs end to end: five steps, run, reports, lock, paid', async ({ page }) => {
  await signIn(page);
  const ym = await page.evaluate(async () => (await (await fetch('/api/v1/payroll/periods')).json()).meta.suggested);
  await resetMonth(page, ym);
  await page.goto(`/payroll/${ym}?step=1`);

  await page.getByRole('button', { name: /Submit attendance/ }).click();
  await expect(page.getByText('Step 1 submitted')).toBeVisible();
  await page.getByRole('button', { name: 'Submit joiners and exits' }).click();
  await expect(page.getByText('Step 2 submitted')).toBeVisible();
  await page.getByRole('button', { name: 'Submit issues' }).click();
  await expect(page.getByText('Step 3 submitted')).toBeVisible();
  await page.getByRole('button', { name: 'Submit adhoc items' }).click();
  await expect(page.getByText('Step 4 submitted')).toBeVisible();

  await page.getByRole('button', { name: /Run payroll for/ }).click();
  await expect(page.getByRole('tab', { name: 'Salary register' })).toBeVisible({ timeout: 60_000 });

  for (const report of ['Salary register', 'Bank transfer', 'PF (ECR)', 'Change vs last month']) {
    await page.getByRole('tab', { name: report }).click();
    await expect(page.getByRole('button', { name: 'CSV' })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByText('Locked', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Mark paid' }).click();
  await page.getByLabel('Payment reference').fill(`E2E-${Date.now()}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Mark paid' }).click();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();

  await resetMonth(page, ym);
});

test('a day is marked from the register, with a reason, and reverted', async ({ page }) => {
  await signIn(page);
  const date = await page.evaluate(async () => {
    const t = (await (await fetch('/api/v1/lookups')).json()).data.today;
    const d = new Date(`${t}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  });
  await page.goto(`/attendance?date=${date}`);
  await page.getByRole('button', { name: 'Correct' }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('What the punches say')).toBeVisible();
  await drawer.getByRole('radio', { name: 'Mark the day' }).click();
  await drawer.getByRole('radio', { name: 'Half day' }).click();
  await drawer.getByLabel('Reason').fill('Sent home at noon by the site engineer (e2e)');
  await drawer.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText(/Day corrected/)).toBeVisible();

  await page.getByRole('button', { name: 'Correct' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revert' }).click();
  await expect(page.getByText('Back to what the punches say')).toBeVisible();
});

test('people: search, filter chips in the URL, open a full-screen profile', async ({ page }) => {
  await signIn(page);
  await page.goto('/people?status=ACTIVE');
  await expect(page.getByText(/Showing 1–/)).toBeVisible();
  await page.getByPlaceholder('Search name, code, designation, phone').fill('AJ00');
  await expect(page).toHaveURL(/q=AJ00/);
  await page.locator('table tbody tr').first().click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}/);
  // Income tax is a section of the Pay tab, reached from its section bar.
  await page.getByRole('tab', { name: 'Pay', exact: true }).click();
  await page.getByRole('button', { name: 'Income tax', exact: true }).click();
  await expect(page.getByText(/regime is cheaper|same tax/)).toBeVisible();
});
