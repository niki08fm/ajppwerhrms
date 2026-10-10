import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ImageOff, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { addDays, DAY_STATUS_LABELS } from '@ajpwer/shared';
import { api, API_BASE, download, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { cn, dateSpan, hhmm, istTime, mins } from '@/utils';
import { PageHeader, PersonLink } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Segmented, Select } from '@/components/ui/form';
import { CorrectionDrawer } from '@/components/attendance/CorrectionDrawer';
import { DeptAvatar } from '@/components/attendance/DeptAvatar';
import { TONE, dayName, fullDate } from '@/components/attendance/dayVocab';

/**
 * One list for everything that waits on HR, with the decision beside it. The list keeps
 * about nine rows on screen and scrolls inside itself; after a decision the next item opens.
 * The server builds the list (backend/src/services/approvals.service.js) and the Today
 * screen counts the same list, so both always show the same numbers.
 */
const KINDS = {
  face: { label: 'Face checks', one: 'Face check', tone: 'warning', dot: TONE.warn },
  miss: { label: 'No punch-out', one: 'No punch-out', tone: 'muted', dot: 'var(--muted-foreground)' },
  short: { label: 'Short days', one: 'Short day', tone: 'destructive', dot: TONE.bad },
  transfer: { label: 'Transfers', one: 'Transfer request', tone: 'muted', dot: 'var(--primary)' },
  move: { label: 'Site changes', one: 'Site change', tone: 'muted', dot: 'var(--muted-foreground)' },
  leave: { label: 'Leave', one: 'Leave', tone: 'muted', dot: 'var(--muted-foreground)' },
};
const DAYS = [
  { value: 'all', label: 'All waiting' },
  { value: 'today', label: 'Today' },
  { value: 'yest', label: 'Yesterday' },
  { value: 'earlier', label: 'Earlier' },
];
const ROWS_ON_SCREEN = 9;

const first = (name) => (name ?? '').split(/\s+/)[0];
const scorePct = (s) => (s === null || s === undefined ? null : `${Math.round(s * 100)}%`);

export default function Approvals() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const kind = sp.get('kind') ?? 'all';
  const day = sp.get('day') ?? 'all';
  const site = sp.get('site') ?? '';
  const dept = sp.get('dept') ?? '';
  const q = sp.get('q') ?? '';
  const set = (patch) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setSp(next, { replace: true });
  };

  const list = useQuery({ queryKey: ['approvals'], queryFn: () => api.get('/approvals').then((r) => r.data), refetchInterval: 60_000 });
  // Decided here, hidden at once — the reload that follows confirms it.
  const [done, setDone] = useState(() => new Set());
  const [sel, setSel] = useState(null);
  const [drawer, setDrawer] = useState(null);

  const today = list.data?.today;
  const bucket = (d) => (d === today ? 'today' : d === addDays(today, -1) ? 'yest' : 'earlier');
  const open = useMemo(() => (list.data?.items ?? []).filter((it) => !done.has(it.id)), [list.data, done]);
  const needle = q.trim().toLowerCase();
  // Everything except the kind, so each chip says how many of that kind are within the other filters.
  const scoped = open.filter(
    (it) =>
      (day === 'all' || bucket(it.day) === day) &&
      (!site || it.site?.id === site || (it.kind === 'transfer' && it.detail.to_site?.id === site)) &&
      (!dept || it.employee?.department?.id === dept) &&
      (!needle || `${it.employee?.name ?? ''} ${it.employee?.code ?? ''}`.toLowerCase().includes(needle)),
  );
  const shown = scoped.filter((it) => kind === 'all' || it.kind === kind);
  const current = shown.find((it) => it.id === sel) ?? shown[0] ?? null;
  const filtered = kind !== 'all' || day !== 'all' || !!site || !!dept || !!needle;

  const reload = () =>
    api
      .get('/approvals', { fresh: 1 })
      .then((r) => qc.setQueryData(['approvals'], r.data))
      .catch(() => list.refetch());

  /** After a decision: hide it, open the next one in the list, and reload what's waiting. */
  const decided = (it, message) => {
    const i = shown.findIndex((x) => x.id === it.id);
    const rest = shown.filter((x) => x.id !== it.id);
    setSel(rest[Math.min(i, rest.length - 1)]?.id ?? null);
    setDone((d) => new Set(d).add(it.id));
    toast.success(message);
    // Refresh the server's waiting-list cache before the dashboard asks for its count.
    reload().then(() => qc.invalidateQueries({ queryKey: ['dashboard'] }));
    if (it.kind === 'transfer') qc.invalidateQueries({ queryKey: ['site-transfer-requests'] });
  };

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Review attendance, leave and site transfer requests."
        actions={
          can('reports.export') && (
            <Button variant="outline" onClick={() => download('/punch-attempts.csv', 'punch-attempts.csv').catch((e) => toast.error(errorMessage(e)))}>
              <Download /> Punch attempts (CSV)
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented label="When" value={day} onChange={(v) => set({ day: v === 'all' ? '' : v })} options={DAYS} />
          <Select aria-label="Site" className="w-auto" value={site} onChange={(e) => set({ site: e.target.value })}>
            <option value="">All sites</option>
            {list.data?.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Department" className="w-auto" value={dept} onChange={(e) => set({ dept: e.target.value })}>
            <option value="">All departments</option>
            {list.data?.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <div className="relative min-w-[200px] flex-1 sm:max-w-[300px]">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search name or code" placeholder="Search name or code" className="pl-8" value={q} onChange={(e) => set({ q: e.target.value })} />
          </div>
          {filtered && (
            <Button variant="ghost" size="sm" className="text-primary" onClick={() => set({ kind: '', day: '', site: '', dept: '', q: '' })}>
              Clear filters
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Kind">
          {[['all', 'Everything', 'var(--foreground)'], ...Object.entries(KINDS).map(([k, v]) => [k, v.label, v.dot])].map(([k, label, dot]) => {
            const n = scoped.filter((it) => k === 'all' || it.kind === k).length;
            const on = kind === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => set({ kind: k === 'all' ? '' : k })}
                className={cn('inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors', on ? 'border-primary bg-secondary' : 'bg-card hover:border-primary/40')}
              >
                <span className="size-2 rounded-full" style={{ background: dot }} />
                {label} <b className="font-semibold num">{n}</b>
              </button>
            );
          })}
        </div>

        {list.isLoading ? (
          <Card>
            <SkeletonRows rows={6} />
          </Card>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2.5 text-[13px] text-muted-foreground">
                <span>
                  <b className="text-foreground num">{shown.length}</b> waiting{filtered ? ` of ${open.length} (filtered)` : ''}
                </span>
                <span>Newest first</span>
              </div>
              <div className="max-h-[576px] overflow-y-auto" role="listbox" aria-label="Waiting on you">
                {shown.map((it) => (
                  <Row key={it.id} it={it} on={current?.id === it.id} today={today} onPick={() => setSel(it.id)} />
                ))}
                {!shown.length && (
                  <EmptyState
                    title={open.length ? 'Nothing matches these filters' : 'All clear'}
                    body={open.length ? 'Change or clear the filters to see the rest.' : `Nothing is waiting on you. Missing punch-outs and short days are checked for the last ${list.data.window_days} days.`}
                  />
                )}
              </div>
              {shown.length > ROWS_ON_SCREEN && (
                <div className="border-t bg-muted/30 px-4 py-2 text-center text-[12px] text-muted-foreground">Scroll the list for {shown.length - ROWS_ON_SCREEN} more</div>
              )}
            </Card>

            <Card className="lg:sticky lg:top-4">
              {current ? (
                <Detail key={current.id} it={current} today={today} can={can} onDecided={decided} onOpenDay={(employeeId, date) => setDrawer({ employeeId, date })} />
              ) : (
                <p className="px-6 py-16 text-center text-sm text-muted-foreground">Pick an item on the left to decide it.</p>
              )}
            </Card>
          </div>
        )}
      </div>

      {drawer && (
        <CorrectionDrawer
          employeeId={drawer.employeeId}
          date={drawer.date}
          open
          onOpenChange={(o) => {
            if (!o) {
              setDrawer(null);
              reload();
            }
          }}
        />
      )}
    </div>
  );
}

/** When it happened, in the words HR uses: "Today 09:32", "Yesterday", "Sat 26". */
function whenOf(it, today) {
  const d = dayName(it.day, today, addDays);
  if (it.kind === 'face' || it.kind === 'move') return `${d} ${istTime(it.at)}`;
  if (it.kind === 'leave' || it.kind === 'transfer') return `Asked ${d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : d}`;
  return d;
}

function summaryOf(it) {
  const x = it.detail;
  switch (it.kind) {
    case 'face':
      return x.exception_kind === 'FAILED_TRIES' ? `blocked after the try limit${x.crops ? ` · ${x.crops} tries` : ''}` : `${scorePct(x.score) ?? 'no match'}${x.crops ? ` after ${x.crops} tr${x.crops === 1 ? 'y' : 'ies'}` : ''}`;
    case 'miss':
      return `in ${hhmm(x.in_min)} · auto out 02:00`;
    case 'short':
      return `${mins(x.worked_min)} · ${mins(x.early_min)} short`;
    case 'move':
      return `to ${x.to_site?.name ?? '—'} · ${x.travel_min} min travel`;
    case 'transfer':
      return `to ${x.to_site?.name ?? '—'} · ${fullDate(x.departure_date)}`;
    case 'leave':
      return `${x.leave_name} · ${dateSpan(x.from_date, x.to_date)} · ${x.days} ${x.days === 1 ? 'day' : 'days'}`;
    default:
      return '';
  }
}

function Row({ it, on, today, onPick }) {
  const k = KINDS[it.kind];
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      onClick={onPick}
      className={cn('flex w-full items-start gap-3 border-b px-4 py-2.5 text-left transition-colors', on ? 'bg-secondary/60 shadow-[inset_3px_0_0_var(--primary)]' : 'hover:bg-accent/40')}
    >
      <DeptAvatar name={it.employee?.name} token={it.employee?.department?.colour} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{it.employee?.name ?? 'Unknown face'}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground num">{whenOf(it, today)}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <Chip tone={k.tone}>{k.one}</Chip>
          <span className="truncate text-[12px] text-muted-foreground">
            {it.site ? `${it.site.name} · ` : ''}
            {summaryOf(it)}
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── The decision panel ──────────────────────────────────────────────────────

function Detail({ it, today, can, onDecided, onOpenDay }) {
  const k = KINDS[it.kind];
  const e = it.employee;
  const allowed = it.kind === 'leave' ? can('leave.write') : can('attendance.write');
  return (
    <div>
      <div className="flex items-center gap-3 border-b px-5 py-4">
        <DeptAvatar name={e?.name} token={e?.department?.colour} size={44} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px]">{e ? <PersonLink id={e.id} name={e.name} code={e.code} /> : <span className="font-medium">Unknown face</span>}</div>
          <div className="text-[12px] text-muted-foreground">
            {[e?.department?.name, whenOf(it, today), it.site?.name].filter(Boolean).join(' · ')}
          </div>
        </div>
        <Chip tone={k.tone}>{k.one}</Chip>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        {it.kind === 'face' && <FaceDecision it={it} allowed={allowed} canReadPeople={can('people.read')} onDecided={onDecided} />}
        {(it.kind === 'miss' || it.kind === 'short') && <DayDecision it={it} allowed={allowed} onDecided={onDecided} onOpenDay={onOpenDay} />}
        {it.kind === 'move' && <MoveDecision it={it} allowed={allowed} onDecided={onDecided} />}
        {it.kind === 'transfer' && <TransferDecision it={it} allowed={allowed} onDecided={onDecided} />}
        {it.kind === 'leave' && <LeaveDecision it={it} allowed={allowed} onDecided={onDecided} />}
        {!allowed && <p className="text-[13px] text-muted-foreground">You can see this but not decide it. Someone with permission has to.</p>}
      </div>
    </div>
  );
}

function Facts({ items }) {
  return (
    <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-2 text-[14px]">
      {items.filter(Boolean).map(([key, v]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="m-0 font-medium">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function Note({ value, onChange, placeholder = 'Note for the record (optional)' }) {
  return <Input aria-label="Note for the record" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
}

const why = (note, fallback) => (note.trim().length >= 3 ? note.trim() : fallback);

function useDecide(fn, onSuccess) {
  return useMutation({ mutationFn: fn, onSuccess, onError: (err) => toast.error(errorMessage(err)) });
}

/** The camera could not confirm who punched. Approving writes the punch at the time of the attempt. */
function FaceDecision({ it, allowed, canReadPeople, onDecided }) {
  const x = it.detail;
  const people = useQuery({ queryKey: ['people', 'active-fx'], queryFn: () => api.get('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data), staleTime: 5 * 60_000 });
  const [who, setWho] = useState(x.claimed?.id ?? x.best_match?.id ?? '');
  const [dir, setDir] = useState(x.direction ?? '');
  const [note, setNote] = useState('');
  const at = istTime(x.occurred_at);
  const decide = useDecide(
    (decision) => api.post(`/face-exceptions/${x.exception_id}/decide`, decision === 'APPROVE' ? { decision, employee_id: who, ...(dir ? { direction: dir } : {}) } : { decision, reason: note.trim() }),
    (_r, decision) => onDecided(it, decision === 'APPROVE' ? `Punch written at ${at}, the time of the attempt.` : 'Rejected. Your note is the record of why.'),
  );
  const guess = x.best_match ? `Best guess is ${x.best_match.name}${x.score !== null ? ` at ${scorePct(x.score)}` : ''}.` : 'Nobody enrolled looks close.';
  const headline =
    x.exception_kind === 'FAILED_TRIES'
      ? `Blocked after the try limit at ${it.site?.name ?? 'the site'}. ${x.claimed ? `They typed ${x.claimed.code} (${x.claimed.name}) at the tablet.` : x.claimed_name ? `They typed “${x.claimed_name}” at the tablet.` : ''}`
      : `The camera at ${it.site?.name ?? 'the site'} could not confirm who this is. ${guess}`;
  const canReject = note.trim().length >= 8;
  return (
    <>
      <p className="m-0 text-[15px]">{headline}</p>
      {x.crops ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {Array.from({ length: x.crops }, (_, n) => (
            <figure key={n} className="m-0">
              <img src={`${API_BASE}/face-exceptions/${x.exception_id}/crops/${n}`} alt={`Face at the tablet, try ${n + 1}`} className="aspect-square w-full rounded-md border object-cover" />
              <figcaption className="mt-0.5 text-center text-[11px] text-muted-foreground">Try {n + 1}</figcaption>
            </figure>
          ))}
        </div>
      ) : x.has_snapshot ? (
        <img src={`${API_BASE}/face-exceptions/${x.exception_id}/snapshot`} alt="Gate snapshot" className="aspect-[4/3] w-full max-w-sm rounded-md border object-cover" />
      ) : (
        <div className="flex aspect-[4/3] w-full max-w-sm flex-col items-center justify-center gap-1 rounded-md border bg-muted text-[13px] text-muted-foreground">
          <ImageOff className="size-5" /> No photo (or past its 30 days)
        </div>
      )}
      <Facts
        items={[
          ['Best match', x.best_match ? `${x.best_match.name} · ${scorePct(x.score) ?? '—'}` : 'Nobody close'],
          x.exception_kind === 'FAILED_TRIES' && ['Typed at the tablet', x.claimed ? `${x.claimed.code} · ${x.claimed.name}` : (x.claimed_name ?? '—')],
          ['Distance from centre', x.distance_m !== null ? `${x.distance_m} m` : '—'],
          ['Reason', x.reason],
        ]}
      />
      <p className="m-0 text-[12px] text-muted-foreground">Only face data is kept for enrolled people, not photographs. Compare with the person or their ID.</p>
      {x.exception_kind === 'FAILED_TRIES' && canReadPeople && who && <Link to={`/people/${who}?tab=face`} className="text-[13px] text-primary hover:underline">Repeated face failures? Review face registration →</Link>}
      {allowed && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Who it actually was</span>
              <Select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Choose…</option>
                {people.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Punch</span>
              <Select value={dir} onChange={(e) => setDir(e.target.value)}>
                <option value="">In or out from their last punch</option>
                <option value="IN">In</option>
                <option value="OUT">Out</option>
              </Select>
            </label>
          </div>
          <Note value={note} onChange={setNote} placeholder="Note — needed to reject (at least 8 letters)" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" className="text-destructive" disabled={!canReject} title={canReject ? undefined : 'Write why in the note first'} loading={decide.isPending && decide.variables === 'REJECT'} onClick={() => decide.mutate('REJECT')}>
              <X /> Reject
            </Button>
            <Button disabled={!who} loading={decide.isPending && decide.variables === 'APPROVE'} onClick={() => decide.mutate('APPROVE')}>
              <Check /> Approve {dir === 'OUT' ? 'out' : dir === 'IN' ? 'in' : ''} at {at}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/** How a day counts, as a label and inside a sentence. */
const COUNTS_AS = { PRESENT: ['Full day', 'a full day'], HALF_DAY: ['Half day', 'a half day'], SHORT: ['Short day', 'a short day'], ABSENT: ['Absent', 'absent'] };

/**
 * A missing punch-out or a short day. Any choice saves a correction for the day, which
 * settles it; the real times can be entered in the day's correction drawer.
 */
function DayDecision({ it, allowed, onDecided, onOpenDay }) {
  const x = it.detail;
  const e = it.employee;
  const [note, setNote] = useState('');
  const date = fullDate(x.work_date);
  const counted = COUNTS_AS[x.status]?.[0] ?? DAY_STATUS_LABELS[x.status] ?? x.status;
  const countedWords = COUNTS_AS[x.status]?.[1] ?? counted.toLowerCase();
  const mark = useDecide(
    (status) =>
      api.post('/attendance/overrides', {
        mode: 'MARK',
        employee_id: e.id,
        work_date: x.work_date,
        status,
        reason_text: why(note, it.kind === 'miss' ? 'Missing punch-out checked in Approvals' : 'Short day checked in Approvals'),
      }),
    (_r, status) => onDecided(it, `${first(e.name)}, ${date}: ${status === 'PRESENT' ? 'full day' : status === 'HALF_DAY' ? 'half day' : 'absent'}. Saved to the log.`),
  );
  const btn = (status, label, variant = 'outline') => (
    <Button key={status} variant={variant} className={variant === 'outline' && status === 'ABSENT' ? 'text-destructive' : undefined} loading={mark.isPending && mark.variables === status} disabled={mark.isPending} onClick={() => mark.mutate(status)}>
      {label}
    </Button>
  );
  if (it.kind === 'miss') {
    return (
      <>
        <p className="m-0 text-[15px]">
          {first(e.name)} did not punch out on {date}. At 2 AM the system punched them out and counted a full day with no overtime.
        </p>
        <Facts
          items={[
            ['Punched in', `${hhmm(x.in_min)}${x.sites.length ? ` at ${x.sites.join(', ')}` : ''}`],
            ['Auto punch-out', '02:00 the next morning'],
            ['Counted now', 'Full day, no overtime'],
          ]}
        />
        {allowed && (
          <>
            <Note value={note} onChange={setNote} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenDay(e.id, x.work_date)}>
                Enter real out time
              </Button>
              {btn('ABSENT', 'Absent')}
              {btn('HALF_DAY', 'Half day')}
              {btn('PRESENT', 'Keep full day', 'default')}
            </div>
          </>
        )}
      </>
    );
  }
  const isHalf = x.status === 'HALF_DAY';
  return (
    <>
      <p className="m-0 text-[15px]">
        {first(e.name)} worked {mins(x.worked_min)} on {date} — {mins(x.early_min)} short of {mins(x.standard_min)}. By the rule this counts as {countedWords}.
      </p>
      <Facts
        items={[
          ['In / out', `${hhmm(x.in_min)} → ${hhmm(x.out_min)}${x.sites.length ? ` at ${x.sites.join(', ')}` : ''}`],
          ['Worked', mins(x.worked_min)],
          ['Short by', mins(x.early_min)],
          x.late_min > 0 && ['Came in late', mins(x.late_min)],
          ['Counted now', counted],
        ]}
      />
      {allowed && (
        <>
          <Note value={note} onChange={setNote} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenDay(e.id, x.work_date)}>
              Open the day
            </Button>
            {btn('ABSENT', 'Mark absent')}
            {isHalf ? btn('PRESENT', 'Count full day') : btn('HALF_DAY', 'Half day')}
            {isHalf ? btn('HALF_DAY', 'Keep half day', 'default') : btn('PRESENT', x.status === 'PRESENT' ? 'Keep full day' : 'Count full day', 'default')}
          </div>
        </>
      )}
    </>
  );
}

const MOVE_STATUS = { COUNTED: 'Punched in at the new site the same day', NOT_COUNTED: 'Did not punch in at the named site that day' };

function TransferDecision({ it, allowed, onDecided }) {
  const x = it.detail;
  const [note, setNote] = useState('');
  const decide = useDecide(
    (decision) => api.post(`/site-transfer-requests/${x.transfer_request_id}/decide`, { decision, ...(note.trim() ? { note: note.trim() } : {}) }),
    (_r, decision) => onDecided(it, `${first(it.employee?.name)}'s transfer to ${x.to_site?.name}: ${decision === 'APPROVED' ? 'approved' : 'rejected'}.`),
  );
  return (
    <>
      <Facts items={[
        ['From', x.from_site?.name],
        ['To', x.to_site?.name],
        ['Departure', fullDate(x.departure_date)],
        ['Reason', x.reason || '—'],
      ]} />
      <p className="m-0 text-[13px] text-muted-foreground">The employee punches out before leaving and punches in at the destination.</p>
      {allowed && (
        <>
          <Note value={note} onChange={setNote} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" className="text-destructive" loading={decide.isPending && decide.variables === 'REJECTED'} disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')}>
              Reject
            </Button>
            <Button loading={decide.isPending && decide.variables === 'APPROVED'} disabled={decide.isPending} onClick={() => decide.mutate('APPROVED')}>
              <Check /> Approve transfer
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/** Someone used Change site on a tablet. HR's travel figure is final. */
function MoveDecision({ it, allowed, onDecided }) {
  const x = it.detail;
  const [minutes, setMinutes] = useState(String(x.travel_min));
  const [note, setNote] = useState('');
  const save = useDecide(
    (min) => api.patch(`/site-changes/${x.site_change_id}`, { travel_min: min, reason: why(note, 'Checked in Approvals') }),
    (_r, min) => onDecided(it, `${first(it.employee?.name)}: ${min} min travel counted. The day is recomputed with it.`),
  );
  const n = Number(minutes);
  const valid = minutes !== '' && Number.isInteger(n) && n >= 0 && n <= 1440;
  return (
    <>
      <p className="m-0 text-[15px]">
        {first(it.employee?.name)} left {x.from_site?.name} at {istTime(x.left_at)} for {x.to_site?.name}
        {x.arrived_at ? ` and punched in there at ${istTime(x.arrived_at)}.` : ', but did not punch in there that day.'} Travel counts toward the day's hours once you accept it.
      </p>
      <Facts
        items={[
          ['Left', `${x.from_site?.name} · ${istTime(x.left_at)}`],
          ['Arrived', x.arrived_at ? `${x.to_site?.name} · ${istTime(x.arrived_at)}` : 'No punch-in there'],
          ['Travel counted now', `${x.travel_min} min`],
          ['Status', MOVE_STATUS[x.status] ?? x.status],
        ]}
      />
      {allowed && (
        <>
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Travel minutes</span>
              <Input type="number" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Note</span>
              <Note value={note} onChange={setNote} placeholder="e.g. bus takes 30 min (optional)" />
            </label>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" loading={save.isPending && save.variables === 0} disabled={save.isPending} onClick={() => save.mutate(0)}>
              No travel time
            </Button>
            <Button disabled={!valid || save.isPending} loading={save.isPending && save.variables === n} onClick={() => save.mutate(n)}>
              Accept {valid ? `${n} min` : 'travel'}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function LeaveDecision({ it, allowed, onDecided }) {
  const x = it.detail;
  const [note, setNote] = useState('');
  const decide = useDecide(
    (decision) => api.post(`/leave/${x.leave_id}/decide`, { decision, ...(note.trim() ? { note: note.trim() } : {}) }),
    (_r, decision) => onDecided(it, `${first(it.employee?.name)}'s ${x.leave_name}: ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`),
  );
  return (
    <>
      <p className="m-0 text-[15px]">
        {x.leave_name} for {dateSpan(x.from_date, x.to_date)} — {x.days} {x.days === 1 ? 'day' : 'days'}.
      </p>
      <Facts
        items={[
          ['Type', x.leave_name],
          ['Dates', dateSpan(x.from_date, x.to_date)],
          ['Days', String(x.days)],
          ['Reason given', x.reason || '—'],
        ]}
      />
      {allowed && (
        <>
          <Note value={note} onChange={setNote} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" className="text-destructive" loading={decide.isPending && decide.variables === 'REJECT'} disabled={decide.isPending} onClick={() => decide.mutate('REJECT')}>
              Reject
            </Button>
            <Button loading={decide.isPending && decide.variables === 'APPROVE'} disabled={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
              Approve
            </Button>
          </div>
        </>
      )}
    </>
  );
}
