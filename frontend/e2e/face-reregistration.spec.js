import { expect, test } from '@playwright/test';

// Fictional employees, approval records and JPEG frames. This suite verifies the
// permission-driven screens and request boundaries, not face recognition accuracy.
const TODAY = '2026-10-11';
const EMPLOYEE = { id: '00000000-0000-4000-8000-000000000083', code: 'AJTEST83', name: 'Example Face Employee', designation: 'Engineer' };
const SITE = { id: '00000000-0000-4000-8000-000000000081', code: 'TEST-SITE', name: 'Example face site' };
const POSITION = { lat: 17.4, lng: 78.4, accuracy_m: 5 };
const APPROVAL = {
  id: '00000000-0000-4000-8000-000000000084', status: 'APPROVED',
  reason: 'Face punching failed repeatedly after an appearance change.',
  approved_by: 'Example HR', approved_at: `${TODAY}T06:00:00.000Z`,
  expires_at: '2026-10-18T06:00:00.000Z', used_at: null, used_site_id: null,
  revoked_by: null, revoked_at: null, usable: true,
};

async function mockProfile(page, { permissions = ['people.read', 'people.write'], authorization = null, authorizeError = false, revokeError = false, days = 4 } = {}) {
  const group = { id: 'test-group', name: 'Site workforce', calendar_method: 'ACTUAL', weekly_off: ['SUN'] };
  const state = { authorization, reads: [], writes: [], unexpected: [], errors: [], authorizeError, revokeError };
  await page.clock.setFixedTime(new Date(`${TODAY}T06:00:00.000Z`));
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    if (method === 'GET') state.reads.push(path);
    else state.writes.push({ path, body });
    let data;
    if (path === '/auth/me') data = { name: 'Example HR', role: 'HR Admin', permissions };
    else if (path === '/lookups') data = { today: TODAY, departments: [], pay_groups: [group], structures: [], pt_states: [], sites: [], shifts: [] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === `/employees/${EMPLOYEE.id}`) data = {
      ...EMPLOYEE, status: 'ACTIVE', joined_on: '2025-01-01', updated_at: `${TODAY}T00:00:00.000Z`, read_only: false,
      department: { id: 'mechanical', name: 'Mechanical', colour: 'chart-1' }, pay_group: group, salary: null, identity: {},
      face: { enrolled: true, enrolled_at: '2025-01-01T06:00:00.000Z', templates: 4, needs_registration: false },
      onboarding: { total: 0, done: 0, required_left: 0, items: [] },
      rules: { pay_group: group, calendar_method: 'ACTUAL', weekly_off: ['SUN'], shift: { name: 'Day', start_min: 540, end_min: 1080 }, policies: [] },
    };
    else if (path === `/employees/${EMPLOYEE.id}/face-registration` && method === 'GET') data = {
      face_registered: true, authorization: state.authorization,
      manual_failure_streak: { days, latest_date: '2026-10-10', requires_review: days > 3, dates: ['2026-10-10', '2026-10-09', '2026-10-08', '2026-10-07'].slice(0, days) },
    };
    else if (path === `/employees/${EMPLOYEE.id}/face-registration/authorize` && method === 'POST') {
      if (state.authorizeError) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Approval could not be saved. Please try again.' } } });
      state.authorization = { ...APPROVAL, reason: body.reason };
      data = state.authorization;
    } else if (path === `/employees/${EMPLOYEE.id}/face-registration/revoke` && method === 'POST') {
      if (state.revokeError) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Permission could not be cancelled. Please try again.' } } });
      state.authorization = { ...state.authorization, status: 'REVOKED', usable: false, revoked_by: 'Example HR', revoked_at: `${TODAY}T06:30:00.000Z` };
      data = state.authorization;
    } else if (path.endsWith('/hold')) data = { current: null, history: [], open_months: [], run_months: [] };
    else if (path.endsWith('/leave-balances')) data = { types: [] };
    else if (path.endsWith('/attendance')) data = { days: [] };
    else if (path === '/advances-loans') data = { rows: [] };
    else {
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint: ${method} ${path}` } } });
    }
    return route.fulfill({ json: { data } });
  });
  return state;
}

test('four consecutive manual-failure days prompt HR review without granting registration automatically', async ({ page }) => {
  const state = await mockProfile(page);
  await page.goto(`/people/${EMPLOYEE.id}?tab=face`);
  const card = page.locator('#section-face');
  await expect(card).toContainText(/4 consecutive/i);
  await expect(card).toContainText('Ready to punch');
  await expect(card.getByRole('button', { name: 'Allow re-registration', exact: true })).toBeVisible();
  await expect(card).not.toContainText('HR approved · ready at any site');
  expect(state.writes).toEqual([]);
  expect(state.authorization).toBeNull();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('a read-only employee viewer can see an HR grant but cannot authorize or cancel it', async ({ page }) => {
  const state = await mockProfile(page, { permissions: ['people.read'], authorization: { ...APPROVAL } });
  await page.goto(`/people/${EMPLOYEE.id}?tab=face`);
  const card = page.locator('#section-face');
  await expect(card).toContainText('HR approved · ready at any site');
  await expect(card.getByRole('button', { name: 'Allow re-registration', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Cancel permission', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('HR authorizes with a reason and can cancel the same one-time permission', async ({ page }) => {
  const state = await mockProfile(page);
  await page.goto(`/people/${EMPLOYEE.id}?tab=face`);
  const card = page.locator('#section-face');
  await card.getByRole('button', { name: 'Allow re-registration', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Allow face re-registration', exact: true });
  await expect(dialog.getByRole('button', { name: 'Approve re-registration', exact: true })).toBeDisabled();
  await dialog.getByLabel(/^Reason/).fill(APPROVAL.reason);
  await dialog.getByRole('button', { name: 'Approve re-registration', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('HR approved · ready at any site');
  await expect(card).toContainText('Expires');
  await expect(card).toContainText('Example HR');
  await card.screenshot({ path: '/tmp/face-reregistration-hr.png' });
  await card.getByRole('button', { name: 'Cancel permission', exact: true }).click();
  const cancel = page.getByRole('dialog', { name: 'Cancel re-registration permission', exact: true });
  await cancel.getByRole('button', { name: 'Cancel permission', exact: true }).click();
  await expect(cancel).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Allow re-registration', exact: true })).toBeVisible();
  await expect(card).not.toContainText('HR approved · ready at any site');
  expect(state.writes).toEqual([
    { path: `/employees/${EMPLOYEE.id}/face-registration/authorize`, body: { reason: APPROVAL.reason } },
    { path: `/employees/${EMPLOYEE.id}/face-registration/revoke`, body: { authorization_id: APPROVAL.id } },
  ]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('a failed HR approval keeps the reason and dialog available to retry', async ({ page }) => {
  const state = await mockProfile(page, { authorizeError: true });
  await page.goto(`/people/${EMPLOYEE.id}?tab=face`);
  await page.locator('#section-face').getByRole('button', { name: 'Allow re-registration', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Allow face re-registration', exact: true });
  await dialog.getByLabel(/^Reason/).fill(APPROVAL.reason);
  await dialog.getByRole('button', { name: 'Approve re-registration', exact: true }).click();
  await expect(dialog).toContainText('Approval could not be saved. Please try again.');
  await expect(dialog.getByLabel(/^Reason/)).toHaveValue(APPROVAL.reason);
  await expect(dialog.getByRole('button', { name: 'Approve re-registration', exact: true })).toBeEnabled();
  expect(state.authorization).toBeNull();
  state.authorizeError = false;
  await dialog.getByRole('button', { name: 'Approve re-registration', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#section-face')).toContainText('HR approved · ready at any site');
  expect(state.writes).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('failed cancellation leaves the existing HR permission visible and can be retried', async ({ page }) => {
  const state = await mockProfile(page, { authorization: { ...APPROVAL }, revokeError: true });
  await page.goto(`/people/${EMPLOYEE.id}?tab=face`);
  const card = page.locator('#section-face');
  await card.getByRole('button', { name: 'Cancel permission', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel re-registration permission', exact: true });
  await dialog.getByRole('button', { name: 'Cancel permission', exact: true }).click();
  await expect(dialog).toContainText('Permission could not be cancelled. Please try again.');
  expect(state.authorization.usable).toBe(true);
  state.revokeError = false;
  await dialog.getByRole('button', { name: 'Cancel permission', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Allow re-registration', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

async function mockApprovedTablet(page, { failSave = false, blockSave = false } = {}) {
  const state = { usable: true, failSave, blockSave, reads: [], writes: [], unexpected: [], errors: [], sessionCount: 0 };
  await page.clock.setFixedTime(new Date(`${TODAY}T06:00:00.000Z`));
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.addInitScript((position) => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(resolve) { resolve({ coords: { latitude: position.lat, longitude: position.lng, accuracy: position.accuracy_m } }); },
    } });
  }, POSITION);
  await page.route('**/src/services/face.js*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    export const loadGuidance = async () => {};
    export const loadLandmarks = async () => {};
    export const startCamera = async () => ({ getTracks: () => [] });
    export const stopCamera = () => {};
    export const capture = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#16887a'; ctx.fillRect(0, 0, 80, 80);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'));
    };
    export const waitForGoodFrame = async () => false;
    export const waitForHeadTurn = async (_, follow) => { follow?.onProgress?.(1); return { yaw: follow.direction === 'LEFT' ? -25 : 25 }; };
    export const waitForStraight = async (_, follow) => { follow?.onProgress?.(1); return { yaw: 0 }; };
    export const waitForBlink = async (_, follow) => { follow?.onProgress?.(1); return { blob: await capture() }; };
    export const messageFor = (code) => code;
  ` }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const multipart = request.headers()['content-type']?.startsWith('multipart/form-data');
    const body = method === 'GET' ? null : multipart ? { fields: [...request.postData().matchAll(/form-data; name="([^"]+)"/g)].map((m) => m[1]) } : request.postDataJSON();
    if (method === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    else state.writes.push({ path, body });
    let data;
    if (path === '/auth/site-me') data = SITE;
    else if (path === '/tablet/summary') data = { site: SITE, date: TODAY, counts: { punched_in_today: 0, on_site_now: 0, late_in: 0, signed_out: 0, early_out: 0 }, punched_in_today: 0, on_site_now: [], departments: [] };
    else if (path === '/tablet/attendance/month') data = { site: SITE, ym: '2026-10', days: [], rows: [] };
    else if (path === '/tablet/employees') data = state.usable ? [{ ...EMPLOYEE, face_registered: true, allow_reregistration: true, reregistration_expires_at: APPROVAL.expires_at }] : [];
    else if (path === '/punches/sessions' && method === 'POST') {
      state.sessionCount++;
      data = { session_id: `register-session-${state.sessionCount}`, challenge: { type: 'STRAIGHT' }, re_registration: true };
    } else if (/^\/punches\/sessions\/register-session-\d+\/frames$/.test(path) && method === 'POST') {
      if (state.failSave) return route.fulfill({ status: 503, json: { error: { code: 'FACE_UNAVAILABLE', message: 'Face service is temporarily unavailable. Please try again.' } } });
      if (state.blockSave) return route.fulfill({ json: { data: { status: 'BLOCKED', message: 'These photos did not pass the face checks.' } } });
      state.usable = false;
      data = { outcome: 'REGISTERED', message: 'Face registered. You can now punch at any site.' };
    } else {
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint: ${method} ${path}` } } });
    }
    return route.fulfill({ json: { data } });
  });
  return state;
}

async function selectApprovedEmployee(page) {
  await page.getByRole('button', { name: 'Register face', exact: true }).click();
  await expect(page.getByRole('button', { name: /Re-register face|Register again|Re-enrol/ })).toHaveCount(0);
  await page.getByRole('combobox').fill('Example');
  const option = page.getByRole('option');
  await expect(option).toContainText('HR approved');
  await option.getByRole('button', { name: new RegExp(EMPLOYEE.name) }).click();
  await expect(page.getByText('HR approved', { exact: true })).toBeVisible();
  await expect(page.getByText('HR has approved one re-registration. Your current face is replaced only after the new photos pass the checks.', { exact: true })).toBeVisible();
  await page.locator('form').screenshot({ path: '/tmp/face-reregistration-tablet.png' });
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Eyes closed', exact: true })).toBeVisible();
  await expect(page.getByText('HR-approved re-registration. Your current face is replaced only after these photos pass the checks.', { exact: true })).toBeVisible();
}

test('HR-approved registered employees use the existing registration button once at any site', async ({ page }) => {
  const state = await mockApprovedTablet(page);
  await page.goto('/tablet');
  await selectApprovedEmployee(page);
  expect(state.usable).toBe(true);
  expect(state.writes).toEqual([{ path: '/punches/sessions', body: { purpose: 'REGISTER', employee_code: EMPLOYEE.code, name: EMPLOYEE.name, ...POSITION } }]);
  await page.getByRole('button', { name: 'Use these photos', exact: true }).click();
  await expect(page.getByText('Face registered. You can now punch at any site.', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  expect(state.usable).toBe(false);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].body.fields).toEqual(['request_id', 'lat', 'lng', 'accuracy_m', 'front', 'left', 'right', 'blink']);
  await page.getByRole('button', { name: 'Register face', exact: true }).click();
  await page.getByRole('combobox').fill('Example');
  await expect(page.getByRole('listbox')).toContainText(/No active employee/);
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeDisabled();
  expect(state.writes.some(({ path }) => /confirm|manual|change-site/.test(path))).toBe(false);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('a failed face save shows recovery and leaves the HR permission available until success', async ({ page }) => {
  const state = await mockApprovedTablet(page, { failSave: true });
  await page.goto('/tablet');
  await selectApprovedEmployee(page);
  await page.getByRole('button', { name: 'Use these photos', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Face service is temporarily unavailable. Please try again.');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(state.usable).toBe(true);
  state.failSave = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Eyes closed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use these photos', exact: true }).click();
  await expect(page.getByText('Face registered. You can now punch at any site.', { exact: true })).toBeVisible();
  expect(state.usable).toBe(false);
  expect(state.writes.filter(({ path }) => path.endsWith('/frames'))).toHaveLength(2);
  expect(state.writes.filter(({ path }) => path === '/punches/sessions')).toHaveLength(1);
  expect(state.writes.some(({ path }) => /confirm|manual|change-site/.test(path))).toBe(false);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('a blocked registration cannot create manual attendance and starts a fresh registration session to retry', async ({ page }) => {
  const state = await mockApprovedTablet(page, { blockSave: true });
  await page.goto('/tablet');
  await selectApprovedEmployee(page);
  await page.getByRole('button', { name: 'Use these photos', exact: true }).click();
  await expect(page.getByText('Registration could not be completed', { exact: true })).toBeVisible();
  await expect(page.getByText('Your current face is unchanged. You can try again while HR permission is valid.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send to HR', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  expect(state.usable).toBe(true);
  state.blockSave = false;
  await page.getByRole('button', { name: 'Try registration again', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Eyes closed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use these photos', exact: true }).click();
  await expect(page.getByText('Face registered. You can now punch at any site.', { exact: true })).toBeVisible();
  expect(state.usable).toBe(false);
  expect(state.writes.filter(({ path }) => path === '/punches/sessions')).toEqual([
    { path: '/punches/sessions', body: { purpose: 'REGISTER', employee_code: EMPLOYEE.code, name: EMPLOYEE.name, ...POSITION } },
    { path: '/punches/sessions', body: { purpose: 'REGISTER', employee_code: EMPLOYEE.code, name: EMPLOYEE.name, ...POSITION } },
  ]);
  expect(state.writes.some(({ path }) => /manual|confirm/.test(path))).toBe(false);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
