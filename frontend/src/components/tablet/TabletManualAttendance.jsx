import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CloudOff, FileClock, FileSpreadsheet, Plus, Search, Send, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/services/api';
import { cn, istTime, mins } from '@/utils';
import { fullDate } from '@/components/attendance/dayVocab';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { Chip, EmptyState, ErrorState, Notice, SkeletonRows } from '@/components/states';
import { manualEntryError, manualEntryPayload, newManualEntry, rowMinutes } from '@/services/manualAttendanceForm';

const STATUS = { PENDING: ['Waiting for HR', 'warning'], APPROVED: ['Approved', 'success'], REJECTED: ['Rejected', 'destructive'], EXPIRED: ['Expired', 'muted'] };
const stamp = (value) => value ? istTime(value, true) : '—';
const RECEIVED = {
  PENDING: 'Sheet sent to HR. Attendance is recorded only after HR approves the sheet.',
  APPROVED: 'This sheet is already approved. Open it below to see the attendance HR recorded.',
  EXPIRED: 'This sheet has expired. It did not record attendance. Open it below for the review history.',
  REJECTED: 'HR has rejected this sheet. It did not record attendance. Open it below for the review history.',
};
const clock = (value) => value == null ? '—' : `${String(Math.floor(value % 1440 / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}${value >= 1440 ? ' (+1 day)' : ''}`;

/** Enter the paper register online. No local storage, offline queue or automatic submission. */
export function TabletManualAttendance(props) { return <ManualWorkspace key={props.site.id} {...props} />; }

function ManualWorkspace({ site, today, online, active }) {
  const qc = useQueryClient();
  const [entry, setEntry] = useState(null), [editing, setEditing] = useState(false), [search, setSearch] = useState('');
  const [opened, setOpened] = useState(null), [sending, setSending] = useState(false), [error, setError] = useState(null), [message, setMessage] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true), submitting = useRef(false), sentPayload = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const headers = { 'X-Site-Id': site.id };
  const directory = useQuery({ queryKey: ['tablet-manual-employees', site.id], queryFn: () => api.get('/tablet/manual-attendance-employees', {}, headers).then((r) => r.data), enabled: online && active, staleTime: 60_000, retry: false });
  const sheets = useQuery({ queryKey: ['tablet-manual-sheets', site.id], queryFn: () => api.get('/tablet/manual-attendance-sheets', {}, headers).then((r) => r.data), enabled: online && active, refetchInterval: online && active ? 60_000 : false, retry: false });
  const detail = useQuery({ queryKey: ['tablet-manual-sheet', site.id, opened], queryFn: () => api.get(`/tablet/manual-attendance-sheets/${opened}`, {}, headers).then((r) => r.data), enabled: online && active && !!opened, retry: false });
  const create = () => { if (!online) return; if (!entry) setEntry(newManualEntry(today)); setEditing(true); setSearch(''); setMessage(null); };
  const changeEntry = (patch) => { if (!online || sending || uncertain) return; setEntry((prev) => ({ ...prev, ...patch })); sentPayload.current = null; setError(null); };
  const available = (directory.data ?? []).filter((person) => search.trim() && search.trim().toLowerCase().split(/\s+/).every((word) => `${person.name} ${person.code}`.toLowerCase().includes(word))).slice(0, 8);
  const entryError = entry ? manualEntryError(entry, today) : null;
  const duplicate = !uncertain && entry && sheets.data?.some((sheet) => sheet.work_date === entry.work_date);
  const locked = !online || sending || uncertain;
  const submit = async () => {
    if (!online || submitting.current || !entry || (!uncertain && (entryError || duplicate))) return;
    submitting.current = true; setSending(true); setError(null);
    if (!sentPayload.current) sentPayload.current = manualEntryPayload(entry);
    try {
      const me = await api.get('/auth/site-me');
      if (!alive.current) return;
      if (me.data?.id !== site.id) throw new ApiError(403, 'SITE_CHANGED', 'Sign in to this sheet’s site before sending it.');
      const reply = await api.post('/tablet/manual-attendance-sheets', sentPayload.current, headers);
      if (!alive.current) return;
      setEntry(null); setEditing(false); setUncertain(false); sentPayload.current = null;
      setMessage(RECEIVED[reply.data.status] ?? 'The sheet is available in sent sheets. Open it below to check its status.');
      if (reply.data.status !== 'PENDING') setOpened(reply.data.id);
      qc.invalidateQueries({ queryKey: ['tablet-manual-sheets', site.id] });
    } catch (failure) {
      if (!alive.current) return;
      // A later sign-in/scope error cannot settle an earlier lost response.
      const ambiguous = uncertain || !failure.status || failure.status >= 500 || failure.code === 'IDEMPOTENCY_CONFLICT';
      setUncertain(ambiguous); setError(failure);
      if (!ambiguous) sentPayload.current = null;
    } finally { submitting.current = false; if (alive.current) setSending(false); }
  };

  return <div className="space-y-4">
    {!online && <Notice tone="warning" icon={<CloudOff className="size-4 shrink-0" />}>Connect to enter and send the times from your paper register. Nothing will be sent automatically after reconnecting.</Notice>}
    {message && <Notice tone="info" icon={<FileClock className="size-4 shrink-0" />}>{message}</Notice>}
    {editing && entry ? <Card className="overflow-hidden">
      <CardHeader title="Enter attendance from the paper register" description="Choose the date, add employees and copy their actual punch-in and punch-out times."
        actions={<Button variant="ghost" disabled={sending} onClick={() => { setEditing(false); if (uncertain) qc.invalidateQueries({ queryKey: ['tablet-manual-sheets', site.id] }); }}>{uncertain ? 'Check sent sheets' : 'Back to sheets'}</Button>} />
      <div className="space-y-4 p-5">
        {error && <Notice tone="destructive">{errorMessage(error)}</Notice>}
        {uncertain && <Notice tone="warning">The server response was interrupted. Retry the same sheet or check sent sheets. Keep the entry unchanged so it cannot be sent twice.</Notice>}
        <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
          <Field label="Attendance date" required>{(id) => <Input id={id} type="date" max={today} value={entry.work_date} disabled={locked} onChange={(event) => changeEntry({ work_date: event.target.value })} />}</Field>
          <Field label="Reason for manual attendance" required>{(id) => <Input id={id} maxLength={300} value={entry.reason} disabled={locked} onChange={(event) => changeEntry({ reason: event.target.value })} />}</Field>
        </div>
        {duplicate && <Notice tone="warning">A sheet already uses this date. Open it in sent sheets or choose a different date.</Notice>}
        <Field label="Add employee">{(id) => <div>
          <div className="relative"><Search aria-hidden className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input id={id} aria-label="Search manual attendance employees" className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} disabled={locked || directory.isLoading} placeholder="Search employee name or ID" autoComplete="off" /></div>
          {directory.isLoading && online ? <p className="mt-2 text-[13px] text-muted-foreground" role="status">Loading employees…</p> : search.trim() && <ul className="mt-2 max-h-48 divide-y overflow-y-auto rounded-md border" aria-label="Manual attendance employee matches">
            {available.length ? available.map((person) => <li key={person.code}><button type="button" disabled={locked || entry.rows.some((row) => row.employee.code === person.code)} aria-label={`Add ${person.name} (${person.code})`} onClick={() => { changeEntry({ rows: [...entry.rows, { employee: person, in_time: '', out_time: '', out_next_day: false }] }); setSearch(''); }} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted disabled:opacity-40"><span><span className="block text-sm font-medium">{person.name}</span><span className="text-[12px] text-muted-foreground">{person.department?.name}{person.designation ? ` · ${person.designation}` : ''}</span></span><span className="text-[12px] num">{person.code}</span></button></li>) : <li className="px-3 py-3 text-[13px] text-muted-foreground">No employees match this search.</li>}
          </ul>}
        </div>}</Field>
        {directory.isError && online && <ErrorState error={directory.error} onRetry={() => directory.refetch()} compact />}
        <p className="text-[12px] text-muted-foreground">{entry.rows.length} employees in this sheet{entry.rows.length > 3 ? ' · Scroll inside the sheet for more employees' : ''}</p>
        <ul className="-m-1 max-h-[52vh] space-y-3 overflow-y-auto p-1" aria-label="Manual attendance rows">
          {entry.rows.map((row, index) => {
            const times = rowMinutes(row);
            const change = (patch) => changeEntry({ rows: entry.rows.map((item, at) => at === index ? { ...item, ...patch } : item) });
            return <li key={row.employee.code} role="group" aria-label={`${row.employee.name} attendance`} className="rounded-lg border p-4">
              <div className="mb-3 flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">{row.employee.name}</p><p className="text-[12px] text-muted-foreground">{row.employee.code} · {row.employee.department?.name ?? row.employee.designation}</p></div><Button size="sm" variant="ghost" disabled={locked} aria-label={`Remove ${row.employee.name}`} onClick={() => changeEntry({ rows: entry.rows.filter((_, at) => at !== index) })}><Trash2 /></Button></div>
              <div className="grid grid-cols-2 gap-3"><Field label="Punch in">{(id) => <Input id={id} type="time" value={row.in_time} aria-label={`Punch in for ${row.employee.name}`} disabled={locked} onChange={(event) => change({ in_time: event.target.value })} />}</Field><Field label="Punch out">{(id) => <Input id={id} type="time" value={row.out_time} aria-label={`Punch out for ${row.employee.name}`} disabled={locked} onChange={(event) => change({ out_time: event.target.value })} />}</Field></div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px]"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={row.out_next_day} aria-label={`Punch out next day for ${row.employee.name}`} disabled={locked} onChange={(event) => change({ out_next_day: event.target.checked })} className="accent-primary" />Punch-out is the next day</label><span className={cn('num', times.out_min > times.in_min ? 'text-muted-foreground' : 'text-destructive')}>{times.in_min !== null && times.out_min !== null ? times.out_min > times.in_min ? `${mins(times.out_min - times.in_min)} entered` : 'Check the punch times' : 'Both times are needed to send'}</span></div>
            </li>;
          })}
        </ul>
        {!entry.rows.length && <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Search and add employees from the paper register.</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-5 py-4">
        <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">{uncertain ? 'No automatic retry. Reconnect and send the same sheet again, or check sent sheets.' : entryError ?? 'HR has 3 days after receipt to review this sheet. Nothing is recorded before approval.'}</p>
        <Button disabled={!online || (!uncertain && (!!entryError || !!duplicate))} loading={sending} onClick={submit}><Send />{uncertain ? 'Retry sending to HR' : 'Send sheet to HR'}</Button>
      </div>
    </Card> : <Card className="overflow-hidden">
      <CardHeader title="Manual attendance sheets" description="Enter the paper register when the connection is available. HR reviews and approves each sheet."
        actions={<Button disabled={!online} onClick={create}><Plus />{entry ? 'Continue entry' : 'New attendance sheet'}</Button>} />
      {entry && <p className="border-b px-5 py-3 text-[12px] text-muted-foreground">An entry is still open on this page. Continue it to send the sheet; it is not saved on this device.</p>}
      {sheets.isLoading ? <SkeletonRows rows={3} cols={3} /> : sheets.isError && online ? <ErrorState error={sheets.error} onRetry={() => sheets.refetch()} compact /> : !sheets.data?.length ? <EmptyState title="No submitted sheets" body="Create one sheet for the day, add employees and punch times, then send it to HR." icon={<FileSpreadsheet className="size-6" />} /> : <ul className="max-h-96 divide-y overflow-y-auto" aria-label="Submitted manual attendance sheets">
        {sheets.data.map((sheet) => { const [label, tone] = STATUS[sheet.status] ?? [sheet.status, 'muted']; return <li key={sheet.id}><button type="button" disabled={!online} onClick={() => setOpened(sheet.id)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted disabled:opacity-60"><FileSpreadsheet aria-hidden className="size-5 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{fullDate(sheet.work_date)}</span><span className="mt-1 block text-[12px] text-muted-foreground">{sheet.row_count} employees · {sheet.status === 'PENDING' ? `Review by ${stamp(sheet.expires_at)}` : `Sent ${stamp(sheet.submitted_at)}`}</span></span><Chip tone={tone}>{label}</Chip><ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" /></button></li>; })}
      </ul>}
      <p className="border-t px-5 py-3 text-[12px] text-muted-foreground">Unapproved sheets expire 3 days after HR receives them. They do not create punches; normal absence or leave rules then apply. Existing attendance is kept.</p>
    </Card>}
    <Dialog open={!!opened} onOpenChange={(open) => !open && setOpened(null)} title="Manual attendance sheet" description={detail.data ? `${fullDate(detail.data.work_date)} · ${site.name}` : 'Saved sheet sent to HR'} wide>
      {detail.isLoading ? <SkeletonRows rows={4} /> : detail.isError ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} compact /> : detail.data && <SheetReadOnly sheet={detail.data} />}
    </Dialog>
  </div>;
}

function SheetReadOnly({ sheet }) {
  const [label, tone] = STATUS[sheet.status] ?? [sheet.status, 'muted'];
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><Chip tone={tone}>{label}</Chip><span className="text-[12px] text-muted-foreground">Sent {stamp(sheet.submitted_at)}</span></div>
    <p className="text-sm text-muted-foreground">{sheet.reason}</p>
    <Notice tone={sheet.status === 'APPROVED' ? 'success' : sheet.status === 'PENDING' ? 'info' : 'warning'}>{sheet.status === 'PENDING' ? `HR can edit each employee before approving. Review deadline: ${stamp(sheet.expires_at)}.` : sheet.status === 'APPROVED' ? 'HR approved this sheet. Included employees’ attendance was recorded.' : sheet.status === 'EXPIRED' ? 'HR did not approve within 3 days. This sheet did not record attendance; normal absence or leave rules apply.' : 'HR rejected this sheet. This sheet did not record attendance.'}</Notice>
    <ul className="divide-y rounded-md border" aria-label="Submitted sheet employees">{sheet.rows?.map((row) => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div><p className="text-sm font-medium">{row.employee.name}</p><p className="text-[12px] text-muted-foreground">{row.employee.code} · {row.employee.department?.name}</p>{row.note && <p className="mt-1 text-[12px] text-muted-foreground">HR: {row.note}</p>}</div><div className="text-right"><p className="text-sm num">{clock(row.in_min)} → {clock(row.out_min)}</p>{row.included === false && <p className="mt-1 text-[12px] text-destructive">Excluded by HR</p>}</div></li>)}</ul>
    {sheet.decision_note && <p className="text-sm text-muted-foreground">HR: {sheet.decision_note}</p>}
  </div>;
}
