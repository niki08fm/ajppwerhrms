# Today interactive preview

Open `today-interactive.html` in a browser. It is self-contained and uses fictional employee and attendance data. It does not contact the backend or modify employee records.

The preview uses the application's actual AppShell, fonts, colours, seven summary cards, and Approvals panel. Sites and Approvals have matching widths and heights on desktop, with scrolling inside the cards when needed.

- Overview: horizontal bars show each site's current headcount; the lower area chart shows one company-wide attendance curve, using the company aggregate rather than summing sites.
- Select a site in the top Site dropdown: the same card shows that site's department headcounts, and the chart shows only that site.
- Bars open their scoped people lists, including calculated overtime hours. The headcount card contains no separate overtime, late, or early columns.
- Current headcounts exclude people who punched out and count workers who moved sites only at their latest open punch-in site. Historical dates show people who punched in that day instead.
- The chart has 7-day, 30-day, and 90-day (labelled “Last 3 months”) ranges, hover values, and an accessible daily-count table. Ranges end on the chosen date, excluding future dates.

The area chart uses the application's `frontend/src/components/dashboard/AttendanceChart.jsx` and its CSS directly. There is no chart replacement in the preview builder. `today-preview-entry.jsx` supplies sample data and the application's real layout. Attendance correction is replaced with read-only sample employee details; other screens show a preview notice.

Rebuild from the repository root:

```sh
npm run build --workspace=@ajpwer/frontend
node docs/designs/build-today-preview.cjs
```

With the frontend running, verify the real application chart using mocked API data:

```sh
npm run test:e2e --workspace=@ajpwer/frontend -- e2e/today-chart.spec.js
```

`today-interactive.png` shows the overview, `today-department-detail.png` shows a selected site, and `attendance-chart-preview.png` shows the area chart with its hover tooltip.
