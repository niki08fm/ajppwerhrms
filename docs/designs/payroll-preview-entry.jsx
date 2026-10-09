import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AppShell } from '../../frontend/src/components/shell.jsx';
import { SessionProvider } from '../../frontend/src/context/SessionContext.jsx';
import { api } from '../../frontend/src/services/api.js';
import Profile from '../../frontend/src/pages/people/Profile.jsx';
import PayGroups from '../../frontend/src/pages/setup/PayGroups.jsx';
import PayGroupWizard from '../../frontend/src/pages/setup/PayGroupWizard.jsx';
import Structures from '../../frontend/src/pages/setup/Structures.jsx';
import StructureBuilder from '../../frontend/src/pages/setup/StructureBuilder.jsx';
import Policies from '../../frontend/src/pages/setup/Policies.jsx';
import Dashboard from '../../frontend/src/pages/dashboard/Dashboard.jsx';
import { createPayrollPreviewState, handlePayrollPreviewApi } from './payroll-preview-data.js';

const state = createPayrollPreviewState();
const requests = [];
window.payrollPreview = { state, requests };
window.previewStaff = state.todayStaff ?? [];
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, 'https://preview.invalid');
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = init.method ?? 'GET';
  let body = {};
  try { body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch { /* No form uploads in this preview. */ }
  const request = { method, path, body, searchParams: url.searchParams };
  let result;
  try {
    result = await handlePayrollPreviewApi(state, request);
  } catch (error) {
    result = { status: 422, json: { error: { code: 'VALIDATION', message: error.message } } };
  }
  if (!result) result = { status: 400, json: { error: { code: 'PREVIEW_ONLY', message: 'This preview covers Today, salary, statutory settings, payslips, pay groups, employee journey and policies. Choose one of the preview tabs above.' } } };
  requests.push({ method, path, status: result.status ?? 200 });
  return new Response(JSON.stringify(result.json), { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } });
};

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const firstEmployee = state.employees[0].id;
const firstProfile = `/people/${firstEmployee}`;

function PreviewToolbar() {
  const loc = useLocation();
  const selectedEmployee = useRef(firstEmployee);
  const profileId = /^\/people\/([^/]+)/.exec(loc.pathname)?.[1];
  if (profileId) selectedEmployee.current = profileId;
  const employee = selectedEmployee.current;
  const tabs = [
    ['/', 'Today'],
    [`/people/${employee}?tab=salary`, 'Salary'],
    [`/people/${employee}?tab=salary&section=statutory`, 'Statutory'],
    [`/people/${employee}?tab=payslips`, 'Payslips'],
    ['/setup/pay-groups', 'Pay groups'],
    ['/setup/structures', 'Salary structures'],
    ['/setup/policies?kind=OVERTIME&new=1', 'Overtime policy'],
    [`/people/${employee}?tab=timeline`, 'Employee journey'],
    ['/people', 'Sample employees'],
  ];
  const active = (to) => {
    if (to === '/') return loc.pathname === '/';
    if (to.includes('new=1')) return loc.pathname === '/setup/policies';
    if (to.includes('tab=')) {
      const target = new URL(to, 'https://preview.invalid');
      const current = new URLSearchParams(loc.search);
      return loc.pathname === target.pathname && current.get('tab') === target.searchParams.get('tab')
        && (current.get('section') ?? 'salary') === (target.searchParams.get('section') ?? 'salary');
    }
    if (to === '/people') return loc.pathname === to;
    return loc.pathname.startsWith(to);
  };
  return <div className="preview-toolbar">
    <div className="preview-caption"><span className="preview-dot" />Interactive preview <span className="preview-sample">· sample data</span><button type="button" className="preview-reset" onClick={() => window.location.reload()}>Reset preview</button></div>
    <nav className="preview-tabs" aria-label="Preview screens">{tabs.map(([to, label]) => <Link key={label} to={to} aria-current={active(to) ? 'page' : undefined}>{label}</Link>)}</nav>
  </div>;
}

function SampleEmployees() {
  const q = useQuery({ queryKey: ['people'], queryFn: () => api.get('/employees').then(r => r.data) });
  return <div>
    <h1 className="font-display text-2xl font-semibold">Sample employees</h1>
    <p className="mt-2 text-muted-foreground">Choose a sample employee. Try salary changes, statutory settings and payslips across years.</p>
    <div className="preview-employee-grid">{(q.data ?? []).map(e => <Link key={e.id} className="preview-employee" to={`/people/${e.id}?tab=salary`}>
      <span className="preview-initials">{e.name.split(' ').map(n => n[0]).slice(0, 2).join('')}</span>
      <div><strong>{e.name}</strong><span>{e.designation} · {e.pay_group.name}</span><small>{!e.salary ? 'Try adding their first salary' : e.id === state.employees[1].id ? 'Ten years of sample payslips' : 'Salary and revision history'}</small></div><span aria-hidden>→</span>
    </Link>)}</div>
    <div className="preview-tip">All changes stay in this preview. Reload the page or use Reset preview to restore the samples.</div>
  </div>;
}

function PreviewDestination() {
  return <div className="rounded-lg border bg-card p-5"><h1 className="font-display text-xl font-semibold">Payroll design preview</h1><p className="my-3 text-muted-foreground">Use the preview tabs above to explore employee salaries, statutory settings, pay groups and overtime policies.</p><Link className="text-primary underline" to={`${firstProfile}?tab=salary`}>Open sample salary</Link></div>;
}

function Preview() {
  return <SessionProvider><PreviewToolbar /><div className="preview-app"><Routes><Route element={<AppShell />}>
    <Route path="/" element={<Dashboard />} />
    <Route path="/people" element={<SampleEmployees />} />
    <Route path="/people/:id" element={<Profile />} />
    <Route path="/setup/pay-groups" element={<PayGroups />} />
    <Route path="/setup/pay-groups/new" element={<PayGroupWizard />} />
    <Route path="/setup/pay-groups/:id/edit" element={<PayGroupWizard />} />
    <Route path="/setup/structures" element={<Structures />} />
    <Route path="/setup/structures/new" element={<StructureBuilder />} />
    <Route path="/setup/policies" element={<Policies />} />
    <Route path="*" element={<PreviewDestination />} />
  </Route></Routes></div><Toaster richColors closeButton position="bottom-right" /></SessionProvider>;
}

createRoot(document.getElementById('root')).render(<QueryClientProvider client={qc}><MemoryRouter><Preview /></MemoryRouter></QueryClientProvider>);
