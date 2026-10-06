import { expect, test } from '@playwright/test';

const TODAY = '2026-10-06';
const sites = [{ id: 'north', name: 'North site' }, { id: 'south', name: 'South site' }];

function monthData(ym) {
  const [year, month] = ym.split('-').map(Number);
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    ym,
    days: Array.from({ length }, (_, index) => {
      const day = index + 1;
      const date = `${ym}-${String(day).padStart(2, '0')}`;
      // One worker visits both sites: summing site counts overstates company attendance.
      return { date, future: date > TODAY, off: false, holiday: null, present: 8 + day % 3, headcount: 12, rate: null, sites: { north: 5 + day % 2, south: 4 } };
    }),
  };
}

async function mockDashboard(page, { failMonthOnce = null } = {}) {
  const requestedMonths = [];
  let failed = false;
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    let data;
    if (url.pathname.endsWith('/auth/me')) {
      data = { name: 'HR Admin', role: 'HR Admin', email: 'hr@example.test', permissions: ['attendance.read'] };
    } else if (url.pathname.endsWith('/dashboard/people')) {
      data = { approvals: { total: 0 } };
    } else if (url.pathname.endsWith('/dashboard/overview')) {
      const date = url.searchParams.get('date') || TODAY;
      data = { date, today: TODAY, is_today: date === TODAY, sites, departments: [], people: [], waiting: [], waiting_total: 0, oldest: null, moves: [] };
    } else if (url.pathname.endsWith('/dashboard/month')) {
      const ym = url.searchParams.get('ym');
      requestedMonths.push(ym);
      if (ym === failMonthOnce && !failed) {
        failed = true;
        // A rejected request does not automatically retry; exercise the explicit retry action.
        await route.fulfill({ status: 400, json: { error: { code: 'UNAVAILABLE', message: 'Attendance is temporarily unavailable.' } } });
        return;
      }
      data = monthData(ym);
    } else {
      data = [];
    }
    await route.fulfill({ json: { data } });
  });
  return requestedMonths;
}

const chartFor = (page) => page.locator('.attendance-chart-card');

async function openDailyCounts(chart) {
  await chart.getByText('View daily counts', { exact: true }).click();
  return chart.locator('tbody tr');
}

async function expectRange(rows, count, first, last) {
  await expect(rows).toHaveCount(count);
  await expect(rows.first().locator('th')).toHaveText(first);
  await expect(rows.last().locator('th')).toHaveText(last);
}

test('the real Today route renders one filled overall chart and counts workers once', async ({ page }) => {
  await mockDashboard(page);
  await page.goto('/');
  const chart = chartFor(page);
  await expect(chart.getByRole('heading', { name: 'Attendance', exact: true })).toBeVisible();
  await expect(chart.locator('.recharts-area')).toHaveCount(1);
  const area = chart.locator('.recharts-area-area');
  await expect(area).toHaveCount(1);
  await expect(area).toHaveAttribute('fill', /^url\(#.+\)$/);
  await expect(area).toHaveAttribute('d', /.+/);
  expect(await area.evaluate((path) => {
    const gradientId = path.getAttribute('fill').slice(5, -1);
    const gradient = document.getElementById(gradientId);
    const stops = [...(gradient?.querySelectorAll('stop') || [])];
    return path.getBBox().height > 0 && stops.length >= 2 && Number(stops[0].getAttribute('stop-opacity')) > 0;
  })).toBe(true);
  await expect(chart.locator('.attendance-chart-legend')).toContainText('Overall attendance');
  await expect(chart).not.toContainText('Other sites');
  const rows = await openDailyCounts(chart);
  await expectRange(rows, 30, 'Sep 7', 'Oct 6');
  // Oct 6 has overall=8, North=5 and South=4. Overall must be 8, not their sum of 9.
  await expect(rows.last().locator('td')).toHaveText('8');
});

test('the top site filter switches the same single series to that site only', async ({ page }) => {
  await mockDashboard(page);
  await page.goto('/');
  const chart = chartFor(page);
  const rows = await openDailyCounts(chart);
  await page.getByRole('combobox', { name: 'Site', exact: true }).selectOption('north');
  await expect(chart.locator('.recharts-area')).toHaveCount(1);
  await expect(chart.locator('.attendance-chart-legend')).toContainText('North site');
  await expect(chart.locator('thead th').last()).toHaveText('North site');
  await expect(rows.last().locator('td')).toHaveText('5');
  await page.getByRole('combobox', { name: 'Site', exact: true }).selectOption('south');
  await expect(chart.locator('.recharts-area')).toHaveCount(1);
  await expect(rows.last().locator('td')).toHaveText('4');
  await page.getByRole('combobox', { name: 'Site', exact: true }).selectOption('');
  await expect(chart.locator('.attendance-chart-legend')).toContainText('Overall attendance');
  await expect(rows.last().locator('td')).toHaveText('8');
  await expect(chart.locator('.recharts-area')).toHaveCount(1);
});

test('7, 30 and 90 day ranges include their exact dates across calendar months', async ({ page }) => {
  const requestedMonths = await mockDashboard(page);
  await page.goto('/');
  const chart = chartFor(page);
  const rows = await openDailyCounts(chart);
  const ranges = chart.getByRole('group', { name: 'Attendance date range' });
  await ranges.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expectRange(rows, 7, 'Sep 30', 'Oct 6');
  await ranges.getByRole('button', { name: 'Last 3 months', exact: true }).click();
  await expectRange(rows, 90, 'Jul 9', 'Oct 6');
  expect(new Set(requestedMonths)).toEqual(new Set(['2026-07', '2026-08', '2026-09', '2026-10']));
  await ranges.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await expectRange(rows, 30, 'Sep 7', 'Oct 6');
  await expect(ranges.getByRole('button', { name: 'Last 30 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a historical day ends the graph at that day and can cross the year boundary', async ({ page }) => {
  const requestedMonths = await mockDashboard(page);
  await page.goto('/?date=2026-01-02&site=north');
  const chart = chartFor(page);
  const rows = await openDailyCounts(chart);
  await chart.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expectRange(rows, 7, 'Dec 27', 'Jan 2');
  // The month endpoint includes Jan 3 onward; they must not appear after the selected day.
  await expect(chart.locator('tbody')).not.toContainText('Jan 3');
  await expect(rows.last().locator('td')).toHaveText('5');
  expect(new Set(requestedMonths)).toEqual(new Set(['2025-12', '2026-01']));
  await expect(chart.locator('.recharts-area')).toHaveCount(1);
});

test('a failed month can be retried without replacing the page', async ({ page }) => {
  const requestedMonths = await mockDashboard(page, { failMonthOnce: '2026-09' });
  await page.goto('/');
  const chart = chartFor(page);
  await expect(chart.getByRole('alert')).toContainText('Could not load attendance');
  await chart.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(chart.locator('.recharts-area-area')).toHaveCount(1);
  await expect(chart.getByRole('alert')).toHaveCount(0);
  expect(requestedMonths.filter((ym) => ym === '2026-09')).toHaveLength(2);
});

test('the chart and range controls fit a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDashboard(page);
  await page.goto('/');
  const chart = chartFor(page);
  await expect(chart.locator('.recharts-area-area')).toHaveCount(1);
  await chart.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  const rows = await openDailyCounts(chart);
  await expectRange(rows, 7, 'Sep 30', 'Oct 6');
  expect(await chart.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
});
