import { expect, test } from '@playwright/test';

const request = {
  id: 'transfer:tr-1', kind: 'transfer', at: '2026-10-10T05:00:00.000Z', day: '2026-10-10',
  employee: { id: 'e-1', code: 'AJ0019', name: 'Harish Varma', department: { id: 'electrical', name: 'Electrical', colour: 'chart-1' } },
  site: { id: 'alpha', name: 'Alpha site' },
  detail: {
    transfer_request_id: 'tr-1', from_site: { id: 'alpha', name: 'Alpha site' }, to_site: { id: 'beta', name: 'Beta site' },
    departure_date: '2026-10-12', reason: 'Electrical work at Beta', requested_by: 'tablet-alpha',
  },
};

async function mockApprovals(page, { readOnly = false, failDecision = false } = {}) {
  const state = { decisions: [], approvalsReads: 0, dashboardReads: 0, items: [request] };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let data = [];
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', email: 'hr@example.test', permissions: ['attendance.read', ...(readOnly ? [] : ['attendance.write'])] };
    else if (path === '/dashboard/people') {
      state.dashboardReads++;
      data = { approvals: { total: state.items.length } };
    } else if (path === '/approvals') {
      state.approvalsReads++;
      data = { today: '2026-10-10', window_days: 7, sites: [request.site, request.detail.to_site], departments: [request.employee.department], items: state.items };
    } else if (path === '/site-transfer-requests/tr-1/decide') {
      state.decisions.push(route.request().postDataJSON());
      if (failDecision) {
        await route.fulfill({ status: 409, json: { error: { code: 'ALREADY_DECIDED', message: 'This transfer has already been decided.' } } });
        return;
      }
      state.items = [];
      data = { id: 'tr-1', status: state.decisions.at(-1).decision };
    }
    await route.fulfill({ json: { data } });
  });
  return state;
}

test('HR can review a transfer from its destination filter and approve without writing a punch', async ({ page }) => {
  const state = await mockApprovals(page);
  await page.goto('/approvals?kind=transfer&site=beta');
  await expect(page.getByRole('button', { name: 'Approve transfer' })).toBeVisible();
  await expect(page.getByText('Electrical work at Beta', { exact: true })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: 'Alpha site' })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: 'Beta site' })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: '12 October 2026' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve transfer' }).click();
  await expect(page.getByRole('button', { name: 'Approve transfer' })).toHaveCount(0);
  await expect.poll(() => state.approvalsReads).toBeGreaterThan(1);
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(1);
  expect(state.decisions).toEqual([{ decision: 'APPROVED' }]);
});

test('HR can reject a transfer with a note', async ({ page }) => {
  const state = await mockApprovals(page);
  await page.goto('/approvals?kind=transfer');
  await page.getByRole('textbox', { name: 'Note for the record' }).fill('Stay at Alpha until the work is complete.');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  expect(state.decisions).toEqual([{ decision: 'REJECTED', note: 'Stay at Alpha until the work is complete.' }]);
});

test('a reader can see a transfer but cannot approve or reject it', async ({ page }) => {
  await mockApprovals(page, { readOnly: true });
  await page.goto('/approvals?kind=transfer');
  await expect(page.getByText('Electrical work at Beta', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve transfer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  await expect(page.getByText('You can see this but not decide it.', { exact: false })).toBeVisible();
});

test('a failed transfer decision keeps the request available for review', async ({ page }) => {
  const state = await mockApprovals(page, { failDecision: true });
  await page.goto('/approvals?kind=transfer');
  await page.getByRole('button', { name: 'Approve transfer' }).click();
  await expect(page.getByText('This transfer has already been decided.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve transfer' })).toBeVisible();
  expect(state.items).toHaveLength(1);
});
