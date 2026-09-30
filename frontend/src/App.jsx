import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/shell';
import { SkeletonRows } from './components/states';
import { SessionProvider, useSession } from './context/SessionContext';

const Login = lazy(() => import('./pages/auth/Login'));
const Tablet = lazy(() => import('./pages/tablet/Tablet'));
const Dashboard = lazy(() => import('./pages/dashboard/Dashboard'));
const Sites = lazy(() => import('./pages/sites/Sites'));
const SiteDetail = lazy(() => import('./pages/sites/SiteDetail'));
const Analytics = lazy(() => import('./pages/dashboard/Analytics'));
const RunPayroll = lazy(() => import('./pages/payroll/RunPayroll'));
const PayslipPrint = lazy(() => import('./pages/payroll/PayslipPrint'));
const Money = lazy(() => import('./pages/payroll/Money'));
const People = lazy(() => import('./pages/people/People'));
const Profile = lazy(() => import('./pages/people/Profile'));
const Offers = lazy(() => import('./pages/people/Offers'));
const Exits = lazy(() => import('./pages/people/Exits'));
const SettlementStatement = lazy(() => import('./pages/people/SettlementStatement'));
const LetterPrint = lazy(() => import('./pages/people/LetterPrint'));
const Attendance = lazy(() => import('./pages/attendance/Register'));
const Overtime = lazy(() => import('./pages/attendance/Overtime'));
const Leave = lazy(() => import('./pages/attendance/Leave'));
const Approvals = lazy(() => import('./pages/attendance/Approvals'));
const Documents = lazy(() => import('./pages/attendance/Documents'));
const PayGroups = lazy(() => import('./pages/setup/PayGroups'));
const PayGroupWizard = lazy(() => import('./pages/setup/PayGroupWizard'));
const Structures = lazy(() => import('./pages/setup/Structures'));
const StructureBuilder = lazy(() => import('./pages/setup/StructureBuilder'));
const Policies = lazy(() => import('./pages/setup/Policies'));
const Statutory = lazy(() => import('./pages/setup/Statutory'));
const Calendar = lazy(() => import('./pages/setup/Calendar'));
const Projects = lazy(() => import('./pages/setup/Projects'));
const Audit = lazy(() => import('./pages/setup/Audit'));

function Loading() {
  return (
    <div className="p-6">
      <SkeletonRows rows={10} />
    </div>
  );
}

function RequireAuth({ children }) {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="py-20 text-center">
      <h1 className="font-display text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted-foreground">That address does not match any screen. Use the navigation on the left.</p>
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        {/* The site tablet has its own login and nothing else. */}
        <Route path="/tablet" element={<Tablet />} />
        <Route
          path="/*"
          element={
            <SessionProvider>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route
                  path="/print/payslip/:ym/:employeeId"
                  element={
                    <RequireAuth>
                      <PayslipPrint />
                    </RequireAuth>
                  }
                />

                <Route
                  path="/print/letter/:employeeId/:letterId"
                  element={
                    <RequireAuth>
                      <LetterPrint />
                    </RequireAuth>
                  }
                />

                <Route
                  path="/print/settlement/:employeeId"
                  element={
                    <RequireAuth>
                      <SettlementStatement print />
                    </RequireAuth>
                  }
                />

                <Route
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  <Route index element={<Dashboard />} />
                  <Route path="sites" element={<Sites />} />
                  <Route path="sites/:id" element={<SiteDetail />} />
                  <Route path="analytics" element={<Analytics />} />
                  <Route path="payroll" element={<RunPayroll />} />
                  <Route path="payroll/:ym" element={<RunPayroll />} />
                  <Route path="money" element={<Money />} />
                  <Route path="people" element={<People />} />
                  <Route path="people/:id" element={<Profile />} />
                  <Route path="offers" element={<Offers />} />
                  <Route path="exits" element={<Exits />} />
                  <Route path="exits/:employeeId" element={<SettlementStatement />} />
                  <Route path="attendance" element={<Attendance />} />
                  <Route path="overtime" element={<Overtime />} />
                  <Route path="leave" element={<Leave />} />
                  <Route path="approvals" element={<Approvals />} />
                  <Route path="documents" element={<Documents />} />
                  <Route path="setup/pay-groups" element={<PayGroups />} />
                  <Route path="setup/pay-groups/new" element={<PayGroupWizard />} />
                  <Route path="setup/pay-groups/:id/edit" element={<PayGroupWizard />} />
                  <Route path="setup/structures" element={<Structures />} />
                  <Route path="setup/structures/new" element={<StructureBuilder />} />
                  <Route path="setup/policies" element={<Policies />} />
                  <Route path="setup/statutory" element={<Statutory />} />
                  <Route path="setup/calendar" element={<Calendar />} />
                  <Route path="setup/projects" element={<Projects />} />
                  <Route path="audit" element={<Audit />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </SessionProvider>
          }
        />
      </Routes>
    </Suspense>
  );
}
