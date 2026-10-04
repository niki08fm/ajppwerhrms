import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FilePlus2, Pencil, Printer, Send, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { EXIT_REASONS } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { exitName, longDate, monthLabel } from '@/utils';
import { KV, Money, Mono } from '@/components/bits';
import { Chip, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ChoiceCards, Field, Input, Select, Textarea } from '@/components/ui/form';
import { Checkbox, Dialog } from '@/components/ui/overlay';
import { fnfStatus, SettlementPanel } from '../../../pages/people/SettlementStatement';

export const useExit = (id) => useQuery({ queryKey: ['exit', id], queryFn: () => api.get(`/employees/${id}/exit`).then((r) => r.data) });

function refresh(qc, id) {
  for (const key of [['exit', id], ['employee', id], ['exits'], ['settlement', id], ['letters', id], ['hold', id]]) qc.invalidateQueries({ queryKey: key });
}

/** A numbered step of the exit, so the order is plain: details, checklist, F&F, letters. */
function Step({ n, done, title, description, actions, children }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full font-sans text-[12px] font-semibold num ${done ? 'bg-success text-white' : 'bg-muted text-muted-foreground'}`}>
              {done ? <CheckCircle2 className="size-4" /> : n}
            </span>
            {title}
          </span>
        }
        description={description}
        actions={actions}
      />
      {children}
    </Card>
  );
}

export function ExitTab({ e }) {
  const q = useExit(e.id);
  const [dialog, setDialog] = useState(null);
  if (q.isLoading) return <SkeletonBlock className="h-64" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const x = q.data;
  const leaving = x.status === 'NOTICE' || x.status === 'EXITED';
  const first = e.name.split(' ')[0];
  if (!leaving) {
    return (
      <>
        <Card className="flex flex-col items-start gap-3 p-6">
          <h3 className="font-semibold">No exit recorded</h3>
          <p className="m-0 max-w-2xl text-[14px] text-muted-foreground">
            Recording the last working day starts the formalities checklist (dues, recoveries, advance balance, held salary) and the F&amp;F statement, where you can add earnings or deductions. {first} works until that day. You can change or cancel it, or rejoin later.
          </p>
          {x.status === 'ACTIVE' ? (
            <Button variant="outline" className="text-destructive" onClick={() => setDialog('record')}>
              Record exit for {first}
            </Button>
          ) : (
            <p className="m-0 text-[13px] text-muted-foreground">Only an active employee's exit can be recorded.</p>
          )}
        </Card>
        {dialog === 'record' && <ExitDialog e={e} x={x} onClose={() => setDialog(null)} />}
      </>
    );
  }
  const required = x.checklist.filter((t) => t.required);
  const ticked = required.filter((t) => t.done_at).length;
  const s = x.settlement;
  const processed = s?.state === 'INCLUDED' || s?.state === 'PAID';
  return (
    <div className="flex flex-col gap-4">
      <Step
        n={1}
        done
        title={`${x.status === 'EXITED' ? 'Exited' : 'Leaving'} — ${exitName(x.exit_reason)}`}
        description={x.status === 'NOTICE' ? (x.locked ?? 'Change the kind of exit or the last day, or withdraw it, until the F&F is processed.') : x.locked}
        actions={
          x.status === 'NOTICE' && (
            <span className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!!x.locked} onClick={() => setDialog('change')}>
                <Pencil /> Change
              </Button>
              <Button size="sm" variant="outline" disabled={!!x.locked} onClick={() => setDialog('withdraw')}>
                <Undo2 /> Withdraw
              </Button>
            </span>
          )
        }
      >
        <CardBody>
          <KV
            cols={3}
            items={[
              ['Exit recorded on', longDate(x.resigned_on)],
              ['Last working day', longDate(x.last_day)],
              ['F&F', fnfStatus(s)],
            ]}
          />
          {x.status === 'EXITED' && <p className="mt-3 text-[13px] text-muted-foreground">The biometric has been deleted. Employment and payroll records are kept, and the profile is read-only.</p>}
        </CardBody>
      </Step>

      <Step n={2} done={ticked === required.length} title="Exit checklist" description={`${ticked} of ${required.length} required tasks done. The F&F is processed, and the relieving letter issued, once they are all ticked.`}>
        <Checklist e={e} x={x} />
      </Step>

      <Step
        n={3}
        done={processed}
        title="Full and final settlement"
        description={
          s?.state === 'PAID'
            ? `${fnfStatus(s)}. It is frozen.`
            : s?.state === 'INCLUDED'
              ? `${fnfStatus(s)}${s.paid_separately ? ` on ${longDate(s.paid_separately.paid_on)}, reference ${s.paid_separately.payment_ref} — recorded in that payroll, not in its bank file` : ' — paid in its bank file'}. Take it back to change it.`
              : 'Worked out live. Check it, then process it into a payroll month — paid in that month’s bank file, or recorded as paid separately.'
        }
        actions={
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => window.open(`/print/settlement/${e.id}`, '_blank')}>
              <Printer /> Print
            </Button>
            {x.status === 'NOTICE' && s?.state === 'INCLUDED' && <TakeBack e={e} />}
            {x.status === 'NOTICE' && s?.state !== 'INCLUDED' && (
              <Button size="sm" disabled={ticked < required.length} title={ticked < required.length ? 'Tick the required checklist tasks first' : undefined} onClick={() => setDialog('process')}>
                <Send /> Process F&F
              </Button>
            )}
          </span>
        }
      >
        <CardBody>
          <SettlementPanel employeeId={e.id} />
        </CardBody>
      </Step>

      <ExitLetters e={e} x={x} />

      {dialog === 'change' && <ExitDialog e={e} x={x} change onClose={() => setDialog(null)} />}
      {dialog === 'withdraw' && <WithdrawDialog e={e} onClose={() => setDialog(null)} />}
      {dialog === 'process' && <ProcessDialog e={e} x={x} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Checklist({ e, x }) {
  const qc = useQueryClient();
  const tick = useMutation({
    mutationFn: ({ code, done }) => api.post(`/employees/${e.id}/exit/tasks/${code}`, { done }),
    onSuccess: () => refresh(qc, e.id),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <ul className="divide-y text-[14px]">
      {x.checklist.map((t) => (
        <li key={t.code} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
          <Checkbox checked={!!t.done_at} disabled={x.status !== 'NOTICE' || !!x.locked || tick.isPending} onCheckedChange={(v) => tick.mutate({ code: t.code, done: v })} label={t.label} />
          <span className="flex-1">{t.label}</span>
          {!t.required && <Chip tone="muted">Optional</Chip>}
          <span className="text-[13px] text-muted-foreground">{t.done_at ? `Done by ${t.done_by} on ${longDate(String(t.done_at).slice(0, 10))}` : t.required ? 'Open' : ''}</span>
        </li>
      ))}
    </ul>
  );
}

function TakeBack({ e }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.del(`/employees/${e.id}/exit/process`),
    onSuccess: () => {
      toast.success('The F&F is taken back. It is worked out live again.');
      refresh(qc, e.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Button size="sm" variant="outline" loading={m.isPending} onClick={() => m.mutate()}>
      <Undo2 /> Take back
    </Button>
  );
}

/** Process the F&F into a payroll month: paid in its bank file, or recorded there as paid separately. */
function ProcessDialog({ e, x, onClose }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const open = x.process_months.filter((m) => m.open);
  const [f, setF] = useState({ period_ym: open[0]?.ym ?? '', how: 'PAYROLL', paid_on: lk?.today ?? '', payment_ref: '' });
  const net = x.settlement?.net ?? 0;
  const save = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/exit/process`, { period_ym: f.period_ym, ...(f.how === 'SEPARATE' ? { paid_separately: { paid_on: f.paid_on, payment_ref: f.payment_ref } } : {}) }),
    onSuccess: () => {
      toast.success(f.how === 'SEPARATE' ? `F&F recorded in ${monthLabel(f.period_ym)} payroll as paid separately.` : `F&F processed: it goes out with ${monthLabel(f.period_ym)} payroll.`);
      refresh(qc, e.id);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const month = f.period_ym ? monthLabel(f.period_ym) : 'that month';
  const ok = f.period_ym && (f.how === 'PAYROLL' || (f.paid_on && f.payment_ref.trim().length >= 2));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Process ${e.name}'s F&F`}
      description={
        <>
          {net < 0 ? 'Recoverable from the employee: ' : 'Net payable: '}
          <Money value={Math.abs(net)} paise />. It is paid once — in one month's payroll only.
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>
            Process F&F
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Payroll month">
          {(id) => (
            <Select id={id} value={f.period_ym} onChange={(ev) => setF({ ...f, period_ym: ev.target.value })}>
              {x.process_months.map((m) => (
                <option key={m.ym} value={m.ym} disabled={!m.open}>
                  {monthLabel(m.ym)}
                  {m.open ? '' : ` — ${m.reason.replace(`${monthLabel(m.ym)} `, '')}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {open.length === 0 && <Notice tone="warning">None of these months can take it now. Reopen step 2 of a month's payroll first.</Notice>}
        <ChoiceCards
          name="how"
          value={f.how}
          onChange={(how) => setF({ ...f, how })}
          options={[
            { value: 'PAYROLL', label: 'Pay it with the payroll', description: `Goes out in ${month}'s bank file with the salaries.` },
            { value: 'SEPARATE', label: 'Paid separately', description: `By cheque, cash or a separate transfer. It is recorded in ${month}'s payroll — register, PF, ESI — but never goes in a bank file.`, disabled: net < 0 },
          ]}
        />
        {f.how === 'SEPARATE' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Paid on">{(id) => <Input id={id} type="date" value={f.paid_on} onChange={(ev) => setF({ ...f, paid_on: ev.target.value })} />}</Field>
            <Field label="Reference" hint="Cheque or transfer number">
              {(id) => <Input id={id} value={f.payment_ref} onChange={(ev) => setF({ ...f, payment_ref: ev.target.value })} />}
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ExitLetters({ e, x }) {
  const qc = useQueryClient();
  const letters = useQuery({ queryKey: ['letters', e.id], queryFn: () => api.get(`/employees/${e.id}/letters`).then((r) => r.data) });
  const issue = useMutation({
    mutationFn: (kind) => api.post(`/employees/${e.id}/letters`, { kind, issue: true }),
    onSuccess: (r) => {
      toast.success('Letter issued.');
      refresh(qc, e.id);
      window.open(`/print/letter/${e.id}/${r.data.id}`, '_blank');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const open = x.checklist.filter((t) => t.required && !t.done_at);
  const exitLetters = (letters.data ?? []).filter((l) => l.kind === 'RELIEVING' || l.kind === 'EXPERIENCE');
  return (
    <Step
      n={4}
      done={exitLetters.some((l) => l.kind === 'RELIEVING')}
      title="Exit letters"
      description={open.length ? `The relieving letter can be issued once the checklist is done (${open.length} required ${open.length === 1 ? 'task' : 'tasks'} open).` : 'Each letter freezes what it states on the day it is issued.'}
      actions={
        <span className="flex gap-2">
          <Button size="sm" variant="outline" loading={issue.isPending && issue.variables === 'RELIEVING'} disabled={open.length > 0} onClick={() => issue.mutate('RELIEVING')}>
            <FilePlus2 /> Relieving letter
          </Button>
          <Button size="sm" variant="outline" loading={issue.isPending && issue.variables === 'EXPERIENCE'} onClick={() => issue.mutate('EXPERIENCE')}>
            <FilePlus2 /> Experience letter
          </Button>
        </span>
      }
    >
      {exitLetters.length > 0 && (
        <ul className="divide-y text-[14px]">
          {exitLetters.map((l) => (
            <li key={l.id} className="flex items-center justify-between px-5 py-2.5">
              <span>
                {l.kind === 'RELIEVING' ? 'Relieving letter' : 'Experience letter'} <Mono className="text-muted-foreground">{l.ref}</Mono>
              </span>
              <Link to={`/print/letter/${e.id}/${l.id}`} target="_blank" className="inline-flex items-center gap-1 text-primary hover:underline">
                <Printer className="size-3.5" /> Print
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}

/** Record an exit, or change one already recorded: its kind and last working day. */
export function ExitDialog({ e, x, change, onClose }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({
    exit_reason: change ? x.exit_reason : 'RESIGNATION',
    resigned_on: change ? x.resigned_on : today,
    last_day: change ? x.last_day : '',
    note: '',
  });
  const body = { resigned_on: f.resigned_on, last_day: f.last_day, exit_reason: f.exit_reason, ...(f.note ? { note: f.note } : {}) };
  const save = useMutation({
    mutationFn: () => (change ? api.patch(`/employees/${e.id}/exit`, body) : api.post(`/employees/${e.id}/resign`, body)),
    onSuccess: () => {
      toast.success(change ? 'Exit changed. The F&F has been worked out again.' : `${e.name}'s exit is recorded. The F&F is now worked out live.`);
      refresh(qc, e.id);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={change ? `Change ${e.name}'s exit` : `Record ${e.name}'s exit`}
      description="No notice period: they work until the last day."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.last_day || !f.resigned_on} onClick={() => save.mutate()}>
            {change ? 'Save changes' : 'Record the exit'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind of exit" className="sm:col-span-2">
          {(id) => (
            <Select id={id} value={f.exit_reason} onChange={(ev) => setF({ ...f, exit_reason: ev.target.value })}>
              {EXIT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {exitName(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={f.exit_reason === 'RESIGNATION' ? 'Resigned on' : f.exit_reason === 'DEATH' ? 'Date of death' : 'Exit recorded on'}>
          {(id) => <Input id={id} type="date" value={f.resigned_on} onChange={(ev) => setF({ ...f, resigned_on: ev.target.value })} />}
        </Field>
        <Field label="Last working day" required>
          {(id) => <Input id={id} type="date" value={f.last_day} min={f.resigned_on} onChange={(ev) => setF({ ...f, last_day: ev.target.value })} />}
        </Field>
        <Field label="Note" className="sm:col-span-2">
          {(id) => <Textarea id={id} value={f.note} onChange={(ev) => setF({ ...f, note: ev.target.value })} />}
        </Field>
        {f.exit_reason === 'DEATH' && (
          <div className="sm:col-span-2">
            <Notice tone="info">Gratuity is paid whatever the years of service on death (Payment of Gratuity Act).</Notice>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function WithdrawDialog({ e, onClose }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/exit/withdraw`, { reason }),
    onSuccess: () => {
      toast.success(`${e.name}'s exit is withdrawn. They are active again.`);
      refresh(qc, e.id);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Withdraw ${e.name}'s exit`}
      description="They become active again. The open F&F and the ticked checklist are set aside; the audit log keeps both."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={reason.trim().length < 8} onClick={() => save.mutate()}>
            Withdraw the exit
          </Button>
        </>
      }
    >
      <Field label="Why" hint="At least eight characters, e.g. “Resignation taken back after a counter-offer”">
        {(id) => <Textarea id={id} value={reason} onChange={(ev) => setReason(ev.target.value)} />}
      </Field>
    </Dialog>
  );
}
