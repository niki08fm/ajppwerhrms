# frontend — React

Every screen of AJPWER Workforce: the HR admin app and the site tablet (`/tablet`).

**Built with:** React 18, Vite, React Router, TanStack Query/Table, Tailwind CSS, Radix UI, Recharts.

```
src/
  features/<area>/   one folder per area — people, attendance, payroll, sites, setup, dashboard, tablet
  components/        shell (navigation), data table, list toolbar, states, charts; ui/ holds buttons, forms, dialogs
  lib/               API client, session, lookups, hooks; face.ts points the tablet at the face models
  App.tsx            the routes
e2e/                 Playwright browser tests
```

- It talks to the backend only through `/api/v1`. In development Vite forwards `/api` and `/face-models` to the backend on port 4000.
- Business rules shown on screen (money rounding, statutory figures, validation) come from `backend/shared`, so a preview here and a payslip from the backend always agree.
- Face detection runs in the browser using the `face/` folder; see `face/README.md`.

```bash
npm run dev --workspace=@ajpwer/frontend     # http://localhost:5173 (the backend must be running)
npm run build --workspace=@ajpwer/frontend   # → frontend/dist, served by the backend in production
npm run test:e2e --workspace=@ajpwer/frontend
```
