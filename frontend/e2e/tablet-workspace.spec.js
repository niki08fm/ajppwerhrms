import { expect, test } from '@playwright/test';

const SITE = { id: '00000000-0000-4000-8000-000000000071', code: 'SITE-TEST', name: 'Example site' };
const OTHER_SITE = { id: '00000000-0000-4000-8000-000000000072', code: 'DEST-TEST', name: 'Destination site' };
const EMPLOYEE = { id: '00000000-0000-4000-8000-000000000073', code: 'AJTEST73', name: 'Example Active Employee', department: 'Mechanical', designation: 'Engineer' };
const TODAY = '2026-10-10';
const POSITION = { lat: 17.4, lng: 78.4, accuracy_m: 5 };
const people = [
  { ...EMPLOYEE, department_id: 'mechanical', since: `${TODAY}T03:30:00.000Z` },
  { id: 'test-person-2', code: 'AJTEST74', name: 'Example Mechanical Two', department: 'Mechanical', department_id: 'mechanical', since: `${TODAY}T03:40:00.000Z` },
  { id: 'test-person-3', code: 'AJTEST75', name: 'Example Mechanical Three', department: 'Mechanical', department_id: 'mechanical', since: `${TODAY}T03:45:00.000Z` },
  { id: 'test-person-4', code: 'AJTEST76', name: 'Example Safety Employee', department: 'Safety', department_id: 'safety', since: `${TODAY}T03:50:00.000Z` },
];

/** All records and camera frames are fictional. These tests check the site UI,
 * cancellation and request boundaries, never biometric recognition accuracy. */
async function mockTablet(page, { loggedIn = true, guidedRegistration = false, delayedCamera = false } = {}) {
  const state = { loggedIn, site: SITE, reads: [], writes: [], unexpected: [], errors: [], transfers: [] };
  // Keep date and month navigation stable when this fixture runs on another day.
  await page.clock.setFixedTime(new Date(`${TODAY}T06:00:00.000Z`));
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.addInitScript((position) => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(resolve) { resolve({ coords: { latitude: position.lat, longitude: position.lng, accuracy: position.accuracy_m } }); },
    } });
  }, POSITION);
  await page.route('**/src/services/face.js*', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `
      const probe = window.__tabletFaceProbe = { started: 0, stopped: 0, waits: 0, captures: 0, resolveCamera: null };
      export const loadGuidance = async () => {};
      export const loadLandmarks = async () => {};
      export const startCamera = async () => {
        probe.started++;
        if (${delayedCamera}) return new Promise((resolve) => {
          const track = { stop: () => { probe.stopped++; } };
          probe.resolveCamera = () => resolve({ getTracks: () => [track] });
        });
        if (!${guidedRegistration}) throw new DOMException('Camera refused for browser test', 'NotAllowedError');
        return { getTracks: () => [] };
      };
      export const stopCamera = (stream) => stream?.getTracks().forEach((track) => track.stop());
      export const capture = async () => {
        probe.captures++;
        if (!${guidedRegistration}) throw new Error('No biometric capture in this test');
        const canvas = document.createElement('canvas');
        canvas.width = 80; canvas.height = 80;
        const context = canvas.getContext('2d');
        context.fillStyle = '#16887a'; context.fillRect(0, 0, 80, 80);
        context.fillStyle = '#ffffff'; context.font = '12px sans-serif'; context.fillText('Test frame', 8, 42);
        return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'));
      };
      export const waitForGoodFrame = async () => { probe.waits++; return false; };
      export const waitForHeadTurn = async (_, follow) => { follow?.onProgress?.(1); return ${guidedRegistration} ? { yaw: follow.direction === 'LEFT' ? -25 : 25 } : false; };
      export const waitForStraight = async (_, follow) => { probe.waits++; follow?.onProgress?.(1); return ${guidedRegistration} ? { yaw: 0 } : false; };
      export const waitForBlink = async (_, follow) => { follow?.onProgress?.(1); return ${guidedRegistration} ? { blob: await capture() } : false; };
      export const messageFor = (code) => code === 'CAMERA_BLOCKED' ? 'Allow the camera in your browser to continue.' : code;
    `,
  }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const multipart = request.headers()['content-type']?.startsWith('multipart/form-data');
    const body = method === 'GET' ? null : multipart ? { fields: [...request.postData().matchAll(/form-data; name="([^"]+)"/g)].map((match) => match[1]), bytes: request.postDataBuffer().length } : request.postDataJSON();
    if (method === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    else state.writes.push({ path, body });
    let data;
    if (path === '/auth/me' && delayedCamera) {
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'HR sign in required.' } } });
    } else if (path === '/auth/site-me') {
      if (!state.loggedIn) return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in to this site.' } } });
      data = state.site;
    } else if (path === '/auth/site-login' && method === 'POST') {
      state.loggedIn = true;
      if (body.login === 'destination-site') state.site = OTHER_SITE;
      data = state.site;
    } else if (path === '/auth/site-logout' && method === 'POST') {
      state.loggedIn = false;
      data = {};
    } else if (path === '/tablet/summary') data = state.site.id === OTHER_SITE.id ? {
      site: OTHER_SITE, date: TODAY,
      counts: { punched_in_today: 0, on_site_now: 0, late_in: 0, signed_out: 0, early_out: 0 },
      punched_in_today: 0, on_site_now: [], departments: [],
    } : {
      site: SITE, date: TODAY,
      counts: { punched_in_today: 6, on_site_now: 4, late_in: 2, signed_out: 2, early_out: 1 },
      punched_in_today: 6, on_site_now: people,
      departments: [{ id: 'mechanical', name: 'Mechanical', colour: 'chart-1', count: 3 }, { id: 'safety', name: 'Safety', colour: 'chart-2', count: 1 }],
    };
    else if (path === '/tablet/attendance/day') {
      const date = url.searchParams.get('date');
      data = { site: state.site, date, rows: state.site.id === OTHER_SITE.id ? [] : [{ ...EMPLOYEE, first_in: `${date}T03:30:00.000Z`, last_out: null, punches_in: 1, punches_out: 0, on_site_now: date === TODAY, worked_min: 240, late_min: date === TODAY ? 15 : 0, early_min: 0, status: date === TODAY ? 'ON_SITE' : 'PRESENT' }] };
    } else if (path === '/tablet/attendance/month') {
      const ym = url.searchParams.get('ym');
      const date = `${ym}-10`;
      data = { site: state.site, ym, days: [{ date, punched_in: state.site.id === OTHER_SITE.id ? 0 : ym === '2026-10' ? 6 : 3, signed_out: 2 }], rows: state.site.id === OTHER_SITE.id ? [] : [{ ...EMPLOYEE, days: [{ date, punched_in: true, signed_out: false, in: `${date}T03:30:00.000Z`, out: null, worked_min: 240 }], punched_days: 1, worked_min: 240 }] };
    } else if (path === '/tablet/sites') data = [OTHER_SITE];
    else if (path === '/tablet/employees') data = state.registered && url.searchParams.get('for') === 'register' ? [] : [EMPLOYEE];
    else if (path === '/tablet/transfers' && method === 'GET') data = state.transfers;
    else if (path === '/tablet/transfers' && method === 'POST') {
      data = { id: 'test-transfer', employee: EMPLOYEE, from_site: SITE, to_site: OTHER_SITE, departure_date: body.departure_date, reason: body.reason, status: 'PENDING', requested_at: `${TODAY}T06:00:00.000Z`, decided_at: null, decision_note: null };
      state.transfers.push(data);
    } else if (path === '/punches/sessions' && method === 'POST') data = { session_id: 'test-session', challenge: { type: 'STRAIGHT' } };
    else if (path === '/punches/sessions/test-session/frames' && method === 'POST' && guidedRegistration) {
      state.registered = true;
      data = { outcome: 'REGISTERED', message: 'Face registered. You can now punch at any site.' };
    }
    else {
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint: ${method} ${path}` } } });
    }
    await route.fulfill({ json: { data } });
  });
  return state;
}

test('site login opens its own Today workspace without HR or payroll requests', async ({ page }) => {
  const state = await mockTablet(page, { loggedIn: false });
  await page.goto('/tablet');
  await page.getByRole('textbox', { name: 'Login ID', exact: true }).fill('EXAMPLE-SITE');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in here', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Example site', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Punch in / out', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Departments on site', exact: true })).toBeVisible();
  await expect(page.getByLabel('Attendance this month', { exact: true })).toBeVisible();
  await expect(page.locator('.recharts-bar-rectangle')).toHaveCount(1);
  await expect(page.locator('.recharts-line')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Monthly payroll', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Employees', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([{ path: '/auth/site-login', body: { login: 'example-site', password: 'test-password', ...POSITION } }]);
  expect(state.reads.every(({ path }) => path.startsWith('/tablet/') || path.startsWith('/auth/site-'))).toBe(true);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('signing out and into another site does not retain the first site headcount', async ({ page }) => {
  const state = await mockTablet(page);
  await page.goto('/tablet');
  await expect(page.getByText(EMPLOYEE.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in here', exact: true })).toBeVisible();
  await expect(page.getByText(EMPLOYEE.name, { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Login ID', exact: true }).fill('destination-site');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in here', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Destination site', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nobody is on site now', exact: true })).toBeVisible();
  await expect(page.getByText(EMPLOYEE.name, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mechanical · 3 people', exact: true })).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('department visualization opens the currently present people from that department', async ({ page }) => {
  const state = await mockTablet(page);
  await page.goto('/tablet');
  await page.getByRole('button', { name: 'Mechanical · 3 people', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(EMPLOYEE.name);
  await expect(dialog).toContainText('Example Mechanical Two');
  await expect(dialog).not.toContainText('Example Safety Employee');
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('selecting a monthly attendance bar opens that site day register', async ({ page }) => {
  const state = await mockTablet(page);
  await page.goto('/tablet');
  await page.locator('.recharts-bar-rectangle').click();
  await expect(page.getByRole('tab', { name: 'Daily register', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Register date', { exact: true })).toHaveValue(TODAY);
  await expect(page.locator('tbody')).toContainText(EMPLOYEE.name);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('daily and monthly registers navigate dates with read-only site-scoped endpoints', async ({ page }) => {
  const state = await mockTablet(page);
  await page.goto('/tablet');
  await page.getByRole('tab', { name: 'Daily register', exact: true }).click();
  await expect(page.getByLabel('Register date', { exact: true })).toHaveValue(TODAY);
  await expect(page.locator('tbody')).toContainText(EMPLOYEE.name);
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(page.getByLabel('Register date', { exact: true })).toHaveValue('2026-10-09');
  await expect.poll(() => state.reads.some(({ path, query }) => path === '/tablet/attendance/day' && query.date === '2026-10-09')).toBe(true);
  await page.getByRole('tab', { name: 'Monthly register', exact: true }).click();
  await expect(page.getByLabel('Attendance month', { exact: true })).toHaveValue('2026-10');
  await expect(page.locator('tbody')).toContainText(EMPLOYEE.name);
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(page.getByLabel('Attendance month', { exact: true })).toHaveValue('2026-09');
  await expect.poll(() => state.reads.some(({ path, query }) => path === '/tablet/attendance/month' && query.ym === '2026-09')).toBe(true);
  await expect(page.getByRole('button', { name: /Edit|Save attendance|Approve|Run payroll/ })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.reads.filter(({ path }) => path.startsWith('/tablet/attendance')).every(({ query }) => !('site_id' in query))).toBe(true);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('transfer requests are separate from face punching and leave current attendance unchanged', async ({ page }) => {
  const state = await mockTablet(page);
  await page.goto('/tablet');
  await page.getByRole('tab', { name: 'Transfer requests', exact: true }).click();
  await page.getByRole('button', { name: 'Request transfer', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Employee search', { exact: true }).fill('Example');
  await dialog.getByRole('button', { name: new RegExp(EMPLOYEE.name) }).click();
  await dialog.getByLabel(/^Destination site/).selectOption(OTHER_SITE.id);
  await dialog.getByLabel(/^Departure date/).fill(TODAY);
  await expect(dialog.getByRole('button', { name: 'Send request', exact: true })).toBeDisabled();
  await dialog.getByLabel(/^Reason/).fill('Project assignment');
  await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Site transfer requests', exact: true })).toContainText('Destination site');
  await expect(page.getByRole('list', { name: 'Site transfer requests', exact: true })).toContainText('Pending');
  expect(state.writes).toEqual([{ path: '/tablet/transfers', body: { employee_code: EMPLOYEE.code, to_site_id: OTHER_SITE.id, departure_date: TODAY, reason: 'Project assignment' } }]);
  expect(state.reads).toContainEqual({ path: '/tablet/employees', query: { q: 'Example', for: 'transfer' } });
  expect(state.writes.some(({ path }) => path.startsWith('/punches/'))).toBe(false);
  await page.getByRole('tab', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mechanical · 3 people', exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('Punch opens a face session only after clicking and offers recovery when the camera is refused', async ({ page }) => {
  const state = await mockTablet(page);
  await page.goto('/tablet');
  await expect(page.getByRole('button', { name: 'Punch in / out', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Punch in / out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Allow the camera in your browser to continue.');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(state.writes).toEqual([{ path: '/punches/sessions', body: { purpose: 'PUNCH', ...POSITION } }]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Punch in / out', exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const purpose of ['PUNCH', 'REGISTER']) {
  test(`going offline during pending ${purpose.toLowerCase()} camera permission stops the late stream without restarting capture`, async ({ page }) => {
    const state = await mockTablet(page, { delayedCamera: true, guidedRegistration: purpose === 'REGISTER' });
    await page.goto('/tablet');
    if (purpose === 'PUNCH') await page.getByRole('button', { name: 'Punch in / out', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Register face', exact: true }).click();
      await page.getByRole('combobox').fill('Example');
      await page.getByRole('option').getByRole('button', { name: new RegExp(EMPLOYEE.name) }).click();
      await page.getByRole('button', { name: 'Start camera', exact: true }).click();
    }
    await expect.poll(() => page.evaluate(() => window.__tabletFaceProbe.started)).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Punch in / out', exact: true })).toBeDisabled();
    await page.evaluate(() => window.__tabletFaceProbe.resolveCamera());
    await expect.poll(() => page.evaluate(() => window.__tabletFaceProbe.stopped)).toBe(1);
    expect(await page.evaluate(() => ({ waits: window.__tabletFaceProbe.waits, captures: window.__tabletFaceProbe.captures }))).toEqual({ waits: 0, captures: 0 });
    await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use these photos', exact: true })).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].path).toBe('/punches/sessions');
    expect(state.writes[0].body.purpose).toBe(purpose);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test('leaving the site screen during pending camera permission stops the late stream without capture', async ({ page }) => {
  const state = await mockTablet(page, { delayedCamera: true });
  await page.goto('/tablet');
  await page.getByRole('button', { name: 'Punch in / out', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tabletFaceProbe.started)).toBe(1);
  // Client-side navigation unmounts Station while retaining the pending camera promise.
  await page.evaluate(() => {
    history.pushState({}, '', '/login');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.evaluate(() => window.__tabletFaceProbe.resolveCamera());
  await expect.poll(() => page.evaluate(() => window.__tabletFaceProbe.stopped)).toBe(1);
  expect(await page.evaluate(() => ({ waits: window.__tabletFaceProbe.waits, captures: window.__tabletFaceProbe.captures }))).toEqual({ waits: 0, captures: 0 });
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([{ path: '/punches/sessions', body: { purpose: 'PUNCH', ...POSITION } }]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('an active employee can choose registration at any site without creating an attendance punch', async ({ page }) => {
  const state = await mockTablet(page);
  await page.goto('/tablet');
  await page.getByRole('button', { name: 'Register face', exact: true }).click();
  await page.getByRole('combobox').fill('Example');
  await page.getByRole('option').getByRole('button', { name: new RegExp(EMPLOYEE.name) }).click();
  await expect(page.getByText(EMPLOYEE.code, { exact: false })).toBeVisible();
  expect(state.reads).toContainEqual({ path: '/tablet/employees', query: { q: 'Example', for: 'register' } });
  expect(state.writes).toEqual([]);
  await expect(page.getByRole('button', { name: /Re-register|Re-enrol|Enrol anyway/ })).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('guided registration reviews four photos and uploads them once before returning to Today', async ({ page }) => {
  const state = await mockTablet(page, { guidedRegistration: true });
  await page.goto('/tablet');
  await page.getByRole('button', { name: 'Register face', exact: true }).click();
  const start = page.getByRole('button', { name: 'Start camera', exact: true });
  await expect(start).toBeDisabled();
  await page.getByRole('combobox').fill('Example');
  await page.getByRole('option').getByRole('button', { name: new RegExp(EMPLOYEE.name) }).click();
  await start.click();
  await expect(page.getByRole('img', { name: 'Looking straight', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Turned left', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Turned right', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Eyes closed', exact: true })).toBeVisible();
  // Guided capture is mocked, but the UI must still wait for the person's review before uploading.
  expect(state.writes).toEqual([{ path: '/punches/sessions', body: { purpose: 'REGISTER', employee_code: EMPLOYEE.code, name: EMPLOYEE.name, ...POSITION } }]);
  await page.getByRole('button', { name: 'Use these photos', exact: true }).click();
  await expect(page.getByText('Face registered. You can now punch at any site.', { exact: true })).toBeVisible();
  // The confirmation stays visible for five seconds before returning to the site dashboard.
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].path).toBe('/punches/sessions/test-session/frames');
  expect(state.writes[1].body.fields).toEqual(['request_id', 'lat', 'lng', 'accuracy_m', 'front', 'left', 'right', 'blink']);
  expect(state.writes[1].body.bytes).toBeGreaterThan(0);
  expect(state.writes.some(({ path }) => /confirm|change-site/.test(path))).toBe(false);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('face registration is absent from onboarding and does not block activation', async ({ page }) => {
  const errors = [];
  const writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const group = { id: 'test-group', name: 'Site workforce', calendar_method: 'ACTUAL', weekly_off: ['SUN'] };
  let status = 'ONBOARDING';
  const employee = () => ({
    ...EMPLOYEE, status, joined_on: '2026-10-01', updated_at: `${TODAY}T00:00:00.000Z`,
    read_only: false, department: { id: 'mechanical', name: 'Mechanical', colour: 'chart-1' },
    pay_group: group, salary: null, identity: {}, face: { enrolled: false, needs_registration: true },
    // Deliberately include an old required FACE item: it must no longer appear or block this UI.
    onboarding: { total: 2, done: 1, required_left: 1, items: [
      { code: 'DETAILS', label: 'Employee details', required: true, done_at: `${TODAY}T00:00:00.000Z`, done_by: 'Test HR' },
      { code: 'FACE', label: 'Face registration', required: true, done_at: null },
    ] },
    rules: { pay_group: group, calendar_method: 'ACTUAL', weekly_off: ['SUN'], shift: { name: 'Day', start_min: 540, end_min: 1080 }, policies: [] },
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    let data;
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/auth/me') data = { name: 'Test HR', role: 'HR Admin', permissions: ['people.read', 'people.write'] };
    else if (path === '/lookups') data = { today: TODAY, departments: [], pay_groups: [group], structures: [], pt_states: [], sites: [], shifts: [] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === `/employees/${EMPLOYEE.id}`) data = employee();
    else if (path === `/employees/${EMPLOYEE.id}/activate`) { status = 'ACTIVE'; data = { status }; }
    else if (path.endsWith('/hold')) data = { current: null, history: [], open_months: [], run_months: [] };
    else if (path.endsWith('/leave-balances')) data = { types: [] };
    else if (path.endsWith('/attendance')) data = { days: [] };
    else if (path === '/advances-loans') data = { rows: [] };
    else return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint: ${path}` } } });
    await route.fulfill({ json: { data } });
  });
  await page.goto(`/people/${EMPLOYEE.id}?tab=onboarding`);
  await expect(page.getByRole('heading', { name: 'Onboarding checklist', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Face registration', exact: true })).toHaveCount(0);
  await expect(page.getByText('All required steps are done.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Enrol face|Re-enrol|Register face|Register face again/ })).toHaveCount(0);
  const activate = page.getByRole('button', { name: 'Activate', exact: true });
  await expect(activate).toBeEnabled();
  await activate.click();
  await expect(page.getByRole('heading', { name: 'Onboarding checklist', exact: true })).toHaveCount(0);
  await expect(page.getByText('Active employees register at any site.', { exact: true })).toBeVisible();
  expect(writes).toEqual([`/employees/${EMPLOYEE.id}/activate`]);
  expect(errors).toEqual([]);
});
