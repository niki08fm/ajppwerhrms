import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { EXIT_REASONS } from '@ajpwer/shared';
import { api, errorMessage } from '@/lib/api';
import { longDate } from '@/lib/utils';
import { KV } from '@/components/bits';
import { Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import type { Employee } from '../types';

export function ExitTab({ e }: { e: Employee }) {
  const [open, setOpen] = useState(false);
  if (e.status === 'NOTICE' || e.status === 'EXITED') {
    return (
      <Card>
        <CardHeader title={e.status === 'EXITED' ? 'Exited' : 'On notice'} actions={<Link to={`/exits/${e.id}`} className="text-[13px] text-primary hover:underline">Open settlement</Link>} />
        <CardBody>
          <KV
            cols={4}
            items={[
              ['Resigned on', longDate(e.resigned_on)],
              ['Last day', longDate(e.last_day)],
              ['Notice', `${e.notice_served_days ?? '—'} of ${e.notice_days} days served`],
              ['Reason', e.exit_reason?.toLowerCase().replace(/_/g, ' ')],
            ]}
          />
          {e.status === 'EXITED' && <p className="mt-3 text-[13px] text-muted-foreground">The biometric has been deleted. Employment and payroll records are kept, and the profile is read-only.</p>}
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Exit" description="Record a resignation to put this person on notice. Their full and final settlement is computed live from then on." />
      <CardBody>
        <Button variant="outline" onClick={() => setOpen(true)} disabled={e.status !== 'ACTIVE'}>
          <LogOut /> Record a resignation
        </Button>
        {e.status !== 'ACTIVE' && <p className="mt-2 text-[12px] text-muted-foreground">Only an active employee can be put on notice.</p>}
      </CardBody>
      {open && <ResignDialog e={e} onClose={() => setOpen(false)} />}
    </Card>
  );
}

export function ResignDialog({ e, onClose }: { e: Pick<Employee, 'id' | 'name' | 'notice_days'>; onClose: () => void }) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ resigned_on: today, last_day: '', exit_reason: 'RESIGNATION', notice_served_days: '', note: '' });
  const served = f.last_day ? Math.min(e.notice_days, Math.max(0, Math.round((Date.parse(f.last_day) - Date.parse(f.resigned_on)) / 86_400_000) + 1)) : null;
  const save = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/resign`, { resigned_on: f.resigned_on, last_day: f.last_day, exit_reason: f.exit_reason, ...(f.notice_served_days ? { notice_served_days: Number(f.notice_served_days) } : {}), ...(f.note ? { note: f.note } : {}) }),
    onSuccess: () => {
      toast.success(`${e.name} is on notice. Their settlement is now computed live.`);
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['exits'] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Record ${e.name}'s resignation`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.last_day} onClick={() => save.mutate()}>
            Put on notice
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Resigned on">{(id) => <Input id={id} type="date" value={f.resigned_on} onChange={(ev) => setF({ ...f, resigned_on: ev.target.value })} />}</Field>
        <Field label="Last working day" required>
          {(id) => <Input id={id} type="date" value={f.last_day} min={f.resigned_on} onChange={(ev) => setF({ ...f, last_day: ev.target.value })} />}
        </Field>
        <Field label="Reason">
          {(id) => (
            <Select id={id} value={f.exit_reason} onChange={(ev) => setF({ ...f, exit_reason: ev.target.value })}>
              {EXIT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Notice served (days)" hint={served !== null ? `Defaults to ${served} of ${e.notice_days}` : `Notice period ${e.notice_days} days`}>
          {(id) => <Input id={id} type="number" min={0} value={f.notice_served_days} placeholder={served !== null ? String(served) : ''} onChange={(ev) => setF({ ...f, notice_served_days: ev.target.value })} />}
        </Field>
        <Field label="Note" className="sm:col-span-2">
          {(id) => <Textarea id={id} value={f.note} onChange={(ev) => setF({ ...f, note: ev.target.value })} />}
        </Field>
        {served !== null && served < e.notice_days && !f.notice_served_days && (
          <div className="sm:col-span-2">
            <Notice tone="warning">A shortfall of {e.notice_days - served} days will be recovered at monthly gross ÷ 30 per day in the settlement.</Notice>
          </div>
        )}
      </div>
    </Dialog>
  );
}
