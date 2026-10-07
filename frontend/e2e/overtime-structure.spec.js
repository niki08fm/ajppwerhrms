import { expect, test } from '@playwright/test';

const SAMPLE_STRUCTURE = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Sample salary',
  components: [], validation: { errors: [], warnings: [] },
  sample: {
    gross: 2_400_000, basic: 1_200_000, hra: 480_000, da: 200_000, yearly: [],
    monthly: [{ name: 'Basic', amount: 1_200_000 }, { name: 'HRA', amount: 480_000 }, { name: 'DA', amount: 200_000 }, { name: 'Special Allowance', amount: 520_000 }],
  },
};

function builderPreview(components) {
  const monthly = components.map((c) => ({ ...c, amount: c.name === 'Basic' ? 1_200_000 : c.name === 'HRA' ? 480_000 : c.calc_type === 'BALANCE' ? 720_000 : 0 }));
  return {
    errors: [], warnings: [], pt_state: 'Andhra Pradesh',
    rates: { pf: { ceiling: 1_500_000, eps_wage_ceiling: 1_500_000, employee_pct: 12, employer_pct: 12, eps_pct: 8.33 }, esi: { ceiling: 2_100_000, employee_pct: 0.75, employer_pct: 3.25 } },
    breakup: {
      gross: 2_400_000, take_home: 2_256_000, esi_within_ceiling: false, solution: null,
      structure: { monthly, yearly: [], over_budget: false },
      ctc: { annual_ctc: 30_528_000, monthly_cost: 2_544_000, employer_pf: 144_000, employer_esi: 0 },
      pf: { employee: 144_000, employer_total: 144_000, employer_epf: 144_000, eps: 0, pf_wage: 1_200_000, vpf: 0 },
      esi: { applicable: false, employee: 0, employer: 0 }, pt: { amount: 0 }, pt_february: { amount: 0 },
      employee_statutory: 144_000, annual_tax: 0, tds_monthly: 0,
    },
  };
}

async function mockSetup(page) {
  const writes = [];
  const validations = [];
  const policies = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    let data;
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', permissions: ['setup.read', 'setup.write', 'attendance.read'] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/lookups') data = { today: '2026-10-07', pt_states: ['Andhra Pradesh'], shifts: [], structures: [], departments: [], pay_groups: [] };
    else if (path === '/structures/validate') {
      const body = request.postDataJSON();
      validations.push(body);
      data = builderPreview(body.components);
    } else if (request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push({ path, body });
      data = { id: SAMPLE_STRUCTURE.id, policy_key: SAMPLE_STRUCTURE.id, version: 1, ...body, pay_groups: [] };
      if (path === '/policies') policies.push(data);
    } else if (path === '/structures') data = [SAMPLE_STRUCTURE];
    else if (path === '/policies') data = policies;
    else if (path === '/overtime') data = [{
      employee: { id: SAMPLE_STRUCTURE.id, name: 'Site engineer', code: 'T001', department: { name: 'Electrical' } },
      ot_min: 120, paid_min: 120, excess_min: 0, hourly: 6000, multiplier: 2,
      base: 'COMPONENTS', components: ['basic', 'da'], policy: { name: 'Site overtime', version: 2 },
      amount: 24000, offday_days: 0, offday_amount: 0, over_cap: false,
    }];
    else data = [];
    await route.fulfill({ json: { data } });
  });
  return { writes, validations };
}

async function openOvertime(page) {
  await page.goto('/setup/policies?kind=OVERTIME&new=1');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Site overtime');
  await dialog.getByLabel(/^Effective from/).fill('2026-10-07');
  return dialog;
}

test('OT uses independently selected Basic/HRA/DA amounts for the sample and submitted rule', async ({ page }) => {
  const { writes } = await mockSetup(page);
  const dialog = await openOvertime(page);
  await expect(dialog.getByRole('combobox', { name: 'Worked out on', exact: true })).toHaveValue('COMPONENTS');
  await expect(dialog.getByRole('checkbox', { name: 'Basic', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'HRA', exact: true })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'HRA', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'DA', exact: true }).check();
  await expect(dialog).toContainText('Basic + DA is ₹14,000');
  await expect(dialog).toContainText('₹67.31'); // ₹14,000 ÷ (26 × 8).
  await dialog.getByRole('checkbox', { name: 'HRA', exact: true }).check();
  await expect(dialog).toContainText('Basic + HRA + DA is ₹18,800');
  await expect(dialog).toContainText('₹90.38');
  await dialog.getByRole('checkbox', { name: 'HRA', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Create policy', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ path: '/policies', body: { kind: 'OVERTIME', rules: { base: 'COMPONENTS', components: ['basic', 'da'] } } });
});

test('an empty OT selection blocks save and Gross clears component selections', async ({ page }) => {
  const { writes } = await mockSetup(page);
  const dialog = await openOvertime(page);
  await dialog.getByRole('checkbox', { name: 'Basic', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'HRA', exact: true }).uncheck();
  await expect(dialog.getByRole('alert')).toHaveText('Select at least one salary component.');
  await expect(dialog.getByRole('button', { name: 'Create policy', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await dialog.getByRole('combobox', { name: 'Worked out on', exact: true }).selectOption('GROSS');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog).toContainText('Gross is ₹24,000');
  await expect(dialog).toContainText('₹115.38');
  await dialog.getByRole('button', { name: 'Create policy', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.rules.base).toBe('GROSS');
  expect(writes[0].body.rules).not.toHaveProperty('components');
});

test('OT examples and policy summaries distinguish low, zero and unlimited monthly caps', async ({ page }) => {
  const { writes } = await mockSetup(page);
  const dialog = await openOvertime(page);
  await dialog.getByRole('spinbutton', { name: 'Days divisor', exact: true }).fill('25');
  const cap = dialog.getByRole('spinbutton', { name: 'Monthly cap (minutes)', exact: true });
  await cap.fill('120');
  await expect(dialog.getByText('2h', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('ten hours of overtime at 2× pays ₹336');
  await cap.fill('0');
  await expect(dialog.getByText('0m', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('ten hours of overtime at 2× pays ₹0');
  await expect(dialog).toContainText('Anything above 0m a month is unpaid');
  await cap.fill('');
  await expect(dialog.getByText('No cap', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('ten hours of overtime at 2× pays ₹1,680');
  await cap.fill('0');
  await dialog.getByRole('button', { name: 'Create policy', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.rules.monthly_cap_min).toBe(0);
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Site overtime', exact: true }) })).toContainText('cap 0h');
});

test('a new structure starts with zero DA and remains valid when DA is removed', async ({ page }) => {
  const { writes, validations } = await mockSetup(page);
  await page.goto('/setup/structures/new');
  const daRow = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Remove DA', exact: true }) });
  await expect(daRow.getByRole('textbox', { name: 'Component name', exact: true })).toHaveValue('DA');
  await expect(daRow.getByRole('textbox', { name: 'Fixed amount', exact: true })).toHaveValue('0');
  await expect(daRow.getByRole('switch', { name: 'Counts as PF wage', exact: true })).toBeChecked();
  await expect.poll(() => validations.length).toBeGreaterThan(0);
  expect(validations[0].components.find((c) => c.name === 'DA')).toMatchObject({ calc_type: 'FIXED', calc_value: 0, frequency: 'MONTHLY' });
  await page.getByRole('textbox', { name: /^Structure name/ }).fill('Optional DA structure');
  await page.getByRole('button', { name: 'Remove DA', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Component name', exact: true })).toHaveCount(2);
  await expect.poll(() => validations.at(-1)?.components.some((c) => c.name === 'DA')).toBe(false);
  const save = page.getByRole('button', { name: 'Create structure', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].path).toBe('/structures');
  expect(writes[0].body.components.map((c) => c.name)).toEqual(['Basic', 'HRA', 'Special Allowance']);
});

test('the Overtime table displays the selected component base together with hours, rate and pay', async ({ page }) => {
  await mockSetup(page);
  await page.goto('/overtime');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Site engineer T001', exact: true }) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('2× on Basic + DA');
  await expect(row).toContainText('Site overtime v2');
  await expect(row.getByRole('cell', { name: '2h', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '₹60.00', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '₹240', exact: true })).toBeVisible();
  await expect(row).not.toContainText('undefined');
});
