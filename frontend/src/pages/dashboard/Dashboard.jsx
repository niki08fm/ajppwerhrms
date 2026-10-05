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
import { TONE, dayName, fullDate, viewsFor } from '@/components/attendance/dayVocab';

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
 * Today: the glance for HR. One row of figures, then sites and departments as two small
 * tables, what waits on HR, and the month's attendance line. Pick a site at the top; click
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

/** Where someone's day is: on site (in overtime or not), done, or gone early. */
function segmentOf(p, isToday) {
  if (isToday) {
    if (p.open_now) return p.ot_min > 0 ? 'ot' : 'work';
    return p.early_min > 0 ? 'early' : 'done';
  }
  if (p.status === 'MISSING_PUNCH' && !p.corrected) return 'nopunch';
  if (p.early_min > 0) return 'early';
  if (p.ot_min > 0) return 'ot';
  return 'done';
}

const SEGMENTS = {
  work: { label: 'On site', colour: TONE.ok },
  ot: { label: 'In overtime', colour: TONE.warn },
  done: { label: 'Done for the day', colour: TONE.soft },
  early: { label: 'Left early', colour: TONE.bad },
  nopunch: { label: 'No punch-out', colour: 'color-mix(in srgb, var(--muted-foreground) 55%, var(--card))' },
};

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
    const s = scope.site ?? site;
    const dp = scope.dept ?? dept;
    const base = d.people.filter((p) => (!dp || p.dept_id === dp) && (key === 'absent' || key === 'leave' || !s || p.sites.includes(s)));
    setPanel({ key, site: s, dept: dp, list: base.filter((p) => p.views.includes(key)) });
  };

  const inN = listOf('in').length;
  const where = [site ? `at ${siteName(site)}` : '', dept ? `in ${deptName(dept)}` : ''].filter(Boolean).join(' ');
  const summary = isToday
    ? `${inN} of ${expected} came in${where ? ` ${where}` : ''}. ${listOf('onsite').length} still on site, ${listOf('ot').length} in overtime.${d.waiting_total ? ` ${d.waiting_total} ${d.waiting_total === 1 ? 'thing waits' : 'things wait'} on you${d.oldest ? ` — the oldest is ${d.oldest.hours} hours old` : ''}.` : ' Nothing waits on you.'}`
    : `On ${fullDate(d.date).split(',')[0]}, ${inN} of ${expected} came in${where ? ` ${where}` : ''}. ${listOf('ot').length} did overtime, ${listOf('late').length} came late, ${listOf('early').length} left early.${listOf('nopunch').length ? ` ${listOf('nopunch').length} forgot to punch out.` : ''}`;

  const updated = new Date(updatedAt + 330 * 60_000);
  const updatedText = `${String(updated.getUTCHours()).padStart(2, '0')}:${String(updated.getUTCMinutes()).padStart(2, '0')}`;

  // The columns both tables share: came in, then the views that matter for the day.
  const cols = [isToday ? 'onsite' : 'nopunch', 'ot', 'late', 'early'];
  const rowOf = (people, scope) => {
    const came = people.filter((p) => p.views.includes('in'));
    const seg = {};
    for (const p of came) {
      const k = segmentOf(p, isToday);
      seg[k] = (seg[k] ?? 0) + 1;
    }
    return { came, expected: people.filter((p) => p.expected).length, seg, n: (k) => people.filter((p) => p.views.includes(k)).length, scope };
  };
  const siteRows = d.sites.map((s) => ({ id: s.id, name: s.name, ...rowOf(inDept.filter((p) => p.sites.includes(s.id)), { site: s.id }) }));
  const deptRows = d.departments
    .map((x) => ({ id: x.id, name: x.name, ...rowOf(d.people.filter((p) => p.dept_id === x.id && (!site || p.sites.includes(site))), { dept: x.id }) }))
    .filter((r) => r.expected > 0 || r.came.length > 0);

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
      <p className="-mt-1 text-[15px] text-foreground/85">{summary}</p>

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
                {v.key === 'in' ? `${n} / ${expected}` : n}
              </span>
              <span className="text-[12px] text-muted-foreground">{v.sub}</span>
            </button>
          );
        })}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <DayTable
            title={isToday ? 'Sites right now' : `Sites on ${fullDate(d.date).split(',')[0]}`}
            description="Click a site to see only its people. Click any number to see who."
            first="Site"
            rows={siteRows}
            cols={cols}
            label={label}
            isToday={isToday}
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
          <DayTable
            title={isToday ? 'Departments right now' : 'Departments'}
            description={`The same, by department${site ? ` at ${siteName(site)}` : ''}. Click one to see only its people.`}
            first="Department"
            rows={deptRows}
            cols={cols}
            label={label}
            isToday={isToday}
            showExpected
            selected={dept}
            onPick={(id) => set({ dept: dept === id ? null : id })}
            onClear={dept ? () => set({ dept: null }) : null}
            clearLabel="Show all departments"
            onShow={show}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <WaitingCard d={d} />
          <MonthCard d={d} site={site} siteName={siteName} />
        </div>
      </div>

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

// ─── Sites and departments: one small table each ─────────────────────────────

const toneOf = (k, n) => (!n ? 'text-muted-foreground' : k === 'ot' || k === 'late' ? 'text-warning-foreground dark:text-warning' : k === 'early' ? 'text-destructive' : '');

/** A count that opens the people behind it. */
function Num({ n, k, scope, strong, extra, onShow }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onShow(k, scope);
      }}
      className={cn('-mx-1.5 rounded px-1.5 py-0.5 num hover:bg-primary/10 hover:underline', strong && 'font-semibold', toneOf(k, n))}
    >
      {n}
      {extra}
    </button>
  );
}

function DayTable({ title, description, first, rows, cols, label, isToday, showExpected, selected, onPick, onClear, clearLabel, onShow, footer }) {
  const segs = isToday ? ['work', 'ot', 'done', 'early'] : ['nopunch', 'ot', 'done', 'early'];
  return (
    <Card className="overflow-hidden">
      <CardTitle title={title} description={description}>
        {onClear && (
          <button type="button" onClick={onClear} className="rounded-md border px-2.5 py-1 text-[13px] font-medium hover:bg-accent">
            {clearLabel}
          </button>
        )}
      </CardTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="bg-muted/50 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-4 py-2 text-left">{first}</th>
              <th className="px-3 py-2 text-right">{label('in')}</th>
              {cols.map((k) => (
                <th key={k} className="px-3 py-2 text-right whitespace-nowrap">
                  {label(k)}
                </th>
              ))}
              <th className="px-4 py-2 text-left">Day so far</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const total = r.came.length;
              return (
                <tr key={r.id} onClick={() => onPick(r.id)} className={cn('cursor-pointer border-t hover:bg-accent/40', selected === r.id && 'bg-primary/5')}>
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
                  <td className="px-3 py-2.5 text-right">
                    <Num onShow={onShow} n={total} k="in" scope={r.scope} strong extra={showExpected ? <span className="font-normal text-muted-foreground"> / {r.expected}</span> : null} />
                  </td>
                  {cols.map((k) => (
                    <td key={k} className="px-3 py-2.5 text-right">
                      <Num onShow={onShow} n={r.n(k)} k={k} scope={r.scope} />
                    </td>
                  ))}
                  <td className="px-4 py-2.5">
                    <div className="flex h-2 w-36 overflow-hidden rounded-full bg-muted" title={segs.map((k) => `${SEGMENTS[k].label} ${r.seg[k] ?? 0}`).join(' · ')}>
                      {segs.map((k) => (
                        <span key={k} style={{ width: total ? `${((r.seg[k] ?? 0) / total) * 100}%` : 0, background: SEGMENTS[k].colour }} />
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={cols.length + 3} className="px-4 py-4 text-muted-foreground">
                  Nothing to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/30 px-4 py-2.5 text-[12px] text-muted-foreground">
        {segs.map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: SEGMENTS[k].colour }} />
            {SEGMENTS[k].label}
          </span>
        ))}
        {footer && <span className="ml-auto">{footer}</span>}
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
    <Card className="overflow-hidden">
      <CardTitle title="Waiting on you" description={work.length ? 'Time counts only after you decide.' : 'Nothing to decide right now.'}>
        <span className={cn('text-[26px] font-semibold num', d.waiting_total ? 'text-destructive' : 'text-muted-foreground')}>{d.waiting_total}</span>
      </CardTitle>
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
      <div className="flex flex-col gap-2 bg-muted/30 px-4 py-3">
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

