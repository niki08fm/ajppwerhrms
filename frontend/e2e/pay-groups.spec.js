import { expect, test } from '@playwright/test';

const GROUP_A = '00000000-0000-4000-8000-000000000001';
const GROUP_B = '00000000-0000-4000-8000-000000000002';
const SHIFT = '00000000-0000-4000-8000-000000000003';
const employee = (index, groupId) => ({ id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`, name: `Test employee ${index}`, code: `TEST${index}`, status: 'ACTIVE', pay_group_id: groupId, pay_group: { id: groupId, name: groupId === GROUP_A ? 'Site staff' : 'Office staff' } });
const ATTENDANCE_KEY = '00000000-0000-4000-8000-000000000101';
const OVERTIME_KEY = '00000000-0000-4000-8000-000000000102';
const policies = [
  { id: '00000000-0000-4000-8000-000000000201', policy_key: ATTENDANCE_KEY, kind: 'ATTENDANCE', name: 'Site attendance', version: 1, valid_from: '2026-01-01', valid_to: '2026-06-30' },
  { id: '00000000-0000-4000-8000-000000000202', policy_key: ATTENDANCE_KEY, kind: 'ATTENDANCE', name: 'Site attendance', version: 2, valid_from: '2026-07-01', valid_to: null },
  { id: '00000000-0000-4000-8000-000000000203', policy_key: OVERTIME_KEY, kind: 'OVERTIME', name: 'Site overtime', version: 1, valid_from: '2026-01-01', valid_to: null },
];

async function mockPayGroups(page, { exitedMember = false, legacyConflicts = false } = {}) {
  const writes = [];
  const availablePolicies = [...policies];
  if (legacyConflicts) availablePolicies.push({ ...policies[0], id: '00000000-0000-4000-8000-000000000204', policy_key: '00000000-0000-4000-8000-000000000104', name: 'Alternative attendance', valid_to: null });
  const employees = [employee(1, GROUP_A), employee(2, GROUP_B), employee(3, GROUP_B)];
  if (exitedMember) employees[0].status = 'EXITED';
  const shift = { id: SHIFT, name: 'Day shift', start_min: 540, end_min: 1080 };
  const groups = () => [GROUP_A, GROUP_B].map((id, index) => ({ id, name: index === 0 ? 'Site staff' : 'Office staff', headcount: employees.filter((e) => e.pay_group_id === id).length, pay_day: 7, calendar_method: 'FIXED_26', weekly_off: ['SUN'], shift, policies: legacyConflicts && index === 0 ? availablePolicies.filter((p) => p.kind === 'ATTENDANCE') : [], warnings: [], divisor_this_month: 26 }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const memberMatch = /^\/pay-groups\/([^/]+)\/employees$/.exec(path);
    let result;
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (memberMatch) {
        let moved = 0;
        for (const e of employees.filter((e) => body.employee_ids.includes(e.id))) {
          if (e.pay_group_id !== memberMatch[1]) moved++;
          e.pay_group_id = memberMatch[1];
          e.pay_group = { id: memberMatch[1], name: groups().find((g) => g.id === memberMatch[1]).name };
        }
        result = { data: { moved, unchanged: body.employee_ids.length - moved, employees: employees.filter((e) => e.pay_group_id === memberMatch[1]) } };
      } else result = { data: { ...groups()[0], ...body } };
    } else if (path === '/auth/me') result = { data: { name: 'HR Admin', role: 'HR Admin', permissions: ['setup.read', 'setup.write', 'people.read', 'people.write'] } };
    else if (path === '/dashboard/people') result = { data: { approvals: { total: 0 } } };
    else if (path === '/pay-groups') result = { data: groups() };
    else if (path === `/pay-groups/${GROUP_A}`) result = { data: groups()[0] };
    else if (memberMatch) result = { data: employees.filter((e) => e.pay_group_id === memberMatch[1]) };
    else if (path === '/policies') result = { data: availablePolicies };
    else if (path === '/lookups') result = { data: { today: '2026-10-07', shifts: [shift], pay_groups: groups(), departments: [], structures: [] } };
    else if (path === '/calendar-methods') result = { data: [], meta: { month: '2026-10' } };
    else if (path === '/employees') {
      const nextPage = url.searchParams.get('cursor');
      result = { data: nextPage ? [employees[2]] : employees.slice(0, 2), meta: { total: 3, nextCursor: nextPage ? null : 'test-next-page' } };
    } else result = { data: [] };
    await route.fulfill({ json: result });
  });
  return { writes, employees, publishPolicy: (p) => availablePolicies.push(p) };
}

test('pay group creation chooses policies with None and keeps effective-date versions, without a group salary structure', async ({ page }) => {
  const { writes } = await mockPayGroups(page);
  await page.goto('/setup/pay-groups/new');
  await page.getByRole('textbox', { name: /^Name/ }).fill('Project group');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const attendance = page.getByRole('combobox', { name: 'Attendance', exact: true });
  await expect(attendance.locator('option')).toHaveCount(2);
  await attendance.selectOption(ATTENDANCE_KEY);
  await attendance.selectOption('');
  await attendance.selectOption(ATTENDANCE_KEY);
  const overtime = page.getByRole('combobox', { name: 'Overtime', exact: true });
  await overtime.selectOption(OVERTIME_KEY);
  await overtime.selectOption('');
  await expect(page.getByRole('combobox')).toHaveCount(7);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Overtime: None', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create pay group', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: '/pay-groups', body: { name: 'Project group', pay_day: 7, calendar_method: 'FIXED_26', weekly_off: ['SUN'], shift_id: SHIFT, policy_ids: policies.slice(0, 2).map((p) => p.id) } });
});

test('adding employees supports selection across pages and skips existing members', async ({ page }) => {
  const { writes, employees } = await mockPayGroups(page);
  await page.goto('/setup/pay-groups');
  await page.getByRole('button', { name: 'Manage employees' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Add employees', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Select Test employee 1', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Select Test employee 2', exact: true }).check();
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Select Test employee 3', exact: true }).check();
  await expect(dialog.getByText('2 selected', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to this pay group', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: `/pay-groups/${GROUP_A}/employees`, body: { employee_ids: [employees[1].id, employees[2].id] } });
  await dialog.getByRole('radio', { name: 'Employees (3)', exact: true }).click();
  await expect(dialog.locator('tbody tr')).toHaveCount(3);
});

test('managing existing members moves them to another pay group', async ({ page }) => {
  const { writes, employees } = await mockPayGroups(page);
  await page.goto('/setup/pay-groups');
  await page.getByRole('button', { name: 'Manage employees' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Select Test employee 1', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Move selected employees', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Move to pay group', exact: true }).selectOption(GROUP_B);
  await dialog.getByRole('button', { name: 'Move selected employees', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ path: `/pay-groups/${GROUP_B}/employees`, body: { employee_ids: [employees[0].id] } });
  await expect(dialog.getByRole('heading', { name: 'No employees in this pay group', exact: true })).toBeVisible();
});

test('exited members remain visible without enabling pay group moves', async ({ page }) => {
  await mockPayGroups(page, { exitedMember: true });
  await page.goto('/setup/pay-groups');
  await page.getByRole('button', { name: 'Manage employees' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox', { name: 'Select Test employee 1', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: 'Select all eligible employees on this page', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Move selected employees', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Exited', { exact: true })).toBeVisible();
});

test('legacy competing policy selections require an explicit choice before saving other group edits', async ({ page }) => {
  const { writes } = await mockPayGroups(page, { legacyConflicts: true });
  await page.goto(`/setup/pay-groups/${GROUP_A}/edit`);
  await page.getByRole('textbox', { name: /^Name/ }).fill('Renamed site staff');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Multiple policies are attached. Choose one policy or None to continue.', { exact: true })).toBeVisible();
  const attendance = page.getByRole('combobox', { name: 'Attendance', exact: true });
  await expect(attendance).toHaveValue('__choose_policy__');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await attendance.selectOption('');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await attendance.selectOption(ATTENDANCE_KEY);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.name).toBe('Renamed site staff');
  expect(writes[0].body.policy_ids).toEqual(policies.slice(0, 2).map((p) => p.id));
});

test('refreshing policies loads a newly created policy without clearing the draft or selected policies', async ({ page }) => {
  const { writes, publishPolicy } = await mockPayGroups(page);
  await page.goto('/setup/pay-groups/new');
  await page.getByRole('textbox', { name: /^Name/ }).fill('Draft project group');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('combobox', { name: 'Attendance', exact: true }).selectOption(ATTENDANCE_KEY);
  const newLeave = { ...policies[0], id: '00000000-0000-4000-8000-000000000205', policy_key: '00000000-0000-4000-8000-000000000105', name: 'New project leave', kind: 'LEAVE', valid_to: null };
  publishPolicy(newLeave);
  const newAttendanceVersion = { ...policies[1], id: '00000000-0000-4000-8000-000000000206', version: 3, valid_from: '2027-01-01' };
  publishPolicy(newAttendanceVersion);
  await page.getByRole('button', { name: 'Refresh policies', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Attendance', exact: true })).toHaveValue(ATTENDANCE_KEY);
  await page.getByRole('combobox', { name: 'Leave', exact: true }).selectOption(newLeave.policy_key);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('Draft project group');
  await expect(page.getByText('Attendance: Site attendance · v3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create pay group', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body.name).toBe('Draft project group');
  expect(writes[0].body.policy_ids).toEqual([...policies.slice(0, 2).map((p) => p.id), newLeave.id, newAttendanceVersion.id]);
});
