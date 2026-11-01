import { expect, test } from '@playwright/test';

const SITE = { id: '00000000-0000-4000-8000-000000000091', code: 'ALPHA', name: 'Alpha site' };
const OTHER = { id: '00000000-0000-4000-8000-000000000092', code: 'BETA', name: 'Beta site' };
const TODAY = '2026-10-30';
const PEOPLE = [
  { code: 'AJ001', name: 'Anil Example', designation: 'Technician', department: { id: 'electrical', name: 'Electrical' } },
  { code: 'AJ002', name: 'Ravi Example', designation: 'Supervisor', department: { id: 'civil', name: 'Civil' } },
];
async function mockSite(page, { loseResponse = false } = {}) {
  const state = { site: SITE, reads: [], writes: [], errors: [], sheets: [], accepted: new Map(), lost: false };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.clock.setFixedTime(new Date(`${TODAY}T14:00:00Z`));
  await page.addInitScript(() => {
    window.locationChecks = 0;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition() { window.locationChecks++; throw new Error('Manual attendance never asks for GPS'); } } });
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', '');
    if (request.method() === 'GET') state.reads.push({ path, siteHeader: request.headers()['x-site-id'] });
    let data;
    if (path === '/auth/site-me') data = state.site;
    else if (path === '/tablet/summary') data = { site: state.site, date: TODAY, counts: { on_site_now: 0, punched_in_today: 0, signed_out: 0, late_in: 0, early_out: 0 }, on_site_now: [], departments: [] };
    else if (path === '/tablet/manual-attendance-employees') data = PEOPLE;
    else if (path === '/tablet/manual-attendance-sheets' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.writes.push({ path, body, siteHeader: request.headers()['x-site-id'] });
      let sheet = state.accepted.get(body.client_request_id);
      if (!sheet) {
        sheet = { ...body, id: `sheet-${state.accepted.size + 1}`, site: state.site, status: 'PENDING', submitted_at: `${TODAY}T14:00:00Z`, expires_at: '2026-11-02T14:00:00Z', version: 1, row_count: body.rows.length, included_count: body.rows.length,
          rows: body.rows.map((row, index) => ({ ...row, id: `row-${index}`, employee: { id: `person-${index}`, ...PEOPLE.find((person) => person.code === row.employee_code) }, included: true, original_in_min: row.in_min, original_out_min: row.out_min })) };
        state.accepted.set(body.client_request_id, sheet); state.sheets.push(sheet);
      }
      if (loseResponse && !state.lost) { state.lost = true; return route.abort('failed'); }
      data = sheet;
    } else if (path === '/tablet/manual-attendance-sheets') data = state.sheets.filter((sheet) => sheet.site.id === state.site.id);
    else if (path.startsWith('/tablet/manual-attendance-sheets/')) data = state.sheets.find((sheet) => sheet.id === path.split('/').at(-1));
    else data = [];
    await route.fulfill({ json: { data } });
  });
  return state;
}
async function openManual(page) {
  await page.goto('/tablet');
  if (page.viewportSize().width <= 1366) {
    await page.getByRole('navigation', { name: 'Site navigation' }).getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Manual attendance', exact: true }).click();
  }
  else await page.getByRole('tab', { name: 'Manual attendance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New attendance sheet', exact: true })).toBeEnabled();
}
async function enterPerson(page, name = 'Anil Example', code = 'AJ001') {
  await page.getByRole('textbox', { name: 'Search manual attendance employees', exact: true }).fill(name.split(' ')[0]);
  await page.getByRole('button', { name: `Add ${name} (${code})`, exact: true }).click();
  await page.getByLabel(`Punch in for ${name}`, { exact: true }).fill('09:00');
  await page.getByLabel(`Punch out for ${name}`, { exact: true }).fill('18:00');
}
async function entryWithPerson(page) {
  await page.getByRole('button', { name: 'New attendance sheet', exact: true }).click();
  await enterPerson(page);
}

test('copies paper attendance into one reviewed sheet with duplicate-person and time validation', async ({ page }) => {
  const state = await mockSite(page);
  await openManual(page); await entryWithPerson(page);
  await page.getByRole('textbox', { name: 'Search manual attendance employees', exact: true }).fill('AJ001');
  await expect(page.getByRole('button', { name: 'Add Anil Example (AJ001)', exact: true })).toBeDisabled();
  await page.getByLabel('Punch out for Anil Example', { exact: true }).fill('08:30');
  await expect(page.getByRole('button', { name: 'Send sheet to HR', exact: true })).toBeDisabled();
  await page.getByLabel('Punch out for Anil Example', { exact: true }).fill('18:00');
  await enterPerson(page, 'Ravi Example', 'AJ002');
  await page.getByRole('button', { name: 'Send sheet to HR', exact: true }).click();
  await expect(page.getByText('Sheet sent to HR. Attendance is recorded only after HR approves the sheet.', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ siteHeader: SITE.id, body: { work_date: TODAY, rows: [{ employee_code: 'AJ001', in_min: 540, out_min: 1080 }, { employee_code: 'AJ002', in_min: 540, out_min: 1080 }] } });
  expect(state.reads.filter((row) => row.path.includes('manual-attendance')).every((row) => row.siteHeader === SITE.id)).toBe(true);
  expect(await page.evaluate(() => window.locationChecks)).toBe(0);
  expect(state.errors).toEqual([]);
});

test('no employee directory is prefetched from Today and paper entries are never stored on the device', async ({ page }) => {
  const state = await mockSite(page);
  await page.goto('/tablet');
  await expect(page.getByRole('button', { name: 'Enter manual attendance', exact: true })).toBeVisible();
  expect(state.reads.some((row) => row.path.includes('manual-attendance'))).toBe(false);
  await page.getByRole('button', { name: 'Enter manual attendance', exact: true }).click();
  await entryWithPerson(page);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('manual-attendance')))).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('connection loss disables the entry and reconnecting never submits it automatically', async ({ page, context }) => {
  const state = await mockSite(page);
  await openManual(page); await entryWithPerson(page);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Send sheet to HR', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Punch in for Anil Example', { exact: true })).toBeDisabled();
  await expect(page.getByText('Connect to enter and send the times from your paper register. Nothing will be sent automatically after reconnecting.', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Send sheet to HR', exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Send sheet to HR', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.errors).toEqual([]);
});

test('lost response locks the original entry and only explicit retry repeats its unchanged request', async ({ page, context }) => {
  const state = await mockSite(page, { loseResponse: true });
  await openManual(page); await entryWithPerson(page);
  await page.getByRole('button', { name: 'Send sheet to HR', exact: true }).click();
  await expect(page.getByText('The server response was interrupted. Retry the same sheet or check sent sheets. Keep the entry unchanged so it cannot be sent twice.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Punch in for Anil Example', { exact: true })).toBeDisabled();
  await context.setOffline(true); await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Retry sending to HR', exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  state.site = OTHER;
  await page.getByRole('button', { name: 'Retry sending to HR', exact: true }).click();
  await expect(page.getByText('Sign in to this sheet’s site before sending it.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Punch in for Anil Example', { exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  state.site = SITE;
  await page.getByRole('button', { name: 'Retry sending to HR', exact: true }).click();
  await expect(page.getByText('Sheet sent to HR. Attendance is recorded only after HR approves the sheet.', { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].body).toEqual(state.writes[0].body);
  expect(state.accepted.size).toBe(1);
  expect(state.errors).toEqual([]);
});

test('site session change prevents submission with another site cookie', async ({ page }) => {
  const state = await mockSite(page);
  await openManual(page); await entryWithPerson(page);
  state.site = OTHER;
  await page.getByRole('button', { name: 'Send sheet to HR', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sign in to this sheet’s site');
  expect(state.writes).toEqual([]);
  state.site = SITE;
  await page.getByRole('button', { name: 'Send sheet to HR', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].siteHeader).toBe(SITE.id);
  expect(state.errors).toEqual([]);
});

test('paper overnight times require the next-day option and preserve the real date', async ({ page }) => {
  const state = await mockSite(page);
  await openManual(page); await entryWithPerson(page);
  await page.getByLabel(/Attendance date/).fill('2026-10-29');
  await page.getByLabel('Punch in for Anil Example', { exact: true }).fill('22:00');
  await page.getByLabel('Punch out for Anil Example', { exact: true }).fill('06:00');
  await expect(page.getByRole('button', { name: 'Send sheet to HR', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Punch out next day for Anil Example', exact: true }).check();
  await page.getByRole('button', { name: 'Send sheet to HR', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toMatchObject({ work_date: '2026-10-29', rows: [{ employee_code: 'AJ001', in_min: 1320, out_min: 1800 }] });
  expect(state.errors).toEqual([]);
});

for (const status of ['APPROVED', 'EXPIRED', 'REJECTED']) {
  test(`an idempotent retry shows the real ${status.toLowerCase()} state rather than claiming a new pending sheet`, async ({ page }) => {
    const state = await mockSite(page, { loseResponse: true });
    await openManual(page); await entryWithPerson(page);
    await page.getByRole('button', { name: 'Send sheet to HR', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry sending to HR', exact: true })).toBeVisible();
    state.sheets[0].status = status;
    await page.getByRole('button', { name: 'Retry sending to HR', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Manual attendance sheet', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(status === 'APPROVED' ? 'Approved' : status === 'EXPIRED' ? 'Expired' : 'Rejected', { exact: true })).toBeVisible();
    await expect(page.getByText('Sheet sent to HR. Attendance is recorded only after HR approves the sheet.', { exact: true })).toHaveCount(0);
    expect(state.accepted.size).toBe(1);
    expect(state.errors).toEqual([]);
  });
}

test('submitted sheets are read-only and show HR edited and excluded rows on a phone', async ({ page }) => {
  const state = await mockSite(page);
  await page.setViewportSize({ width: 390, height: 844 });
  state.sheets.push({ id: 'reviewed-sheet', site: SITE, work_date: '2026-10-29', status: 'APPROVED', row_count: 2, reason: 'Device did not connect', submitted_at: '2026-10-29T13:00:00Z', expires_at: '2026-11-01T13:00:00Z',
    rows: [{ id: 'a', employee: PEOPLE[0], in_min: 570, out_min: 1080, note: 'Time checked by HR', included: true }, { id: 'b', employee: PEOPLE[1], in_min: 540, out_min: 1080, included: false }] });
  await openManual(page);
  await page.getByRole('list', { name: 'Submitted manual attendance sheets', exact: true }).getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: 'Manual attendance sheet', exact: true });
  await expect(dialog).toContainText('09:30 → 18:00'); await expect(dialog).toContainText('Excluded by HR');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test('the manual view needs a connection before creating a paper entry and offers no queue action', async ({ page, context }) => {
  const state = await mockSite(page);
  await page.goto('/tablet'); await expect(page.getByRole('heading', { name: 'Alpha site', exact: true })).toBeVisible();
  await context.setOffline(true);
  if (page.viewportSize().width <= 1366) {
    await page.getByRole('navigation', { name: 'Site navigation' }).getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Manual attendance', exact: true }).click();
  }
  else await page.getByRole('tab', { name: 'Manual attendance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New attendance sheet', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send when online', exact: true })).toHaveCount(0);
  expect(state.reads.some((row) => row.path.includes('manual-attendance'))).toBe(false);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});
