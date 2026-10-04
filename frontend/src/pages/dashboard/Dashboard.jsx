import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { addDays } from '@ajpwer/shared';
import { api } from '@/services/api';
import { cn, hhmm } from '@/utils';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Card } from '@/components/ui/card';
import { CorrectionDrawer } from '@/components/attendance/CorrectionDrawer';
import { DayPicker, useMonth } from '@/components/attendance/DayPicker';
import { SiteCircles, countSegments, segmentDefs } from '@/components/attendance/SiteCircles';
import { TONE, dayName, faceStack, fullDate, shortDate, viewsFor } from '@/components/attendance/dayVocab';

// ─── Small pieces ────────────────────────────────────────────────────────────

/** Grey initials, two at most, then "+N". */
function Faces({ list, n = 2, size = 26 }) {
  const { faces, more } = faceStack(list, n);
  if (!list.length) return <span className="text-[12px] text-muted-foreground">Nobody</span>;
  return (
    <span className="flex items-center pl-[7px]">
      {faces.map((f) => (
        <span
          key={f.id ?? f.ini}
          title={f.name}
          className="-ml-[7px] inline-flex items-center justify-center rounded-full border-2 border-card bg-muted text-[10px] font-semibold text-muted-foreground"
          style={{ width: size, height: size }}
        >
          {f.ini}
        </span>
      ))}
      {more > 0 && (
        <span className="-ml-[7px] inline-flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-card bg-muted/60 px-1 text-[10px] font-semibold text-muted-foreground num" style={{ height: size }}>
          +{more}
        </span>
      )}
    </span>
  );
}

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
 * Today: the morning glance for HR. Pick any day; the cards, the site circles and the
 * charts follow. Every count opens Attendance filtered to exactly those people, under the
 * same name.
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
  const [bin, setBin] = useState(-1);
  const [open, setOpen] = useState(null);

  if (ov.isLoading)
    return (
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-24" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-[118px]" />
          ))}
        </div>
        <SkeletonBlock className="h-[520px]" />
      </div>
    );
  if (ov.isError) return <ErrorState error={ov.error} onRetry={() => ov.refetch()} />;

  return (
    <TodayBody
      d={ov.data}
      site={sp.get('site')}
      dept={sp.get('dept')}
      hl={sp.get('hl')}
      set={set}
      nav={nav}
      updatedAt={ov.dataUpdatedAt}
      bin={bin}
      setBin={setBin}
      onPerson={(id) => setOpen(id)}
      drawer={open && <CorrectionDrawer employeeId={open} date={ov.data.date} open onOpenChange={(o) => !o && setOpen(null)} />}
    />
  );
}

function TodayBody({ d, site, dept, hl, set, nav, updatedAt, bin, setBin, onPerson, drawer }) {
  const isToday = d.is_today;
  const views = viewsFor(isToday);
  const siteName = (id) => d.sites.find((s) => s.id === id)?.name ?? 'a site';

  // Department first; then site. Absence and leave belong to no site, so they stay company-wide.
  const inDept = useMemo(() => d.people.filter((p) => !dept || p.dept_id === dept), [d.people, dept]);
  const atSite = useMemo(() => (site ? inDept.filter((p) => p.sites.includes(site)) : inDept), [inDept, site]);
  const scopeFor = (key) => (key === 'absent' || key === 'leave' ? inDept : atSite);
  const listOf = (key) => scopeFor(key).filter((p) => p.views.includes(key));
  const expected = inDept.filter((p) => p.expected).length;

  const attendanceLink = (view, siteId = site) => {
    const q = new URLSearchParams({ date: d.date });
    if (view) q.set('view', view);
    if (siteId && view !== 'absent' && view !== 'leave') q.set('site', siteId);
    if (dept) q.set('dept', dept);
    return `/attendance?${q}`;
  };

  // Waiting on you: highlight the sites where the selected kind of item sits.
  const hlItem = d.waiting.find((w) => w.key === hl);
  const hlIds = hlItem ? new Set(hlItem.employee_ids) : new Set(d.waiting.filter((w) => !['hold', 'heldback'].includes(w.key)).flatMap((w) => w.employee_ids));

  const inN = listOf('in').length;
  const summary = isToday
    ? `${inN} of ${expected} came in${site ? ` at ${siteName(site)}` : ''}. ${listOf('onsite').length} still on site, ${listOf('ot').length} in overtime.${d.waiting_total ? ` ${d.waiting_total} ${d.waiting_total === 1 ? 'thing waits' : 'things wait'} on you${d.oldest ? ` — the oldest is ${d.oldest.hours} hours old` : ''}.` : ' Nothing waits on you.'}`
    : `On ${fullDate(d.date).split(',')[0]}, ${inN} of ${expected} came in${site ? ` at ${siteName(site)}` : ''}. ${listOf('ot').length} did overtime, ${listOf('late').length} came late, ${listOf('early').length} left early.${listOf('nopunch').length ? ` ${listOf('nopunch').length} forgot to punch out.` : ''}`;

  const updated = new Date(updatedAt + 330 * 60_000);
  const updatedText = `${String(updated.getUTCHours()).padStart(2, '0')}:${String(updated.getUTCMinutes()).padStart(2, '0')}`;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className={cn('size-2 rounded-full', isToday ? 'bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]' : 'bg-muted-foreground/50')} />
            {isToday ? `Live · updated ${updatedText}` : 'Day closed · final punches'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <h1 className="font-display text-[30px] leading-tight font-semibold">{dayName(d.date, d.today, addDays)}</h1>
            <span className="text-[15px] text-muted-foreground">{fullDate(d.date)}</span>
            <DayPicker date={d.date} today={d.today} onChange={(x) => set({ date: x === d.today ? null : x, hl: null })} />
          </div>
          <p className="mt-1.5 text-[15px] text-foreground/85">{summary}</p>
        </div>
        <div role="radiogroup" aria-label="Site" className="inline-flex max-w-full flex-wrap rounded-md border bg-muted p-0.5">
          {[{ id: null, name: 'All sites' }, ...d.sites].map((s) => (
            <button
              key={s.id ?? 'all'}
              type="button"
              role="radio"
              aria-checked={site === s.id || (!site && !s.id)}
              onClick={() => set({ site: s.id, hl: null })}
              className={cn('rounded-[5px] px-3 py-1.5 text-sm font-medium', site === s.id || (!site && !s.id) ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {/* Departments */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Departments</span>
        {[{ id: null, name: 'All' }, ...d.departments].map((dep) => {
          const ppl = d.people.filter((p) => !dep.id || p.dept_id === dep.id);
          const exp = ppl.filter((p) => p.expected).length;
          const came = (site ? ppl.filter((p) => p.sites.includes(site)) : ppl).filter((p) => p.views.includes('in')).length;
          const pct = exp ? Math.min(100, Math.round((came / exp) * 100)) : 0;
          const on = (dept ?? null) === dep.id;
          if (dep.id && !ppl.length) return null;
          return (
            <button
              key={dep.id ?? 'all'}
              type="button"
              aria-pressed={on}
              onClick={() => set({ dept: dep.id })}
              className={cn('inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors', on ? 'border-primary bg-secondary' : 'bg-card hover:border-primary/40')}
            >
              <span className="relative inline-block size-[18px] rounded-full" style={{ background: `conic-gradient(var(--primary) ${pct}%, var(--border) 0)` }}>
                <span className={cn('absolute inset-[4px] rounded-full', on ? 'bg-secondary' : 'bg-card')} />
              </span>
              {dep.name} <b className="font-semibold num">{came}</b>
              {!site && <span className="text-muted-foreground num">/ {exp}</span>}
            </button>
          );
        })}
      </div>

      {/* The cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {views.map((v) => {
          const list = listOf(v.key);
          return (
            <Link
              key={v.key}
              to={attendanceLink(v.key)}
              className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3.5 shadow-sm transition-[border-color,box-shadow] hover:border-primary/50 hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{v.label}</span>
              <span className="text-[28px] leading-tight font-semibold whitespace-nowrap num" style={{ color: list.length || v.key === 'in' ? v.colour : 'var(--foreground)' }}>
                {v.key === 'in' ? `${list.length} / ${expected}` : list.length}
              </span>
              <span className="text-[12px] text-muted-foreground">{v.sub}</span>
              <span className="mt-1 flex min-h-7 items-center">
                <Faces list={list} />
              </span>
            </Link>
          );
        })}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <SitesCard d={d} people={inDept} site={site} isToday={isToday} hlIds={hlIds} focus={!!hlItem} set={set} nav={nav} attendanceLink={attendanceLink} listOf={listOf} siteName={siteName} />
        <WaitingCard d={d} hl={hl} set={set} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <ArrivalsCard d={d} people={atSite} bin={bin} setBin={setBin} onPerson={onPerson} />
        <MonthCard d={d} site={site} siteName={siteName} />
      </div>
      {drawer}
    </div>
  );
}

// ─── Sites ───────────────────────────────────────────────────────────────────

function SitesCard({ d, people, site, isToday, hlIds, focus, set, nav, attendanceLink, listOf, siteName }) {
  const defs = segmentDefs(isToday);
  const scoped = site ? people.filter((p) => p.sites.includes(site)) : people;
  const seg = countSegments(
    scoped.filter((p) => p.sites.length),
    isToday,
  );
  return (
    <Card className="overflow-hidden">
      <CardTitle
        title={isToday ? 'Sites right now' : `Sites on ${shortDate(d.date)}`}
        description={`Circle size follows how many punched in. The ring shows how their day ${isToday ? 'is going' : 'went'}. Tap any number to see those people.`}
      >
        <div className="flex flex-wrap gap-0.5">
          {defs.map((s) => (
            <Link key={s.key} to={attendanceLink(s.view)} className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-accent">
              <span className="size-3 rounded-full" style={{ background: s.colour }} />
              {s.label} <b className="text-foreground num">{seg[s.key] ?? 0}</b>
            </Link>
          ))}
        </div>
      </CardTitle>
      <div className="px-4 pt-3 pb-2">
        <SiteCircles
          sites={d.sites}
          people={people}
          isToday={isToday}
          site={site}
          highlightIds={hlIds}
          focus={focus}
          onPickSite={(id) => set({ site: id })}
          onOpen={(view, siteId) => nav(attendanceLink(view, siteId))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2.5 border-t bg-muted/30 px-5 py-3">
        <span className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Not at a site</span>
        {[
          { key: 'absent', label: 'Absent', colour: TONE.bad },
          { key: 'leave', label: 'On leave', colour: 'var(--muted-foreground)' },
        ].map((a) => (
          <Link key={a.key} to={attendanceLink(a.key)} className="inline-flex h-[30px] items-center gap-1.5 rounded-full border bg-card px-3 text-[13px] font-medium hover:border-primary/40">
            <span className="size-2 rounded-full" style={{ background: a.colour }} />
            {a.label} <b className="num">{listOf(a.key).length}</b>
          </Link>
        ))}
        <span className="flex-1" />
        {d.moves.length > 0 && (
          <Link to="/approvals?kind=move" className="inline-flex h-[30px] max-w-full items-center gap-1.5 truncate rounded-full border bg-card px-3 text-[13px] font-medium hover:border-primary/40">
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            {d.moves.length} moved site · {d.moves[0].name?.split(' ')[0]}, {siteName(d.moves[0].from_site_id)} → {siteName(d.moves[0].to_site_id)}
            {d.moves[0].travel_min ? `, ${d.moves[0].travel_min} min travel` : ''}
            {d.moves.length > 1 ? ` and ${d.moves.length - 1} more` : ''}
          </Link>
        )}
      </div>
    </Card>
  );
}

// ─── Waiting on you ──────────────────────────────────────────────────────────

function WaitingCard({ d, hl, set }) {
  const work = d.waiting.filter((w) => !['hold', 'heldback'].includes(w.key));
  const pay = d.waiting.filter((w) => ['hold', 'heldback'].includes(w.key));
  return (
    <Card className="overflow-hidden">
      <CardTitle title="Waiting on you" description={work.length ? 'Time counts only after you decide. Tap a kind to see which sites have them.' : 'Nothing to decide right now.'}>
        <span className={cn('text-[26px] font-semibold num', d.waiting_total ? 'text-destructive' : 'text-muted-foreground')}>{d.waiting_total}</span>
      </CardTitle>
      {work.map((w) => {
        const on = hl === w.key;
        return (
          <div
            key={w.key}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            onClick={() => set({ hl: on ? null : w.key, site: null })}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && set({ hl: on ? null : w.key, site: null })}
            className={cn('flex cursor-pointer items-center gap-3 border-b px-4 py-3 hover:bg-accent/40', on && 'bg-destructive/5 shadow-[inset_3px_0_0_var(--destructive)]')}
          >
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-muted font-semibold num">{w.n}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{w.label}</div>
              <div className="truncate text-[12px] text-muted-foreground">{w.names.map((n) => n.split(' ')[0]).join(', ')}</div>
            </div>
            <Faces list={w.names.map((name, i) => ({ id: `${w.key}${i}`, name }))} size={22} />
            <Link to={w.to} onClick={(e) => e.stopPropagation()} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`Open ${w.label}`}>
              <ChevronRight className="size-4" />
            </Link>
          </div>
        );
      })}
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

// ─── Arrivals ────────────────────────────────────────────────────────────────

function ArrivalsCard({ d, people, bin, setBin, onPerson }) {
  const start = d.shift.start_min;
  const lateFrom = start + d.shift.grace_min;
  const edges = Array.from({ length: 6 }, (_, i) => start - 20 + i * 10);
  const arrivals = people.filter((p) => p.in_min !== null).sort((a, b) => a.in_min - b.in_min);
  const bins = edges.map((e, i) => arrivals.filter((p) => (i === 0 ? p.in_min < e + 10 : i === edges.length - 1 ? p.in_min >= e : p.in_min >= e && p.in_min < e + 10)));
  const max = Math.max(1, ...bins.map((b) => b.length));
  const late = arrivals.filter((p) => p.in_min > lateFrom);
  const med = arrivals[Math.floor(arrivals.length / 2)];
  const shiftX = `${(100 * 2) / edges.length}%`;
  return (
    <Card>
      <CardTitle title="How the morning arrived" description={`Punch-ins every 10 minutes. Shift starts ${hhmm(start)}, late after ${hhmm(lateFrom)}. Tap a bar.`} />
      <div className="px-5 pt-4 pb-3">
        <div className="relative flex h-[150px] items-end gap-2.5 border-b">
          <span className="absolute top-[-6px] bottom-0 border-l-[1.5px] border-dashed border-muted-foreground/50" style={{ left: shiftX }} />
          <span className="absolute top-[-8px] text-[11px] text-muted-foreground" style={{ left: `calc(${shiftX} + 6px)` }}>
            {hhmm(start)} shift start
          </span>
          {bins.map((b, i) => (
            <button key={i} type="button" onClick={() => setBin(bin === i ? -1 : i)} aria-label={`${hhmm(edges[i])}: ${b.length}`} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[12px] font-semibold num">{b.length}</span>
              <span
                className="w-full rounded-t-md"
                style={{ height: Math.max(4, Math.round((b.length / max) * 118)), background: edges[i] + 10 > lateFrom + 1 ? 'color-mix(in srgb, var(--warning) 80%, var(--card))' : 'var(--primary)', boxShadow: bin === i ? '0 0 0 2px var(--foreground)' : 'none' }}
              />
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex gap-2.5">
          {edges.map((e, i) => (
            <span key={e} className="flex-1 text-center text-[12px] text-muted-foreground num">
              {i === 0 ? `≤${hhmm(e)}` : hhmm(e)}
            </span>
          ))}
        </div>
        <div className="mt-3 min-h-[44px] rounded-lg bg-muted/60 px-3 py-2.5 text-[13px]">
          {bin >= 0 ? (
            bins[bin].length ? (
              <span className="flex flex-wrap gap-x-2 gap-y-1">
                {bins[bin].map((p) => (
                  <button key={p.id} type="button" className="hover:underline" onClick={() => onPerson(p.id)}>
                    {p.name} <span className="text-muted-foreground num">{hhmm(p.in_min)}</span>
                  </button>
                ))}
              </span>
            ) : (
              'Nobody in this slot.'
            )
          ) : arrivals.length ? (
            `Median punch-in ${hhmm(med.in_min)} · ${late.length} came after ${hhmm(lateFrom)} · earliest ${arrivals[0].name} ${hhmm(arrivals[0].in_min)}, latest ${arrivals[arrivals.length - 1].name} ${hhmm(arrivals[arrivals.length - 1].in_min)}.`
          ) : (
            'Nobody has punched in.'
          )}
        </div>
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
      <CardTitle title="People in, this month" description="How many punched in each day. Pick a site at the top to bring its line forward." />
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

