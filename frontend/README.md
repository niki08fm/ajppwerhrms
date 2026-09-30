# frontend — React

Every screen of AJPWER Workforce: the HR admin app and the site tablet (`/tablet`).

**Built with:** React 18, Vite, React Router, TanStack Query/Table, Tailwind CSS, Radix UI, Recharts.

```
src/
  main.jsx           starts the app;  App.jsx  holds the routes
  pages/<area>/      one file per screen: dashboard, people, attendance, payroll, sites, setup, auth, tablet
  components/        pieces used by pages — shell (navigation), data table, charts, states;
                     ui/ holds buttons, forms, dialogs; <area>/ holds area-specific parts
                     (e.g. people/SalaryBreakup.jsx, people/profile-tabs/, payroll/Steps.jsx)
  services/          api.js (every call to the backend), face.js (points at the face models)
  hooks/             useLookups, list paging, debounce, online status
  context/           SessionContext (who is signed in)
  utils/             formatting helpers (rupees, dates, class names)
  styles.css         theme colours and fonts
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
