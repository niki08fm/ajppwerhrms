import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn, istTime, mins } from '@/utils';
import { fullDate, shortDate, monthName } from '@/components/attendance/dayVocab';
import { NumberPager } from '@/components/attendance/NumberPager';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { useCompactSiteView } from './useCompactSiteView';

/** Site registers display the site's punches; they never open an HR correction form. */
export function TabletRegisters({ mode, query, today, selector }) {
  const compact = useCompactSiteView();
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const data = query.data;
  const allRows = data?.rows ?? [];
  const departments = useMemo(() => [...new Set(allRows.map((r) => r.department).filter(Boolean))].sort(), [allRows]);
  const needle = search.trim().toLowerCase();
  const rows = allRows.filter((r) => (!department || r.department === department) && (!needle || `${r.name} ${r.code}`.toLowerCase().includes(needle)));
  const pages = Math.max(1, Math.ceil(rows.length / limit));
  const currentPage = Math.min(page, pages);
  const shown = rows.slice((currentPage - 1) * limit, currentPage * limit);
  const dates = data?.days?.map((d) => d.date) ?? [];

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="site-register-header" title={mode === 'day' ? (data?.date ? fullDate(data.date) : 'Daily register') : (data?.ym ? monthName(data.ym) : 'Monthly register')} description="Punch records at this site. OT updates after punch-out. View only." actions={selector} />
      <div className="flex flex-wrap items-center gap-3 border-b p-4">
        <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden="true" /><Input aria-label="Search register" placeholder="Search name or employee ID" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="pl-9" /></div>
        <Select aria-label="Register department" value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }} className="w-full sm:w-48"><option value="">All departments</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
        {data && <span className="text-[12px] text-muted-foreground">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>}
      </div>
      {query.isLoading ? <SkeletonRows rows={8} cols={6} /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !rows.length ? <EmptyState title={allRows.length ? 'No matching people' : 'No punches at this site'} body={allRows.length ? 'Change the search or department.' : 'People appear here after punching at this site during the selected period.'} /> : (
        <>
          {compact ? <div>
            {mode === 'day' ? <DailyCards rows={shown} /> : <MonthlyCards rows={shown} dates={dates} today={today} />}
          </div> : <>
          <p className="hidden border-b px-4 py-2 text-xs text-muted-foreground md:block">Scroll across the register to see all {mode === 'day' ? 'attendance details' : 'days and totals'}.</p>
          <div className="hidden max-h-[640px] overflow-auto md:block" role="region" aria-label={mode === 'day' ? 'Daily register table' : 'Monthly register table'} tabIndex={0}>
            {mode === 'day' ? <DailyTable rows={shown} /> : <MonthlyTable rows={shown} dates={dates} today={today} />}
          </div>
          </>}
          {mode === 'month' && !compact && <div className="hidden flex-wrap md:flex gap-4 border-t px-4 py-2.5 text-[12px] text-muted-foreground"><span><b className="text-primary">P</b> Punched in</span><span><b className="text-warning-foreground">O</b> Punch-out only</span><span><b>—</b> No punch at this site</span><span>Hours include only this site's sessions.</span></div>}
          {compact ? <div className="space-y-3 border-t p-4">
            <div className="flex items-center justify-between gap-2 text-sm">
              <Button variant="outline" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft /> Previous</Button>
              <span className="text-xs text-muted-foreground">Page {currentPage} of {pages}</span>
              <Button variant="outline" aria-label="Next page" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next <ChevronRight /></Button>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm text-muted-foreground">Rows per page
              <Select aria-label="Rows per page" className="w-24" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>{[20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
            </label>
          </div> : <div><NumberPager page={currentPage} pages={pages} total={rows.length} limit={limit} onPage={setPage} onLimit={(next) => { setLimit(next); setPage(1); }} hint="" /></div>}
        </>
      )}
    </Card>
  );
}

function EmployeeCell({ person }) {
  return <div className="min-w-[180px]"><p className="font-medium">{person.name}</p><p className="mt-0.5 text-[11px] text-muted-foreground"><span className="num">{person.code}</span>{person.department ? ` · ${person.department}` : ''}</p></div>;
}

const heading = 'sticky top-0 z-10 whitespace-nowrap border-b bg-muted px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const cell = 'border-b px-4 py-3 text-[13px]';
const STATUS = {
  ON_SITE: ['On site', 'success'],
  SIGNED_OUT: ['Signed out', 'muted'],
  MISSING_PUNCH: ['No punch-out', 'warning'],
  OUT_ONLY: ['Out only', 'warning'],
};

function RegisterStatus({ person }) {
  const [label, tone] = person.on_site_now ? STATUS.ON_SITE : STATUS[person.status] ?? [person.status || 'Signed out', 'muted'];
  return <Chip tone={tone}>{label}</Chip>;
}

function DailyTable({ rows }) {
  return <table className="w-full min-w-[940px] border-collapse"><thead><tr>{['Employee', 'First in', 'Last out', 'Status', 'In / out', 'Worked', 'OT', 'Late', 'Left early'].map((h) => <th key={h} scope="col" className={cn(heading, h === 'Employee' && 'left-0 z-20')}>{h}</th>)}</tr></thead><tbody>{rows.map((r) => <tr key={r.id} className="hover:bg-muted/30"><td className={cn(cell, 'sticky left-0 z-[1] bg-card')}><EmployeeCell person={r} /></td><td className={cn(cell, 'num')}>{istTime(r.first_in)}</td><td className={cn(cell, 'num')}>{istTime(r.last_out)}</td><td className={cell}><RegisterStatus person={r} /></td><td className={cn(cell, 'num')}>{r.punches_in} / {r.punches_out}</td><td className={cn(cell, 'whitespace-nowrap num')}>{mins(r.worked_min)}</td><td className={cn(cell, 'whitespace-nowrap num')}>{r.ot_min > 0 ? mins(r.ot_min) : '—'}</td><td className={cn(cell, 'whitespace-nowrap num', r.late_min > 0 && 'text-warning-foreground')}>{r.late_min > 0 ? mins(r.late_min) : '—'}</td><td className={cn(cell, 'whitespace-nowrap num', r.early_min > 0 && 'text-destructive')}>{r.early_min > 0 ? mins(r.early_min) : '—'}</td></tr>)}</tbody></table>;
}

function MonthlyTable({ rows, dates, today }) {
  return <table className="w-full border-separate border-spacing-0"><thead><tr><th scope="col" className={cn(heading, 'left-0 z-20')}>Employee</th>{dates.map((date) => <th key={date} scope="col" className={cn(heading, 'min-w-9 px-1 text-center', date === today && 'text-primary')} title={fullDate(date)}>{Number(date.slice(8))}</th>)}<th scope="col" className={heading}>Days in</th><th scope="col" className={heading}>Worked</th><th scope="col" className={heading}>OT</th></tr></thead><tbody>{rows.map((r) => {
    const byDate = new Map((r.days ?? []).map((d) => [d.date, d]));
    return <tr key={r.id}><td className={cn(cell, 'sticky left-0 z-[1] bg-card')}><EmployeeCell person={r} /></td>{dates.map((date) => {
      const d = byDate.get(date);
      const future = date > today;
      const punched = !!d?.punched_in;
      const outOnly = !punched && !!d?.signed_out;
      const note = `${fullDate(date)} · ${future ? 'Future day' : punched ? `Punched in ${istTime(d.in)}${d.out ? ` · out ${istTime(d.out)}` : ''}` : outOnly ? `Punch-out only ${istTime(d.out)}` : 'No punch at this site'}${!future && d?.ot_min > 0 ? ` · Site OT ${mins(d.ot_min)}` : ''}`;
      return <td key={date} className="border-b p-1 text-center"><span title={note} aria-label={note} className={cn('inline-flex size-7 items-center justify-center rounded text-[11px] font-semibold', future ? 'text-muted-foreground/30' : punched ? 'bg-primary/10 text-primary' : outOnly ? 'bg-warning/15 text-warning-foreground' : 'bg-muted/40 text-muted-foreground')}>{future ? '' : punched ? 'P' : outOnly ? 'O' : '—'}</span></td>;
    })}<td className={cn(cell, 'text-center font-semibold num')}>{r.punched_days}</td><td className={cn(cell, 'whitespace-nowrap num')}>{mins(r.worked_min)}</td><td className={cn(cell, 'whitespace-nowrap num')}>{r.ot_min > 0 ? mins(r.ot_min) : '—'}</td></tr>;
  })}</tbody></table>;
}


function PersonHeading({ person }) {
  return <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
    <div className="min-w-0"><h4 className="break-words text-base font-semibold">{person.name}</h4><p className="mt-1 text-xs text-muted-foreground">{person.code}{person.department ? ` · ${person.department}` : ''}</p></div>
    <RegisterStatus person={person} />
  </div>;
}

function Figures({ items }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3">{items.map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-medium num">{value}</dd></div>)}</dl>;
}

/** Phones show every daily figure without sideways scrolling. */
function DailyCards({ rows }) {
  return <ul className="divide-y" aria-label="Daily attendance cards">{rows.map((person) => <li key={person.id} className="space-y-4 p-4">
    <PersonHeading person={person} />
    <Figures items={[
      ['First in', istTime(person.first_in)], ['Last out', istTime(person.last_out)],
      ['Worked', mins(person.worked_min)], ['OT', person.ot_min > 0 ? mins(person.ot_min) : '—'],
      ['Late', person.late_min > 0 ? mins(person.late_min) : '—'], ['Left early', person.early_min > 0 ? mins(person.early_min) : '—'],
      ['Punches in / out', `${person.punches_in} / ${person.punches_out}`],
    ]} />
  </li>)}</ul>;
}

/** Daily details expand by person rather than squeezing 31 days onto a phone. */
function MonthlyCards({ rows, dates, today }) {
  return <ul className="divide-y" aria-label="Monthly attendance cards">{rows.map((person) => {
    const byDate = new Map((person.days ?? []).map((day) => [day.date, day]));
    return <li key={person.id} className="space-y-4 p-4">
      <div><h4 className="break-words text-base font-semibold">{person.name}</h4><p className="mt-1 text-xs text-muted-foreground">{person.code}{person.department ? ` · ${person.department}` : ''}</p></div>
      <Figures items={[[ 'Days punched in', person.punched_days ], ['Worked', mins(person.worked_min)], ['OT', person.ot_min > 0 ? mins(person.ot_min) : '—']]} />
      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-3 text-sm font-medium">View daily punches</summary>
        <ul className="divide-y border-t" aria-label={`Daily punches for ${person.name}`}>{dates.filter((date) => date <= today).map((date) => {
          const day = byDate.get(date);
          return <li key={date} className="space-y-1 px-3 py-3 text-sm">
            <p className="font-medium">{shortDate(date)}</p>
            <p className="text-muted-foreground">{day?.punched_in ? `In ${istTime(day.in)} · ${day.out ? `Out ${istTime(day.out)}` : 'No punch-out'}` : day?.signed_out ? `Punch-out only ${istTime(day.out)}` : 'No punch at this site'}</p>
            {(day?.worked_min > 0 || day?.ot_min > 0) && <p className="num">Worked {mins(day.worked_min ?? 0)} · OT {day.ot_min > 0 ? mins(day.ot_min) : '—'}</p>}
          </li>;
        })}</ul>
        {dates.every((date) => date > today) && <p className="px-3 pb-3 text-sm text-muted-foreground">This period has no elapsed days.</p>}
      </details>
    </li>;
  })}</ul>;
}
