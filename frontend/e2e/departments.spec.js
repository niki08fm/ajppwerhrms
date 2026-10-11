import { expect, test } from '@playwright/test';

const ELECTRICAL = '00000000-0000-4000-8000-000000000091';
const CIVIL = '00000000-0000-4000-8000-000000000092';
const CREATED = '00000000-0000-4000-8000-000000000093';

async function mockDepartments(page, { readOnly = false, raceInUse = false, failRead = false, noPeopleRead = false } = {}) {
  const state = {
    rows: [
      { id: ELECTRICAL, name: 'Electrical', colour: 'chart-1', headcount: 3, assigned_count: 5, can_delete: false },
      { id: CIVIL, name: 'Civil', colour: 'chart-2', headcount: 0, assigned_count: 0, can_delete: true },
    ],
    reads: [], writes: [], unexpected: [], errors: [],
  };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname.replace('/api/v1', '');
    const method = req.method(), body = ['POST', 'PATCH'].includes(method) ? req.postDataJSON() : null;
    if (method === 'GET') state.reads.push(path);
    else state.writes.push({ path, method, body });
    let data;
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', permissions: [...(noPeopleRead ? [] : ['people.read']), 'setup.read', ...(readOnly ? [] : ['setup.write'])] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/lookups') data = { today: '2026-10-11', departments: state.rows, sites: [], structures: [], pay_groups: [] };
    else if (path === '/departments' && method === 'GET') {
      if (failRead) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Departments are temporarily unavailable.' } } });
      data = state.rows;
    } else if (path === '/departments' && method === 'POST') {
      if (state.rows.some((row) => row.name.toLowerCase() === body.name.trim().toLowerCase())) return route.fulfill({ status: 409, json: { error: { code: 'DUPLICATE_NAME', message: 'A department with this name already exists.', field: 'name' } } });
      data = { id: CREATED, ...body, headcount: 0, assigned_count: 0, can_delete: true };
      state.rows.push(data);
    } else if (path.startsWith('/departments/') && method === 'PATCH') {
      const id = path.split('/').at(-1);
      data = state.rows.find((row) => row.id === id);
      Object.assign(data, body);
    } else if (path.startsWith('/departments/') && method === 'DELETE') {
      const id = path.split('/').at(-1), row = state.rows.find((item) => item.id === id);
      if (row?.assigned_count || raceInUse) return route.fulfill({ status: 409, json: { error: { code: 'DEPARTMENT_IN_USE', message: 'Employees are assigned to this department. Move them before deleting it.' } } });
      state.rows = state.rows.filter((item) => item.id !== id);
      data = { id, deleted: true };
    } else {
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint ${method} ${path}` } } });
    }
    return route.fulfill({ json: { data } });
  });
  return state;
}

const clean = (state) => {
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
};

test('HR creates, renames and deletes an unused department with the selected chart colour', async ({ page }) => {
  const state = await mockDepartments(page);
  await page.goto('/setup/departments');
  await expect(page.getByRole('heading', { name: 'Departments', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add department', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Department name', { exact: false }).fill('Example quality team');
  await dialog.getByRole('button', { name: 'Cyan', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add department', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Example quality team', exact: true })).toBeVisible();
  expect(state.writes[0]).toEqual({ path: '/departments', method: 'POST', body: { name: 'Example quality team', colour: 'chart-3' } });
  await page.getByRole('button', { name: 'Edit Example quality team', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Department name', { exact: false }).fill('Example quality control');
  await dialog.getByRole('button', { name: 'Blue', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Example quality control', exact: true })).toBeVisible();
  expect(state.writes[1]).toEqual({ path: `/departments/${CREATED}`, method: 'PATCH', body: { name: 'Example quality control', colour: 'chart-5' } });
  await page.getByRole('button', { name: 'Delete Example quality control', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete Example quality control?');
  await dialog.getByRole('button', { name: 'Delete department', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Example quality control', exact: true })).toHaveCount(0);
  expect(state.writes[2]).toEqual({ path: `/departments/${CREATED}`, method: 'DELETE', body: null });
  expect(state.rows).toHaveLength(2);
  clean(state);
});

test('department names reject invalid input and surface duplicate-name errors without closing the draft', async ({ page }) => {
  const state = await mockDepartments(page);
  await page.goto('/setup/departments');
  await page.getByRole('button', { name: 'Add department', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Department name', { exact: false }).fill('   ');
  await dialog.getByRole('button', { name: 'Add department', exact: true }).click();
  await expect(dialog.getByText('Enter a department name.', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await dialog.getByLabel('Department name', { exact: false }).fill('a'.repeat(81));
  await dialog.getByRole('button', { name: 'Add department', exact: true }).click();
  await expect(dialog.getByText('Use 80 characters or less.', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await dialog.getByLabel('Department name', { exact: false }).fill(' Electrical ');
  await dialog.getByRole('button', { name: 'Add department', exact: true }).click();
  await expect(dialog.getByText('A department with this name already exists.', { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(state.rows).toHaveLength(2);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body.name).toBe('Electrical');
  clean(state);
});

test('department deletion is disabled for linked employee records including former employees', async ({ page }) => {
  const state = await mockDepartments(page);
  await page.goto('/setup/departments');
  await expect(page.getByRole('button', { name: 'Delete Electrical', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete Civil', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Edit Electrical', exact: true })).toBeEnabled();
  expect(state.rows[0].assigned_count).toBeGreaterThan(state.rows[0].headcount);
  expect(state.writes).toHaveLength(0);
  clean(state);
});

test('a new employee assignment blocks deletion safely after the confirmation opens', async ({ page }) => {
  const state = await mockDepartments(page, { raceInUse: true });
  await page.goto('/setup/departments');
  await page.getByRole('button', { name: 'Delete Civil', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Delete department', exact: true }).click();
  await expect(dialog.getByText('Employees are assigned to this department. Move them before deleting it.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Civil', exact: true })).toBeVisible();
  expect(state.rows).toHaveLength(2);
  expect(state.writes).toEqual([{ path: `/departments/${CIVIL}`, method: 'DELETE', body: null }]);
  clean(state);
});

test('a department reader sees headcounts without management controls', async ({ page }) => {
  const state = await mockDepartments(page, { readOnly: true });
  await page.goto('/setup/departments');
  await expect(page.getByRole('heading', { name: 'Departments', exact: true })).toBeVisible();
  await expect(page.getByText('Electrical', { exact: true })).toBeVisible();
  await expect(page.getByText('Civil', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add department', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  clean(state);
});

test('renaming a department preserves its existing custom colour until explicitly changed', async ({ page }) => {
  const state = await mockDepartments(page);
  state.rows[0].colour = '#5C4B99';
  await page.goto('/setup/departments');
  await page.getByRole('button', { name: 'Edit Electrical', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Current colour', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await dialog.getByLabel('Department name', { exact: false }).fill('Example electrical team');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Example electrical team', exact: true })).toBeVisible();
  expect(state.writes).toEqual([{ path: `/departments/${ELECTRICAL}`, method: 'PATCH', body: { name: 'Example electrical team' } }]);
  expect(state.rows[0].colour).toBe('#5C4B99');
  clean(state);
});

test('department access requires employee viewing permission and does not fetch protected data', async ({ page }) => {
  const state = await mockDepartments(page, { noPeopleRead: true });
  await page.goto('/setup/departments');
  await expect(page.getByText('You need employee viewing access to see departments.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Departments', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Departments', exact: true })).toHaveCount(0);
  expect(state.reads).not.toContain('/departments');
  expect(state.writes).toEqual([]);
  clean(state);
});
