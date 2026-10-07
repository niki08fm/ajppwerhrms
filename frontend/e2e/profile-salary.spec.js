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

test('first salary needs an explicit structure and date, including an empty pay object', async ({ page }) => {
  const state = await mockProfile(page, {
    noSalary: true,
    emptyPayObject: true,
  });
  await page.goto('/people/employee-test?tab=salary');
  await expect(tab(page).getByRole('heading', { name: 'No salary yet' }).first()).toBeVisible();
  await tab(page).getByRole('button', { name: 'Add salary', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add salary', exact: true });
  await dialog.getByLabel('Annual gross').fill('360000');
  await dialog.getByLabel('Effective from').fill('2026-10-01');
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

test('statutory settings and component-based overtime rules remain usable without salary', async ({ page }) => {
  const state = await mockProfile(page, {
    noSalary: true,
    emptyPayObject: true,
  });
  await page.goto('/people/employee-test?tab=salary');
  await tab(page).getByRole('radio', { name: 'Statutory', exact: true }).click();
  await expect(tab(page).getByRole('heading', { name: 'Applicable statutory rates' })).toBeVisible();
  await expect(tab(page)).toContainText('Basic + HRA + DA');
  await expect(tab(page)).not.toContainText('undefined');
  await page.screenshot({ path: '/tmp/payroll-profile-statutory.png', fullPage: true });
  await tab(page).getByRole('switch', { name: 'PF', exact: true }).click();
  await expect.poll(() => state.requests.filter((r) => r.path.endsWith('/statutory')).length).toBe(1);
  expect(state.requests.at(-1).body).toEqual({ pf_enabled: false });
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
  await dialog.getByLabel('Effective from').fill('2024-02-01');
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
  await dialog.getByLabel('Effective from').fill('2026-10-01');
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
  await expect(salary.getByRole('heading', { name: 'Applicable statutory rates' })).toBeVisible();
  await salary.getByRole('radio', { name: 'Salary', exact: true }).click();
  await expect(salary.getByRole('button', { name: 'Add salary', exact: true })).toBeVisible();
});
