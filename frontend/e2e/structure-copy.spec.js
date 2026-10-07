import { expect, test } from '@playwright/test';
import { createPreviewSetupData, previewSalary } from '../../docs/designs/payroll-preview-setup.js';

test('a failed duplicate load shows retry and preserves the original components after retrying', async ({ page }) => {
  const state = createPreviewSetupData();
  const source = state.structures[0];
  let requests = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    let data;
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', permissions: ['setup.read', 'setup.write'] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/lookups') data = { today: '2026-10-07', pt_states: ['Telangana'], shifts: [], structures: [], departments: [], pay_groups: [] };
    else if (path === `/structures/${source.id}`) {
      requests++;
      if (requests === 1) {
        await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'The selected salary structure could not be loaded.' } } });
        return;
      }
      data = source;
    } else if (path === '/structures/validate') {
      const body = request.postDataJSON();
      data = { ...previewSalary(state, { ...body.sample, components: body.components }), errors: [], warnings: [] };
    } else data = [];
    await route.fulfill({ json: { data } });
  });
  await page.goto(`/setup/structures/new?from=${source.id}`);
  await expect(page.getByRole('alert')).toContainText('The selected salary structure could not be loaded.');
  await expect(page.getByRole('button', { name: 'Create structure', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Structure name/ })).toHaveValue(`${source.name} (copy)`);
  const daRow = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Remove DA', exact: true }) });
  await expect(daRow.getByRole('textbox', { name: 'Component name', exact: true })).toHaveValue('DA');
  await expect(daRow.getByRole('textbox', { name: 'Percent', exact: true })).toHaveValue('10');
  const basicRow = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Remove Basic', exact: true }) });
  await expect(basicRow.getByRole('combobox', { name: 'Frequency', exact: true }).locator('option[value="YEARLY"]')).toBeDisabled();
  const hraRow = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Remove HRA', exact: true }) });
  await expect(hraRow.getByRole('combobox', { name: 'Frequency', exact: true }).locator('option[value="YEARLY"]')).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Salary breakup', exact: true })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('whichever pay group');
  expect(requests).toBe(2);
});
