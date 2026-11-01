import { expect, test } from '@playwright/test';

const employee = { id: 'employee-a', name: 'Example Anil', code: 'TEST01' };
const leaveType = { code: 'PAID', name: 'Paid leave', paid: true, balance: 12 };
const pendingLeave = { id: 'leave-1', employee, leave_name: 'Paid leave', from_date: '2026-11-02', to_date: '2026-11-02', days: 1, reason: 'Family appointment', status: 'PENDING' };
const transfer = (id, name) => ({
  id: `transfer:${id}`, kind: 'transfer', at: '2026-11-01T05:00:00Z', day: '2026-11-01',
  employee: { ...employee, id, name }, site: { id: 'alpha', name: 'Alpha site' },
  detail: { transfer_request_id: id, from_site: { id: 'alpha', name: 'Alpha site' }, to_site: { id: 'beta', name: 'Beta site' }, departure_date: '2026-11-02', reason: `Transfer for ${name}` },
});
const settlement = {
  employee: { ...employee, joined_on: '2025-01-01', last_day: '2026-10-31', exit_reason: 'RESIGNATION' },
  frozen: false, locked: false, state: 'DRAFT',
  result: { earnings: [{ code: 'LEAVE', name: 'Leave encashment', amount: 120000, days: 4, computed_days: 4 }], deductions: [], total_earnings: 120000, total_deductions: 0, net: 120000, service: { years: 1, months: 9 }, clearance: [], can_pay: true },
};

async function mockHR(page, options = {}) {
  const state = { creates: [], decisions: [], loans: [], advances: [], adjustments: [], items: [transfer('t1', 'Example Anil'), transfer('t2', 'Example Bhavana'), transfer('t3', 'Example Charan')], previewReady: true, delayPreview: false, release: null, failApproval: !!options.failApproval, failLoan: !!options.failLoan, settlementReads: 0, errors: [] };
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  page.on('pageerror', (e) => state.errors.push(e.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', ''), method = request.method();
    const body = method === 'POST' ? request.postDataJSON() : null;
    let data = [], meta = { total: 0 };
    const fail = (message) => route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message } } });
    if (path === '/auth/me') data = { name: 'Example HR', role: 'HR Admin', permissions: ['people.read', 'attendance.read', 'salary.read', 'payroll.read', 'leave.read', ...(options.readOnly ? [] : ['attendance.write', 'leave.write', 'salary.write', 'payroll.run', 'payroll.pay'])] };
    else if (path === '/lookups') data = { today: '2026-11-01', departments: [], sites: [], pay_groups: [], structures: [], leave_types: [] };
    else if (path === '/dashboard/people') data = { approvals: { total: state.items.length } };
    else if (path === '/employees') data = [employee];
    else if (path === '/advances-loans') data = { rows: [], carries: [], totals: { outstanding: 0, active: 0 } };
    else if (path === '/loans') { state.loans.push(body); if (state.failLoan) return fail('Payroll is currently locked.'); data = { id: 'loan-1' }; }
    else if (path === '/advances') { state.advances.push(body); data = { id: 'advance-1' }; }
    else if (path === '/leave/types') data = [leaveType];
    else if (path === '/leave/preview') {
      if (state.delayPreview) await new Promise((resolve) => { state.release = resolve; });
      data = { errors: state.previewReady ? [] : ['These dates overlap existing leave.'], warnings: [], working_days: 1, type: leaveType };
    } else if (path === '/leave' && method === 'GET') { data = [pendingLeave, { ...pendingLeave, id: 'leave-2', status: 'APPROVED' }]; meta = { total: 2 }; }
    else if (path === '/leave' && method === 'POST') { state.creates.push(body); data = { id: 'leave-created' }; }
    else if (path === '/leave/leave-created/decide') { state.decisions.push(body); if (state.failApproval) return fail('Approval is temporarily unavailable.'); data = { id: 'leave-created', status: 'APPROVED' }; }
    else if (path === '/approvals') data = { today: '2026-11-01', window_days: 7, sites: [], departments: [], items: state.items };
    else if (path.startsWith('/site-transfer-requests/') && path.endsWith('/decide')) {
      state.decisions.push(body);
      await new Promise((resolve) => { state.release = resolve; });
      const id = path.split('/')[2]; state.items = state.items.filter((it) => it.detail.transfer_request_id !== id); data = { status: 'APPROVED' };
    } else if (path === `/settlements/${employee.id}`) { state.settlementReads++; data = settlement; }
    else if (path === `/settlements/${employee.id}/adjust`) { state.adjustments.push(body); if (options.failAdjustment) return fail('Settlement changed. Review the current statement.'); data = {}; }
    await route.fulfill({ json: { data, meta } });
  });
  return state;
}

async function openLeave(page) {
  await page.goto('/leave?new=1');
  const dialog = page.getByRole('dialog', { name: 'Record leave' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Person', { exact: true }).selectOption(employee.id);
  await dialog.getByLabel('From', { exact: true }).fill('2026-11-02');
  await expect(dialog.getByText('1 working day of Paid leave.')).toBeVisible();
  return dialog;
}

test('approval failure retains the recorded leave and retries only approval', async ({ page }, testInfo) => {
  const state = await mockHR(page, { failApproval: true });
  const dialog = await openLeave(page);
  await dialog.getByRole('button', { name: 'Record and approve' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Approval is temporarily unavailable.');
  await expect(dialog.getByText('Leave has been recorded.', { exact: false })).toBeVisible();
  await expect(dialog.getByLabel('From', { exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('leave-approval-retry.png'), fullPage: true });
  state.failApproval = false;
  await dialog.getByRole('button', { name: 'Retry approval' }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.creates).toHaveLength(1);
  expect(state.decisions).toHaveLength(2);
  expect(state.errors).toEqual([]);
});

test('changed leave dates cannot save against the previous preview', async ({ page }) => {
  const state = await mockHR(page);
  const dialog = await openLeave(page);
  state.delayPreview = true; state.previewReady = false;
  await dialog.getByLabel('From', { exact: true }).fill('2026-11-03');
  await expect(dialog.getByRole('status')).toHaveText('Checking dates and leave balance…');
  await expect(dialog.getByRole('button', { name: 'Record and approve' })).toBeDisabled();
  await expect.poll(() => !!state.release).toBe(true); state.release();
  await expect(dialog.getByText('These dates overlap existing leave.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record and approve' })).toBeDisabled();
  expect(state.creates).toEqual([]);
});

test('bulk leave selection includes pending requests only', async ({ page }) => {
  await mockHR(page);
  await page.goto('/leave');
  await page.getByRole('checkbox', { name: 'Select all on this page' }).click();
  await expect(page.getByRole('button', { name: 'Approve 1', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select row', exact: true }).nth(1)).toBeDisabled();
});

test('loan validates repayment length and retains entered values on save failure', async ({ page }, testInfo) => {
  const state = await mockHR(page, { failLoan: true });
  await page.goto('/money');
  await page.getByRole('button', { name: 'New loan' }).click();
  const dialog = page.getByRole('dialog', { name: 'New loan' });
  await dialog.getByLabel('Person', { exact: true }).selectOption(employee.id);
  await dialog.getByLabel('Principal', { exact: true }).fill('1000');
  await dialog.getByLabel('Months', { exact: true }).fill('121');
  await expect(dialog.getByRole('button', { name: 'Record loan' })).toBeDisabled();
  await dialog.getByLabel('Months', { exact: true }).fill('3');
  await expect(dialog.getByText('Monthly repayment ₹333.34; the final instalment may be lower.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Record loan' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Payroll is currently locked.');
  await expect(dialog.getByLabel('Principal', { exact: true })).toHaveValue('1000');
  await page.screenshot({ path: testInfo.outputPath('loan-save-error.png'), fullPage: true });
  state.failLoan = false;
  await dialog.getByRole('button', { name: 'Record loan' }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.loans[1]).toMatchObject({ employee_id: employee.id, principal: 100000, months: 3 });
  expect(state.errors).toEqual([]);
});

test('advance repayment cannot exceed the recorded advance', async ({ page }) => {
  const state = await mockHR(page);
  await page.goto('/money');
  await page.getByRole('button', { name: 'New advance' }).click();
  const dialog = page.getByRole('dialog', { name: 'New advance' });
  await dialog.getByLabel('Person', { exact: true }).selectOption(employee.id);
  await dialog.getByLabel('Amount', { exact: true }).fill('1000');
  await dialog.getByLabel('Instalment per month', { exact: true }).fill('1500');
  await dialog.getByLabel('Reason', { exact: true }).fill('Travel advance');
  await expect(dialog.getByRole('button', { name: 'Record advance' })).toBeDisabled();
  await dialog.getByLabel('Instalment per month', { exact: true }).fill('500');
  await dialog.getByRole('button', { name: 'Record advance' }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.advances).toEqual([expect.objectContaining({ amount: 100000, instalment: 50000 })]);
});

test('a delayed decision does not move HR away from a newly selected request', async ({ page }) => {
  const state = await mockHR(page);
  await page.goto('/approvals?kind=transfer');
  await page.getByRole('option').filter({ hasText: 'Example Anil' }).click();
  await page.getByRole('button', { name: 'Approve transfer' }).click();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Note for the record' })).toBeDisabled();
  await page.getByRole('option').filter({ hasText: 'Example Charan' }).click();
  await expect.poll(() => !!state.release).toBe(true); state.release();
  await expect(page.getByRole('option').filter({ hasText: 'Example Anil' })).toHaveCount(0);
  await expect(page.getByRole('option').filter({ hasText: 'Example Charan' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Transfer for Example Charan', { exact: true })).toBeVisible();
  expect(state.decisions).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('settlement changes preserve the reason on failure and reject negative days', async ({ page }, testInfo) => {
  const state = await mockHR(page, { failAdjustment: true });
  await page.goto(`/exits/${employee.id}`);
  await page.getByRole('button', { name: 'Change Leave encashment' }).click();
  await page.getByRole('menuitem', { name: 'Change days…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Days for Leave encashment' });
  await dialog.getByLabel('Days', { exact: true }).fill('-1');
  await dialog.getByLabel('Reason', { exact: true }).fill('Verified leave register');
  await expect(dialog.getByRole('button', { name: 'Save settlement change' })).toBeDisabled();
  await dialog.getByLabel('Days', { exact: true }).fill('3');
  await dialog.getByRole('button', { name: 'Save settlement change' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Settlement changed. Review the current statement.');
  await expect(dialog.getByLabel('Reason', { exact: true })).toHaveValue('Verified leave register');
  await page.screenshot({ path: testInfo.outputPath('settlement-save-error.png'), fullPage: true });
  expect(state.adjustments).toEqual([{ action: 'SET_DAYS', code: 'LEAVE', days: 3, reason: 'Verified leave register' }]);
  expect(state.errors).toEqual([]);
});

test('readers have no creation or decision controls', async ({ page }) => {
  await mockHR(page, { readOnly: true });
  await page.goto('/money');
  await expect(page.getByRole('heading', { name: 'Advances and loans' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New loan' })).toHaveCount(0);
  await page.goto('/leave');
  await expect(page.getByRole('heading', { name: 'Leave', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record leave' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await page.goto(`/exits/${employee.id}`);
  await expect(page.getByText('Full and final settlement', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add earning' })).toHaveCount(0);
});

test('a save in progress keeps the form open and prevents a second submission', async ({ page }) => {
  const state = await mockHR(page);
  let finish;
  await page.route('**/api/v1/advances', async (route) => {
    state.advances.push(route.request().postDataJSON());
    await new Promise((resolve) => { finish = resolve; });
    await route.fulfill({ json: { data: { id: 'advance-delayed' } } });
  });
  await page.goto('/money');
  await page.getByRole('button', { name: 'New advance' }).click();
  const dialog = page.getByRole('dialog', { name: 'New advance' });
  await dialog.getByLabel('Person', { exact: true }).selectOption(employee.id);
  await dialog.getByLabel('Amount', { exact: true }).fill('1000');
  await dialog.getByLabel('Instalment per month', { exact: true }).fill('500');
  await dialog.getByLabel('Reason', { exact: true }).fill('Travel advance');
  await dialog.getByRole('button', { name: 'Record advance' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(dialog.getByLabel('Amount', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Record advance' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect.poll(() => !!finish).toBe(true); finish();
  await expect(dialog).not.toBeVisible();
  expect(state.advances).toHaveLength(1);
});

test('a failed preview is actionable and cannot submit leave', async ({ page }) => {
  await mockHR(page);
  await page.route('**/api/v1/leave/preview', (route) => route.fulfill({ status: 503, json: { error: { message: 'Leave balance check is unavailable.' } } }));
  await page.goto('/leave?new=1');
  const dialog = page.getByRole('dialog', { name: 'Record leave' });
  await dialog.getByLabel('Person', { exact: true }).selectOption(employee.id);
  await dialog.getByLabel('From', { exact: true }).fill('2026-11-02');
  await expect(dialog.getByRole('alert')).toContainText('Leave balance check is unavailable.');
  await expect(dialog.getByRole('button', { name: 'Record and approve' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('a saved settlement change refreshes the statement before further editing', async ({ page }) => {
  const state = await mockHR(page);
  let finish;
  await page.goto(`/exits/${employee.id}`);
  await page.getByRole('button', { name: 'Add earning', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add an earning' });
  await dialog.getByLabel('Name', { exact: true }).fill('Project bonus');
  await dialog.getByLabel('Amount', { exact: true }).fill('500');
  await dialog.getByLabel('Reason', { exact: true }).fill('Approved by payroll manager');
  await page.route(`**/api/v1/settlements/${employee.id}`, async (route) => {
    state.settlementReads++;
    await new Promise((resolve) => { finish = resolve; });
    await route.fulfill({ json: { data: { ...settlement, result: { ...settlement.result, net: 170000, total_earnings: 170000, earnings: [...settlement.result.earnings, { code: 'BONUS', name: 'Project bonus', amount: 50000 }] } } } });
  });
  await dialog.getByRole('button', { name: 'Save settlement change' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Updating settlement…');
  await expect(page.getByRole('button', { name: 'Add earning', exact: true })).toHaveCount(0);
  await expect.poll(() => !!finish).toBe(true); finish();
  await expect(page.getByText('Project bonus', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add earning', exact: true })).toBeVisible();
  expect(state.adjustments).toHaveLength(1);
});
