import { expect, test } from '@playwright/test';

const TODAY = '2026-10-11';
const SITE = {
  id: '00000000-0000-4000-8000-000000000081', code: 'ALPHA-TEST', name: 'Alpha substation',
  state: 'Telangana', address: 'Example project road', lat: 17.4, lng: 78.4, radius_m: 250,
  login: 'alpha-test', login_enabled: true, is_active: true, tablet_signed_in: true,
  project_id: '00000000-0000-4000-8000-000000000083',
  project: { id: '00000000-0000-4000-8000-000000000083', name: 'Transmission upgrade' }, last_login_at: `${TODAY}T03:00:00.000Z`,
};
const OTHER_SITE = { ...SITE, id: '00000000-0000-4000-8000-000000000082', code: 'BETA-TEST', name: 'Beta line camp', login: 'beta-test', project: null };
const DEPARTMENTS = [
  { id: 'electrical', name: 'Electrical', colour: 'chart-1', count: 14 },
  { id: 'civil', name: 'Civil', colour: 'chart-2', count: 10 },
  { id: 'mechanical', name: 'Mechanical', colour: 'chart-3', count: 8 },
];
const PEOPLE = DEPARTMENTS.flatMap((department) => Array.from({ length: department.count }, (_, i) => ({
  id: `${department.id}-person-${i + 1}`, code: `${department.id.toUpperCase().slice(0, 3)}${String(i + 1).padStart(3, '0')}`,
  name: `Example ${department.name} ${i + 1}`, designation: i === 0 ? 'Supervisor' : 'Technician',
  department: department.name, department_id: department.id, colour: department.colour,
  since: `${TODAY}T03:${String(10 + i).padStart(2, '0')}:00.000Z`,
})));
const ATTENDANCE = Array.from({ length: 11 }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, punched_in: [36, 38, 0, 40, 39, 42, 35, 41, 38, 44, 42][index],
  signed_out: index === 10 ? 10 : 30 + index % 6, late_in: index % 4,
  worked_min: 12000 + index * 240, ot_min: [120, 180, 0, 240, 300, 420, 180, 360, 240, 480, 210][index],
}));
const WAGE_DEPARTMENTS = [
  { ...DEPARTMENTS[0], people: 20, worked_min: 54000, ot_min: 840, normal_wages: 7200000, ot_wages: 700000, other_wages: 200000, total_wages: 8100000 },
  { ...DEPARTMENTS[1], people: 14, worked_min: 36000, ot_min: 1560, normal_wages: 4500000, ot_wages: 250000, other_wages: 100000, total_wages: 4850000 },
  { ...DEPARTMENTS[2], people: 12, worked_min: 24000, ot_min: 330, normal_wages: 2700000, ot_wages: 100000, other_wages: 50000, total_wages: 2850000 },
];
const trendWeights = ATTENDANCE.map((row) => row.punched_in);
const trendWeightTotal = trendWeights.reduce((sum, value) => sum + value, 0);
const dailyAmounts = (total) => {
  const rows = trendWeights.map((weight) => Math.floor(total * weight / trendWeightTotal));
  rows[rows.length - 1] += total - rows.reduce((sum, value) => sum + value, 0);
  return rows;
};
const normalByDay = dailyAmounts(14400000), otByDay = dailyAmounts(1050000), otherByDay = dailyAmounts(350000);
const workedByDay = dailyAmounts(114000);
ATTENDANCE.forEach((day, index) => { day.worked_min = workedByDay[index]; });
const COSTS = {
  normal_wages: 14400000, ot_wages: 1050000, other_wages: 350000, total_wages: 15800000, ot_min: 2730,
  departments: WAGE_DEPARTMENTS,
  trend: ATTENDANCE.map((day, index) => ({ date: day.date, normal_wages: normalByDay[index], ot_wages: otByDay[index], other_wages: otherByDay[index], total_wages: normalByDay[index] + otByDay[index] + otherByDay[index], ot_min: day.ot_min })),
  source: 'mixed', attribution: 'estimated', uncosted_people: 1, uncosted_min: 180,
  unallocated_wages: 0, months: [{ month: '2026-09', source: 'snapshot' }, { month: '2026-10', source: 'estimate' }],
  note: 'Site wage costs are allocated from payroll using time worked at this site. Open months are estimates.',
};

/** Fictional names, attendance and payroll. These tests never reset or mutate the imported employee database. */
async function mockSites(page, { empty = false, costs = true, manage = true, legacyColour = null } = {}) {
  const state = { reads: [], writes: [], unexpected: [], errors: [] };
  const withDepartmentColour = (row) => legacyColour && (row.department_id ?? row.id) === 'electrical' ? { ...row, colour: legacyColour } : row;
  const departments = DEPARTMENTS.map(withDepartmentColour);
  const people = PEOPLE.map(withDepartmentColour);
  await page.clock.setFixedTime(new Date(`${TODAY}T06:30:00.000Z`));
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname.replace('/api/v1', '');
    if (req.method() === 'GET') state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    else state.writes.push({ path, method: req.method(), body: req.postDataJSON() });
    let data;
    if (path === '/auth/me') data = { id: 'hr-test', name: 'HR Admin', role: 'HR Admin', email: 'hr@example.test', permissions: ['sites.read', 'people.read', ...(costs ? ['payroll.read'] : []), ...(manage ? ['sites.manage'] : [])] };
    else if (path === '/lookups') data = { today: TODAY, sites: [SITE, OTHER_SITE], departments, projects: [SITE.project], pay_groups: [], structures: [], pt_states: ['Telangana'], states: ['Telangana', 'Andhra Pradesh'] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/sites') data = [SITE, OTHER_SITE].map((site, i) => ({
      ...site, today: { punched_in: empty ? 0 : i ? 18 : 42, on_site_now: empty ? 0 : i ? 12 : 32, worked_min: empty ? 0 : i ? 5400 : 19200 },
      sparkline: ATTENDANCE.map((day) => ({ date: day.date, present: empty ? 0 : i ? Math.round(day.punched_in / 2) : day.punched_in })),
    }));
    else if (path === `/sites/${SITE.id}/insights`) {
      const from = url.searchParams.get('from') || '2026-10-01', to = url.searchParams.get('to') || TODAY;
      const date = url.searchParams.get('date') || TODAY;
      const wages = empty ? { ...COSTS, normal_wages: 0, ot_wages: 0, other_wages: 0, total_wages: 0, ot_min: 0, departments: [], trend: [], uncosted_people: 0, uncosted_min: 0, months: [], source: 'estimate' } : { ...COSTS, departments: WAGE_DEPARTMENTS.map(withDepartmentColour) };
      data = {
        site: SITE, date,
        today: empty ? { punched_in: 0, on_site_now: 0, signed_out: 0, late_in: 0, early_out: 0, worked_min: 0, ot_min: 0 } : { punched_in: 42, on_site_now: 32, signed_out: 10, late_in: 3, early_out: 1, worked_min: 19200, ot_min: 210 },
        on_site_now: empty ? [] : people, departments: empty ? [] : departments,
        attendance: empty ? [] : ATTENDANCE,
        period: { from, to, people: empty ? 0 : 46, person_days: empty ? 0 : 395, worked_min: empty ? 0 : 114000, ot_min: empty ? 0 : 2730 },
        costs: costs ? wages : null,
      };
    } else if (path === `/sites/${SITE.id}/day`) data = {
      site: SITE, date: TODAY,
      today: { punched_in: empty ? 0 : 42, on_site_now: empty ? 0 : 32, worked_min: empty ? 0 : 19200, avg_min: empty ? 0 : 457 },
      on_site_now: empty ? [] : people, people_per_day: ATTENDANCE.map((day) => ({ date: day.date, present: day.punched_in })),
      department_mix: [], arrivals_by_hour: [], movement: [], punches: [],
    };
    else {
      state.unexpected.push(path);
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint ${path}` } } });
    }
    return route.fulfill({ json: { data } });
  });
  return state;
}

const clean = (state) => {
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.writes).toEqual([]);
};

async function view(page, name) {
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name, exact: true });
}

test('HR site directory emphasizes current people and attendance without loading networks', async ({ page }) => {
  const state = await mockSites(page);
  await page.goto('/sites');
  await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
  const alpha = page.getByRole('link', { name: `Open ${SITE.name}`, exact: true });
  await expect(alpha).toContainText('32');
  await expect(alpha).toContainText('people on site now');
  await expect(alpha).toContainText('42');
  await expect(page.getByRole('img', { name: /Alpha substation: daily attendance/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Networks/ })).toHaveCount(0);
  expect(state.reads.some(({ path }) => /network/i.test(path))).toBe(false);
  await page.getByRole('textbox', { name: 'Search sites', exact: true }).fill('beta');
  await expect(alpha).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Open ${OTHER_SITE.name}`, exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search sites', exact: true }).fill('missing');
  await expect(page.getByRole('heading', { name: 'No sites match', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await alpha.click();
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('list', { name: 'People on site', exact: true }).getByRole('listitem')).toHaveCount(32);
  await expect(page.getByRole('region', { name: 'Wage cost', exact: true })).toHaveCount(0);
  clean(state);
});

test('site Overview stays compact and period screens open only from their tabs', async ({ page }) => {
  const state = await mockSites(page);
  await page.goto(`/sites/${SITE.id}`);
  const overview = page.getByRole('tabpanel', { name: 'Overview', exact: true });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole('list', { name: 'People on site', exact: true }).getByRole('listitem')).toHaveCount(32);
  await expect(page.getByLabel('Attendance month', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Wage cost', exact: true })).toHaveCount(0);
  const main = page.locator('main');
  expect(await main.evaluate((element) => element.scrollHeight <= element.clientHeight + 24)).toBe(true);
  const reads = state.reads.filter(({ path }) => path.endsWith('/insights')).length;
  const attendance = await view(page, 'Attendance');
  await expect(attendance.getByLabel('Attendance month', { exact: true })).toBeVisible();
  await expect(attendance.getByRole('list', { name: 'People on site', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Wage cost', exact: true })).toHaveCount(0);
  await view(page, 'Wages');
  await expect(page.getByRole('region', { name: 'Wage cost', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'People on site', exact: true })).toHaveCount(0);
  await view(page, 'Overview');
  await expect(overview.getByRole('list', { name: 'People on site', exact: true }).getByRole('listitem')).toHaveCount(32);
  expect(state.reads.filter(({ path }) => path.endsWith('/insights'))).toHaveLength(reads);
  await page.screenshot({ path: '/tmp/site-compact-desktop-overview.png' });
  clean(state);
});

test('site Wages opens one visualization at a time and exposes accurate department figures', async ({ page }) => {
  const state = await mockSites(page);
  await page.goto(`/sites/${SITE.id}`);
  await view(page, 'Wages');
  const wages = page.getByRole('region', { name: 'Wage cost', exact: true });
  await expect(wages).toContainText('₹1,58,000');
  await expect(wages).toContainText('₹1,44,000');
  await expect(wages).toContainText('₹10,500');
  await expect(wages).toContainText('Payroll + estimates');
  await expect(wages.getByRole('table')).toHaveCount(0);
  const wageView = wages.getByRole('radiogroup', { name: 'Wage view', exact: true });
  await expect(wageView.getByRole('radio', { name: 'Trend', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(wages.getByRole('img', { name: 'Department wages, highest first', exact: true })).toHaveCount(0);
  await wageView.getByRole('radio', { name: 'Departments', exact: true }).click();
  await expect(wages.getByRole('img', { name: 'Department wages, highest first', exact: true })).toBeVisible();
  await expect(wages.getByRole('table')).toHaveCount(0);
  await wages.getByRole('button', { name: 'Show figures', exact: true }).click();
  const table = wages.getByRole('table');
  await expect(table.getByRole('row').nth(1)).toHaveText(/Electrical20.*₹72,000.*₹7,000.*₹2,000.*₹81,000/);
  await expect(table.getByRole('row').nth(2)).toHaveText(/Civil14.*₹45,000.*₹2,500.*₹1,000.*₹48,500/);
  await expect(table.getByRole('row').nth(3)).toHaveText(/Mechanical12.*₹27,000.*₹1,000.*₹500.*₹28,500/);
  const metric = wages.getByRole('combobox', { name: 'Department metric', exact: true });
  await metric.selectOption('ot_wages');
  const otWageChart = wages.getByRole('img', { name: 'Department OT wages, highest first', exact: true });
  await expect(otWageChart).toBeVisible();
  await expect(otWageChart.locator('.recharts-bar')).toHaveCount(1);
  await metric.selectOption('ot_min');
  await expect(wages.getByRole('img', { name: 'Department overtime hours, highest first', exact: true })).toBeVisible();
  await expect(table.getByRole('row').nth(1)).toContainText('Civil');
  await metric.selectOption('total_wages');
  await expect(table.getByRole('row').nth(1)).toContainText('Electrical');
  await wages.getByRole('button', { name: 'Hide figures', exact: true }).click();
  await expect(table).toHaveCount(0);
  await wageView.getByRole('radio', { name: 'Trend', exact: true }).click();
  await expect(wages.getByRole('img', { name: 'Department wages, highest first', exact: true })).toHaveCount(0);
  await expect(wages).toContainText('1 person has work without a salary calculation');
  await page.locator('main').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/site-compact-desktop-wages.png' });
  clean(state);
});

test('site period selection is shared by Attendance and Wages and rejects invalid ranges', async ({ page }) => {
  const state = await mockSites(page);
  const reads = () => state.reads.filter(({ path }) => path.endsWith('/insights'));
  await page.goto(`/sites/${SITE.id}`);
  await view(page, 'Attendance');
  await expect(page.getByLabel('Attendance month', { exact: true })).toBeVisible();
  await expect.poll(() => reads().at(-1)?.query).toEqual({ from: '2026-10-01', to: TODAY });
  await page.getByRole('button', { name: 'Last month', exact: true }).click();
  await expect.poll(() => reads().at(-1)?.query).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  await expect(page.getByLabel('Attendance month', { exact: true })).toHaveValue('2026-09');
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect.poll(() => reads().at(-1)?.query).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.getByLabel('Attendance month', { exact: true })).toHaveValue('2026-09');
  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect.poll(() => reads().at(-1)?.query).toEqual({ from: '2026-10-05', to: TODAY });
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  const count = reads().length;
  await page.getByLabel('Period from', { exact: true }).fill('2026-10-09');
  await page.getByLabel('Period to', { exact: true }).fill('2026-10-06');
  await page.getByRole('button', { name: 'Apply period', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The end date must be on or after the start date.');
  expect(reads()).toHaveLength(count);
  await page.getByLabel('Period from', { exact: true }).fill('2025-01-01');
  await page.getByLabel('Period to', { exact: true }).fill(TODAY);
  await page.getByRole('button', { name: 'Apply period', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose a period of 366 days or less.');
  expect(reads()).toHaveLength(count);
  await page.getByLabel('Period from', { exact: true }).fill('2026-09-25');
  await page.getByLabel('Period to', { exact: true }).fill('2026-10-07');
  await page.getByRole('button', { name: 'Apply period', exact: true }).click();
  await expect.poll(() => reads().at(-1)?.query).toEqual({ from: '2026-09-25', to: '2026-10-07' });
  await view(page, 'Wages');
  await expect(page.getByRole('region', { name: 'Wage cost', exact: true })).toContainText('25 Sep – 7 Oct 2026');
  await view(page, 'Attendance');
  await expect(page.getByLabel('Period from', { exact: true })).toHaveValue('2026-09-25');
  clean(state);
});

test('Overview department visualization filters current people and Attendance switches to OT', async ({ page }) => {
  const state = await mockSites(page);
  await page.goto(`/sites/${SITE.id}`);
  const overview = page.getByRole('tabpanel', { name: 'Overview', exact: true });
  await overview.getByRole('radio', { name: 'Departments', exact: true }).click();
  await expect(overview.getByRole('img', { name: 'Department headcount: 32 people on site now', exact: true })).toBeVisible();
  const electrical = overview.getByRole('button', { name: 'Electrical: 14 people on site', exact: true });
  await electrical.click();
  const people = overview.getByRole('list', { name: 'People on site', exact: true });
  await expect(people.getByRole('listitem')).toHaveCount(14);
  await expect(people).toContainText('Example Electrical 1');
  await expect(people).not.toContainText('Example Civil');
  await overview.getByLabel('Search people on site', { exact: true }).fill('ELE003');
  await expect(people.getByRole('listitem')).toHaveCount(1);
  await expect(people).toContainText('Example Electrical 3');
  await overview.getByLabel('Search people on site', { exact: true }).fill('');
  await overview.getByRole('button', { name: 'All departments', exact: true }).click();
  await expect(people.getByRole('listitem')).toHaveCount(32);
  const attendance = await view(page, 'Attendance');
  await attendance.getByRole('button', { name: 'OT hours', exact: true }).click();
  await expect(attendance.getByRole('heading', { name: 'Overtime worked', exact: true })).toBeVisible();
  await expect(attendance.getByRole('img', { name: /^Overtime hours from / })).toBeVisible();
  await expect(attendance.locator('.recharts-line')).toHaveCount(0);
  await attendance.getByRole('button', { name: 'People', exact: true }).click();
  await expect(attendance.getByRole('heading', { name: 'Attendance', exact: true })).toBeVisible();
  clean(state);
});

test('department custom colours stay consistent between current headcount and wage charts', async ({ page }) => {
  const state = await mockSites(page, { legacyColour: '#5C4B99' });
  await page.goto(`/sites/${SITE.id}`);
  const overview = page.getByRole('tabpanel', { name: 'Overview', exact: true });
  await overview.getByRole('radio', { name: 'Departments', exact: true }).click();
  const donut = overview.getByRole('img', { name: 'Department headcount: 32 people on site now', exact: true });
  const sector = donut.locator('path.recharts-sector[fill="#5C4B99"]');
  await expect(sector).toHaveCount(1);
  await expect(sector).toHaveCSS('fill', 'rgb(92, 75, 153)');
  await view(page, 'Wages');
  const wages = page.getByRole('region', { name: 'Wage cost', exact: true });
  await wages.getByRole('radio', { name: 'Departments', exact: true }).click();
  const departmentChart = wages.getByRole('img', { name: 'Department wages, highest first', exact: true });
  const bar = departmentChart.locator('.recharts-bar-rectangle path[fill="#5C4B99"]');
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveCSS('fill', 'rgb(92, 75, 153)');
  clean(state);
});

test('site cost access hides the Wages tab while current people and attendance remain available', async ({ page }) => {
  const state = await mockSites(page, { costs: false, manage: false });
  await page.goto(`/sites/${SITE.id}`);
  await expect(page.getByRole('tab', { name: 'Wages', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Wage cost', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit site', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset password', exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'People on site', exact: true }).getByRole('listitem')).toHaveCount(32);
  await view(page, 'Attendance');
  await expect(page.getByLabel('Attendance month', { exact: true })).toBeVisible();
  clean(state);
});

test('site Overview preserves edit project and tablet login controls in settings', async ({ page }) => {
  const state = await mockSites(page);
  await page.goto(`/sites/${SITE.id}`);
  await page.getByRole('button', { name: 'Edit site', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue(SITE.project_id);
  await expect(dialog.getByLabel('Site name', { exact: false })).toHaveValue(SITE.name);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Site settings' }).click();
  await expect(page.getByRole('heading', { name: 'Tablet login', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('New password', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Disable login', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Disable the login for ${SITE.name}?`);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  clean(state);
});

test('empty current people, attendance and wages retain clear separate zero states', async ({ page }) => {
  const state = await mockSites(page, { empty: true });
  await page.goto(`/sites/${SITE.id}`);
  await expect(page.getByRole('tabpanel', { name: 'Overview', exact: true })).toContainText('No one');
  await view(page, 'Attendance');
  await expect(page.getByText('No attendance recorded in this period', { exact: true })).toBeVisible();
  await view(page, 'Wages');
  const wages = page.getByRole('region', { name: 'Wage cost', exact: true });
  await expect(wages.getByRole('heading', { name: 'No allocated wages yet', exact: true })).toBeVisible();
  await wages.getByRole('radio', { name: 'Departments', exact: true }).click();
  await expect(wages.getByRole('heading', { name: 'No department costs yet', exact: true })).toBeVisible();
  await expect(wages).not.toContainText('NaN');
  await expect(wages).not.toContainText('Infinity');
  clean(state);
});

test('phone site tabs fit the viewport and optional wage figures scroll inside their card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockSites(page);
  await page.goto(`/sites/${SITE.id}`);
  await expect(page.getByRole('list', { name: 'People on site', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: '/tmp/site-compact-phone-overview.png' });
  await view(page, 'Attendance');
  await page.screenshot({ path: '/tmp/site-compact-phone-attendance.png' });
  await view(page, 'Wages');
  const wages = page.getByRole('region', { name: 'Wage cost', exact: true });
  await expect(wages).toBeVisible();
  await expect(wages.getByRole('table')).toHaveCount(0);
  await wages.getByRole('radio', { name: 'Departments', exact: true }).click();
  await wages.getByRole('button', { name: 'Show figures', exact: true }).click();
  const table = wages.getByRole('table');
  expect(await table.evaluate((element) => {
    const scroller = element.parentElement;
    return getComputedStyle(scroller).overflowX === 'auto' && scroller.scrollWidth > scroller.clientWidth;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await wages.getByRole('button', { name: 'Hide figures', exact: true }).click();
  await page.locator('main').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/site-compact-phone-wages.png' });
  clean(state);
});
