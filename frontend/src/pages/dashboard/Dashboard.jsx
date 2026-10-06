import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { addDays } from '@ajpwer/shared';
import { api } from '@/services/api';
import { cn, hhmm, mins } from '@/utils';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { CorrectionDrawer } from '@/components/attendance/CorrectionDrawer';
import { DayPicker, useMonth } from '@/components/attendance/DayPicker';
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
 * Today: attendance figures, a site breakdown and pending actions, with one monthly
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
  const scopeFor = (key) => (key === 'absent' || key === 'leave' ? inDept : atSite);
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
    const base = d.people.filter((p) => (!dp || p.dept_id === dp) && (key === 'absent' || key === 'leave' || !s || p.sites.includes(s)));
    setPanel({ key, site: s, dept: dp, list: base.filter((p) => p.views.includes(key)) });
  };

  const updated = new Date(updatedAt + 330 * 60_000);
  const updatedText = `${String(updated.getUTCHours()).padStart(2, '0')}:${String(updated.getUTCMinutes()).padStart(2, '0')}`;

  // The columns both tables share: came in, then the views that matter for the day.
  const cols = [isToday ? 'onsite' : 'nopunch', 'ot', 'late', 'early'];
  const rowOf = (people, scope) => {
    const came = people.filter((p) => p.views.includes('in'));
    const departments = d.departments.filter((department) => !dept || department.id === dept).map((department, index) => ({
      ...department,
      colour: `var(--chart-${index % 5 + 1})`,
      count: came.filter((person) => person.dept_id === department.id).length,
    }));
    return { came, departments, n: (k) => people.filter((p) => p.views.includes(k)).length, scope };
  };
  const siteRows = d.sites.map((s) => ({ id: s.id, name: s.name, ...rowOf(inDept.filter((p) => p.sites.includes(s.id)), { site: s.id }) }));

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
            <option value="">All sites · {d.people.filter((p) => (!dept || p.dept_id === dept) && p.views.includes('in')).length} in</option>
            {siteRows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.came.length} in
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <p>Attendance by site. Select an overtime count to see names and hours.</p>
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

      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <DayTable
            title={isToday ? 'Sites right now' : `Sites on ${fullDate(d.date).split(',')[0]}`}
            description="People who punched in, grouped by department. Select a bar or count to see names."
            first="Site"
            rows={siteRows}
            cols={cols}
            label={label}
            selected={site}
            onPick={(id) => set({ site: site === id ? null : id })}
            onClear={site ? () => set({ site: null }) : null}
            clearLabel="Show all sites"
            onShow={show}
            footer={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                Not at a site:
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => show('absent')}>
                  {listOf('absent').length} absent
                </button>
                ·
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => show('leave')}>
                  {listOf('leave').length} on leave
                </button>
                {d.moves.length > 0 && (
                  <Link to="/approvals?kind=move" className="inline-flex items-center gap-1 hover:underline">
                    · <ArrowRight className="size-3.5" /> {d.moves.length} moved site
                  </Link>
                )}
              </span>
            }
          />

        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <WaitingCard d={d} />
        </div>
      </div>

      <MonthCard d={d} site={site} siteName={siteName} />

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

// ─── Site attendance ─────────────────────────────

const toneOf = (k, n) => (!n ? 'text-muted-foreground' : k === 'ot' || k === 'late' ? 'text-warning-foreground dark:text-warning' : k === 'early' ? 'text-destructive' : '');

/** A count that opens the people behind it. */
function Num({ n, k, scope, strong, extra, onShow, accessibleLabel }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onShow(k, scope);
      }}
      aria-label={accessibleLabel}
      className={cn('-mx-1.5 rounded px-1.5 py-0.5 num hover:bg-primary/10 hover:underline', strong && 'font-semibold', toneOf(k, n))}
    >
      {n}
      {extra}
    </button>
  );
}

function DayTable({ title, description, first, rows, cols, label, selected, onPick, onClear, clearLabel, onShow, footer }) {
  // One scale for every site makes department headcounts comparable.
  const maxCount = Math.max(1, ...rows.flatMap((row) => row.departments.map((department) => department.count)));
  return (
    <Card className="flex h-[440px] min-w-0 flex-col overflow-hidden">
      <div className="shrink-0">
        <CardTitle title={title} description={description}>
          {onClear && <button type="button" onClick={onClear} className="rounded-md border px-2.5 py-1 text-[13px] font-medium hover:bg-accent">{clearLabel}</button>}
        </CardTitle>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label="Site attendance and department counts">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th scope="col" className="px-4 py-3 text-left">{first}</th>
              <th scope="col" className="px-4 py-3 text-left whitespace-nowrap">Departments · punched in</th>
              <th scope="col" className="px-3 py-3 text-right whitespace-nowrap">{label('in')}</th>
              {cols.map((k) => <th scope="col" key={k} className="px-3 py-3 text-right whitespace-nowrap">{label(k)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cn('border-t hover:bg-accent/40', selected === r.id && 'bg-primary/5')}>
                <th scope="row" className="px-4 py-4 text-left font-medium">
                  <button type="button" aria-pressed={selected === r.id} onClick={() => onPick(r.id)} className="min-w-20 rounded text-left hover:text-primary hover:underline">{r.name}</button>
                </th>
                <td className="min-w-56 px-4 py-3">
                  <div className="flex flex-col gap-2">
                    {r.departments.map((department) => (
                      <button key={department.id} type="button" onClick={() => onShow('in', { ...r.scope, dept: department.id })} aria-label={`${r.name}: ${department.name}, ${department.count} people punched in`} className="group w-full rounded text-left focus-visible:outline-2 focus-visible:outline-ring">
                        <span className="mb-1 flex justify-between gap-4 text-[12px]">
                          <span className="group-hover:text-primary group-hover:underline">{department.name}</span>
                          <span className="font-semibold num">{department.count}</span>
                        </span>
                        <span className="block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <span className="block h-full rounded-full" style={{ width: `${department.count / maxCount * 100}%`, background: department.colour }} />
                        </span>
                      </button>
                    ))}
                    {!r.departments.length && <span className="text-muted-foreground">No departments</span>}
                  </div>
                </td>
                <td className="px-3 py-3 text-right"><Num onShow={onShow} n={r.came.length} k="in" scope={r.scope} strong accessibleLabel={`${r.name}: ${label('in')}, ${r.came.length} people`} /></td>
                {cols.map((k) => <td key={k} className="px-3 py-3 text-right"><Num onShow={onShow} n={r.n(k)} k={k} scope={r.scope} accessibleLabel={`${r.name}: ${label(k)}, ${r.n(k)} people`} /></td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={cols.length + 3} className="px-4 py-8 text-center text-muted-foreground">No sites to show.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t bg-muted/30 px-4 py-3 text-[12px] text-muted-foreground">
        <p className="mb-2">Scroll sideways for more attendance details. Bars use the same scale across sites.</p>
        {footer}
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

// ─── The month ───────────────────────────────────────────────────────────────

function MonthCard({ d, site, siteName }) {
  const month = useMonth(d.date.slice(0, 7));
  const days = (month.data?.days ?? []).filter((x) => !x.future);
  const W = 720;
  const H = 220;
  const L = 36;
  const R = 700;
  const T = 20;
  const B = 190;
  const n = month.data?.days.length ?? 30;
  const x = (i) => L + ((R - L) * i) / Math.max(1, n - 1);
  const max = Math.max(1, ...days.map((x2) => x2.present));
  const y = (v) => B - ((B - T) * v) / max;
  const path = (get) => days.map((dd, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(get(dd)).toFixed(1)}`).join(' ');
  const di = (month.data?.days ?? []).findIndex((x2) => x2.date === d.date);
  const avg = (get) => {
    const w = days.filter((x2) => !x2.off);
    return w.length ? Math.round(w.reduce((a, x2) => a + get(x2), 0) / w.length) : 0;
  };
  return (
    <Card>
      <CardTitle title="Attendance this month" description={site ? `People who came in each day at ${siteName(site)}; the other sites in grey.` : 'People who came in each day; each site in grey.'} />
      <div className="px-4 pt-3 pb-4">
        {month.isLoading ? (
          <SkeletonBlock className="h-[220px]" />
        ) : month.isError ? (
          <ErrorState error={month.error} onRetry={() => month.refetch()} compact />
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="People who punched in each day this month">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line x1={L} x2={R} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" />
                  <text x={L - 6} y={y(max * f) + 4} fontSize="11" fill="var(--muted-foreground)" textAnchor="end">
                    {Math.round(max * f)}
                  </text>
                </g>
              ))}
              {(month.data?.days ?? []).map((dd, i) =>
                i % 4 === 0 ? (
                  <text key={dd.date} x={x(i)} y={H - 10} fontSize="11" fill="var(--muted-foreground)" textAnchor="middle">
                    {Number(dd.date.slice(8))}
                  </text>
                ) : null,
              )}
              {d.sites
                .filter((s) => s.id !== site)
                .map((s) => (
                  <path key={s.id} d={path((dd) => dd.sites[s.id] ?? 0)} fill="none" stroke="var(--border)" strokeWidth="1.5" />
                ))}
              {site ? (
                <path d={path((dd) => dd.sites[site] ?? 0)} fill="none" stroke="var(--primary)" strokeWidth="3" />
              ) : (
                <path d={path((dd) => dd.present)} fill="none" stroke="var(--primary)" strokeWidth="3" />
              )}
              {di >= 0 && (
                <g>
                  <line x1={x(di)} x2={x(di)} y1={T - 4} y2={B} stroke="var(--foreground)" strokeDasharray="3 3" />
                  <text x={x(di)} y={T - 5} fontSize="10" fill="var(--foreground)" textAnchor="middle">
                    {d.is_today ? 'Today' : Number(d.date.slice(8))}
                  </text>
                </g>
              )}
            </svg>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-[3px] w-4 rounded bg-primary" />
                {site ? siteName(site) : 'All sites'}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-[2px] w-4 rounded bg-border" />
                Other sites
              </span>
              <span>
                Working-day average:{' '}
                {d.sites.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && ' · '}
                    {s.name} {avg((dd) => dd.sites[s.id] ?? 0)}
                  </span>
                ))}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

