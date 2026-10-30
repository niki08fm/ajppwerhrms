import { expect, test } from '@playwright/test';

const NOW = '2026-10-30T06:30:00.000Z';
const SHEET_ID = '00000000-0000-4000-8000-000000000601';
const copy = (value) => JSON.parse(JSON.stringify(value));
const sheetData = () => ({
  id: SHEET_ID, site: { id: 'site-alpha', code: 'ALPHA', name: 'Alpha substation' }, work_date: '2026-10-29',
  status: 'PENDING', reason: 'Site network was unavailable', submitted_at: '2026-10-29T12:30:00Z', expires_at: '2026-11-01T12:30:00Z',
  version: 1, row_count: 2, included_count: 2, decided_by: null, decided_at: null, decision_note: null,
  rows: [
    { id: 'row-anita', employee: { id: 'employee-anita', code: 'AJ001', name: 'Anita Example', designation: 'Electrician', department: { id: 'electrical', name: 'Electrical' } }, in_min: 540, out_min: 1080, original_in_min: 540, original_out_min: 1080, included: true, note: null },
    { id: 'row-ravi', employee: { id: 'employee-ravi', code: 'AJ002', name: 'Ravi Example', designation: 'Technician', department: { id: 'mechanical', name: 'Mechanical' } }, in_min: 550, out_min: 1080, original_in_min: 550, original_out_min: 1080, included: true, note: null },
  ],
});

async function mockReview(page, { readOnly = false, status = 'PENDING', expiredAt = null, conflict = null } = {}) {
  const state = { sheet: sheetData(), writes: [], reads: [], errors: [], decisionConflict: conflict };
  state.sheet.status = status;
  if (expiredAt) state.sheet.expires_at = expiredAt;
  await page.clock.setFixedTime(new Date(NOW));
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    if (request.method() !== 'GET') state.writes.push({ path, method: request.method(), body: request.postDataJSON() });
    else state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    let data;
    if (path === '/auth/me') data = { id: 'example-hr', name: 'HR Admin', role: 'HR Admin', permissions: ['attendance.read', ...(readOnly ? [] : ['attendance.write'])] };
    else if (path === '/dashboard/people') data = { approvals: { total: state.sheet.status === 'PENDING' ? 1 : 0 } };
    else if (path === '/approvals') data = { today: '2026-10-30', window_days: 7, sites: [state.sheet.site], departments: [], items: state.sheet.status === 'PENDING' ? [{ id: `manual:${SHEET_ID}`, kind: 'manual', at: state.sheet.submitted_at, day: state.sheet.work_date, employee: null, site: state.sheet.site, detail: { sheet_id: SHEET_ID, row_count: 2, expires_at: state.sheet.expires_at } }] : [] };
    else if (path === '/manual-attendance-sheets') data = !url.searchParams.get('status') || url.searchParams.get('status') === state.sheet.status ? [copy(state.sheet)] : [];
    else if (path === `/manual-attendance-sheets/${SHEET_ID}`) {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON();
        if (body.version !== state.sheet.version) return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT', message: 'Another reviewer updated this sheet. Refresh it before saving.' } } });
        for (const change of body.rows) Object.assign(state.sheet.rows.find((row) => row.id === change.id), change);
        state.sheet.version++;
        state.sheet.included_count = state.sheet.rows.filter((row) => row.included).length;
      }
      data = copy(state.sheet);
    } else if (path === `/manual-attendance-sheets/${SHEET_ID}/decide`) {
      if (state.decisionConflict) {
        if (state.decisionConflict === 'EXPIRED') state.sheet.status = 'EXPIRED';
        return route.fulfill({ status: 409, json: { error: { code: state.decisionConflict, message: state.decisionConflict === 'EXPIRED' ? 'The three-day approval window has ended.' : 'Anita Example already has attendance for this day. Review or exclude this row.' } } });
      }
      const body = request.postDataJSON();
      state.sheet.status = body.decision;
      state.sheet.version++;
      state.sheet.decided_by = 'hr@example.test';
      state.sheet.decided_at = NOW;
      state.sheet.decision_note = body.note ?? null;
      data = copy(state.sheet);
    } else return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint ${path}` } } });
    await route.fulfill({ json: { data } });
  });
  return state;
}
const open = (page) => page.goto(`/approvals?kind=manual&sheet=${SHEET_ID}`);
const dialog = (page) => page.getByRole('dialog', { name: 'Manual attendance sheet', exact: true });

test('manual sheets are visible as files and do not become unknown-face requests', async ({ page }) => {
  const state = await mockReview(page);
  await page.goto('/approvals');
  await expect(page.getByRole('tab', { name: 'Manual attendance sheets 1', exact: true })).toBeVisible();
  await expect(page.getByText('Unknown face', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Manual attendance sheets 1', exact: true }).click();
  await page.getByRole('button', { name: 'Open Alpha substation attendance sheet for 2026-10-29', exact: true }).click();
  await expect(dialog(page)).toContainText('Anita Example');
  await expect(dialog(page)).toContainText('Ravi Example');
  await expect(dialog(page)).toContainText('2 of 2 employees included');
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('HR edits one employee then explicitly approves the whole updated sheet version', async ({ page }) => {
  const state = await mockReview(page);
  await open(page);
  await dialog(page).getByRole('button', { name: 'Edit Anita Example', exact: true }).click();
  const editor = dialog(page).getByRole('region', { name: 'Edit attendance for Anita Example', exact: true });
  await editor.getByLabel('Punch out', { exact: true }).fill('17:45');
  await editor.getByLabel('Employee review note', { exact: true }).fill('Actual departure checked');
  await expect(dialog(page).getByRole('button', { name: 'Approve sheet', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'Save employee row', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(state.writes).toEqual([{ path: `/manual-attendance-sheets/${SHEET_ID}`, method: 'PATCH', body: { version: 1, rows: [{ id: 'row-anita', in_min: 540, out_min: 1065, note: 'Actual departure checked', included: true }] } }]);
  await dialog(page).getByRole('button', { name: 'Approve sheet', exact: true }).click();
  await expect(dialog(page)).toContainText('Attendance was recorded for the included employees');
  expect(state.writes.at(-1)).toEqual({ path: `/manual-attendance-sheets/${SHEET_ID}/decide`, method: 'POST', body: { decision: 'APPROVED', version: 2 } });
  await expect(dialog(page).getByRole('button', { name: 'Approve sheet', exact: true })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Edit Anita Example', exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test('overnight times and excluded employee rows remain explicit in the reviewed sheet', async ({ page }) => {
  const state = await mockReview(page);
  await open(page);
  await dialog(page).getByRole('button', { name: 'Edit Ravi Example', exact: true }).click();
  const editor = dialog(page).getByRole('region', { name: 'Edit attendance for Ravi Example', exact: true });
  await editor.getByLabel('Punch in', { exact: true }).fill('22:00');
  await editor.getByLabel('Punch out', { exact: true }).fill('06:00');
  await expect(editor.getByRole('button', { name: 'Save employee row', exact: true })).toBeDisabled();
  await editor.getByLabel('Punch out is on the next day', { exact: true }).check();
  await editor.getByLabel('Include this employee when approving', { exact: true }).uncheck();
  await editor.getByLabel('Employee review note', { exact: true }).fill('Hold this row for confirmation');
  await editor.getByRole('button', { name: 'Save employee row', exact: true }).click();
  await expect(dialog(page)).toContainText('1 of 2 employees included');
  await expect(dialog(page)).toContainText('06:00 +1 day');
  await expect(dialog(page)).toContainText('Excluded');
  expect(state.writes[0].body.rows[0]).toMatchObject({ id: 'row-ravi', in_min: 1320, out_min: 1800, included: false });
});

test('a conflicting approval is not shown as recorded and HR can review the affected row', async ({ page }) => {
  const state = await mockReview(page, { conflict: 'ROW_CONFLICT' });
  await open(page);
  await dialog(page).getByRole('button', { name: 'Approve sheet', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('already has attendance');
  await expect(dialog(page)).not.toContainText('Attendance was recorded for the included employees');
  await expect(dialog(page).getByRole('button', { name: 'Edit Anita Example', exact: true })).toBeEnabled();
  expect(state.sheet.status).toBe('PENDING');
  expect(state.writes).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('a server-side deadline rejection refreshes the sheet to expired and never reports success', async ({ page }) => {
  const state = await mockReview(page, { conflict: 'EXPIRED' });
  await open(page);
  await dialog(page).getByRole('button', { name: 'Approve sheet', exact: true }).click();
  await expect(dialog(page)).toContainText('This sheet did not record attendance');
  await expect(dialog(page).getByRole('button', { name: 'Approve sheet', exact: true })).toHaveCount(0);
  await expect(dialog(page)).not.toContainText('Attendance was recorded for the included employees');
  expect(state.sheet.status).toBe('EXPIRED');
});

test('expired history is read-only and explains the normal absence result', async ({ page }) => {
  const state = await mockReview(page, { status: 'EXPIRED', expiredAt: '2026-10-29T12:00:00Z' });
  await page.goto('/approvals?kind=manual');
  await page.getByRole('combobox', { name: 'Sheet status', exact: true }).selectOption('EXPIRED');
  await page.getByRole('button', { name: 'Open Alpha substation attendance sheet for 2026-10-29', exact: true }).click();
  await expect(dialog(page)).toContainText('Normal absence rules apply');
  await expect(dialog(page).getByRole('button', { name: 'Edit Anita Example', exact: true })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Approve sheet', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('read-only HR can inspect every row without edit or approval controls', async ({ page }) => {
  const state = await mockReview(page, { readOnly: true });
  await open(page);
  await expect(dialog(page)).toContainText('Anita Example');
  await expect(dialog(page)).toContainText('Attendance approval permission is needed');
  await expect(dialog(page).getByRole('button', { name: 'Edit Anita Example', exact: true })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Approve sheet', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('another reviewer version cannot be silently overwritten by an older row editor', async ({ page }) => {
  const state = await mockReview(page);
  await open(page);
  await dialog(page).getByRole('button', { name: 'Edit Anita Example', exact: true }).click();
  const editor = dialog(page).getByRole('region', { name: 'Edit attendance for Anita Example', exact: true });
  await editor.getByLabel('Punch out', { exact: true }).fill('17:50');
  state.sheet.version = 2;
  state.sheet.rows[0].out_min = 1075;
  await editor.getByRole('button', { name: 'Save employee row', exact: true }).click();
  await expect(dialog(page)).toContainText('Another reviewer updated this sheet');
  await expect(editor.getByLabel('Punch out', { exact: true })).toHaveValue('17:50');
  await expect(editor.getByRole('button', { name: 'Save employee row', exact: true })).toBeDisabled();
  expect(state.sheet.rows[0].out_min).toBe(1075);
  await dialog(page).getByRole('button', { name: 'Refresh sheet', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(dialog(page)).toContainText('17:55');
  expect(state.errors).toEqual([]);
});

test('a rejection records the reason without presenting attendance as recorded', async ({ page }) => {
  const state = await mockReview(page);
  await open(page);
  await dialog(page).getByLabel('Sheet decision note (optional)', { exact: true }).fill('Site confirmed this was the wrong date');
  await dialog(page).getByRole('button', { name: 'Reject sheet', exact: true }).click();
  await expect(dialog(page)).toContainText('No attendance was recorded from it');
  expect(state.writes[0].body).toEqual({ decision: 'REJECTED', version: 1, note: 'Site confirmed this was the wrong date' });
});

test('the file list and row editor fit a phone without page-wide horizontal scrolling', async ({ page }) => {
  const state = await mockReview(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/approvals?kind=manual');
  await page.getByRole('button', { name: 'Open Alpha substation attendance sheet for 2026-10-29', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Edit Anita Example', exact: true }).click();
  await expect(dialog(page).getByRole('region', { name: 'Edit attendance for Anita Example', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await dialog(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.width).toBeLessThanOrEqual(390);
  expect(state.errors).toEqual([]);
});
