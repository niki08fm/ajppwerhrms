import { expect, test } from '@playwright/test';
import { createPreviewSetupData, handlePreviewSetupApi } from '../../docs/designs/payroll-preview-setup.js';

async function mockStructures(page, { copy } = {}) {
  const state = createPreviewSetupData();
  if (copy) Object.assign(state.structures[0], copy);
  const requests = { validations: [], saves: [] };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = request.postDataJSON() ?? {};
    let result;
    if (path === '/auth/me') result = { json: { data: { name: 'HR Admin', role: 'HR Admin', permissions: ['setup.read', 'setup.write'] } } };
    else if (path === '/dashboard/people') result = { json: { data: { approvals: { total: 0 } } } };
    else if (path === '/lookups') result = { json: { data: { today: '2026-10-11', pt_states: ['Telangana'], shifts: [], departments: [], pay_groups: [], structures: [] } } };
    else {
      if (path === '/structures/validate') requests.validations.push(body);
      if (path === '/structures' && request.method() === 'POST') requests.saves.push(body);
      result = await handlePreviewSetupApi(state, { method: request.method(), path, body, searchParams: url.searchParams });
    }
    await route.fulfill(result ?? { json: { data: [] } });
  });
  return { state, ...requests };
}

const componentRow = (page, name) => page.getByRole('row').filter({ has: page.getByRole('button', { name: `Remove ${name}`, exact: true }) });
const esiSwitch = (page, name) => page.getByRole('switch', { name: `${name} counts as ESI wage`, exact: true });

test('selected monthly ESI components update eligibility and save independently of PF; yearly earnings stay excluded', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const requests = await mockStructures(page);
  await page.goto('/setup/structures/new');
  await page.getByRole('textbox', { name: /^Structure name/ }).fill('Selected ESI earnings');
  for (const name of ['Basic', 'HRA', 'DA', 'Special Allowance']) await expect(esiSwitch(page, name)).toBeChecked();
  const sampleEsi = page.getByRole('switch', { name: 'ESI on for the sample', exact: true });
  await expect(sampleEsi).toBeDisabled(); // All monthly earnings total ₹24,000 initially.
  await esiSwitch(page, 'Special Allowance').click();
  await expect(sampleEsi).toBeEnabled();
  await expect(sampleEsi).toBeChecked();
  const companyEsi = page.getByRole('row').filter({ has: page.getByRole('cell', { name: /^ESI — company share/ }) });
  await expect(companyEsi).toContainText('On an ESI wage of ₹16,800');
  await page.screenshot({ path: '/tmp/esi-structure-settings.png', fullPage: true });
  await esiSwitch(page, 'HRA').click();
  await expect(companyEsi).toContainText('On an ESI wage of ₹12,000');
  await expect(componentRow(page, 'Basic').getByRole('switch', { name: 'Counts as PF wage', exact: true })).toBeChecked();
  await expect(componentRow(page, 'HRA').getByRole('switch', { name: 'Counts as PF wage', exact: true })).not.toBeChecked();

  await page.getByRole('button', { name: 'Add component', exact: true }).click();
  let bonus = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Remove component', exact: true }) });
  await bonus.getByRole('textbox', { name: 'Component name', exact: true }).fill('Annual bonus');
  bonus = componentRow(page, 'Annual bonus');
  await expect(esiSwitch(page, 'Annual bonus')).toBeChecked();
  await bonus.getByRole('combobox', { name: 'Frequency', exact: true }).selectOption('YEARLY');
  await expect(esiSwitch(page, 'Annual bonus')).toBeDisabled();
  await expect(esiSwitch(page, 'Annual bonus')).not.toBeChecked();
  await expect.poll(() => requests.validations.at(-1)?.components.find((c) => c.name === 'Annual bonus')).toMatchObject({ frequency: 'YEARLY', counts_as_esi_wages: false });
  await expect(companyEsi).toContainText('On an ESI wage of ₹12,000');
  await page.getByRole('button', { name: 'Create structure', exact: true }).click();
  await expect.poll(() => requests.saves.length).toBe(1);
  const saved = requests.saves[0].components;
  expect(saved.map((c) => [c.name, c.counts_as_esi_wages])).toEqual([
    ['Basic', true], ['HRA', false], ['DA', true], ['Annual bonus', false], ['Special Allowance', false],
  ]);
  expect(saved.find((c) => c.name === 'Basic').counts_as_wages).toBe(true);
  await expect(page.getByRole('heading', { name: 'Salary structures', exact: true })).toBeVisible();
  const savedTable = page.getByRole('table').filter({ has: page.getByRole('cell', { name: /^Annual bonus \(yearly/ }) });
  await expect(savedTable.getByRole('columnheader', { name: 'ESI wage', exact: true })).toBeVisible();
  for (const name of ['Basic', 'DA']) {
    const row = savedTable.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
    await expect(row.getByRole('cell', { name: 'ESI wage', exact: true })).toBeVisible();
  }
  for (const name of ['HRA', 'Annual bonus', 'Special Allowance']) {
    const row = savedTable.getByRole('row').filter({ has: page.getByRole('cell', name === 'Annual bonus' ? { name: /^Annual bonus \(yearly/ } : { name, exact: true }) });
    await expect(row.getByRole('cell', { name: 'ESI wage', exact: true })).toHaveCount(0);
  }
});

test('duplicating preserves selected ESI components and includes legacy monthly earnings by default', async ({ page }) => {
  const source = createPreviewSetupData().structures[0];
  source.components[1].counts_as_esi_wages = false;
  source.components[3].counts_as_esi_wages = false;
  source.components.push({
    seq: 5, name: 'Yearly incentive', calc_type: 'FIXED', calc_value: 100_000,
    max_amount: null, frequency: 'YEARLY', pay_month: 3, is_taxable: true,
    counts_as_wages: false, counts_as_esi_wages: true, colour: 'chart-5',
  });
  const requests = await mockStructures(page, { copy: source });
  await page.goto(`/setup/structures/new?from=${source.id}`);
  await expect(esiSwitch(page, 'Basic')).toBeChecked();
  await expect(esiSwitch(page, 'DA')).toBeChecked();
  await expect(esiSwitch(page, 'HRA')).not.toBeChecked();
  await expect(esiSwitch(page, 'Special Allowance')).not.toBeChecked();
  await expect(esiSwitch(page, 'Yearly incentive')).toBeDisabled();
  await expect(esiSwitch(page, 'Yearly incentive')).not.toBeChecked();
  await page.getByRole('button', { name: 'Create structure', exact: true }).click();
  await expect.poll(() => requests.saves.length).toBe(1);
  expect(requests.saves[0]).toMatchObject({ duplicated_from: source.id });
  expect(requests.saves[0].components.map((c) => [c.name, c.counts_as_esi_wages])).toEqual([
    ['Basic', true], ['HRA', false], ['DA', true], ['Yearly incentive', false], ['Special Allowance', false],
  ]);
});

test('unselecting every monthly ESI wage shows a neutral warning and keeps saving available', async ({ page }) => {
  const requests = await mockStructures(page);
  await page.goto('/setup/structures/new');
  await page.getByRole('textbox', { name: /^Structure name/ }).fill('No selected ESI earnings');
  for (const name of ['Basic', 'HRA', 'DA', 'Special Allowance']) await esiSwitch(page, name).click();
  const companyEsi = page.getByRole('row').filter({ has: page.getByRole('cell', { name: /^ESI — company share/ }) });
  await expect(companyEsi).toContainText('No monthly earnings selected as ESI wage');
  await expect(page.getByRole('button', { name: 'Create structure', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Create structure', exact: true }).click();
  await expect.poll(() => requests.saves.length).toBe(1);
  expect(requests.saves[0].components.every((c) => c.counts_as_esi_wages === false)).toBe(true);
});
