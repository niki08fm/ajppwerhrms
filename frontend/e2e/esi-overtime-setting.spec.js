import { expect, test } from '@playwright/test';
import { STATUTORY_MINIMUM_RATES } from '@ajpwer/shared';

for (const include of [undefined, false]) {
  test(`publishes ESI OT exclusion explicitly, with current value ${include}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let current = { id: 'rates-original', valid_from: '2026-04-01', ...STATUTORY_MINIMUM_RATES,
      esi: { ...STATUTORY_MINIMUM_RATES.esi, ...(include === false ? { include_overtime: false } : {}) } };
    const writes = [];
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace('/api/v1', '');
      let data = [];
      if (path === '/auth/me') data = { id: 'admin', name: 'HR Admin', role: 'HR Admin', permissions: ['setup.read', 'setup.write'] };
      else if (path === '/lookups') data = { today: '2026-10-31', departments: [], sites: [], pay_groups: [], structures: [], pt_states: [] };
      else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
      else if (path === '/statutory-rates') {
        if (req.method() === 'PATCH') {
          const body = req.postDataJSON();
          writes.push(body);
          current = { id: 'rates-new', ...body };
        }
        data = { current, versions: [current] };
      }
      await route.fulfill({ json: { data } });
    });
    await page.goto('/setup/statutory');
    await page.getByRole('button', { name: 'Publish new rates', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const choice = dialog.getByLabel('Overtime in ESI contributions', { exact: true });
    await expect(choice).toHaveValue(include === false ? 'exclude' : 'include');
    expect(writes).toHaveLength(0);
    await choice.selectOption('exclude');
    await dialog.getByLabel(/^Effective from/).fill('2026-10-01');
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].esi.include_overtime).toBe(false);
    expect(writes[0].valid_from).toBe('2026-10-01');
    expect(writes[0].pf).toEqual(STATUTORY_MINIMUM_RATES.pf);
    await expect(page.getByText(/Overtime is excluded by this configuration/)).toBeVisible();
    expect(errors).toEqual([]);
  });
}
