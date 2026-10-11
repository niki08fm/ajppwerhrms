import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, KeyRound, Loader2, Pencil, Power, Search, Settings2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, Pie, PieChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { addDays, addMonths, diffDays, firstOfMonth, isISODate, isYearMonth, istDate, lastOfMonth } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { useLookups } from '@/hooks/useLookups';
import { cn, dateSpan, istTime, mins } from '@/utils';
import { Mono, PageHeader, PersonLink, Stat } from '@/components/bits';
import { axis, CHART, grid, tooltipStyle } from '@/components/charts';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { PasswordOnceDialog, ResetPasswordDialog, SiteFormDialog } from '@/components/sites/SiteForm';
import SiteWageInsights from '@/components/sites/SiteWageInsights';

const shortDay = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const departmentKey = (department) => department.id ?? 'unassigned';
const departmentColour = (department, index) => department.colour ? `var(--${department.colour})` : CHART[index % CHART.length];
const monthRange = (month, today) => ({ from: firstOfMonth(month), to: month === today.slice(0, 7) ? today : lastOfMonth(month) });

/** Daily bars stay readable for longer periods by grouping weeks or months. */
function attendanceBars(days) {
  const grouping = days.length > 120 ? 'month' : days.length > 45 ? 'week' : 'day';
  const groups = new Map();
  days.forEach((day, index) => {
    const key = grouping === 'month' ? day.date.slice(0, 7) : grouping === 'week' ? Math.floor(index / 7) : day.date;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(day);
  });
  return {
    grouping,
    data: [...groups.values()].map((group) => ({
      date: group[0].date,
      to: group.at(-1).date,
      people: Number((group.reduce((sum, day) => sum + day.punched_in, 0) / group.length).toFixed(1)),
      ot_hours: Number((group.reduce((sum, day) => sum + day.ot_min, 0) / 60).toFixed(2)),
    })),
  };
}

export default function SiteDetail() {
  const { id } = useParams();
  const { data: lk } = useLookups();
  const today = lk?.today ?? istDate(new Date());
  const [range, setRange] = useState(() => monthRange(today.slice(0, 7), today));
  const [preset, setPreset] = useState('this-month');
  const [custom, setCustom] = useState(range);
  const [rangeError, setRangeError] = useState('');
  const [attendanceMetric, setAttendanceMetric] = useState('people');
  const [department, setDepartment] = useState(null);
  const [peopleSearch, setPeopleSearch] = useState('');
  const [peopleOpen, setPeopleOpen] = useState(false);
  const peopleSection = useRef(null);
  const lastLoaded = useRef(null);
  const { can } = useSession();
  const wageAccess = can('payroll.read');
  const q = useQuery({
    queryKey: ['site-day', id, 'insights', range.from, range.to, wageAccess],
    queryFn: () => api.get(`/sites/${id}/insights`, range).then((r) => r.data),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === id && previousQuery?.queryKey[5] === wageAccess ? previous : undefined,
    refetchInterval: 60_000,
  });
  const [editing, setEditing] = useState(false);
  const selectRange = (next, nextPreset) => {
    setRange(next);
    setCustom(next);
    setPreset(nextPreset);
    setRangeError('');
  };
  const selectMonth = (month) => {
    if (!isYearMonth(month) || month > today.slice(0, 7)) return;
    selectRange(monthRange(month, today), month === today.slice(0, 7) ? 'this-month' : month === addMonths(today.slice(0, 7), -1) ? 'last-month' : 'month');
  };
  const applyCustom = () => {
    if (!isISODate(custom.from) || !isISODate(custom.to)) return setRangeError('Choose a start and end date.');
    if (custom.from > custom.to) return setRangeError('The end date must be on or after the start date.');
    if (custom.to > today) return setRangeError('Choose a period ending today or earlier.');
    if (diffDays(custom.from, custom.to) + 1 > 366) return setRangeError('Choose a period of 366 days or less.');
    selectRange(custom, 'custom');
  };
  const openPeople = (nextDepartment = department) => {
    setDepartment(nextDepartment);
    setPeopleOpen(true);
    requestAnimationFrame(() => peopleSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  if (q.data && !q.isPlaceholderData) lastLoaded.current = { id, wageAccess, data: q.data };
  const d = q.data ?? (lastLoaded.current?.id === id && lastLoaded.current?.wageAccess === wageAccess ? lastLoaded.current.data : null);
  if (!d && q.isLoading) return <SkeletonBlock className="h-96" />;
  if (!d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const periodLabel = dateSpan(d.period.from, d.period.to);
  const selectedDepartment = d.departments.find((item) => departmentKey(item) === department);
  const people = d.on_site_now.filter((person) => (department === null || (person.department_id ?? 'unassigned') === department) && [person.name, person.code, person.department, person.designation].some((value) => String(value ?? '').toLowerCase().includes(peopleSearch.trim().toLowerCase())));
  const attendance = attendanceBars(d.attendance);
  const overtime = attendanceMetric === 'overtime';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Sites', to: '/sites' }, { label: d.site.name }]}
        title={d.site.name}
        description={`${d.site.state}${d.site.project ? ` · ${d.site.project.name}` : ''}${d.site.address ? ` · ${d.site.address}` : ''}`}
        meta={<><Chip tone={d.site.is_active ? 'success' : 'muted'}>{d.site.is_active ? 'Active site' : 'Inactive site'}</Chip><Mono className="text-muted-foreground">{d.site.code}</Mono></>}
        actions={
          can('sites.manage') && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit site
            </Button>
          )
        }
      />
      {editing && <SiteFormDialog site={d.site} onClose={() => setEditing(false)} />}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <div className="flex items-center gap-2"><span className="font-medium">Today</span><span className="text-muted-foreground">{dateSpan(d.date)}</span></div>
          <div className="flex items-center gap-1.5 text-muted-foreground" role="status">{q.isFetching ? <><Loader2 className="size-3 animate-spin" /> Updating…</> : q.isError ? 'Could not refresh' : <><span className="size-2 rounded-full bg-primary" /> Live · updated {istTime(new Date(q.dataUpdatedAt).toISOString())}</>}</div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="On site now" value={d.today.on_site_now} sub="currently punched in" tone="success" />
          <Stat label="In today" value={d.today.punched_in} sub="people who punched in" />
          <Stat label="Signed out" value={d.today.signed_out} sub="people who punched out" />
          <Stat label="Late in" value={d.today.late_in} sub="after their grace time" tone={d.today.late_in ? 'warning' : undefined} />
          <div className="col-span-2 md:col-span-1"><Stat label="OT hours" value={mins(d.today.ot_min)} sub="recorded today" /></div>
        </div>
      </div>

      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-display text-[18px] font-semibold">{wageAccess ? 'Attendance and wages' : 'Attendance period'}</h2><p className="mt-0.5 text-[13px] text-muted-foreground">{periodLabel}{q.isPlaceholderData && <span className="ml-2 font-medium text-primary">Updating selected period…</span>}{q.isError && <span className="ml-2 font-medium">Showing the last loaded period</span>}</p></div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => selectMonth(addMonths(range.from.slice(0, 7), -1))}><ChevronLeft /></Button>
            <Input type="month" value={range.from.slice(0, 7)} max={today.slice(0, 7)} aria-label="Attendance month" onChange={(event) => selectMonth(event.target.value)} className="w-40" />
            <Button variant="outline" size="icon" aria-label="Next month" disabled={range.from.slice(0, 7) >= today.slice(0, 7)} onClick={() => selectMonth(addMonths(range.from.slice(0, 7), 1))}><ChevronRight /></Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {[['this-month', 'This month'], ['last-month', 'Last month'], ['last-seven', 'Last 7 days'], ['custom', 'Custom']].map(([key, label]) => <Button key={key} size="sm" variant={preset === key ? 'secondary' : 'ghost'} aria-pressed={preset === key} onClick={() => key === 'custom' ? (setPreset('custom'), setCustom(range), setRangeError('')) : selectRange(key === 'last-seven' ? { from: addDays(today, -6), to: today } : monthRange(key === 'last-month' ? addMonths(today.slice(0, 7), -1) : today.slice(0, 7), today), key)}>{label}</Button>)}
        </div>
        {preset === 'custom' && <div className="mt-3 border-t pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">From<Input type="date" aria-label="Period from" value={custom.from} max={today} className="w-40" onChange={(event) => { setCustom({ ...custom, from: event.target.value }); setRangeError(''); }} /></label>
            <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">To<Input type="date" aria-label="Period to" value={custom.to} max={today} className="w-40" onChange={(event) => { setCustom({ ...custom, to: event.target.value }); setRangeError(''); }} /></label>
            <Button size="sm" onClick={applyCustom}>Apply period</Button>
          </div>
          {rangeError && <p className="mt-2 text-[13px] text-destructive" role="alert">{rangeError}</p>}
        </div>}
      </Card>

      {q.isError && <Card><ErrorState error={q.error} compact onRetry={() => q.refetch()} /></Card>}

      <div className="grid items-stretch gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="flex min-w-0 flex-col">
          <CardHeader title={overtime ? 'Overtime worked' : 'Attendance'} description={periodLabel} actions={<div className="flex rounded-md bg-muted p-0.5"><Button size="sm" variant={overtime ? 'ghost' : 'outline'} aria-pressed={!overtime} onClick={() => setAttendanceMetric('people')}>People</Button><Button size="sm" variant={overtime ? 'outline' : 'ghost'} aria-pressed={overtime} onClick={() => setAttendanceMetric('overtime')}>OT hours</Button></div>} />
          <div className="flex flex-1 flex-col px-4 py-5">
            <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
              {overtime ? <span><span className="num text-[22px] font-semibold text-foreground">{mins(d.period.ot_min)}</span> overtime in this period</span> : <><span><span className="num text-[22px] font-semibold text-foreground">{d.period.people}</span> people</span><span><span className="num font-medium text-foreground">{d.period.person_days}</span> attendance days</span></>}
            </div>
            <div className="relative min-h-[220px] flex-1" role="img" aria-label={overtime ? `Overtime hours from ${periodLabel}` : `Attendance from ${periodLabel}`}>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={attendance.data} margin={{ top: 8, right: 6, bottom: 0, left: -18 }} accessibilityLayer>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="date" {...axis} tickFormatter={shortDay} minTickGap={24} interval="preserveStartEnd" />
                  <YAxis {...axis} allowDecimals={overtime || attendance.grouping !== 'day'} domain={[0, 'auto']} />
                  <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--muted)' }} labelFormatter={(_label, payload) => payload?.[0]?.payload?.date ? dateSpan(payload[0].payload.date, payload[0].payload.to) : ''} formatter={(value) => [overtime ? `${value} h` : value, overtime ? 'Overtime' : attendance.grouping === 'day' ? 'People in' : 'Average people per day']} />
                  <Bar dataKey={overtime ? 'ot_hours' : 'people'} fill={overtime ? CHART[2] : CHART[0]} radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
              {!attendance.data.some((day) => (overtime ? day.ot_hours : day.people) > 0) && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="rounded-md bg-card/95 px-3 py-2 text-[13px] text-muted-foreground">{overtime ? 'No overtime recorded in this period' : 'No attendance recorded in this period'}</span></div>}
            </div>
            <p className="mt-3 text-[12px] text-muted-foreground">{overtime ? `Recorded overtime${attendance.grouping === 'day' ? ' each day' : ` by ${attendance.grouping}`}.` : attendance.grouping === 'day' ? 'People who punched in each day.' : `Average daily attendance by ${attendance.grouping}.`}</p>
          </div>
        </Card>
        <Card className="flex min-w-0 flex-col">
          <CardHeader title="Departments on site" description="Current headcount. Select a department to see people." actions={<Button size="sm" variant="ghost" onClick={() => openPeople(null)}>View people</Button>} />
          {d.departments.some((item) => item.count > 0) ? <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 pb-5 pt-3">
            <div className="relative h-48 w-full max-w-[250px]" role="img" aria-label={`Department headcount: ${d.today.on_site_now} people on site now`}>
              <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={d.departments} dataKey="count" nameKey="name" innerRadius={59} outerRadius={82} paddingAngle={d.departments.length > 1 ? 2 : 0} stroke="var(--card)" isAnimationActive={false} onClick={(item) => openPeople(department === departmentKey(item) ? null : departmentKey(item))}>
                {d.departments.map((item, index) => <Cell key={departmentKey(item)} fill={departmentColour(item, index)} opacity={department === null || department === departmentKey(item) ? 1 : 0.35} className="cursor-pointer" />)}
              </Pie><Tooltip {...tooltipStyle} formatter={(value) => [value, 'People on site']} /></PieChart></ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="num text-3xl font-semibold">{d.today.on_site_now}</span><span className="mt-1 text-[12px] text-muted-foreground">on site now</span></div>
            </div>
            <ul className="max-h-36 w-full space-y-1 overflow-y-auto text-[13px]">
              {d.departments.map((item, index) => <li key={departmentKey(item)}><button type="button" aria-label={`${item.name}: ${item.count} people on site`} aria-pressed={department === departmentKey(item)} onClick={() => openPeople(department === departmentKey(item) ? null : departmentKey(item))} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring', department === departmentKey(item) && 'bg-accent')}><span className="size-2.5 shrink-0 rounded-sm" style={{ background: departmentColour(item, index) }} /><span className="min-w-0 flex-1 break-words">{item.name}</span><span className="num font-semibold">{item.count}</span></button></li>)}
            </ul>
          </div> : <div className="flex flex-1 items-center justify-center"><EmptyState icon={<Users className="size-6" />} title="No one on site now" body="Department headcounts appear when people punch in." /></div>}
        </Card>
      </div>

      {wageAccess && d.costs && <SiteWageInsights costs={d.costs} period={d.period} />}

      <div ref={peopleSection} className="scroll-mt-5"><Card>
        <details open={peopleOpen} onToggle={(event) => setPeopleOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"><div><h2 className="font-display text-[18px] font-semibold">People on site now <span className="ml-1 num text-[14px] text-muted-foreground">{d.today.on_site_now}</span></h2><p className="mt-0.5 text-[13px] text-muted-foreground">Names, departments and punch-in times.</p></div><ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', peopleOpen && 'rotate-180')} /></summary>
          <div className="border-t">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><span>{people.length} people{selectedDepartment ? ` · ${selectedDepartment.name}` : ''}</span>{department !== null && <Button size="sm" variant="ghost" onClick={() => setDepartment(null)}>All departments</Button>}</div>
              <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search people on site" value={peopleSearch} onChange={(event) => setPeopleSearch(event.target.value)} placeholder="Search name, code or department" className="pl-9" /></div>
            </div>
            {people.length ? <ul className="grid max-h-80 overflow-y-auto sm:grid-cols-2" aria-label="People on site">
              {people.map((person) => <li key={person.id} className="flex min-w-0 items-center justify-between gap-3 border-t px-5 py-3 text-[14px]"><div className="min-w-0"><PersonLink id={person.id} name={person.name} code={person.code} /><p className="mt-0.5 truncate text-[12px] text-muted-foreground">{[person.department || 'No department', person.designation].filter(Boolean).join(' · ')}</p></div><span className="shrink-0 text-[12px] text-muted-foreground">In <span className="num text-foreground">{istTime(person.since)}</span></span></li>)}
            </ul> : <p className="border-t px-5 py-8 text-center text-[13px] text-muted-foreground">{d.on_site_now.length ? 'No people match these filters.' : 'No one is currently punched in at this site.'}</p>}
          </div>
        </details>
      </Card></div>

      <details className="rounded-lg border bg-card text-card-foreground shadow-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-[14px] font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"><Settings2 className="size-4 text-muted-foreground" /> Site settings <ChevronDown className="ml-auto size-4 text-muted-foreground" /></summary>
        <div className="border-t p-4"><TabletLogin site={d.site} manage={can('sites.manage')} /><p className="mt-3 text-[12px] text-muted-foreground">Punch boundary: {d.site.radius_m} m from <span className="num">{d.site.lat.toFixed(6)}, {d.site.lng.toFixed(6)}</span>. Login is available from any location; attendance punches require the site boundary.</p></div>
      </details>
    </div>
  );
}

/** Login ID, last sign-in, whether a tablet is signed in; reset the password, disable or enable the login. */
function TabletLogin({ site, manage }) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [creds, setCreds] = useState(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled) => api.post(`/sites/${site.id}/login-enabled`, { enabled }),
    onSuccess: (r) => {
      setConfirmOff(false);
      qc.invalidateQueries({ queryKey: ['site-day', site.id] });
      qc.invalidateQueries({ queryKey: ['sites'] });
      toast.success(r.data.login_enabled ? 'Login enabled. The current password works again.' : 'Login disabled. Every tablet at this site has been signed out.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title="Tablet login"
        description="Use this login ID at /tablet from any location. Attendance punches must be inside the site's boundary."
        actions={
          manage && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setResetting(true)}>
                <KeyRound /> Reset password
              </Button>
              {site.login_enabled ? (
                <Button size="sm" variant="outline" onClick={() => setConfirmOff(true)}>
                  <Power /> Disable login
                </Button>
              ) : (
                <Button size="sm" variant="outline" loading={toggle.isPending} onClick={() => toggle.mutate(true)}>
                  <Power /> Enable login
                </Button>
              )}
            </div>
          )
        }
      />
      <dl className="grid grid-cols-2 gap-3 p-4 text-[14px] md:grid-cols-4">
        <div>
          <dt className="text-[13px] text-muted-foreground">Login ID</dt>
          <dd>
            <Mono>{site.login}</Mono>
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Login</dt>
          <dd>{site.login_enabled ? <Chip tone="success">Enabled</Chip> : <Chip tone="warning">Disabled</Chip>}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Last sign-in</dt>
          <dd className="num">{site.last_login_at ? istTime(site.last_login_at, true) : 'Never'}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Tablet signed in now</dt>
          <dd>{site.tablet_signed_in ? <Chip tone="success">Yes</Chip> : <Chip tone="muted">No</Chip>}</dd>
        </div>
      </dl>
      {resetting && (
        <ResetPasswordDialog
          site={site}
          onClose={() => setResetting(false)}
          onDone={(c) => {
            setResetting(false);
            setCreds(c);
          }}
        />
      )}
      {creds && <PasswordOnceDialog creds={creds} onClose={() => setCreds(null)} />}
      {confirmOff && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirmOff(false)}
          title={`Disable the login for ${site.name}?`}
          description="Every tablet signed in to this site is signed out, and none can sign in until you enable the login again."
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmOff(false)}>
                Cancel
              </Button>
              <Button variant="destructive" loading={toggle.isPending} onClick={() => toggle.mutate(false)}>
                Disable login
              </Button>
            </>
          }
        />
      )}
    </Card>
  );
}
