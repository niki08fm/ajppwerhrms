import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { cn, istTime, mins } from '@/utils';
import { fullDate, monthName } from '@/components/attendance/dayVocab';
import { NumberPager } from '@/components/attendance/NumberPager';
import { Card, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';

/** Site registers display the site's punches; they never open an HR correction form. */
export function TabletRegisters({ mode, query, today, selector }) {
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
      <CardHeader title={mode === 'day' ? (data?.date ? fullDate(data.date) : 'Daily register') : (data?.ym ? monthName(data.ym) : 'Monthly register')} description="Punch records at this site. View only." actions={selector} />
      <div className="flex flex-wrap items-center gap-3 border-b p-4">
        <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden="true" /><Input aria-label="Search register" placeholder="Search name or employee ID" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="pl-9" /></div>
        <Select aria-label="Register department" value={department} onChange={(e) => { setDepartment(e.target.value); setPage(1); }} className="w-full sm:w-48"><option value="">All departments</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
        {data && <span className="text-[12px] text-muted-foreground">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>}
      </div>
      {query.isLoading ? <SkeletonRows rows={8} cols={6} /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !rows.length ? <EmptyState title={allRows.length ? 'No matching people' : 'No punches at this site'} body={allRows.length ? 'Change the search or department.' : 'People appear here after punching at this site during the selected period.'} /> : (
        <>
          <div className="max-h-[640px] overflow-auto" role="region" aria-label={mode === 'day' ? 'Daily register table' : 'Monthly register table'} tabIndex={0}>
            {mode === 'day' ? <DailyTable rows={shown} /> : <MonthlyTable rows={shown} dates={dates} today={today} />}
          </div>
          {mode === 'month' && <div className="flex flex-wrap gap-4 border-t px-4 py-2.5 text-[12px] text-muted-foreground"><span><b className="text-primary">P</b> Punched in</span><span><b className="text-warning-foreground">O</b> Punch-out only</span><span><b>—</b> No punch at this site</span><span>Hours include only this site's sessions.</span></div>}
          <NumberPager page={currentPage} pages={pages} total={rows.length} limit={limit} onPage={setPage} onLimit={(next) => { setLimit(next); setPage(1); }} hint="" />
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
  return <table className="w-full min-w-[940px] border-collapse"><thead><tr>{['Employee', 'First in', 'Last out', 'Status', 'In / out', 'Worked', 'Late', 'Left early'].map((h) => <th key={h} scope="col" className={cn(heading, h === 'Employee' && 'left-0 z-20')}>{h}</th>)}</tr></thead><tbody>{rows.map((r) => <tr key={r.id} className="hover:bg-muted/30"><td className={cn(cell, 'sticky left-0 z-[1] bg-card')}><EmployeeCell person={r} /></td><td className={cn(cell, 'num')}>{istTime(r.first_in)}</td><td className={cn(cell, 'num')}>{istTime(r.last_out)}</td><td className={cell}><RegisterStatus person={r} /></td><td className={cn(cell, 'num')}>{r.punches_in} / {r.punches_out}</td><td className={cn(cell, 'whitespace-nowrap num')}>{mins(r.worked_min)}</td><td className={cn(cell, 'whitespace-nowrap num', r.late_min > 0 && 'text-warning-foreground')}>{r.late_min > 0 ? mins(r.late_min) : '—'}</td><td className={cn(cell, 'whitespace-nowrap num', r.early_min > 0 && 'text-destructive')}>{r.early_min > 0 ? mins(r.early_min) : '—'}</td></tr>)}</tbody></table>;
}

function MonthlyTable({ rows, dates, today }) {
  return <table className="w-full border-separate border-spacing-0"><thead><tr><th scope="col" className={cn(heading, 'left-0 z-20')}>Employee</th>{dates.map((date) => <th key={date} scope="col" className={cn(heading, 'min-w-9 px-1 text-center', date === today && 'text-primary')} title={fullDate(date)}>{Number(date.slice(8))}</th>)}<th scope="col" className={heading}>Days in</th><th scope="col" className={heading}>Worked</th></tr></thead><tbody>{rows.map((r) => {
    const byDate = new Map((r.days ?? []).map((d) => [d.date, d]));
    return <tr key={r.id}><td className={cn(cell, 'sticky left-0 z-[1] bg-card')}><EmployeeCell person={r} /></td>{dates.map((date) => {
      const d = byDate.get(date);
      const future = date > today;
      const punched = !!d?.punched_in;
      const outOnly = !punched && !!d?.signed_out;
      const note = `${fullDate(date)} · ${future ? 'Future day' : punched ? `Punched in ${istTime(d.in)}${d.out ? ` · out ${istTime(d.out)}` : ''}` : outOnly ? `Punch-out only ${istTime(d.out)}` : 'No punch at this site'}`;
      return <td key={date} className="border-b p-1 text-center"><span title={note} aria-label={note} className={cn('inline-flex size-7 items-center justify-center rounded text-[11px] font-semibold', future ? 'text-muted-foreground/30' : punched ? 'bg-primary/10 text-primary' : outOnly ? 'bg-warning/15 text-warning-foreground' : 'bg-muted/40 text-muted-foreground')}>{future ? '' : punched ? 'P' : outOnly ? 'O' : '—'}</span></td>;
    })}<td className={cn(cell, 'text-center font-semibold num')}>{r.punched_days}</td><td className={cn(cell, 'whitespace-nowrap num')}>{mins(r.worked_min)}</td></tr>;
  })}</tbody></table>;
}
