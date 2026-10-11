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
  await expect(page.getByText('In today', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Sites right now')).toBeVisible();
  await expect(page.getByText('Waiting on you')).toBeVisible();
  await expect(page.getByText('Departments right now')).toBeVisible();
  // A figure opens its people in a side panel, and from there Attendance filtered the same way.
  await page.getByRole('button', { name: /On site now/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Open in Attendance' }).click();
  await expect(page).toHaveURL(/\/attendance\?.*view=onsite/);
  await expect(page.getByRole('button', { name: /On site now/, pressed: true })).toBeVisible();
});

test('a month runs end to end: overview, five steps, generate, reports, lock, paid', async ({ page }) => {
  await signIn(page);
  const ym = await page.evaluate(async () => (await (await fetch('/api/v1/payroll/periods')).json()).meta.suggested);
  await resetMonth(page, ym);
  await page.goto(`/payroll/${ym}`);

  // The overview says where the month stopped; continuing opens that step full screen.
  await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();
  await expect(page.getByText('Payroll cost · last six months')).toBeVisible();
  await page.getByRole('button', { name: /Continue · step 1, Attendance/ }).click();

  const steps = [
    ['Submit attendance', 'Step 2 · Joiners and exits'],
    ['Submit joiners and exits', 'Step 3 · Held salary'],
    ['Submit held salaries', 'Step 4 · F&F'],
    ['Submit F&F', 'Step 5 · Adhoc'],
    ['Submit adhoc', 'Generate payroll'],
  ];
  for (const [button, next] of steps) {
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByRole('heading', { name: next })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Generate payroll' }).click();
  await expect(page.getByRole('tab', { name: 'Salary register' })).toBeVisible({ timeout: 60_000 });

  for (const report of ['Salary register', 'Bank transfer', 'PF (ECR)', 'Change vs last month']) {
    await page.getByRole('tab', { name: report }).click();
    await expect(page.getByRole('button', { name: 'CSV' })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByText(/locked · payslips are final/)).toBeVisible();

  const ref = `E2E-${Date.now()}`;
  await page.getByRole('button', { name: 'Mark paid' }).click();
  await page.getByLabel('Payment reference').fill(ref);
  await page.getByRole('dialog').getByRole('button', { name: 'Mark paid' }).click();
  await expect(page.getByText(new RegExp(`paid · ref ${ref}`))).toBeVisible();

  // Back on the overview, the month's reports are there to download.
  await page.getByRole('button', { name: 'Back to overview' }).click();
  await expect(page.getByText(/Reports and files ·/)).toBeVisible();

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
  const details = page.getByRole('dialog', { name: 'Attendance details', exact: true });
  const correction = details.getByRole('region', { name: 'Correct attendance', exact: true });
  await expect(details.getByRole('region', { name: 'Month attendance calendar', exact: true })).toBeVisible();
  await expect(details).toBeVisible();
  await correction.getByRole('radio', { name: 'Half day', exact: true }).click();
  await correction.getByLabel('Correction reason').fill('Sent home at noon by the site engineer (e2e)');
  await correction.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByText('Attendance corrected. Original punches are kept.', { exact: true })).toBeVisible();

  // The drawer keeps the day open, with its correction and original punches.
  await details.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(page.getByText('Original attendance restored', { exact: true })).toBeVisible();
});

test('monthly register: a cell per day, and a day opens the month of that person', async ({ page }) => {
  await signIn(page);
  await page.goto('/attendance?tab=month');
  await expect(page.getByRole('tab', { name: 'Monthly register' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/Showing 1–/)).toBeVisible();
  await page.locator('tbody button[aria-label*=" · "]:enabled').first().click();
  const details = page.getByRole('dialog', { name: 'Attendance details', exact: true });
  await expect(details.getByRole('region', { name: 'Month attendance calendar', exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Selected day attendance', exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Correct attendance', exact: true })).toBeVisible();
  await expect(details.getByRole('region', { name: 'Monthly attendance totals', exact: true })).toContainText('Late minutes');
  await expect(details).toBeVisible();
});

test('people: search, filter chips in the URL, open a full-screen profile', async ({ page }) => {
  await signIn(page);
  await page.goto('/people?status=ACTIVE');
  await expect(page.getByText(/Showing 1–/)).toBeVisible();
  await page.getByPlaceholder('Search name, code, designation, phone').fill('AJ00');
  await expect(page).toHaveURL(/q=AJ00/);
  await page.locator('table tbody tr').first().click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}/);
  // Hold salary on top, the breakup beside every statutory switch, declarations below.
  await page.getByRole('tab', { name: 'Salary and statutory', exact: true }).click();
  await expect(page.getByText('Take-home', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Hold salary/ })).toBeVisible();
  await expect(page.getByLabel('PT state')).toBeVisible();
  await expect(page.getByText(/regime is cheaper|same tax/)).toBeVisible();
  // The figures under the name open their tab.
  await page.getByRole('button', { name: /^Joined/ }).click();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Leave', exact: true }).click();
  await page.getByText('Loss of pay', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Loss of pay' })).toBeVisible();
});
