import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, FileSpreadsheet, Pencil, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { hhmm } from '@/utils';
import { Chip, EmptyState, ErrorState, Notice, PermissionDenied, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { fullDate } from './dayVocab';

const STATES = [
  ['PENDING', 'Waiting for review'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['EXPIRED', 'Expired'], ['', 'All sheets'],
];
const STATUS = {
  PENDING: { label: 'Waiting for review', tone: 'warning' }, APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'muted' }, EXPIRED: { label: 'Expired', tone: 'destructive' },
};
const stamp = (value) => value ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const timeInput = (value) => value == null ? '' : hhmm(value % 1440);
const minutes = (value) => /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
const shownTime = (value) => value == null ? '—' : `${hhmm(value % 1440)}${value >= 1440 ? ' +1 day' : ''}`;
const expired = (sheet, now) => sheet.status === 'EXPIRED' || (sheet.status === 'PENDING' && Date.parse(sheet.expires_at) <= now);

/** A file per site and day. The file is the approval boundary, not each employee. */
export function ManualAttendanceSheets({ sheetId, onSelectSheet }) {
  const { can } = useSession();
  const [status, setStatus] = useState('PENDING');
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['manual-attendance-sheets', status],
    queryFn: () => api.get('/manual-attendance-sheets', { status: status || undefined }).then((r) => r.data),
    enabled: can('attendance.read'), refetchInterval: 30_000,
  });
  if (!can('attendance.read')) return <PermissionDenied message="Attendance access is needed to review these sheets." />;
  const needle = search.trim().toLowerCase();
  const rows = (list.data ?? []).filter((sheet) => `${sheet.site.name} ${sheet.site.code} ${sheet.work_date}`.toLowerCase().includes(needle));
  return <section className="space-y-4" aria-label="Manual attendance sheets">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">Each file contains a site's employees for one day. Review and edit the rows, then approve the sheet to record attendance. Unapproved sheets expire after three days.</div>
      <Button size="sm" variant="outline" onClick={() => list.refetch()} loading={list.isFetching}><RefreshCw /> Refresh sheets</Button>
    </div>
    <div className="flex flex-wrap gap-3">
      <Select aria-label="Sheet status" value={status} onChange={(event) => setStatus(event.target.value)} className="w-full sm:w-52">
        {STATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      <div className="relative w-full sm:max-w-80"><Search aria-hidden className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Search sheet site or date" placeholder="Search site or date" className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
    </div>
    {list.isLoading ? <Card><SkeletonRows rows={5} /></Card> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? <Card><EmptyState icon={<FileSpreadsheet className="size-6" />} title={needle ? 'No matching sheets' : status === 'PENDING' ? 'No manual sheets waiting' : 'No sheets in this view'} body={needle ? 'Try another site or date.' : 'Choose All sheets to see earlier submissions and decisions.'} /></Card> : <div className="grid gap-3 lg:grid-cols-2">
      {rows.map((sheet) => <button type="button" key={sheet.id} onClick={() => onSelectSheet(sheet.id)} aria-label={`Open ${sheet.site.name} attendance sheet for ${sheet.work_date}`} className="flex min-w-0 items-start gap-3 rounded-lg border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><FileSpreadsheet className="size-5" aria-hidden /></span>
        <span className="min-w-0 flex-1"><span className="block font-semibold">{sheet.site.name}</span><span className="mt-0.5 block text-[13px] text-muted-foreground">{fullDate(sheet.work_date)}</span><span className="mt-2 block text-[13px]">{sheet.included_count ?? sheet.row_count} employees{sheet.included_count != null && sheet.included_count !== sheet.row_count ? ` included · ${sheet.row_count} rows` : ''}</span><span className="mt-1 block text-[12px] text-muted-foreground">{sheet.status === 'PENDING' ? `Review by ${stamp(sheet.expires_at)} IST` : `Submitted ${stamp(sheet.submitted_at)} IST`}</span></span>
        <span className="flex shrink-0 flex-col items-end gap-3"><Chip tone={STATUS[sheet.status]?.tone}>{STATUS[sheet.status]?.label ?? sheet.status}</Chip><ChevronRight aria-hidden className="size-4 text-muted-foreground" /></span>
      </button>)}
    </div>}
    {sheetId && <ManualAttendanceReview key={sheetId} sheetId={sheetId} onClose={() => onSelectSheet(null)} />}
  </section>;
}

function ManualAttendanceReview({ sheetId, onClose }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [now, setNow] = useState(Date.now);
  const [editor, setEditor] = useState(null);
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState(null);
  const [decisionResult, setDecisionResult] = useState(null);
  const q = useQuery({ queryKey: ['manual-attendance-sheet', sheetId], queryFn: () => api.get(`/manual-attendance-sheets/${sheetId}`).then((r) => r.data), refetchInterval: 30_000 });
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const sheet = q.data;
  const isExpired = sheet && expired(sheet, now);
  const pending = sheet?.status === 'PENDING' && !isExpired;
  const editable = pending && can('attendance.write');
  const count = sheet?.rows?.filter((row) => row.included !== false).length ?? 0;

  const refreshWaiting = () => {
    qc.invalidateQueries({ queryKey: ['manual-attendance-sheets'] });
    qc.invalidateQueries({ queryKey: ['tablet-manual-sheets'] });
    qc.invalidateQueries({ queryKey: ['tablet-manual-sheet'] });
    api.get('/approvals', { fresh: 1 }).then((r) => qc.setQueryData(['approvals'], r.data)).catch(() => qc.invalidateQueries({ queryKey: ['approvals'] }));
    for (const key of ['dashboard', 'register', 'attendance-day', 'month-register', 'attendance-month', 'emp-attendance', 'payroll-attendance', 'payroll-summary', 'payroll-preview', 'tablet-summary', 'tablet-day', 'tablet-month']) qc.invalidateQueries({ queryKey: [key] });
  };
  const onFailure = (error) => { setFailure(errorMessage(error)); if (error.status === 409) q.refetch(); };
  const save = useMutation({
    mutationFn: (value) => api.patch(`/manual-attendance-sheets/${sheetId}`, { version: value.version, rows: [{ id: value.id, in_min: value.in_min, out_min: value.out_min, note: value.note.trim(), included: value.included }] }).then((r) => r.data),
    onSuccess: (data) => { qc.setQueryData(['manual-attendance-sheet', sheetId], data); setEditor(null); setFailure(null); toast.success('Employee row saved'); refreshWaiting(); }, onError: onFailure,
  });
  const decide = useMutation({
    mutationFn: ({ decision, version }) => api.post(`/manual-attendance-sheets/${sheetId}/decide`, { decision, version, ...(note.trim() ? { note: note.trim() } : {}) }).then((r) => r.data),
    onSuccess: (data) => { qc.setQueryData(['manual-attendance-sheet', sheetId], data); setFailure(null); setDecisionResult(data.status); toast.success(data.status === 'APPROVED' ? 'Sheet approved. Attendance recorded.' : 'Sheet rejected. Attendance was not recorded.'); refreshWaiting(); }, onError: onFailure,
  });
  const busy = save.isPending || decide.isPending;
  const refresh = async () => { const result = await q.refetch(); if (!result.isError) { setEditor(null); setFailure(null); } };
  const startEdit = (row) => { setEditor({ id: row.id, version: sheet.version, name: row.employee.name, in: timeInput(row.in_min), out: timeInput(row.out_min), inOffset: row.in_min >= 1440 ? 1440 : 0, nextDay: row.out_min >= 1440, included: row.included !== false, note: row.note ?? '' }); setFailure(null); };
  const inMin = editor ? minutes(editor.in) : null;
  const outMin = editor ? minutes(editor.out) : null;
  const inputIn = inMin == null ? null : inMin + (editor?.inOffset ?? 0);
  const inputOut = outMin == null ? null : outMin + (editor?.nextDay ? 1440 : 0);
  const validTimes = inputIn != null && inputOut != null && inputOut > inputIn;
  const staleEdit = editor && editor.version !== sheet?.version;
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()} wide title="Manual attendance sheet" description={sheet ? `${sheet.site.name} · ${fullDate(sheet.work_date)}` : 'Loading submitted attendance…'} footer={
    <div className="flex w-full flex-wrap items-center justify-between gap-3">
      <span className="text-[12px] text-muted-foreground">{sheet ? `${count} of ${sheet.row_count} employees included` : ''}</span>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>Close sheet</Button>{editable && <><Button variant="outline" className="text-destructive" disabled={busy || !!editor} onClick={() => decide.mutate({ decision: 'REJECTED', version: sheet.version })}><X /> Reject sheet</Button><Button disabled={busy || !!editor || !count} loading={decide.isPending && decide.variables?.decision === 'APPROVED'} onClick={() => decide.mutate({ decision: 'APPROVED', version: sheet.version })}><Check /> Approve sheet</Button></>}</div>
    </div>
  }>
    {q.isLoading ? <SkeletonRows rows={6} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : sheet && <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><Chip tone={isExpired ? STATUS.EXPIRED.tone : STATUS[sheet.status]?.tone}>{isExpired ? 'Expired' : STATUS[sheet.status]?.label ?? sheet.status}</Chip><p className="text-[12px] text-muted-foreground">Submitted {stamp(sheet.submitted_at)} IST</p></div>
      {pending && <Notice tone="warning">Review by <b>{stamp(sheet.expires_at)} IST</b>. Nothing in this sheet counts as attendance until you approve it.</Notice>}
      {isExpired && <Notice tone="destructive">The three-day approval window ended. This sheet did not record attendance. Normal absence rules apply where there is no other attendance or approved leave.</Notice>}
      {sheet.status === 'APPROVED' && <Notice tone="success">{decisionResult === 'APPROVED' ? 'Sheet approved. ' : ''}Attendance was recorded for the included employees{sheet.decided_by ? ` by ${sheet.decided_by}` : ''}{sheet.decided_at ? ` on ${stamp(sheet.decided_at)} IST` : ''}.</Notice>}
      {sheet.status === 'REJECTED' && <Notice tone="warning">This sheet was rejected. No attendance was recorded from it.</Notice>}
      {sheet.reason && <div className="rounded-md bg-muted/50 px-3 py-2 text-[13px]"><span className="font-medium">Site note: </span>{sheet.reason}</div>}
      {failure && <div className="space-y-2"><Notice tone="destructive">{failure}</Notice><Button size="sm" variant="outline" onClick={refresh} disabled={busy}><RefreshCw /> Refresh sheet</Button></div>}
      <div className="overflow-hidden rounded-lg border" aria-label="Employee attendance rows">
        <div className="hidden grid-cols-[minmax(0,1fr)_110px_110px_70px] gap-3 border-b bg-muted/40 px-4 py-2 text-[12px] font-semibold text-muted-foreground sm:grid"><span>Employee</span><span>Punch in</span><span>Punch out</span><span /></div>
        <ul className="divide-y">
          {sheet.rows.map((row) => <li key={row.id} className="px-4 py-3" aria-label={`Attendance for ${row.employee.name}`}>
            <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_110px_110px_70px]">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{row.employee.name}</span>{row.included === false && <Chip tone="muted">Excluded</Chip>}</div><p className="mt-0.5 text-[12px] text-muted-foreground">{row.employee.code}{row.employee.department?.name ? ` · ${row.employee.department.name}` : ''}</p>{row.note && editor?.id !== row.id && <p className="mt-1 text-[12px] text-muted-foreground">{row.note}</p>}</div>
              <span className="text-sm num"><span className="mr-2 text-[12px] text-muted-foreground sm:hidden">In</span>{shownTime(row.in_min)}</span><span className="text-sm num"><span className="mr-2 text-[12px] text-muted-foreground sm:hidden">Out</span>{shownTime(row.out_min)}</span>
              {editable && <Button size="sm" variant="ghost" className="justify-self-start sm:justify-self-end" disabled={busy || !!editor} aria-label={`Edit ${row.employee.name}`} onClick={() => startEdit(row)}><Pencil /> Edit</Button>}
            </div>
            {(row.in_min !== row.original_in_min || row.out_min !== row.original_out_min) && editor?.id !== row.id && <p className="mt-2 text-[12px] text-muted-foreground">Submitted times: {shownTime(row.original_in_min)} → {shownTime(row.original_out_min)} · edited by HR</p>}
            {editor?.id === row.id && <div className="mt-3 space-y-3 rounded-md border bg-muted/30 p-3" role="region" aria-label={`Edit attendance for ${row.employee.name}`}>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Punch in">{(id) => <Input id={id} type="time" value={editor.in} onChange={(event) => setEditor({ ...editor, in: event.target.value })} />}</Field><Field label="Punch out">{(id) => <Input id={id} type="time" value={editor.out} onChange={(event) => setEditor({ ...editor, out: event.target.value })} />}</Field></div>
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="accent-primary" checked={editor.nextDay} onChange={(event) => setEditor({ ...editor, nextDay: event.target.checked })} /> Punch out is on the next day</label>
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="accent-primary" checked={editor.included} onChange={(event) => setEditor({ ...editor, included: event.target.checked })} /> Include this employee when approving</label>
              {!editor.included && <p className="text-[12px] text-muted-foreground">Excluded rows stay in this sheet for the record. They will not create punches.</p>}
              <Field label="Employee review note">{(id) => <Input id={id} value={editor.note} onChange={(event) => setEditor({ ...editor, note: event.target.value })} placeholder="Reason for changing or excluding this row" maxLength={300} />}</Field>
              {!validTimes && <p className="text-[12px] text-destructive" role="alert">Enter both times. Punch out must be later than punch in; choose next day for an overnight shift.</p>}
              {staleEdit && <Notice tone="warning">Another reviewer changed this sheet. Refresh it before saving; your earlier values have not replaced their changes.</Notice>}
              <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" disabled={save.isPending} onClick={() => setEditor(null)}>Cancel row edit</Button><Button size="sm" loading={save.isPending} disabled={!validTimes || !!staleEdit || !editable} onClick={() => save.mutate({ ...editor, in_min: inputIn, out_min: inputOut })}>Save employee row</Button></div>
            </div>}
          </li>)}
        </ul>
      </div>
      {editor && <p className="text-[13px] text-muted-foreground">Save or cancel the employee row edit before approving the whole sheet.</p>}
      {editable && !count && <Notice tone="warning">Include at least one employee before approving this sheet. Excluded rows do not create attendance.</Notice>}
      {editable && <Field label="Sheet decision note (optional)">{(id) => <Input id={id} value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Note for the site and audit record" />}</Field>}
      {sheet.decision_note && !pending && <p className="text-[13px] text-muted-foreground"><span className="font-medium">Decision note: </span>{sheet.decision_note}</p>}
      {pending && !can('attendance.write') && <Notice>You can review the rows. Attendance approval permission is needed to edit or approve this sheet.</Notice>}
    </div>}
  </Dialog>;
}
