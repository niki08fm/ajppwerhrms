import { expect, test } from '@playwright/test';

const KEY = '00000000-0000-4000-8000-000000000071';
const GROUP = { id: '00000000-0000-4000-8000-000000000081', name: 'Example site workforce' };
const NAME = 'Example site attendance';
const ATTACHED_REASON = 'Remove this policy from its pay groups before deleting its only version.';
const FROZEN_REASON = 'Used by locked payroll. Unlock that payroll before changing this policy version.';
const previousDay = (day) => new Date(new Date(`${day}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);

async function mockPolicies(page, { single = false, attached = true, frozen = false, staleEdit = false, staleDelete = false, readOnly = false, noRead = false, failHistory = false } = {}) {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  const state = {
    rows: [
      { version: 1, valid_from: '2026-04-01', valid_to: single ? null : '2026-05-31', grace: 10 },
      ...(!single ? [{ version: 2, valid_from: '2026-06-01', valid_to: '2026-08-31', grace: 15 }, { version: 3, valid_from: '2026-09-01', valid_to: null, grace: 20 }] : []),
    ].map((version) => ({
      id: `00000000-0000-4000-8000-00000000007${version.version + 1}`,
      policy_key: KEY, kind: 'ATTENDANCE', name: NAME, version: version.version,
      valid_from: version.valid_from, valid_to: version.valid_to, created_by: 'Example HR',
      rules: { standard_min: 540, half_day_min: 0, half_day_upto_min: 240, grace_min: version.grace },
      pay_groups: attached ? [GROUP] : [],
    })),
    reads: [], writes: [], unexpected: [], errors: [], failHistory,
  };
  const view = (row) => {
    const protectedVersion = frozen && row.version === 1;
    return {
      ...row, can_edit: !protectedVersion,
      can_delete: !protectedVersion && !(state.rows.length === 1 && row.pay_groups.length),
      protection_reason: protectedVersion ? FROZEN_REASON : null,
      deletion_reason: protectedVersion ? FROZEN_REASON : state.rows.length === 1 && row.pay_groups.length ? ATTACHED_REASON : null,
    };
  };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', ''), method = request.method();
    const body = ['POST', 'PATCH'].includes(method) ? request.postDataJSON() : null;
    if (method === 'GET') state.reads.push(path);
    else state.writes.push({ path, method, body });
    let data;
    if (path === '/auth/me') data = { name: 'Example HR', role: 'HR Admin', permissions: ['people.read', ...(noRead ? [] : ['setup.read']), ...(readOnly ? [] : ['setup.write'])] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/lookups') data = { today: '2026-10-11', departments: [], sites: [], structures: [], pay_groups: [GROUP] };
    else if (path === '/structures' && method === 'GET') data = [];
    else if (path === '/policies' && method === 'GET') data = state.rows.map(view);
    else if (path === `/policies/${KEY}/versions` && method === 'GET') {
      if (state.failHistory) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Policy history is temporarily unavailable.' } } });
      data = [...state.rows].sort((a, b) => b.version - a.version).map(view);
    } else if (path.startsWith(`/policies/${KEY}/versions/`) && method === 'PATCH') {
      if (staleEdit) return route.fulfill({ status: 409, json: { error: { code: 'POLICY_PROTECTED', message: FROZEN_REASON } } });
      const row = state.rows.find((item) => item.version === Number(path.split('/').at(-1)));
      if (body.valid_from) {
        const ordered = [...state.rows].sort((a, b) => a.version - b.version), index = ordered.findIndex((item) => item.id === row.id);
        if ((ordered[index - 1] && body.valid_from <= ordered[index - 1].valid_from) || (ordered[index + 1] && body.valid_from >= ordered[index + 1].valid_from)) {
          return route.fulfill({ status: 422, json: { error: { code: 'VALIDATION', field: 'valid_from', message: 'Keep the effective date between the neighbouring versions.' } } });
        }
        if (ordered[index - 1]) ordered[index - 1].valid_to = previousDay(body.valid_from);
      }
      Object.assign(row, body);
      data = view(row);
    } else if (path.startsWith(`/policies/${KEY}/versions/`) && method === 'DELETE') {
      if (staleDelete) return route.fulfill({ status: 409, json: { error: { code: 'POLICY_PROTECTED', message: FROZEN_REASON } } });
      const row = state.rows.find((item) => item.version === Number(path.split('/').at(-1)));
      const predecessor = state.rows.filter((item) => item.version < row.version).sort((a, b) => b.version - a.version)[0];
      if (predecessor) predecessor.valid_to = row.valid_to;
      state.rows = state.rows.filter((item) => item.id !== row.id);
      data = { id: row.id, policy_key: KEY, version: row.version, deleted: true };
    } else {
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint ${method} ${path}` } } });
    }
    return route.fulfill({ json: { data } });
  });
  return state;
}

const historyButton = (page) => page.getByRole('button', { name: `Version history for ${NAME}`, exact: true });
const historyDialog = (page) => page.getByRole('dialog', { name: 'Version history', exact: true });
const clean = (state) => {
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
};

test('a sole attached version remains editable and its history explains why deletion is blocked', async ({ page }) => {
  const state = await mockPolicies(page, { single: true });
  await page.goto('/setup/policies');
  await historyButton(page).click();
  const history = historyDialog(page);
  await expect(history.getByRole('button', { name: 'Edit v1', exact: true })).toBeEnabled();
  await expect(history.getByRole('button', { name: 'Delete v1', exact: true })).toBeDisabled();
  await expect(history).toContainText(ATTACHED_REASON);
  await history.getByRole('button', { name: 'Edit v1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `Edit ${NAME} · v1`, exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  clean(state);
});

test('editing a version updates its name, date and rules with a live example, preserving version history', async ({ page }) => {
  const state = await mockPolicies(page);
  await page.goto('/setup/policies');
  await historyButton(page).click();
  await historyDialog(page).getByRole('button', { name: 'Edit v2', exact: true }).click();
  const editor = page.getByRole('dialog', { name: `Edit ${NAME} · v2`, exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Example adjusted attendance');
  await editor.getByLabel('Effective from', { exact: false }).fill('2026-07-01');
  await editor.getByLabel('Grace (minutes)', { exact: false }).fill('45');
  await expect(editor).toContainText('Coming in up to 45 minutes after shift start is on time');
  await page.screenshot({ path: '/tmp/policy-version-desktop-edit.png' });
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: `/policies/${KEY}/versions/2`, method: 'PATCH', body: { name: 'Example adjusted attendance', valid_from: '2026-07-01', rules: { grace_min: 45 } } });
  expect(state.rows.map((row) => row.version)).toEqual([1, 2, 3]);
  expect(state.rows[0].valid_to).toBe('2026-06-30');
  await expect(historyDialog(page)).toContainText('2026-07-01');
  await expect(historyDialog(page)).toContainText('45 min grace');
  clean(state);
});

test('deleting the latest version requires confirmation and restores the prior date coverage', async ({ page }) => {
  const state = await mockPolicies(page);
  await page.goto('/setup/policies');
  await historyButton(page).click();
  await historyDialog(page).getByRole('button', { name: 'Delete v3', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: `Delete ${NAME} · v3?`, exact: true });
  await expect(confirmation).toContainText('Example site workforce');
  await expect(confirmation).toContainText('Version 2');
  await page.screenshot({ path: '/tmp/policy-version-desktop-delete.png' });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.writes).toEqual([]);
  await historyDialog(page).getByRole('button', { name: 'Delete v3', exact: true }).click();
  await page.getByRole('dialog', { name: `Delete ${NAME} · v3?`, exact: true }).getByRole('button', { name: 'Delete version', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(historyDialog(page).getByRole('button', { name: 'Edit v3', exact: true })).toHaveCount(0);
  await expect(historyDialog(page).getByRole('button', { name: 'Edit v2', exact: true })).toBeVisible();
  expect(state.writes).toEqual([{ path: `/policies/${KEY}/versions/3`, method: 'DELETE', body: null }]);
  expect(state.rows.map((row) => row.version)).toEqual([1, 2]);
  expect(state.rows[1].valid_to).toBeNull();
  clean(state);
});

test('editing an effective date respects the preceding version and the edited version’s finite end', async ({ page }) => {
  const state = await mockPolicies(page);
  state.rows[2].valid_to = '2026-10-31';
  await page.goto('/setup/policies');
  await page.getByRole('button', { name: `Edit ${NAME} v3`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: `Edit ${NAME} · v3`, exact: true });
  const date = editor.getByLabel('Effective from', { exact: false });
  await date.fill('2026-11-01');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(date).toHaveAttribute('aria-invalid', 'true');
  await expect(editor).toContainText('on or before 2026-10-31');
  expect(state.writes).toEqual([]);
  await date.fill('2026-06-01');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(date).toHaveAttribute('aria-invalid', 'true');
  expect(state.writes).toEqual([]);
  await date.fill('2026-10-01');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(state.writes).toEqual([{ path: `/policies/${KEY}/versions/3`, method: 'PATCH', body: { valid_from: '2026-10-01' } }]);
  expect(state.rows[2].valid_to).toBe('2026-10-31');
  clean(state);
});

test('an unused unattached sole version can be deleted', async ({ page }) => {
  const state = await mockPolicies(page, { single: true, attached: false });
  await page.goto('/setup/policies');
  await historyButton(page).click();
  await historyDialog(page).getByRole('button', { name: 'Delete v1', exact: true }).click();
  await page.getByRole('dialog', { name: `Delete ${NAME} · v1?`, exact: true }).getByRole('button', { name: 'Delete version', exact: true }).click();
  await expect(historyButton(page)).toHaveCount(0);
  expect(state.rows).toEqual([]);
  expect(state.writes).toEqual([{ path: `/policies/${KEY}/versions/1`, method: 'DELETE', body: null }]);
  clean(state);
});

test('deleting the first version explains the uncovered period and keeps the next version start unchanged', async ({ page }) => {
  const state = await mockPolicies(page);
  await page.goto('/setup/policies');
  await historyButton(page).click();
  await historyDialog(page).getByRole('button', { name: 'Delete v1', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: `Delete ${NAME} · v1?`, exact: true });
  await expect(confirmation).toContainText('2026-06-01');
  await expect(confirmation).toContainText(/default|fallback/i);
  await confirmation.getByRole('button', { name: 'Delete version', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(state.rows.map((row) => row.version)).toEqual([2, 3]);
  expect(state.rows[0].valid_from).toBe('2026-06-01');
  clean(state);
});

test('frozen payroll versions show disabled edit and delete actions with the protection reason', async ({ page }) => {
  const state = await mockPolicies(page, { frozen: true });
  await page.goto('/setup/policies');
  await historyButton(page).click();
  const history = historyDialog(page);
  await expect(history.getByRole('button', { name: 'Edit v1', exact: true })).toBeDisabled();
  await expect(history.getByRole('button', { name: 'Delete v1', exact: true })).toBeDisabled();
  await expect(history).toContainText(FROZEN_REASON);
  await expect(history.getByRole('button', { name: 'Edit v2', exact: true })).toBeEnabled();
  await expect(history.getByRole('button', { name: 'Delete v3', exact: true })).toBeEnabled();
  await page.screenshot({ path: '/tmp/policy-version-desktop-history.png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/policy-version-desktop-history-dark.png', animations: 'disabled' });
  expect(state.writes).toEqual([]);
  clean(state);
});

test('a newly frozen payroll is reported when saving an open edit without losing the draft', async ({ page }) => {
  const state = await mockPolicies(page, { staleEdit: true });
  await page.goto('/setup/policies');
  await page.getByRole('button', { name: `Edit ${NAME} v3`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: `Edit ${NAME} · v3`, exact: true });
  await editor.getByLabel('Grace (minutes)', { exact: false }).fill('35');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor).toContainText(FROZEN_REASON);
  await expect(editor.getByLabel('Grace (minutes)', { exact: false })).toHaveValue('35');
  expect(state.rows[2].rules.grace_min).toBe(20);
  expect(state.writes).toHaveLength(1);
  clean(state);
});

test('a newly frozen payroll blocks an already-open delete confirmation safely', async ({ page }) => {
  const state = await mockPolicies(page, { staleDelete: true });
  await page.goto('/setup/policies');
  await page.getByRole('button', { name: `Delete ${NAME} v3`, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: `Delete ${NAME} · v3?`, exact: true });
  await confirmation.getByRole('button', { name: 'Delete version', exact: true }).click();
  await expect(confirmation).toContainText(FROZEN_REASON);
  expect(state.rows).toHaveLength(3);
  expect(state.writes).toEqual([{ path: `/policies/${KEY}/versions/3`, method: 'DELETE', body: null }]);
  clean(state);
});

test('policy readers can inspect history without any management actions', async ({ page }) => {
  const state = await mockPolicies(page, { readOnly: true });
  await page.goto('/setup/policies');
  await historyButton(page).click();
  await expect(historyDialog(page)).toContainText('2026-09-01');
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New policy', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish new version', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  clean(state);
});

test('a user without setup viewing access does not fetch policies or version history', async ({ page }) => {
  const state = await mockPolicies(page, { noRead: true });
  await page.goto('/setup/policies?new=1&kind=ATTENDANCE');
  await expect(page.getByRole('button', { name: 'New policy', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/viewing access|permission|access to view/i).first()).toBeVisible();
  expect(state.reads.filter((path) => path.startsWith('/policies'))).toEqual([]);
  expect(state.writes).toEqual([]);
  clean(state);
});

test('history errors are recoverable and phone dialogs keep their actions within the screen', async ({ page }) => {
  const state = await mockPolicies(page, { failHistory: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/setup/policies');
  await historyButton(page).click();
  const history = historyDialog(page);
  await expect(history).toContainText('Policy history is temporarily unavailable.');
  state.failHistory = false;
  await history.getByRole('button', { name: /try again|retry/i }).click();
  await history.getByRole('button', { name: 'Edit v3', exact: true }).click();
  const editor = page.getByRole('dialog', { name: `Edit ${NAME} · v3`, exact: true });
  await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
  const box = await editor.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(width.page).toBeLessThanOrEqual(width.view);
  await page.screenshot({ path: '/tmp/policy-version-phone-edit.png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/policy-version-phone-edit-dark.png', animations: 'disabled' });
  clean(state);
});
