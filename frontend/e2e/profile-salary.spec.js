import { expect, test } from '@playwright/test';

const groups = [
  {
    id: 'group-a',
    name: 'General',
    calendar_method: 'ACTUAL',
    weekly_off: ['SUN'],
  },
  {
    id: 'group-b',
    name: 'Project crew',
    calendar_method: 'ACTUAL',
    weekly_off: ['SUN'],
  },
];
const structures = [
  { id: 'structure-a', name: 'Employee structure' },
  { id: 'structure-b', name: 'Alternate structure' },
];
const rates = {
  pf: {
    employee_pct: 12,
    employer_pct: 12,
    ceiling: 2500000,
    eps_pct: 8.33,
    eps_wage_ceiling: 1500000,
    edli_pct: 0.5,
    admin_pct: 0.5,
  },
  esi: { employee_pct: 0.75, employer_pct: 3.25, ceiling: 2100000 },
};
const initial = {
  id: 'salary-current',
  mode: 'GROSS',
  amount: 3_000_000,
  monthly_gross: 3_000_000,
  valid_from: '2026-05-01',
  valid_to: null,
  structure_id: 'structure-a',
  structure: structures[0],
  reason: 'Annual review',
  can_edit: true,
  can_delete: true,
};
function preview(gross = 3_000_000) {
  return {
    gross,
    take_home: gross - 200_000,
    tds_monthly: 0,
    annual_tax: 0,
    employee_statutory: 200_000,
    structure: {
      monthly: [
        {
          name: 'Basic',
          amount: gross / 2,
          calc_type: 'PCT_GROSS',
          calc_value: 50,
        },
        { name: 'HRA', amount: gross * 0.2, calc_type: 'PCT_GROSS', calc_value: 20 },
        { name: 'DA', amount: 0, calc_type: 'FIXED', calc_value: 0 },
        { name: 'Special Allowance', amount: gross * 0.3, calc_type: 'BALANCE' },
      ],
      yearly: [{ name: 'Annual incentive', amount: 120_000, pay_month: 3 }],
    },
    pf: {
      pf_wage: gross / 2,
      employee: 180_000,
      employer_total: 180_000,
      employer_epf: 100_000,
      eps: 80_000,
      vpf: 0,
    },
    esi: { applicable: false, employee: 0, employer: 0 },
    esi_within_ceiling: false,
    pt: { state: 'Telangana', amount: 20_000 },
    pt_february: { amount: 20_000 },
    ctc: {
      employer_pf: 180_000,
      employer_esi: 0,
      monthly_cost: gross + 180_000,
      annual_ctc: (gross + 180_000) * 12 + 120_000,
    },
    solution: { ambiguous: false, gross },
  };
}

async function mockProfile(page, { noSalary = false, protectedRevision = false, emptyPayObject = false } = {}) {
  const state = {
    e: {
      id: 'employee-test',
      code: 'AJTEST01',
      name: 'Example Employee',
      designation: 'Coordinator',
      status: 'ACTIVE',
      joined_on: '2024-01-01',
      updated_at: '2026-10-07T00:00:00.000Z',
      read_only: false,
      gender: 'FEMALE',
      phone: '',
      department: { id: 'dept', name: 'Operations', colour: 'chart-1' },
      pay_group: groups[0],
      salary: noSalary ? null : { ...initial },
      identity: {},
      face: { enrolled: false },
      onboarding: { required_left: 0 },
      statutory: {
        pf_enabled: true,
        pf_restrict_to_ceiling: true,
        vpf_pct: 0,
        esi_enabled: false,
        pt_applicable: true,
        pt_state: 'Telangana',
        tax_regime_code: 'NEW',
        decl_80c: 0,
        decl_80d: 0,
        decl_rent_monthly: 0,
        decl_metro: false,
      },
      rules: {
        pay_group: groups[0],
        calendar_method: 'ACTUAL',
        weekly_off: ['SUN'],
        shift: { name: 'General', start_min: 540, end_min: 1080 },
        policies: [
          {
            id: 'ot',
            kind: 'OVERTIME',
            rules: {
              multiplier: 2,
              base: 'COMPONENTS',
              components: ['basic', 'hra', 'da'],
              counts_from: 'SHIFT_END',
              after_min: 0,
              rounding_min: 30,
            },
          },
        ],
      },
    },
    rows: noSalary
      ? []
      : [
          { ...initial },
          {
            ...initial,
            id: 'salary-old',
            valid_from: '2024-01-01',
            valid_to: '2026-04-30',
            reason: 'Initial agreement',
          },
        ],
    requests: [],
    previews: [],
  };
  if (protectedRevision)
    Object.assign(state.rows[1], {
      can_edit: false,
      can_delete: false,
      protection_reason: 'May payroll is locked.',
      deletion_reason: 'May payroll is locked.',
    });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/v1', ''),
      method = req.method();
    let data = [];
    if (path === '/auth/me')
      data = {
        name: 'HR Admin',
        role: 'HR Admin',
        email: 'hr@example.test',
        permissions: ['people.read', 'people.write', 'salary.read', 'salary.write'],
      };
    else if (path === '/lookups')
      data = {
        today: '2026-10-07',
        pay_groups: groups,
        structures,
        departments: [state.e.department],
        pt_states: ['Telangana'],
        sites: [],
      };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/advances-loans') data = { rows: [] };
    else if (path.endsWith('/hold')) data = { current: null, history: [], open_months: [], run_months: [] };
    else if (path.endsWith('/leave-balances')) data = { types: [] };
    else if (path.endsWith('/attendance')) data = { days: [] };
    else if (path.endsWith('/timeline'))
      data = [
        {
          id: 'generic-1',
          action: 'employee.update',
          at: '2026-10-07T04:00:00.000Z',
          actor: 'HR Admin',
          detail: {
            changes: { designation: { from: 'Assistant', to: 'Coordinator' } },
          },
        },
        {
          id: 'journey-1',
          action: 'employee.designation_change',
          at: '2026-10-07T04:00:00.000Z',
          actor: 'HR Admin',
          detail: {
            from: 'Assistant',
            to: 'Coordinator',
            effective_on: '2026-10-07',
          },
        },
      ];
    else if (path === '/employees/salary-preview') {
      const body = req.postDataJSON();
      state.previews.push(body);
      data = preview(body.mode === 'GROSS' ? body.amount : Math.round(body.amount / 12));
      if (body.mode === 'CTC' && body.amount === 40_000_000)
        data.solution = {
          ambiguous: true,
          gross: 3_300_000,
          alternative: { gross: 3_200_000 },
        };
    } else if (path.endsWith('/pay'))
      data = state.e.salary
        ? {
            salary: state.e.salary,
            preview: preview(state.e.salary.monthly_gross),
            rates,
          }
        : emptyPayObject
          ? { salary: null, preview: null, rates }
          : null;
    else if (path.endsWith('/tax')) data = null;
    else if (path === '/employees/employee-test/salary') {
      if (method === 'POST') {
        const body = req.postDataJSON();
        state.requests.push({ method, path, body });
        const row = {
          ...initial,
          ...body,
          id: 'salary-added',
          monthly_gross: body.mode === 'GROSS' ? body.amount : Math.round(body.amount / 12),
          structure: structures.find((s) => s.id === body.structure_id),
        };
        state.rows.unshift(row);
        state.e.salary = row;
        data = row;
      } else data = state.rows;
    } else if (path.startsWith('/employees/employee-test/salary/')) {
      const id = path.split('/').at(-1),
        body = method === 'PATCH' ? req.postDataJSON() : undefined;
      state.requests.push({ method, path, body });
      if (method === 'PATCH') {
        const index = state.rows.findIndex((r) => r.id === id);
        const row = {
          ...state.rows[index],
          ...body,
          monthly_gross: body.mode === 'GROSS' ? body.amount : Math.round(body.amount / 12),
          structure: structures.find((s) => s.id === body.structure_id),
        };
        state.rows[index] = row;
        if (state.e.salary?.id === id) state.e.salary = row;
        data = row;
      } else {
        state.rows = state.rows.filter((r) => r.id !== id);
        data = { id, deleted: true };
      }
    } else if (path.endsWith('/statutory') && method === 'PATCH') {
      const body = req.postDataJSON();
      state.requests.push({ method, path, body });
      state.e.statutory = { ...state.e.statutory, ...body };
      data = state.e.statutory;
    } else if (path === '/employees/employee-test') {
      if (method === 'PATCH') {
        const body = req.postDataJSON();
        state.requests.push({ method, path, body });
        if (body.pay_group_id) {
          state.e.pay_group = groups.find((g) => g.id === body.pay_group_id);
          state.e.rules.pay_group = state.e.pay_group;
        }
        if (body.designation) state.e.designation = body.designation;
        state.e.updated_at = '2026-10-07T00:01:00.000Z';
      }
      data = state.e;
    }
    await route.fulfill({ json: { data } });
  });
  return state;
}
const tab = (page) => page.getByRole('tabpanel', { name: 'Salary and statutory' });

test('first salary needs an explicit structure and month, including an empty pay object', async ({ page }) => {
  const state = await mockProfile(page, {
    noSalary: true,
    emptyPayObject: true,
  });
  await page.goto('/people/employee-test?tab=salary');
  await expect(tab(page).getByRole('heading', { name: 'No salary yet' }).first()).toBeVisible();
  await expect(tab(page).getByRole('region', { name: 'Salary overview', exact: true })).toHaveCount(0);
  await tab(page).getByRole('button', { name: 'Add salary', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add salary', exact: true });
  await dialog.getByLabel('Annual gross').fill('360000');
  await dialog.getByLabel('Effective month').fill('2026-10');
  await dialog.getByLabel('Reason').fill('Initial agreement');
  await expect(dialog.getByRole('button', { name: 'Add salary', exact: true })).toBeDisabled();
  await dialog.getByLabel('Salary structure').selectOption('structure-b');
  await dialog.getByRole('button', { name: 'Add salary', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((r) => r.method === 'POST').body).toEqual({
    mode: 'GROSS',
    amount: 3_000_000,
    valid_from: '2026-10-01',
    structure_id: 'structure-b',
    reason: 'Initial agreement',
  });
  await expect(
    tab(page).getByRole('heading', {
      name: 'Salary breakup · Alternate structure',
    }),
  ).toBeVisible();
});

test('statutory settings remain usable without salary and show only the selected tax regime', async ({ page }) => {
  const state = await mockProfile(page, {
    noSalary: true,
    emptyPayObject: true,
  });
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('radio', { name: 'Statutory', exact: true }).click();
  await expect(tab(page).getByRole('heading', { name: 'Applicable statutory rates' })).toHaveCount(0);
  await expect(tab(page)).not.toContainText('Basic + HRA + DA');
  await expect(tab(page).getByLabel('Tax regime', { exact: true })).toHaveValue('NEW');
  await expect(tab(page).getByRole('heading', { name: 'Declarations', exact: true })).toBeVisible();
  await expect(tab(page)).not.toContainText('undefined');
  await page.screenshot({ path: '/tmp/payroll-profile-statutory.png', fullPage: true });
  await tab(page).getByRole('switch', { name: 'PF', exact: true }).click();
  await expect.poll(() => state.requests.filter((r) => r.path.endsWith('/statutory')).length).toBe(1);
  expect(state.requests.at(-1).body).toEqual({ pf_enabled: false });
  await tab(page).getByLabel('Tax regime', { exact: true }).selectOption('OLD');
  await expect(tab(page).getByLabel('Tax regime', { exact: true })).toHaveValue('OLD');
  await tab(page).getByLabel('80C (annual)', { exact: true }).fill('120000');
  await tab(page).getByLabel('80D (annual)', { exact: true }).fill('20000');
  await tab(page).getByLabel('Rent paid (monthly)', { exact: true }).fill('15000');
  await tab(page).getByRole('button', { name: 'Save declarations', exact: true }).click();
  await expect.poll(() => state.requests.some((request) => request.body?.decl_80c === 12_000_000)).toBe(true);
  expect(state.requests.find((request) => request.body?.decl_80c === 12_000_000).body).toEqual({ decl_80c: 12_000_000, decl_80d: 2_000_000, decl_rent_monthly: 1_500_000, decl_metro: false });
  await expect(tab(page).getByRole('heading', { name: 'New regime', exact: true })).toHaveCount(0);
  await expect(tab(page).getByRole('heading', { name: 'Old regime', exact: true })).toHaveCount(0);
  await tab(page).getByRole('radio', { name: 'Salary', exact: true }).click();
  await expect(tab(page).getByRole('button', { name: 'Add salary', exact: true })).toBeVisible();
});

test('pay group changes independently while employee salary structure stays selected', async ({ page }) => {
  const state = await mockProfile(page);
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByLabel('Pay group', { exact: true }).selectOption('group-b');
  await tab(page).getByRole('button', { name: 'Save pay group', exact: true }).click();
  await expect(tab(page).getByRole('button', { name: 'Save pay group', exact: true })).toBeDisabled();
  expect(state.requests.find((r) => r.path === '/employees/employee-test').body).toEqual({
    pay_group_id: 'group-b',
    updated_at: '2026-10-07T00:00:00.000Z',
  });
  expect(state.e.salary).toMatchObject({
    amount: 3_000_000,
    structure_id: 'structure-a',
  });
  await expect(
    tab(page).getByRole('heading', {
      name: 'Salary breakup · Employee structure',
    }),
  ).toBeVisible();
  await expect(tab(page).getByRole('cell', { name: /Annual incentive/ })).toBeVisible();
  await page.screenshot({ path: '/tmp/payroll-profile-salary.png', fullPage: true });
});

test('salary revision edits use the full body and deletion retains one agreement', async ({ page }) => {
  const state = await mockProfile(page);
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('button', { name: 'Edit salary from 2026-05-01' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit salary revision' });
  await dialog.getByLabel('Annual gross').fill('420000');
  await dialog.getByLabel('Salary structure').selectOption('structure-b');
  await dialog.getByLabel('Reason').fill('Corrected agreement');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((r) => r.method === 'PATCH' && r.path.endsWith('/salary/salary-current')).body).toEqual({
    mode: 'GROSS',
    amount: 3_500_000,
    valid_from: '2026-05-01',
    structure_id: 'structure-b',
    reason: 'Corrected agreement',
  });
  await tab(page).getByRole('button', { name: 'Delete salary from 2024-01-01' }).click();
  await page.getByRole('dialog', { name: 'Delete salary revision' }).getByRole('button', { name: 'Delete revision' }).click();
  await expect(tab(page).getByRole('button', { name: 'Delete salary from 2026-05-01' })).toBeDisabled();
  expect(state.rows).toHaveLength(1);
});

test('locked payroll protects revisions with a visible reason', async ({ page }) => {
  await mockProfile(page, { protectedRevision: true });
  await page.goto('/people/employee-test?tab=salary');
  await expect(tab(page).getByRole('button', { name: 'Edit salary from 2024-01-01' })).toBeDisabled();
  await expect(tab(page).getByRole('button', { name: 'Delete salary from 2024-01-01' })).toBeDisabled();
  await expect(tab(page)).toContainText('May payroll is locked.');
});

test('editing a historical salary compares the original agreement using its effective date', async ({ page }) => {
  const state = await mockProfile(page);
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('button', { name: 'Edit salary from 2024-01-01' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit salary revision' });
  await expect.poll(() => state.previews.some((body) => body.chosen_gross === initial.monthly_gross && body.date === '2024-01-01')).toBe(true);
  await dialog.getByLabel('Effective month').fill('2024-02');
  await expect.poll(() => state.previews.some((body) => body.date === '2024-02-01')).toBe(true);
  expect(state.previews.find((body) => body.chosen_gross === initial.monthly_gross)).toMatchObject({ date: '2024-01-01', structure_id: 'structure-a' });
});

test('employee journey shows meaningful designation changes', async ({ page }) => {
  await mockProfile(page);
  await page.goto('/people/employee-test?tab=timeline');
  const journey = page.getByRole('tabpanel', { name: 'Employee journey' });
  await expect(journey.getByRole('heading', { name: 'Employee journey' })).toBeVisible();
  await expect(journey).toContainText('Designation changed');
  await expect(journey).toContainText('Assistant → Coordinator');
  await expect(journey.getByText('Designation changed', { exact: true })).toHaveCount(1);
});

test('salary setup fits a mobile dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockProfile(page, { noSalary: true });
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('button', { name: 'Add salary', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add salary', exact: true });
  await expect(dialog.getByLabel('Salary structure')).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('CTC salary waits for the latest preview and requires an explicit ambiguous gross choice', async ({ page }) => {
  const state = await mockProfile(page, {
    noSalary: true,
    emptyPayObject: true,
  });
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('button', { name: 'Add salary', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add salary', exact: true });
  await dialog.getByRole('radio', { name: 'CTC', exact: true }).click();
  await dialog.getByLabel('Annual CTC').fill('360000');
  await dialog.getByLabel('Effective month').fill('2026-10');
  await dialog.getByLabel('Salary structure').selectOption('structure-a');
  await dialog.getByLabel('Reason').fill('CTC agreement');
  const add = dialog.getByRole('button', { name: 'Add salary', exact: true });
  await expect(add).toBeEnabled();
  await dialog.getByLabel('Annual CTC').fill('400000');
  await expect(add).toBeDisabled();
  await expect(
    dialog.getByText('This CTC has two valid monthly grosses. Choose one.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(add).toBeDisabled();
  await dialog.getByRole('radio', { name: /with ESI$/ }).check();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((r) => r.method === 'POST').body).toMatchObject({
    mode: 'CTC',
    amount: 40_000_000,
    structure_id: 'structure-a',
    chosen_gross: 3_200_000,
  });
});

test('a designation can be edited without replacing an unchanged missing imported phone', async ({ page }) => {
  const state = await mockProfile(page, {
    noSalary: true,
    emptyPayObject: true,
  });
  await page.goto('/people/employee-test?tab=salary');
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Example Employee' });
  await dialog.getByLabel('Designation', { exact: true }).fill('Lead coordinator');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((r) => r.path === '/employees/employee-test').body).toEqual({
    designation: 'Lead coordinator',
    updated_at: '2026-10-07T00:00:00.000Z',
  });
  expect(state.e.phone).toBe('');
});


test('legacy tax links open the statutory subsection', async ({ page }) => {
  await mockProfile(page, { noSalary: true, emptyPayObject: true });
  await page.goto('/people/employee-test?tab=tax');
  const salary = page.getByRole('tabpanel', { name: 'Salary and statutory' });
  await expect(salary.getByRole('radio', { name: 'Statutory', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(salary.getByLabel('Tax regime', { exact: true })).toBeVisible();
  await salary.getByRole('radio', { name: 'Salary', exact: true }).click();
  await expect(salary.getByRole('button', { name: 'Add salary', exact: true })).toBeVisible();
});

test('a sole unlocked salary remains editable and cannot be deleted', async ({ page }) => {
  const state = await mockProfile(page);
  state.rows = [state.rows[0]];
  await page.goto('/people/employee-test?tab=salary');
  await expect(tab(page).getByRole('button', { name: 'Edit salary from 2026-05-01' })).toBeEnabled();
  await expect(tab(page).getByRole('button', { name: 'Delete salary from 2026-05-01' })).toBeDisabled();
  await tab(page).getByRole('button', { name: 'Edit salary from 2026-05-01' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit salary revision' });
  await expect(dialog.getByLabel('Effective month')).toHaveValue('2026-05');
  await dialog.getByLabel('Annual gross').fill('420000');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((request) => request.path.endsWith('/salary/salary-current'))).toMatchObject({ method: 'PATCH', body: { valid_from: '2026-05-01', amount: 3_500_000 } });
  expect(state.rows).toHaveLength(1);
});

test('salary overview shows calculated monthly earnings and net pay alongside editable history', async ({ page }) => {
  const state = await mockProfile(page);
  state.rows = [state.rows[0]];
  await page.goto('/people/employee-test?tab=salary');
  const overview = tab(page).getByRole('region', { name: 'Salary overview', exact: true });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole('img', { name: 'Monthly salary earnings', exact: true })).toBeVisible();
  await expect(overview).toContainText('Gross salary');
  await expect(overview).toContainText('₹30,000');
  await expect(overview).toContainText('Net pay');
  await expect(overview).toContainText('₹28,000');
  await expect(overview).toContainText('Deductions');
  await expect(overview).toContainText('₹2,000');
  await expect(overview).toContainText('Basic');
  await expect(overview).toContainText('₹15,000');
  await expect(overview).toContainText('HRA');
  await expect(overview).toContainText('₹6,000');
  await expect(overview).toContainText('DA');
  await expect(overview).toContainText('₹0');
  await expect(overview).toContainText('Special Allowance');
  await expect(overview).toContainText('₹9,000');
  const basic = overview.getByRole('button', { name: 'Basic: ₹15,000', exact: true });
  await basic.hover();
  await expect(basic).toHaveAttribute('aria-pressed', 'false');
  await basic.click();
  await expect(basic).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(10, 10);
  await expect(basic).toHaveAttribute('aria-pressed', 'true');
  await basic.click();
  await expect(basic).toHaveAttribute('aria-pressed', 'false');
  await expect(tab(page).getByRole('button', { name: 'Edit salary from 2026-05-01', exact: true })).toBeEnabled();
  await expect(tab(page).getByRole('button', { name: 'Delete salary from 2026-05-01', exact: true })).toBeDisabled();
});

test('a long salary history scrolls inside its card on desktop and mobile', async ({ page }) => {
  const state = await mockProfile(page);
  state.e.joined_on = '2014-01-01';
  state.rows = [
    { ...initial },
    ...Array.from({ length: 12 }, (_, index) => {
      const year = 2025 - index;
      return {
        ...initial,
        id: `salary-${year}`,
        monthly_gross: 1_500_000 + index * 10_000,
        valid_from: `${year}-01-01`,
        valid_to: `${year}-12-31`,
        reason: `Review ${year}`,
      };
    }),
  ];
  await page.goto('/people/employee-test?tab=salary');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const card = tab(page).getByRole('region', { name: 'Salary revisions', exact: true });
    const history = card.getByRole('region', { name: 'Salary revision history', exact: true });
    await expect(history).toBeVisible();
    await expect(history).toHaveAttribute('tabindex', '0');
    expect(await history.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await history.evaluate((element) => { element.scrollLeft = 0; });
    await history.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => history.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await history.getByRole('button', { name: 'Edit salary from 2014-01-01', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit salary revision', exact: true });
    await expect(dialog.getByLabel('Effective month')).toHaveValue('2014-01');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
});

test('a protected sole salary can be updated from the next safe month without rewriting history', async ({ page }) => {
  const state = await mockProfile(page);
  state.rows = [{ ...state.rows[0], can_edit: false, can_delete: false, next_revision_month: '2026-11', protection_reason: 'October payroll is paid.' }];
  const original = { ...state.rows[0] };
  await page.goto('/people/employee-test?tab=salary');
  await expect(tab(page).getByRole('button', { name: 'Delete salary from 2026-05-01' })).toBeDisabled();
  await tab(page).getByRole('button', { name: 'Edit salary from 2026-05-01' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update salary', exact: true });
  await expect(dialog).toContainText('Starts a new revision; previous payroll stays unchanged.');
  await expect(dialog.getByLabel('Effective month')).toHaveValue('2026-11');
  await dialog.getByLabel('Effective month').fill('2026-10');
  await dialog.getByLabel('Annual gross').fill('420000');
  await dialog.getByLabel('Reason').fill('Annual review');
  await expect(dialog.getByRole('button', { name: 'Save revision' })).toBeDisabled();
  await dialog.getByLabel('Effective month').fill('2026-11');
  await dialog.getByRole('button', { name: 'Save revision' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.filter((request) => request.method === 'PATCH' && request.path.includes('/salary/'))).toHaveLength(0);
  expect(state.requests.find((request) => request.method === 'POST' && request.path.endsWith('/salary')).body).toMatchObject({ valid_from: '2026-11-01', amount: 3_500_000 });
  expect(state.rows.find((row) => row.id === original.id)).toEqual(original);
});

test('editing a legacy salary keeps its exact day when its original month is restored', async ({ page }) => {
  const state = await mockProfile(page);
  state.rows[1].valid_from = '2024-01-17';
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('button', { name: 'Edit salary from 2024-01-17' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit salary revision' });
  await dialog.getByLabel('Effective month').fill('2024-02');
  await dialog.getByLabel('Effective month').fill('2024-01');
  await dialog.getByLabel('Reason').fill('Corrected structure');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((request) => request.path.endsWith('/salary/salary-old')).body.valid_from).toBe('2024-01-17');
});

test('a first salary selected in the joining month starts on the joining day', async ({ page }) => {
  const state = await mockProfile(page, { noSalary: true, emptyPayObject: true });
  state.e.joined_on = '2024-01-17';
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('button', { name: 'Add salary', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add salary', exact: true });
  await dialog.getByLabel('Annual gross').fill('360000');
  await dialog.getByLabel('Effective month').fill('2024-01');
  await dialog.getByLabel('Salary structure').selectOption('structure-a');
  await dialog.getByLabel('Reason').fill('Joining agreement');
  await dialog.getByRole('button', { name: 'Add salary', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.requests.find((request) => request.method === 'POST' && request.path.endsWith('/salary')).body.valid_from).toBe('2024-01-17');
});
