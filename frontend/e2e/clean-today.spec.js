import { expect, test } from '@playwright/test';

const TODAY = '2026-10-06';
const SITES = [{ id: 'north', name: 'North site' }, { id: 'south', name: 'South site' }, { id: 'workshop', name: 'Workshop' }];
const DEPARTMENTS = [{ id: 'engineering', name: 'Engineering' }, { id: 'operations', name: 'Operations' }];
const PEOPLE = [
  { id: 'anita', name: 'Anita Rao', dept_id: 'engineering', sites: ['north'], current_site_id: 'north', views: ['in', 'onsite', 'late'], late_min: 15 },
  { id: 'ravi', name: 'Ravi Kumar', dept_id: 'operations', sites: ['south'], current_site_id: 'south', views: ['in', 'onsite', 'ot'], ot_min: 95 },
  // One employee moved sites: only the latest open site counts as current.
  { id: 'kiran', name: 'Kiran Reddy', dept_id: 'operations', sites: ['south', 'north'], current_site_id: 'north', views: ['in', 'onsite', 'ot'], ot_min: 65 },
  { id: 'neha', name: 'Neha Verma', dept_id: 'engineering', sites: ['north'], current_site_id: null, views: ['in', 'early'], early_min: 30, open_now: false, out_min: 1020 },
  { id: 'meera', name: 'Meera Shah', dept_id: 'engineering', sites: [], current_site_id: null, views: ['absent'], open_now: false },
  { id: 'vijay', name: 'Vijay Das', dept_id: 'operations', sites: [], current_site_id: null, views: ['leave'], expected: false, open_now: false },
].map((person, index) => ({ code: `TEST${index + 1}`, expected: true, open_now: true, in_min: 540,
  out_min: null, ot_min: 0, late_min: 0, early_min: 0, ...person }));

async function mockToday(page, { manySites = false, empty = false } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get('date') || TODAY;
    let data;
    if (url.pathname.endsWith('/auth/me')) data = { name: 'HR Admin', role: 'HR Admin', permissions: ['attendance.read', 'people.read'] };
    else if (url.pathname.endsWith('/dashboard/people')) data = { approvals: { total: empty ? 0 : 3 } };
    else if (url.pathname.endsWith('/dashboard/overview')) data = {
      date, today: TODAY, is_today: date === TODAY,
      sites: manySites ? [...SITES, ...Array.from({ length: 12 }, (_, index) => ({ id: `empty-${index}`, name: `Additional site ${index + 1}` }))] : SITES,
      departments: DEPARTMENTS, people: empty ? [] : PEOPLE.map(person => date === TODAY ? person : {
        ...person, open_now: false, current_site_id: null, views: person.views.filter(view => view !== 'onsite'),
      }),
      waiting: empty ? [] : [{ key: 'leave', n: 2, label: 'Leave requests', names: ['Vijay Das', 'Meera Shah'], to: '/approvals' },
        { key: 'face', n: 1, label: 'Face checks', names: ['Anita Rao'], to: '/approvals' }],
      waiting_total: empty ? 0 : 3, oldest: empty ? null : { name: 'Vijay Das', hours: 3, label: 'Leave request' }, moves: [],
    };
    else if (url.pathname.endsWith('/dashboard/month')) {
      const ym = url.searchParams.get('ym');
      data = { ym, days: Array.from({ length: new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate() }, (_, index) => {
        const day = `${ym}-${String(index + 1).padStart(2, '0')}`;
        return { date: day, future: day > TODAY, present: 4 + index % 3, sites: { north: 2, south: 3 }, off: false };
      }) };
    } else if (url.pathname.endsWith('/audit')) return route.fulfill({ json: { data: [], meta: { total: 0, nextCursor: null } } });
    else if (url.pathname.endsWith('/lookups')) data = { today: TODAY, sites: SITES, departments: DEPARTMENTS, users: [] };
    else data = [];
    await route.fulfill({ json: { data } });
  });
  return errors;
}

test('Today starts with four priorities and keeps secondary attendance available on demand', async ({ page }) => {
  const errors = await mockToday(page);
  await page.goto('/');
  const summary = page.getByRole('region', { name: 'Attendance summary', exact: true });
  await expect(summary.getByRole('button')).toHaveCount(5); // four numbers and the disclosure
  await expect(page.getByRole('region', { name: 'Additional attendance', exact: true })).toHaveCount(0);
  await summary.getByRole('button', { name: 'More attendance detail', exact: true }).click();
  const additional = page.getByRole('region', { name: 'Additional attendance', exact: true });
  await expect(additional.getByRole('button')).toHaveCount(3);
  await additional.getByRole('button', { name: /^Late in/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Anita Rao');
  await expect(drawer).not.toContainText('Ravi Kumar');
  await expect(drawer.getByRole('button', { name: 'Open in Attendance' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('site selection shows current departments, excludes punch-outs and counts a transfer once', async ({ page }) => {
  const errors = await mockToday(page);
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Site', exact: true }).selectOption('north');
  await expect(page.getByRole('heading', { name: 'North site · departments', exact: true })).toBeVisible();
  const departments = page.getByRole('region', { name: 'Department headcounts', exact: true });
  await expect(departments.getByRole('button', { name: 'Engineering: 1 people on site now', exact: true })).toBeVisible();
  await expect(departments.getByRole('button', { name: 'Operations: 1 people on site now', exact: true })).toBeVisible();
  const absent = page.getByRole('region', { name: 'Attendance summary' }).getByRole('button', { name: /^Absent/ });
  await expect(absent).toContainText('all sites · company');
  await departments.getByRole('button', { name: /^Operations:/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Kiran Reddy');
  await expect(drawer).not.toContainText('Ravi Kumar');
  await expect(drawer).not.toContainText('Neha Verma');
  expect(errors).toEqual([]);
});

test('many sites keep the overview bounded and provide navigation to every site', async ({ page }) => {
  await mockToday(page, { manySites: true });
  await page.goto('/');
  const headcounts = page.getByRole('region', { name: 'Site headcounts', exact: true });
  await expect(headcounts.getByRole('button')).toHaveCount(5);
  await expect(page.getByText('Top 5 of 15 sites', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'All sites', exact: true })).toHaveAttribute('href', '/sites');
  const size = await headcounts.locator('..').boundingBox();
  expect(size.height).toBeLessThanOrEqual(361);
  await page.getByRole('button', { name: 'Show all 15', exact: true }).click();
  await expect(headcounts.getByRole('button')).toHaveCount(15);
  expect((await headcounts.locator('..').boundingBox()).height).toBeLessThanOrEqual(361);
  await page.getByRole('button', { name: 'Show top 5', exact: true }).click();
  await expect(headcounts.getByRole('button')).toHaveCount(5);
});

test('an empty day gives clear empty states rather than a row of empty site bars', async ({ page }) => {
  await mockToday(page, { empty: true });
  await page.goto('/');
  await expect(page.getByText('Nobody on site right now', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Site headcounts' }).getByRole('button')).toHaveCount(0);
  await expect(page.getByText('You’re all caught up', { exact: true })).toBeVisible();
});

test('historical attendance retains the missing punch-out check instead of live headcounts', async ({ page }) => {
  await mockToday(page);
  await page.goto('/?date=2026-10-05');
  const summary = page.getByRole('region', { name: 'Attendance summary' });
  await expect(summary.getByRole('button', { name: /^No punch-out/ })).toBeVisible();
  await expect(summary.getByRole('button', { name: /^On site now/ })).toHaveCount(0);
  await expect(page.getByText('Day closed · final punches', { exact: true })).toBeVisible();
});

test('less-used tools stay reachable and a deep link opens its navigation group', async ({ page }) => {
  const errors = await mockToday(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main', exact: true });
  await expect(nav.getByRole('link', { name: 'Loans and advances', exact: true })).toHaveCount(0);
  await nav.getByRole('button', { name: 'More tools', exact: true }).click();
  await expect(nav.getByRole('link', { name: 'Loans and advances', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Hiring and onboarding', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'More tools', exact: true }).click();
  await page.goto('/audit');
  await expect(nav.getByRole('button', { name: 'More tools', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: 'Audit log', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});

test('the focused overview and navigation remain usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await mockToday(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'More attendance detail', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Additional attendance' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main', exact: true });
  await nav.getByRole('button', { name: 'More tools', exact: true }).click();
  await expect(nav.getByRole('link', { name: 'Exits and settlement', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
