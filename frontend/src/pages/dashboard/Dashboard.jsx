import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { addDays } from '@ajpwer/shared';
import { api } from '@/services/api';
import { cn, hhmm, mins } from '@/utils';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { CorrectionDrawer } from '@/components/attendance/CorrectionDrawer';
import { DayPicker } from '@/components/attendance/DayPicker';
import AttendanceChart from '@/components/dashboard/AttendanceChart';
import { dayName, fullDate, viewsFor } from '@/components/attendance/dayVocab';

// ─── Small pieces ────────────────────────────────────────────────────────────

function CardTitle({ title, description, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
      <div className="min-w-0 flex-[1_1_14rem]">
        <h3 className="text-[15px] leading-snug font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ─── The screen ──────────────────────────────────────────────────────────────

/**
 * Today: attendance figures, a site breakdown and pending actions, with one attendance
 * chart at the bottom. Pick a site at the top; click
 * any number to see who, in a side panel.
 */
export default function Dashboard() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const set = (patch) =>
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
        return n;
      },
      { replace: true },
    );
  const ov = useQuery({
    queryKey: ['dashboard', 'overview', sp.get('date') ?? 'today'],
    queryFn: () => api.get('/dashboard/overview', { date: sp.get('date') ?? undefined }).then((r) => r.data),
    refetchInterval: sp.get('date') ? false : 60_000,
  });
  const [open, setOpen] = useState(null);

  if (ov.isLoading)
    return (
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-24" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-[92px]" />
          ))}
        </div>
        <SkeletonBlock className="h-[420px]" />
      </div>
    );
  if (ov.isError) return <ErrorState error={ov.error} onRetry={() => ov.refetch()} />;

  return (
    <TodayBody
      d={ov.data}
      site={sp.get('site')}
      dept={sp.get('dept')}
      set={set}
      nav={nav}
      updatedAt={ov.dataUpdatedAt}
      onPerson={(id) => setOpen(id)}
      drawer={open && <CorrectionDrawer employeeId={open} date={ov.data.date} open onOpenChange={(o) => !o && setOpen(null)} />}
    />
  );
}

function TodayBody({ d, site, dept, set, nav, updatedAt, onPerson, drawer }) {
  const isToday = d.is_today;
  const views = viewsFor(isToday);
  const label = (key) => views.find((v) => v.key === key)?.label ?? key;
  const siteName = (id) => d.sites.find((s) => s.id === id)?.name ?? 'a site';
  const deptName = (id) => d.departments.find((x) => x.id === id)?.name ?? 'a department';
  const [panel, setPanel] = useState(null);

  // Department first; then site. Absence and leave belong to no site, so they stay company-wide.
  const inDept = useMemo(() => d.people.filter((p) => !dept || p.dept_id === dept), [d.people, dept]);
  const atSite = useMemo(() => (site ? inDept.filter((p) => p.sites.includes(site)) : inDept), [inDept, site]);
  const scopeFor = (key) => key === 'absent' || key === 'leave' ? inDept : key === 'onsite' && site ? inDept.filter((p) => p.current_site_id === site) : atSite;
  const listOf = (key) => scopeFor(key).filter((p) => p.views.includes(key));
  const expected = inDept.filter((p) => p.expected).length;

  const attendanceLink = (view, siteId = site, deptId = dept) => {
    const q = new URLSearchParams({ date: d.date });
    if (view) q.set('view', view);
    if (siteId && view !== 'absent' && view !== 'leave') q.set('site', siteId);
    if (deptId) q.set('dept', deptId);
    return `/attendance?${q}`;
  };
  // A number clicked: who, in a side panel. `scope` narrows it to one site or department.
  const show = (key, scope = {}) => {
    const s = key === 'absent' || key === 'leave' ? null : scope.site ?? site;
    const dp = scope.dept ?? dept;
    const base = d.people.filter((p) => (!dp || p.dept_id === dp) && (key === 'absent' || key === 'leave' || !s || (key === 'onsite' ? p.current_site_id === s : p.sites.includes(s))));
    setPanel({ key, site: s, dept: dp, list: base.filter((p) => p.views.includes(key)) });
  };

  const updated = new Date(updatedAt + 330 * 60_000);
  const updatedText = `${String(updated.getUTCHours()).padStart(2, '0')}:${String(updated.getUTCMinutes()).padStart(2, '0')}`;

  const headcountView = isToday ? 'onsite' : 'in';
  const peopleAt = (siteId) => inDept.filter((person) =>
    isToday ? person.open_now && person.current_site_id === siteId : person.sites.includes(siteId) && person.views.includes('in'),
  );
  const siteRows = d.sites.map((entry, index) => ({
    id: entry.id,
    name: entry.name,
    colour: `var(--chart-${index % 5 + 1})`,
    count: peopleAt(entry.id).length,
    scope: { site: entry.id },
  }));
  const departmentRows = d.departments
    .filter((department) => !dept || department.id === dept)
    .map((department, index) => ({
      id: department.id,
      name: department.name,
      colour: `var(--chart-${index % 5 + 1})`,
      count: peopleAt(site).filter((person) => person.dept_id === department.id).length,
      scope: { site, dept: department.id },
    }));


  return (
    <div className="flex flex-col gap-4">
      {/* Header: the day on the left, the site on the right */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className={cn('size-2 rounded-full', isToday ? 'bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]' : 'bg-muted-foreground/50')} />
            {isToday ? `Live · updated ${updatedText}` : 'Day closed · final punches'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <h1 className="font-display text-[30px] leading-tight font-semibold">{dayName(d.date, d.today, addDays)}</h1>
            <span className="text-[15px] text-muted-foreground">{fullDate(d.date)}</span>
            <DayPicker date={d.date} today={d.today} onChange={(x) => set({ date: x === d.today ? null : x })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Site
          <Select className="h-9 min-w-56" value={site ?? ''} onChange={(e) => set({ site: e.target.value || null })} aria-label="Site">
            <option value="">All sites · {inDept.filter((p) => p.views.includes(headcountView)).length} {isToday ? 'on site' : 'in'}</option>
            {siteRows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.count} {isToday ? 'on site' : 'in'}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <p>Select a bar to see people and their overtime status.</p>
        {dept && <button type="button" className="text-primary hover:underline" onClick={() => set({ dept: null })}>{deptName(dept)} · Clear department</button>}
      </div>

      {/* The figures, one slim row */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-7">
        {views.map((v) => {
          const n = listOf(v.key).length;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => show(v.key)}
              className="flex flex-col gap-0.5 rounded-xl border bg-card px-3.5 py-3 text-left shadow-sm transition-[border-color,box-shadow] hover:border-primary/50 hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{v.label}</span>
              <span className="text-[24px] leading-tight font-semibold whitespace-nowrap num" style={{ color: n || v.key === 'in' ? v.colour : 'var(--foreground)' }}>
                {v.key === 'in' && !site ? `${n} / ${expected}` : n}
              </span>
              <span className="text-[12px] text-muted-foreground">{site && ['absent', 'leave'].includes(v.key) ? (dept ? 'all sites · department' : 'all sites · company') : site && v.key === 'in' ? 'at this site' : v.sub}</span>
            </button>
          );
        })}
      </div>

      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <HeadcountCard
          title={site ? `${siteName(site)} · departments` : isToday ? 'Sites right now' : `Sites on ${fullDate(d.date).split(',')[0]}`}
          isToday={isToday}
          rows={site ? departmentRows : siteRows}
          site={site}
          onShow={(row) => show(headcountView, row.scope)}
          onClear={site ? () => set({ site: null }) : null}
        />
        <WaitingCard d={d} />
      </div>

      <AttendanceChart d={d} site={site} siteName={siteName} />

      <PeoplePanel
        panel={panel}
        d={d}
        label={label}
        siteName={siteName}
        deptName={deptName}
        link={panel ? attendanceLink(panel.key, panel.site, panel.dept) : ''}
        onPerson={(id) => {
          setPanel(null);
          onPerson(id);
        }}
        onClose={() => setPanel(null)}
        nav={nav}
      />
      {drawer}
    </div>
  );
}

// ─── Current headcount: sites, or departments in the selected site ────────────

function HeadcountCard({ title, isToday, rows, site, onShow, onClear }) {
  const maxCount = Math.max(1, ...rows.map((row) => row.count));
  return (
    <Card className="flex h-[440px] min-w-0 flex-col overflow-hidden">
      <div className="shrink-0">
        <CardTitle title={title} description={isToday ? 'People currently on site. Select a bar to see names.' : 'People who punched in that day. Select a bar to see names.'}>
          {onClear && <button type="button" onClick={onClear} className="rounded-md border px-2.5 py-1 text-[13px] font-medium hover:bg-accent">Back to all sites</button>}
        </CardTitle>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5" tabIndex={0} role="region" aria-label={site ? 'Department headcounts' : 'Site headcounts'}>
        <ul className="flex flex-col gap-5">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onShow(row)}
                aria-label={`${row.name}: ${row.count} ${isToday ? 'people on site now' : 'people punched in'}`}
                title={`${row.name} · ${row.count} ${isToday ? 'on site now' : 'punched in'}`}
                className="group flex w-full items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="w-24 shrink-0 break-words text-[13px] group-hover:text-primary sm:w-28">{row.name}</span>
                <span className="h-10 min-w-0 flex-1 overflow-hidden rounded-md bg-muted/50" aria-hidden="true">
                  <span className="block h-full rounded-md transition-[width,opacity] group-hover:opacity-85" style={{ width: `${row.count / maxCount * 100}%`, background: row.colour }} />
                </span>
                <span className="w-8 shrink-0 text-right text-[15px] font-semibold num">{row.count}</span>
              </button>
            </li>
          ))}
        </ul>
        {!rows.length && <p className="py-8 text-center text-[13px] text-muted-foreground">{site ? 'No departments to show.' : 'No sites to show.'}</p>}
      </div>
    </Card>
  );
}

// ─── Who: the side panel a number opens ──────────────────────────────────────

function PeoplePanel({ panel, d, label, siteName, deptName, link, onPerson, onClose, nav }) {
  const scope = panel ? [panel.site ? siteName(panel.site) : '', panel.dept ? deptName(panel.dept) : ''].filter(Boolean).join(' · ') : '';
  // The note says what put them on this list, then how their day is going.
  const note = (p) => {
    const k = panel?.key;
    if ((k === 'in' || k === 'onsite') && p.ot_min > 0) return { t: `${mins(p.ot_min)} overtime`, c: 'text-warning-foreground dark:text-warning' };
    if (k === 'late' || (!k && p.views.includes('late'))) return { t: p.late_min ? `${mins(p.late_min)} late` : 'Late in', c: 'text-warning-foreground dark:text-warning' };
    if (k === 'early') return { t: p.early_min ? `Left ${mins(p.early_min)} early` : 'Left early', c: 'text-destructive' };
    if (k === 'ot') return { t: p.ot_min ? `${mins(p.ot_min)} overtime` : 'In overtime', c: 'text-warning-foreground dark:text-warning' };
    if (p.views.includes('absent')) return { t: 'No punch, no leave', c: 'text-destructive' };
    if (p.views.includes('leave')) return { t: 'On leave', c: 'text-muted-foreground' };
    if (p.views.includes('nopunch')) return { t: 'No punch-out', c: 'text-muted-foreground' };
    if (p.views.includes('ot')) return { t: 'In overtime', c: 'text-warning-foreground dark:text-warning' };
    if (p.views.includes('early')) return { t: 'Left early', c: 'text-destructive' };
    if (p.views.includes('late')) return { t: 'Late in', c: 'text-warning-foreground dark:text-warning' };
    return { t: p.open_now ? 'On site' : 'Done for the day', c: 'text-muted-foreground' };
  };
  return (
    <Drawer
      open={!!panel}
      onOpenChange={(o) => !o && onClose()}
      title={panel ? `${label(panel.key)} · ${panel.list.length}` : ''}
      description={panel ? `${scope || 'All sites and departments'} · ${fullDate(d.date)}` : ''}
      footer={
        <button
          type="button"
          onClick={() => {
            onClose();
            nav(link);
          }}
          className="inline-flex h-9 items-center rounded-md border px-3.5 text-sm font-medium hover:bg-accent"
        >
          Open in Attendance
        </button>
      }
    >
      {panel && !panel.list.length ? (
        <p className="text-muted-foreground">Nobody.</p>
      ) : (
        <ul className="-mx-5 divide-y">
          {panel?.list.map((p) => {
            const n = note(p);
            return (
              <li key={p.id}>
                <button type="button" onClick={() => onPerson(p.id)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-accent/40">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-semibold text-primary">
                    {p.name
                      .split(' ')
                      .map((w) => w[0])
                      .join('')
                      .slice(0, 2)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {p.name} <span className="font-mono text-[12px] text-muted-foreground">{p.code}</span>
                    </span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {deptName(p.dept_id)}
                      {p.sites.length ? ` · ${p.sites.map(siteName).join(', ')}` : ''}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-medium num">{p.in_min === null ? '—' : p.out_min !== null && !p.open_now ? `${hhmm(p.in_min)}–${hhmm(p.out_min)}` : `in ${hhmm(p.in_min)}`}</span>
                    <span className={cn('block text-[12px]', n.c)}>{n.t}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}

// ─── Waiting on you ──────────────────────────────────────────────────────────

function WaitingCard({ d }) {
  const work = d.waiting.filter((w) => !['hold', 'heldback'].includes(w.key) && w.n > 0);
  const pay = d.waiting.filter((w) => ['hold', 'heldback'].includes(w.key) && w.n > 0);
  return (
    <Card className="flex h-[440px] min-w-0 flex-col overflow-hidden">
      <div className="shrink-0"><CardTitle title="Approvals" description={d.waiting_total ? 'Pending across the company.' : 'Nothing to decide right now.'}>
        <span className={cn('text-[26px] font-semibold num', d.waiting_total ? 'text-destructive' : 'text-muted-foreground')}>{d.waiting_total}</span>
      </CardTitle></div>
      <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0} role="region" aria-label="Pending approvals">
      {work.map((w) => (
        <Link key={w.key} to={w.to} className="flex items-center gap-3 border-b px-4 py-2.5 hover:bg-accent/40">
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-muted font-semibold num">{w.n}</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{w.label}</div>
            <div className="truncate text-[12px] text-muted-foreground">
              {w.names.map((n) => n.split(' ')[0]).join(', ')}
              {w.n > w.names.length ? ` and ${w.n - w.names.length} more` : ''}
            </div>
          </div>
          <ChevronRight className="size-4 text-muted-foreground" />
        </Link>
      ))}
      {pay.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b px-4 py-3">
          {pay.map((w) => (
            <Link key={w.key} to={w.to} className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1 text-[13px] hover:bg-warning/20">
              {w.key === 'hold' ? `${w.n} ${w.n === 1 ? 'salary' : 'salaries'} on hold` : `${w.n} left out of payroll`}
            </Link>
          ))}
        </div>
      )}
      {!d.waiting_total && <p className="px-5 py-6 text-[13px] text-muted-foreground">You’re all caught up.</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t bg-muted/30 px-4 py-3">
        {d.oldest && (
          <div className="text-[12px] text-muted-foreground">
            Oldest waiting: <b className="text-foreground">{d.oldest.name} · {d.oldest.hours} h</b> ({d.oldest.label})
          </div>
        )}
        <Link to="/approvals" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90">
          Review all in Approvals
        </Link>
      </div>
    </Card>
  );
}
