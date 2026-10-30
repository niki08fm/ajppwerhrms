import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, CloudOff, LogOut, MapPin, ScanFace, Users, UserPlus } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { addDays, addMonths } from '@ajpwer/shared';
import { api } from '@/services/api';
import { cn, istTime } from '@/utils';
import { axis, grid, tooltipStyle } from '@/components/charts';
import { fullDate, shortDate } from '@/components/attendance/dayVocab';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { EmptyState, ErrorState, Notice, SkeletonRows } from '@/components/states';
import { TabletRegisters } from './TabletRegisters';
import { TabletTransfers } from './TabletTransfers';
import { TabletManualAttendance } from './TabletManualAttendance';

const TABS = [
  { value: 'today', label: 'Today' },
  { value: 'day', label: 'Daily register' },
  { value: 'month', label: 'Monthly register' },
  { value: 'transfers', label: 'Transfer requests' },
  { value: 'manual', label: 'Manual attendance' },
];

const localToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const validMonth = (value, today) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '1900-01' && value <= today.slice(0, 7);
const validDate = (value, today) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= today;

/** A site session has its own workspace; no admin links or employee profile links. */
export function TabletDashboard({ site, online, onPunch, onRegister, onSignOut }) {
  const [tab, setTab] = useState('today');
  const [date, setDate] = useState(localToday);
  const [ym, setYm] = useState(() => localToday().slice(0, 7));
  const [department, setDepartment] = useState(null);
  const [showPeople, setShowPeople] = useState(false);
  const [showMonth, setShowMonth] = useState(false);
  // Manual entries follow the current IST day even before the summary refreshes.
  // The selected historical register dates stay unchanged.
  const [manualToday, setManualToday] = useState(localToday);
  useEffect(() => {
    const refresh = () => setManualToday(localToday());
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  const summary = useQuery({
    queryKey: ['tablet-summary', site.id],
    queryFn: () => api.get('/tablet/summary').then((r) => r.data),
    enabled: online,
    refetchInterval: 60_000,
  });
  const today = summary.data?.date ?? localToday();
  const month = useQuery({
    queryKey: ['tablet-month', site.id, ym],
    queryFn: () => api.get('/tablet/attendance/month', { ym }).then((r) => r.data),
    enabled: online && (tab === 'month' || (tab === 'today' && showMonth)),
    refetchInterval: ym === today.slice(0, 7) ? 60_000 : false,
  });
  const day = useQuery({
    queryKey: ['tablet-day', site.id, date],
    queryFn: () => api.get('/tablet/attendance/day', { date }).then((r) => r.data),
    enabled: online && tab === 'day',
    refetchInterval: date === today ? 60_000 : false,
  });
  const openDay = (next) => {
    setDate(next);
    setTab('day');
  };
  const counts = summary.data?.counts;
  const people = summary.data?.on_site_now ?? [];
  const departments = summary.data?.departments ?? [];
  const selectedPeople = department ? people.filter((p) => p.department_id === department.id) : people;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><MapPin className="size-5" aria-hidden="true" /></span>
            <div className="min-w-0">
              <h1 className="truncate font-display text-xl font-semibold">{site.name}</h1>
              <p className="text-[12px] text-muted-foreground">{site.code} · Site workspace</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onSignOut}><LogOut /> Sign out</Button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 py-6 sm:px-6">
        {!online && tab !== 'manual' && <Notice tone="warning" icon={<CloudOff className="size-4 shrink-0" />}>Offline. Keep attendance in the paper register. Enter and send it for HR review when connected.</Notice>}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-3xl font-semibold">{TABS.find((t) => t.value === tab)?.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{fullDate(tab === 'manual' ? manualToday : today)}</p>
          </div>
          {tab !== 'today' && <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" variant="outline" disabled={!online} onClick={onRegister}><UserPlus /> Register face</Button>
            <Button size="lg" disabled={!online} onClick={onPunch}><ScanFace /> Punch in / out</Button>
          </div>}
        </div>

        <div role="tablist" aria-label="Site views" className="flex gap-1 overflow-x-auto border-b scrollbar-thin">
          {TABS.map((t, index) => (
            <button key={t.value} id={`site-tab-${t.value}`} type="button" role="tab" aria-selected={tab === t.value} aria-controls={`site-panel-${t.value}`} onClick={() => setTab(t.value)}
              tabIndex={tab === t.value ? 0 : -1} onKeyDown={(e) => {
                const nextIndex = e.key === 'ArrowRight' ? (index + 1) % TABS.length : e.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
                if (nextIndex === null) return;
                e.preventDefault();
                setTab(TABS[nextIndex].value);
                document.getElementById(`site-tab-${TABS[nextIndex].value}`)?.focus();
              }}
              className={cn('-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring', tab === t.value ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t.label}
            </button>
          ))}
        </div>

        <section id={`site-panel-${tab}`} role="tabpanel" aria-labelledby={`site-tab-${tab}`} className="min-w-0">
          {tab === 'today' && (
            <div className="flex flex-col gap-5">
              <Card className="flex flex-col justify-between gap-6 border-primary/20 bg-primary/[0.035] p-5 sm:flex-row sm:items-center sm:p-6">
                <div className="flex items-center gap-4">
                  <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-card text-primary"><ScanFace className="size-7" aria-hidden="true" /></span>
                  <div><p className="font-display text-xl font-semibold">Ready for the next person</p><p className="mt-1 max-w-lg text-[13px] text-muted-foreground">Punch in when you arrive. Punch out when you leave.</p></div>
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:min-w-52">
                  <Button size="xl" disabled={!online} onClick={onPunch}><ScanFace /> Punch in / out</Button>
                  <Button size="lg" variant="ghost" disabled={!online} onClick={onRegister}><UserPlus /> Register face</Button>
                  <Button variant="link" size="sm" disabled={!online} onClick={() => setTab('manual')}>Enter manual attendance</Button>
                </div>
              </Card>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Today's attendance">
                {[
                  ['On site now', counts?.on_site_now, 'currently punched in'],
                  ['Total punched', counts?.punched_in_today, 'came in today'],
                  ['Signed out', counts?.signed_out, 'finished their punch'],
                  ['Late in', counts?.late_in, 'after the grace time'],
                ].map(([label, value, sub]) => (
                  <Card key={label} className="px-4 py-3.5">
                    <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
                    <p className="mt-1 text-[28px] leading-tight font-semibold num">{summary.isLoading ? <span className="inline-block h-8 w-14 animate-pulse rounded bg-muted" aria-label="Loading count" /> : value ?? '—'}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>
                  </Card>
                ))}
              </div>

                <Card className="min-w-0 overflow-hidden">
                  <CardHeader title="Departments on site" description="Select a department to see who is here." actions={<Button variant="outline" size="sm" disabled={summary.isLoading || summary.isError} onClick={() => { setDepartment(null); setShowPeople(true); }}><Users /> View people</Button>} />
                  {summary.isLoading ? <SkeletonRows rows={5} cols={2} /> : summary.isError ? <ErrorState error={summary.error} onRetry={() => summary.refetch()} compact /> : <DepartmentDonut departments={departments} onSelect={setDepartment} />}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-5 py-3 text-[12px] text-muted-foreground">
                    <span>{summary.isLoading ? 'Loading today’s figures…' : <><span className="font-medium text-foreground num">{counts?.early_out ?? '—'}</span> left early today</>}</span>
                    <Button variant="link" size="sm" onClick={() => openDay(today)}>Open daily register <ChevronRight /></Button>
                  </div>
                </Card>

              <Card className="min-w-0 overflow-hidden">
                <button type="button" aria-expanded={showMonth} aria-controls="site-month-overview" onClick={() => setShowMonth((value) => !value)} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left focus-visible:outline-2 focus-visible:outline-ring">
                  <span><span className="block font-display text-[17px] font-semibold">Attendance this month</span><span className="mt-1 block text-[12px] text-muted-foreground">Daily headcounts and earlier attendance.</span></span>
                  <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', showMonth && 'rotate-180')} aria-hidden="true" />
                </button>
                {showMonth && <div id="site-month-overview" className="border-t">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4"><p className="text-[12px] text-muted-foreground">People who punched in at this site.</p><MonthPicker ym={ym} today={today} onChange={setYm} /></div>
                  {month.isLoading ? <div className="m-5 h-60 animate-pulse rounded bg-muted" aria-label="Loading monthly attendance" /> : month.isError ? <ErrorState error={month.error} onRetry={() => month.refetch()} /> : month.data ? <MonthlyBars days={month.data.days ?? []} today={today} onDay={openDay} /> : <EmptyState title="Monthly attendance is unavailable" body="Connect to load this site's attendance." />}
                </div>}
              </Card>
            </div>
          )}

          {tab === 'day' && <TabletRegisters mode="day" query={day} today={today} selector={<DayPicker date={date} today={today} onChange={setDate} />} />}
          {tab === 'month' && <TabletRegisters mode="month" query={month} today={today} selector={<MonthPicker ym={ym} today={today} onChange={setYm} />} />}
          {tab === 'transfers' && <TabletTransfers site={site} today={today} online={online} />}
          <div hidden={tab !== 'manual'}><TabletManualAttendance site={site} today={manualToday} online={online} active={tab === 'manual'} /></div>
        </section>
      </main>

      <Dialog open={!!department || showPeople} onOpenChange={(open) => { if (!open) { setDepartment(null); setShowPeople(false); } }} title={department?.name ?? 'People on site'} description="People currently punched in at this site.">
        {selectedPeople.length ? <PeopleList people={selectedPeople} /> : <EmptyState title="Nobody is on site in this department" body="This headcount updates when people punch in or out." />}
      </Dialog>
    </div>
  );
}

function PeopleList({ people }) {
  return (
    <ul className="max-h-[320px] divide-y overflow-y-auto" aria-label="People on site">
      {people.map((p) => (
        <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
          <div className="min-w-0"><p className="font-medium">{p.name}</p><p className="mt-0.5 text-[12px] text-muted-foreground">{p.code}{p.department ? ` · ${p.department}` : ''}</p></div>
          <span className="shrink-0 text-[12px] text-muted-foreground">In <span className="text-foreground num">{istTime(p.since)}</span></span>
        </li>
      ))}
    </ul>
  );
}

function DepartmentDonut({ departments, onSelect }) {
  const [hovered, setHovered] = useState(null);
  const total = departments.reduce((sum, d) => sum + d.count, 0);
  const circumference = 2 * Math.PI * 68;
  let offset = 0;
  if (!departments.length) return <EmptyState title="No department headcount yet" body="Departments appear when employees are on site." />;
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-6 p-5 sm:flex-row" onPointerLeave={() => setHovered(null)}>
      <div className="relative size-48 shrink-0">
        <svg viewBox="0 0 192 192" className="size-full" role="img" aria-label={`Department headcount: ${total} people on site`}>
          <circle cx="96" cy="96" r="68" fill="none" stroke="var(--muted)" strokeWidth="24" />
          {departments.map((d, i) => {
            const length = total ? d.count / total * circumference : 0;
            const start = offset;
            offset += length;
            if (!length) return null;
            return <circle key={d.id ?? d.name} cx="96" cy="96" r="68" fill="none" stroke={`var(--${d.colour || `chart-${i % 5 + 1}`})`} strokeWidth="24" strokeDasharray={`${length} ${circumference}`} strokeDashoffset={-start} transform="rotate(-90 96 96)" opacity={hovered === null || hovered === d.id ? 1 : 0.35} onPointerEnter={() => setHovered(d.id)} onClick={() => onSelect(d)} className="cursor-pointer"><title>{`${d.name}: ${d.count} people`}</title></circle>;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-3xl font-semibold num">{total}</span><span className="text-[12px] text-muted-foreground">on site now</span></div>
      </div>
      <ul className="w-full min-w-0 space-y-1.5 text-sm sm:flex-1">
        {departments.map((d, i) => (
          <li key={d.id ?? d.name}><button type="button" aria-label={`${d.name} · ${d.count} people`} onClick={() => onSelect(d)} onPointerEnter={() => setHovered(d.id)} onFocus={() => setHovered(d.id)} onBlur={() => setHovered(null)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><span className="size-2.5 shrink-0 rounded-sm" style={{ background: `var(--${d.colour || `chart-${i % 5 + 1}`})` }} aria-hidden="true" /><span className="min-w-0 flex-1 break-words">{d.name}</span><span className="font-semibold num">{d.count}</span></button></li>
        ))}
      </ul>
    </div>
  );
}

function MonthlyBars({ days, today, onDay }) {
  if (!days.length) return <EmptyState title="No attendance this month" body="Daily headcounts appear when people punch in at this site." />;
  const data = days.map((d) => ({ ...d, day: Number(d.date.slice(8)), punched_in: d.date > today ? null : d.punched_in }));
  return (
    <div className="p-5">
      <div className="overflow-x-auto" role="region" aria-label="Attendance this month" tabIndex={0}>
        <div className="h-[260px] min-w-[580px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -15 }} accessibilityLayer>
              <CartesianGrid {...grid} />
              <XAxis dataKey="day" {...axis} interval={2} />
              <YAxis {...axis} allowDecimals={false} />
              <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--muted)' }} labelFormatter={(_, payload) => payload[0]?.payload?.date ? shortDate(payload[0].payload.date) : ''} formatter={(value) => [value, 'Punched in']} />
              <Bar dataKey="punched_in" name="Punched in" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} onClick={(entry) => entry?.date && entry.date <= today && onDay(entry.date)} className="cursor-pointer" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground"><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-primary" aria-hidden="true" /> People punched in</span><span>Select a bar to view that day's register.</span></div>
    </div>
  );
}

function MonthPicker({ ym, today, onChange }) {
  return <div className="flex items-center gap-1.5"><Button variant="outline" size="icon" aria-label="Previous month" disabled={ym <= '1900-01'} onClick={() => onChange(addMonths(ym, -1))}><ChevronLeft /></Button><Input type="month" aria-label="Attendance month" value={ym} min="1900-01" max={today.slice(0, 7)} onChange={(e) => validMonth(e.target.value, today) && onChange(e.target.value)} className="w-40" /><Button variant="outline" size="icon" aria-label="Next month" disabled={ym >= today.slice(0, 7)} onClick={() => onChange(addMonths(ym, 1))}><ChevronRight /></Button></div>;
}

function DayPicker({ date, today, onChange }) {
  return <div className="flex items-center gap-1.5"><Button variant="outline" size="icon" aria-label="Previous day" disabled={date <= '1900-01-01'} onClick={() => onChange(addDays(date, -1))}><ChevronLeft /></Button><Input type="date" aria-label="Register date" value={date} min="1900-01-01" max={today} onChange={(e) => validDate(e.target.value, today) && onChange(e.target.value)} className="w-40" /><Button variant="outline" size="icon" aria-label="Next day" disabled={date >= today} onClick={() => onChange(addDays(date, 1))}><ChevronRight /></Button></div>;
}

export default TabletDashboard;
