import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowRightLeft, Check, Search } from 'lucide-react';
import { api, errorMessage } from '@/services/api';
import { useDebounced } from '@/hooks';
import { istTime } from '@/utils';
import { fullDate } from '@/components/attendance/dayVocab';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { Chip, EmptyState, ErrorState, Notice, SkeletonRows } from '@/components/states';

const STATUS = {
  PENDING: ['Pending', 'warning'],
  APPROVED: ['Approved', 'success'],
  REJECTED: ['Rejected', 'destructive'],
  CANCELLED: ['Cancelled', 'muted'],
};

export function TabletTransfers({ site, today, online }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const requests = useQuery({ queryKey: ['tablet-transfers', site.id], queryFn: () => api.get('/tablet/transfers').then((r) => r.data), enabled: online, refetchInterval: 60_000 });
  const close = (next) => { setOpen(next); if (next) setSent(false); };
  const submitted = () => {
    setOpen(false);
    setSent(true);
    qc.invalidateQueries({ queryKey: ['tablet-transfers'] });
  };
  return (
    <div className="space-y-4">
      {sent && <Notice tone="success" icon={<Check className="size-4 shrink-0" />}>Transfer request sent to HR for approval.</Notice>}
      <Card className="overflow-hidden">
        <CardHeader title="Transfer requests" description="Requests to move people from this site." actions={<Button disabled={!online} onClick={() => close(true)}><ArrowRightLeft /> Request transfer</Button>} />
        {requests.isLoading ? <SkeletonRows rows={5} cols={4} /> : requests.isError ? <ErrorState error={requests.error} onRetry={() => requests.refetch()} /> : !requests.data?.length ? <EmptyState title="No transfer requests" body="Request a transfer before someone leaves for another site." icon={<ArrowRightLeft className="size-6" />} /> : (
          <ul className="divide-y" aria-label="Site transfer requests">
            {requests.data.map((r) => {
              const [label, tone] = STATUS[r.status] ?? [r.status, 'muted'];
              return <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{r.employee.name} <span className="ml-1 text-[12px] font-normal text-muted-foreground num">{r.employee.code}</span></p><p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px]">{r.from_site.name}<ArrowRight className="size-3 text-muted-foreground" aria-hidden="true" />{r.to_site.name}</p><p className="mt-1 text-[12px] text-muted-foreground">{fullDate(r.departure_date)}</p>{r.reason && <p className="mt-2 text-[13px] text-muted-foreground">{r.reason}</p>}{r.decision_note && <p className="mt-1 text-[12px] text-muted-foreground">HR: {r.decision_note}</p>}</div>
                <div className="flex shrink-0 flex-col items-end gap-1.5"><Chip tone={tone}>{label}</Chip><span className="text-[11px] text-muted-foreground">Requested {istTime(r.requested_at, true)}</span></div>
              </li>;
            })}
          </ul>
        )}
      </Card>
      {open && <TransferForm site={site} today={today} online={online} onClose={() => setOpen(false)} onSubmitted={submitted} />}
    </div>
  );
}

function TransferForm({ site, today, online, onClose, onSubmitted }) {
  const [search, setSearch] = useState('');
  const [employee, setEmployee] = useState(null);
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');
  const q = useDebounced(search.trim(), 250);
  const sites = useQuery({ queryKey: ['tablet-sites', site.id], queryFn: () => api.get('/tablet/sites').then((r) => r.data), enabled: online });
  const people = useQuery({ queryKey: ['tablet-transfer-employees', site.id, q], queryFn: () => api.get('/tablet/employees', { for: 'transfer', q }).then((r) => r.data), enabled: online && !employee && q.length >= 2 });
  const submit = useMutation({ mutationFn: () => api.post('/tablet/transfers', { employee_code: employee.code, to_site_id: destination, departure_date: date, reason: reason.trim() }), onSuccess: onSubmitted });
  const start = (e) => { e.preventDefault(); if (employee && destination && date && reason.trim().length >= 3 && online) submit.mutate(); };

  return (
    <Dialog open onOpenChange={(next) => !next && !submit.isPending && onClose()} title="Request transfer" description={`From ${site.name}. HR approval is required.`} footer={<><Button variant="outline" disabled={submit.isPending} onClick={onClose}>Cancel</Button><Button type="submit" form="site-transfer-form" disabled={!online || !employee || !destination || !date || reason.trim().length < 3 || sites.isError} loading={submit.isPending}>Send request</Button></>}>
      <form id="site-transfer-form" onSubmit={start} className="space-y-4">
        {!online && <Notice tone="warning">Connect to send the request.</Notice>}
        {submit.isError && <Notice tone="destructive">{errorMessage(submit.error)}</Notice>}
        <Field label="Employee" required>{(id) => <div>
          <div className="relative"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden="true" /><Input id={id} aria-label="Employee search" value={search} onChange={(e) => { setSearch(e.target.value); setEmployee(null); submit.reset(); }} placeholder="Search name or employee ID" className="pl-9" autoComplete="off" disabled={submit.isPending} /></div>
          {employee ? <p className="mt-2 flex items-center gap-1.5 text-[12px] text-primary"><Check className="size-3.5" />{employee.name} · {employee.code}</p> : q.length < 2 ? <p className="mt-1.5 text-[12px] text-muted-foreground">Type at least two characters. Only people currently at this site appear.</p> : people.isError ? <ErrorState error={people.error} onRetry={() => people.refetch()} compact /> : people.isLoading ? <p className="py-3 text-[13px] text-muted-foreground" role="status">Searching…</p> : people.data?.length ? <ul className="mt-2 max-h-44 divide-y overflow-y-auto rounded-md border" aria-label="Employee matches">{people.data.map((p) => <li key={p.code}><button type="button" disabled={submit.isPending} onClick={() => { setEmployee(p); setSearch(p.name); }} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><span><span className="block text-sm font-medium">{p.name}</span>{p.designation && <span className="block text-[12px] text-muted-foreground">{p.designation}</span>}</span><span className="text-[12px] text-muted-foreground num">{p.code}</span></button></li>)}</ul> : <p className="mt-2 text-[13px] text-muted-foreground">No matching person is currently punched in at this site.</p>}
        </div>}</Field>
        <Field label="Destination site" required>{(id) => <Select id={id} value={destination} onChange={(e) => { setDestination(e.target.value); submit.reset(); }} required disabled={sites.isLoading || sites.isError || submit.isPending}><option value="">{sites.isLoading ? 'Loading sites…' : 'Choose a site'}</option>{sites.data?.filter((s) => s.id !== site.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        {sites.isError && <ErrorState error={sites.error} onRetry={() => sites.refetch()} compact />}
        {sites.data?.length === 0 && <p className="text-[13px] text-muted-foreground">No other active site is available.</p>}
        <Field label="Departure date" required>{(id) => <Input id={id} type="date" value={date} min={today} onChange={(e) => { setDate(e.target.value); submit.reset(); }} required disabled={submit.isPending} />}</Field>
        <Field label="Reason" required>{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required placeholder="Why is this person moving to another site?" disabled={submit.isPending} />}</Field>
        <p className="border-t pt-3 text-[12px] text-muted-foreground">Attendance is recorded separately. The employee must punch out here and punch in at the destination.</p>
      </form>
    </Dialog>
  );
}
