import { expect, test } from '@playwright/test';

const MONTH = '2026-10';
const TODAY = '2026-10-11';
const EMPLOYEE_A = '00000000-0000-4000-8000-000000000091';
const EMPLOYEE_B = '00000000-0000-4000-8000-000000000092';
const department = { id: 'dept-operations', name: 'Operations', colour: 'chart-1' };
const site = { id: 'site-a', code: 'ALPHA', name: 'Alpha substation' };
const group = { id: 'group-a', name: 'Site workforce' };
const employees = [
  { id: EMPLOYEE_A, code: 'AJTEST01', name: 'Example Anil', department, pay_group_id: group.id },
  { id: EMPLOYEE_B, code: 'AJTEST02', name: 'Example Bhavana', department, pay_group_id: group.id },
];
const monthDates = (ym) => {
  const [year, month] = ym.split('-').map(Number);
  return Array.from({ length: new Date(Date.UTC(year, month, 0)).getUTCDate() }, (_, index) => `${ym}-${String(index + 1).padStart(2, '0')}`);
};
const dates = monthDates(MONTH);

function initialDay(date, employeeId) {
  const first = employeeId === EMPLOYEE_A;
  const missing = first && date === '2026-10-09';
  const absent = first && date === '2026-10-10';
  const worked = absent || missing ? 0 : first && date === '2026-10-07' ? 520 : first && date === '2026-10-08' ? 525 : 540;
  return {
    date, kind: 'WORKING', status: absent ? 'ABSENT' : missing ? 'MISSING_PUNCH' : 'PRESENT',
    day_value: absent ? 0 : missing ? 0.5 : 1, worked_min: worked,
    first_punch_min: absent ? null : 540, last_punch_min: absent || missing ? null : 540 + worked,
    late_min: 0, early_min: !missing && !absent ? 540 - worked : 0,
    shift_shortfall_min: !missing && !absent ? 540 - worked : 0, required_min: 540, standard_min: 540,
    ot_min: 0, sites: absent ? [] : [site.id], flags: missing ? ['UNMATCHED_IN'] : [],
    leave_days: 0, auto_leave: 0, pairs: missing || absent ? 0 : 1, break_min: 0,
    overridden: false, future: date > TODAY,
  };
}

async function mockAttendance(page, { readOnly = false, frozen = false, frozenPayroll = false, noExport = false, noAttendance = false, delayedDay = null, delayedMonthEmployee = null, delayedMonth = null, staleFrozen = false } = {}) {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  const state = { writes: [], previews: [], reads: [], downloads: [], unexpected: [], errors: [], overrides: new Map() };
  const day = (employeeId, date) => {
    const original = initialDay(date, employeeId);
    const override = state.overrides.get(`${employeeId}:${date}`);
    return override ? { ...original, ...override, overridden: true } : original;
  };
  const summary = (employeeId, ym = MONTH) => {
    const days = monthDates(ym).filter((date) => date <= TODAY).map((date) => day(employeeId, date));
    const paid = days.reduce((total, item) => total + item.day_value, 0);
    const shortfall = days.reduce((total, item) => total + item.shift_shortfall_min, 0);
    return {
      days: days.length, working_days: days.length, present: days.filter((item) => item.status === 'PRESENT').length,
      present_days: days.filter((item) => item.status === 'PRESENT').length, absent: days.filter((item) => item.status === 'ABSENT').length,
      absent_days: days.filter((item) => item.status === 'ABSENT').length, half_day: 0, short_days: 0,
      missing_punch: days.filter((item) => item.status === 'MISSING_PUNCH').length,
      paid, paid_days: paid, lop: days.length - paid, lop_days: days.length - paid, lop_in_window: days.length - paid,
      paid_leave_days: 0, unpaid_leave_days: 0, applied_paid_leave: 0, auto_leave_days: 0, leave_days: 0,
      late_days: 0, late_minutes: shortfall, shift_shortfall_min: shortfall, ot_min: 0, worked_min: days.reduce((total, item) => total + item.worked_min, 0),
      off_days: 0, off_days_worked: 0, corrected: days.filter((item) => item.overridden).length,
    };
  };
  const month = (employeeId, ym = MONTH) => ({
    month: ym, ym, today: TODAY, employee: employees.find((item) => item.id === employeeId),
    days: monthDates(ym).map((date) => day(employeeId, date)), sites: [site],
    attendance_summary: summary(employeeId, ym), totals: summary(employeeId, ym), frozen: { frozen, reason: frozen ? 'Attendance is frozen by submitted payroll.' : null },
  });
  const dayResponse = (employeeId, date) => {
    const effective = day(employeeId, date), original = initialDay(date, employeeId);
    const override = state.overrides.get(`${employeeId}:${date}`);
    return {
      employee: employees.find((item) => item.id === employeeId), date,
      in_min: effective.first_punch_min, out_min: effective.last_punch_min,
      computed: original, day: effective, effective, shift_shortfall_min: effective.shift_shortfall_min, required_shift_min: 540, open_now: false,
      override: override ? { ...override, id: `override-${employeeId}-${date}`, in_min: override.first_punch_min, out_min: override.last_punch_min, work_date: date, created_by: 'Example HR', reason_text: override.reason_text } : null,
      context: { kind: 'WORKING', shift_start_min: 540, shift_end_min: 1080, standard_min: 540, grace_min: 0, off_day_paid: false, ot: { after_min: 0, rounding_min: 1 } },
      punches: original.status === 'ABSENT' ? [] : [
        { id: `${date}-in`, punched_at: `${date}T03:30:00Z`, direction: 'IN', site, method: 'FACE', match_score: 0.99, flagged: false },
        ...(original.last_punch_min !== null ? [{ id: `${date}-out`, punched_at: `${date}T12:30:00Z`, direction: 'OUT', site, method: 'FACE', match_score: 0.99, flagged: false }] : []),
      ],
      not_in_employment: false, frozen: { frozen, reason: frozen ? 'Attendance is frozen by submitted payroll.' : null },
    };
  };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', ''), method = request.method();
    const body = method === 'POST' ? request.postDataJSON() : null;
    if (method === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    let data, meta;
    if (path === '/auth/me') data = { id: 'hr', name: 'Example HR', role: 'HR Admin', permissions: ['people.read', 'payroll.read', 'payroll.run', 'setup.read', ...(noAttendance ? [] : ['attendance.read']), ...(readOnly ? [] : ['attendance.write']), ...(noExport ? [] : ['reports.export'])] };
    else if (path === '/lookups') data = { today: TODAY, departments: [department], sites: [site], pay_groups: [group], structures: [], shifts: [], leave_types: [] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/approvals') data = {
      today: TODAY, sites: [site], departments: [department], window_days: 30,
      items: state.overrides.has(`${EMPLOYEE_A}:2026-10-09`) ? [] : [{
        id: 'missing-punch-approval', kind: 'miss', day: '2026-10-09', at: '2026-10-09T18:29:00Z', employee: employees[0], site,
        detail: { work_date: '2026-10-09', status: 'MISSING_PUNCH', in_min: 540, out_min: null, worked_min: 0, early_min: 0, late_min: 0, standard_min: 540, sites: [site.name] },
      }],
    };
    else if (path === '/saved-views') data = [];
    else if (path === '/attendance' && method === 'GET') {
      const selectedDate = url.searchParams.get('date') || TODAY;
      data = employees.map((employee) => ({ employee, day: day(employee.id, selectedDate), in_min: day(employee.id, selectedDate).first_punch_min, out_min: day(employee.id, selectedDate).last_punch_min, open_now: false, override: state.overrides.get(`${employee.id}:${selectedDate}`) || null }));
      meta = { total: data.length, page: 1, limit: 20, pages: 1, frozen: { frozen, reason: 'Attendance is frozen by submitted payroll.' }, summary: { everyone: 2, in: 2, absent: 0, onsite: 0, ot: 0, late: 0, early: 0, leave: 0 } };
    } else if (path === '/attendance/month') data = { ym: MONTH, today: TODAY, dates, frozen: { frozen, reason: 'Attendance is frozen by submitted payroll.' }, rows: employees.map((employee) => ({ employee, days: month(employee.id).days, totals: summary(employee.id) })) };
    else if (path === '/attendance/day') {
      const employeeId = url.searchParams.get('employee_id'), date = url.searchParams.get('date');
      if (date === delayedDay) await new Promise((resolve) => setTimeout(resolve, 500));
      data = dayResponse(employeeId, date);
    } else if (/^\/employees\/[^/]+\/attendance$/.test(path)) {
      const employeeId = path.split('/')[2];
      const ym = url.searchParams.get('month') ?? MONTH;
      if (employeeId === delayedMonthEmployee || ym === delayedMonth) await new Promise((resolve) => setTimeout(resolve, 1200));
      data = month(employeeId, ym);
    }
    else if (/^\/employees\/[^/]+$/.test(path)) {
      const employee = employees.find((item) => item.id === path.split('/')[2]);
      data = { ...employee, status: 'ACTIVE', joined_on: '2024-01-01', updated_at: TODAY, designation: 'Coordinator', read_only: false, gender: 'MALE', phone: '', salary: null, pay_group: group, identity: {}, face: { enrolled: false }, onboarding: { required_left: 0 }, rules: { shift: { name: 'General', start_min: 540, end_min: 1080 } } };
    } else if (path.endsWith('/leave-balances')) data = { types: [], year: { start: '2026-01', end: '2026-12' } };
    else if (path.endsWith('/hold')) data = { current: null, history: [], open_months: [] };
    else if (path === '/advances-loans') data = { rows: [] };
    else if (path === '/payroll/periods') { data = [{ ym: MONTH, state: 'DRAFT' }]; meta = { suggested: MONTH }; }
    else if (path === `/payroll/periods/${MONTH}`) data = { ym: MONTH, state: 'DRAFT', steps_submitted: frozen || frozenPayroll ? [1] : [], step_log: [] };
    else if (path === `/payroll/periods/${MONTH}/attendance`) data = { rows: employees.map((employee) => ({ employee, ...summary(employee.id), attendance_summary: summary(employee.id), in_run: true, partial: false, overridden_days: summary(employee.id).corrected })), shortlist: [{ employee: employees[0], date: '2026-10-09', status: 'MISSING_PUNCH', worked_min: 0 }] };
    else if (path === '/attendance/overrides/preview' && method === 'POST') {
      state.previews.push(body);
      const out = body.out_min ?? body.in_min + 540 + (body.ot_min ?? 0), worked = out - body.in_min;
      data = { ...initialDay(body.work_date, body.employee_id), status: 'PRESENT', day_value: 1, in_min: body.in_min, out_min: out, worked_min: worked, ot_min: Math.max(0, worked - 540), shift_shortfall_min: Math.max(0, 540 - worked) };
    } else if (path === '/attendance/overrides' && method === 'POST') {
      state.writes.push({ path, method, body });
      if (staleFrozen) return route.fulfill({ status: 409, json: { error: { code: 'ATTENDANCE_FROZEN', message: 'Payroll was submitted while this correction was open. Reopen attendance before saving.' } } });
      const worked = body.mode === 'TIMES' ? body.out_min - body.in_min : body.status === 'PRESENT' ? 540 : body.status === 'HALF_DAY' ? 270 : 0;
      state.overrides.set(`${body.employee_id}:${body.work_date}`, {
        status: body.mode === 'TIMES' ? 'PRESENT' : body.status, day_value: body.mode === 'TIMES' || body.status === 'PRESENT' ? 1 : body.status === 'HALF_DAY' ? 0.5 : 0,
        first_punch_min: body.mode === 'TIMES' ? body.in_min : null, last_punch_min: body.mode === 'TIMES' ? body.out_min : null,
        worked_min: worked, shift_shortfall_min: worked ? Math.max(0, 540 - worked) : 0, late_min: 0, early_min: 0,
        ot_min: body.ot_min ?? Math.max(0, worked - 540), reason_text: body.reason_text,
      });
      data = { id: 'saved-override' };
    } else if (path.startsWith('/attendance/overrides/') && method === 'DELETE') {
      state.writes.push({ path, method, body: null });
      for (const key of state.overrides.keys()) {
        if (`/attendance/overrides/override-${key.replace(':', '-')}` === path) state.overrides.delete(key);
      }
      data = { restored: true };
    } else if (path.startsWith('/attendance/reports/')) {
      state.downloads.push({ path, query: Object.fromEntries(url.searchParams) });
      const format = url.searchParams.get('format'), report = url.searchParams.get('report') ?? 'daily';
      return route.fulfill({ status: 200, contentType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'Content-Disposition': `attachment; filename="attendance-${report}-${MONTH}.${format}"` }, body: format === 'pdf' ? '%PDF-1.4\nMocked UI download' : 'Mocked UI spreadsheet download' });
    } else {
      state.unexpected.push({ path, method });
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected mock request ${method} ${path}` } } });
    }
    return route.fulfill({ json: { data, ...(meta ? { meta } : {}) } });
  });
  return state;
}

const calendar = (page) => page.getByRole('region', { name: 'Month attendance calendar' });
const selectedDay = (page) => page.getByRole('region', { name: 'Selected day attendance' });
const correction = (page) => page.getByRole('region', { name: 'Correct attendance', exact: true });
const attendanceDrawer = (page) => page.getByRole('dialog', { name: 'Attendance details', exact: true });
const drawerMonthTotals = (page) => attendanceDrawer(page).getByRole('region', { name: 'Monthly attendance totals', exact: true });
const dayButton = (page, dayNumber) => calendar(page).getByRole('button', { name: new RegExp(`, ${dayNumber} October 2026:`) });
const clean = (state) => { expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]); };

test('profile calendar shows month totals and corrects the selected day without a drawer or navigation', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto(`/people/${EMPLOYEE_A}?tab=attendance`);
  await expect(calendar(page)).toBeVisible();
  await expect(page.getByText('35 min', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/35 late minutes/)).toBeVisible();
  await dayButton(page, 7).click();
  await expect(selectedDay(page)).toContainText('8h 40m');
  await expect(correction(page)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await correction(page).getByRole('radio', { name: 'Full day', exact: true }).click();
  await correction(page).getByLabel('Correction reason').fill('Confirmed completed shift');
  await correction(page).getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toMatchObject({ employee_id: EMPLOYEE_A, work_date: '2026-10-07', mode: 'MARK', status: 'PRESENT' });
  await expect(page.getByText('15 min', { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/people/${EMPLOYEE_A}\\?tab=attendance$`));
  clean(state);
});

test('daily register opens the calendar above day details in a drawer and a new employee starts a clean correction', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto(`/attendance?date=${TODAY}`);
  await page.getByRole('button', { name: /Example Anil/ }).first().click();
  await expect(attendanceDrawer(page)).toBeVisible();
  await expect(calendar(page)).toBeVisible();
  await expect(selectedDay(page)).toContainText('Sunday, 11 October 2026');
  await expect(drawerMonthTotals(page)).toContainText('35 min');
  expect(await calendar(page).evaluate((element) => !!(element.compareDocumentPosition(document.querySelector('[aria-label="Selected day attendance"]')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await correction(page).getByLabel('Correction reason').fill('Draft for Anil only');
  await attendanceDrawer(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: /Example Bhavana/ }).first().click();
  await expect(correction(page).getByLabel('Correction reason')).toHaveValue('');
  await expect(attendanceDrawer(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/attendance\\?date=${TODAY}$`));
  expect(state.writes).toEqual([]);
  clean(state);
});

test('reopening the drawer for another employee never displays the previous employee month or day details', async ({ page }) => {
  const state = await mockAttendance(page, { delayedMonthEmployee: EMPLOYEE_B });
  await page.goto('/attendance?date=2026-10-07');
  await page.getByRole('button', { name: 'Open attendance for Example Anil', exact: true }).click();
  await expect(calendar(page)).toBeVisible();
  await expect(selectedDay(page)).toContainText('8h 40m');
  await attendanceDrawer(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open attendance for Example Bhavana', exact: true }).click();
  await expect(selectedDay(page)).toContainText('Example Bhavana');
  // Her day request finishes before her month. It must not inherit Anil's 8h40m day.
  expect(await selectedDay(page).innerText()).toContain('9h');
  expect(await selectedDay(page).innerText()).not.toContain('8h 40m');
  await expect(calendar(page)).toBeVisible();
  await expect(drawerMonthTotals(page)).toContainText('0 min');
  clean(state);
});

test('crossing a month in the drawer hides stale calendar cells and shows the selected month late-minute total', async ({ page }) => {
  const state = await mockAttendance(page, { delayedMonth: '2026-09' });
  await page.goto('/attendance?date=2026-10-01');
  await page.getByRole('button', { name: 'Open attendance for Example Anil', exact: true }).click();
  await expect(drawerMonthTotals(page)).toContainText('35 min');
  await attendanceDrawer(page).getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(selectedDay(page)).toContainText('Wednesday, 30 September 2026');
  expect(await calendar(page).getByRole('button', { name: /October 2026/ }).count()).toBe(0);
  await expect(calendar(page).getByRole('button', { name: /30 September 2026/ })).toBeVisible();
  await expect(drawerMonthTotals(page)).toContainText('0 min');
  clean(state);
});

test('switching calendar days does not carry a draft or show a delayed previous day as the current day', async ({ page }) => {
  const state = await mockAttendance(page, { delayedDay: '2026-10-07' });
  await page.goto(`/people/${EMPLOYEE_A}?tab=attendance`);
  await correction(page).getByLabel('Correction reason').fill('Draft for today');
  await dayButton(page, 7).click();
  await dayButton(page, 8).click();
  await expect(selectedDay(page)).toContainText('Thursday, 8 October 2026');
  await expect(selectedDay(page)).toContainText('8h 45m');
  await expect(correction(page).getByLabel('Correction reason')).toHaveValue('');
  await page.waitForTimeout(650);
  await expect(selectedDay(page)).toContainText('Thursday, 8 October 2026');
  expect(state.writes).toEqual([]);
  clean(state);
});

test('a server rejection after payroll submission keeps the correction draft visible', async ({ page }) => {
  const state = await mockAttendance(page, { staleFrozen: true });
  await page.goto(`/people/${EMPLOYEE_A}?tab=attendance`);
  await dayButton(page, 7).click();
  await correction(page).getByRole('radio', { name: 'Full day', exact: true }).click();
  await correction(page).getByLabel('Correction reason').fill('Verified completed work');
  await correction(page).getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByText('Payroll was submitted while this correction was open. Reopen attendance before saving.', { exact: true })).toBeVisible();
  await expect(correction(page).getByLabel('Correction reason')).toHaveValue('Verified completed work');
  await expect(page.getByText('35 min', { exact: true }).first()).toBeVisible();
  expect(state.writes).toHaveLength(1);
  clean(state);
});

test('monthly register opens a selected day in a drawer with total late minutes below its calendar', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto(`/attendance?tab=month&ym=${MONTH}`);
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: /Example Anil/ }) });
  await expect(page.getByRole('columnheader', { name: 'Late minutes', exact: true })).toBeVisible();
  await expect(row).toContainText('35');
  await row.getByRole('button', { name: /9 October 2026.*No out/ }).click();
  await expect(selectedDay(page)).toContainText('No punch-out');
  await expect(correction(page)).toBeVisible();
  await expect(attendanceDrawer(page)).toBeVisible();
  await expect(drawerMonthTotals(page)).toContainText('35 min');
  const finalCalendarCellBox = await calendar(page).getByRole('button').last().boundingBox(), totalsBox = await drawerMonthTotals(page).boundingBox();
  expect(totalsBox.y).toBeGreaterThanOrEqual(finalCalendarCellBox.y + finalCalendarCellBox.height);
  await page.screenshot({ path: '/tmp/attendance-month-drawer.png', fullPage: true });
  await dayButton(page, 7).click();
  await correction(page).getByRole('radio', { name: 'Full day', exact: true }).click();
  await correction(page).getByLabel('Correction reason').fill('Completed shift confirmed');
  await correction(page).getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(drawerMonthTotals(page)).toContainText('15 min');
  expect(state.writes[0].body).toMatchObject({ employee_id: EMPLOYEE_A, work_date: '2026-10-07', mode: 'MARK', status: 'PRESENT' });
  clean(state);
});

test('payroll attendance opens the employee month and corrects a shortlisted day in its attendance drawer', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto(`/payroll/${MONTH}?step=1`);
  await page.getByRole('button', { name: /Example Anil.*10-09/ }).click();
  await expect(attendanceDrawer(page)).toBeVisible();
  await expect(calendar(page)).toBeVisible();
  await expect(selectedDay(page)).toContainText('Friday, 9 October 2026');
  await correction(page).getByRole('radio', { name: 'In and out times', exact: true }).click();
  await correction(page).getByLabel('Punch in', { exact: true }).fill('09:00');
  await correction(page).getByLabel('Punch out', { exact: true }).fill('18:00');
  await correction(page).getByLabel('Correction reason').fill('Verified missing punch-out');
  await correction(page).getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toMatchObject({ employee_id: EMPLOYEE_A, work_date: '2026-10-09', mode: 'TIMES', in_min: 540, out_min: 1080 });
  await expect(page).toHaveURL(new RegExp(`/payroll/${MONTH}\\?step=1$`));
  await expect(attendanceDrawer(page)).toBeVisible();
  await expect(drawerMonthTotals(page)).toContainText('35 min');
  clean(state);
});

test('submitted payroll keeps its attendance drawer read-only even if day metadata has not caught up', async ({ page }) => {
  const state = await mockAttendance(page, { frozenPayroll: true });
  await page.goto(`/payroll/${MONTH}?step=1`);
  await page.getByRole('button', { name: 'View attendance for Example Anil', exact: true }).click();
  await expect(attendanceDrawer(page)).toBeVisible();
  await expect(calendar(page)).toBeVisible();
  await expect(selectedDay(page)).toContainText('Example Anil');
  await expect(attendanceDrawer(page).getByRole('button', { name: 'Save correction', exact: true })).toHaveCount(0);
  await expect(attendanceDrawer(page).getByLabel('Correction reason')).toHaveCount(0);
  expect(state.writes).toEqual([]);
  clean(state);
});

test('a payroll reader without attendance access sees payroll totals but cannot load employee attendance details', async ({ page }) => {
  const state = await mockAttendance(page, { noAttendance: true });
  await page.goto(`/payroll/${MONTH}?step=1`);
  await expect(page.getByRole('button', { name: 'View attendance for Example Anil', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Example Anil.*10-09/ })).toBeDisabled();
  await expect(page.getByText('Attendance details require attendance access. Payroll totals are shown below.', { exact: true })).toBeVisible();
  await expect(calendar(page)).toHaveCount(0);
  expect(state.reads.some(({ path }) => path === '/attendance/day' || /^\/employees\/[^/]+\/attendance$/.test(path))).toBe(false);
  clean(state);
});

for (const [label, options] of [['read-only permissions', { readOnly: true }], ['submitted payroll', { frozen: true }]]) {
  test(`${label} keeps the calendar and details visible while withholding correction controls`, async ({ page }) => {
    const state = await mockAttendance(page, options);
    await page.goto(`/people/${EMPLOYEE_A}?tab=attendance`);
    await dayButton(page, 7).click();
    await expect(selectedDay(page)).toContainText('8h 40m');
    await expect(page.getByRole('button', { name: 'Save correction', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Correction reason')).toHaveCount(0);
    expect(state.writes).toEqual([]);
    clean(state);
  });
}

test('monthly register offers both reports with Excel or PDF and preserves department filtering in the download', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto(`/attendance?tab=month&ym=${MONTH}`);
  await page.getByLabel('Department', { exact: true }).selectOption(department.id);
  await page.getByRole('button', { name: 'Download report', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Download monthly report', exact: true });
  await expect(dialog.getByRole('radio', { name: 'Monthly summary', exact: false })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Daily details for all employees', exact: false })).toBeVisible();
  await dialog.getByRole('radio', { name: 'Daily details for all employees', exact: false }).click();
  await dialog.getByRole('radio', { name: 'PDF', exact: true }).click();
  const pdf = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);
  expect(state.downloads[0]).toMatchObject({ path: '/attendance/reports/monthly', query: { ym: MONTH, report: 'detailed', format: 'pdf', dept: department.id } });
  await page.getByRole('button', { name: 'Download report', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Monthly summary', exact: false }).click();
  await dialog.getByRole('radio', { name: 'Excel', exact: true }).click();
  const excel = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download Excel', exact: true }).click();
  expect((await excel).suggestedFilename()).toMatch(/\.xlsx$/);
  expect(state.downloads[1]).toMatchObject({ path: '/attendance/reports/monthly', query: { ym: MONTH, report: 'summary', format: 'xlsx' } });
  clean(state);
});

test('daily register downloads the selected day and users without export permission see no report action', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto('/attendance?date=2026-10-08');
  await page.getByRole('button', { name: 'Download report', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Download daily report', exact: true });
  await expect(dialog.getByRole('radio', { name: 'Monthly summary', exact: false })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download Excel', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  expect(state.downloads[0]).toMatchObject({ path: '/attendance/reports/daily', query: { date: '2026-10-08', format: 'xlsx' } });
  clean(state);
});

test('report action is unavailable without reports.export permission', async ({ page }) => {
  const state = await mockAttendance(page, { noExport: true });
  await page.goto(`/attendance?tab=month&ym=${MONTH}`);
  await expect(page.getByRole('button', { name: /Example Anil/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download report', exact: true })).toHaveCount(0);
  expect(state.downloads).toEqual([]);
  clean(state);
});

test('employee attendance stays usable on a phone without page-wide horizontal scrolling', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/people/${EMPLOYEE_A}?tab=attendance`);
  await dayButton(page, 7).click();
  await expect(selectedDay(page)).toContainText('8h 40m');
  await expect(correction(page).getByLabel('Correction reason')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/attendance-profile-phone.png', fullPage: true });
  clean(state);
});

test('Approvals retains its legacy attendance drawer and can save and revert a real out time', async ({ page }) => {
  const state = await mockAttendance(page);
  await page.goto('/approvals');
  await expect(page.getByText('Provisional half day, no overtime', { exact: true })).toBeVisible();
  await expect(page.getByText('02:00 the next morning', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enter real out time', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Attendance details', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Month attendance calendar' })).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Selected day attendance' })).toContainText('Friday, 9 October 2026');
  const form = drawer.getByRole('region', { name: 'Correct attendance', exact: true });
  await form.getByRole('radio', { name: 'In and out times', exact: true }).click();
  await form.getByLabel('Punch out', { exact: true }).fill('18:00');
  await form.getByLabel('Correction reason').fill('Supervisor confirmed the real out time');
  await form.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(drawer.getByRole('region', { name: 'Existing correction', exact: true })).toContainText('Supervisor confirmed the real out time');
  await expect(drawer.getByRole('region', { name: 'Selected day attendance' })).toContainText('18:00');
  await drawer.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({ method: 'DELETE' });
  await expect(drawer.getByRole('region', { name: 'Existing correction', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('region', { name: 'Selected day attendance' })).toContainText('No punch-out');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(/\/approvals$/);
  clean(state);
});
