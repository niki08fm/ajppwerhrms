import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatINR, PT_STATES } from '@ajpwer/shared';
import { api, ApiError, errorMessage } from '@/services/api';
import { Chip, Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';
import { SalaryAssignment } from './SalaryAssignment';

/** Saving a step refreshes everything the profile shows about the person. */
function useRefresh(e) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['employee', e.id] });
    qc.invalidateQueries({ queryKey: ['people'] });
    for (const key of ['employee-pay', 'employee-tax', 'letters', 'timeline']) qc.invalidateQueries({ queryKey: [key, e.id] });
  };
}

/** PATCH the profile with only what changed; a step that completes is ticked by the server. */
function useProfileSave(e, onSaved) {
  const refresh = useRefresh(e);
  const [errors, setErrors] = useState({});
  const save = useMutation({
    mutationFn: (body) => api.patch(`/employees/${e.id}`, { ...body, updated_at: e.updated_at }),
    onSuccess: () => {
      setErrors({});
      toast.success('Saved');
      refresh();
      onSaved();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.field) setErrors({ [err.field.replace('identity.', '')]: err.message });
      toast.error(errorMessage(err));
    },
  });
  return { save, errors };
}

function Actions({ children, onSkip }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-4">
      {onSkip && (
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
      )}
      {children}
    </div>
  );
}

const changed = (values, before) => Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== (before[k] ?? '')));

export function PersonalStep({ e, onSaved, onSkip, disabled }) {
  const before = { name: e.name, phone: e.phone, email: e.email ?? '', dob: e.dob ?? '', blood_group: e.blood_group ?? '', address: e.address ?? '' };
  const [f, setF] = useState(before);
  const { save, errors } = useProfileSave(e, onSaved);
  const set = (k) => (ev) => setF((x) => ({ ...x, [k]: ev.target.value }));
  const submit = () => {
    const body = changed(f, before);
    for (const k of ['email', 'dob', 'blood_group', 'address']) if (k in body) body[k] = body[k] || null;
    if (!Object.keys(body).length) return onSaved();
    save.mutate(body);
  };
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" required error={errors.name}>{(id, inv) => <Input id={id} aria-invalid={inv} value={f.name} disabled={disabled} onChange={set('name')} />}</Field>
        <Field label="Phone" required error={errors.phone}>{(id, inv) => <Input id={id} aria-invalid={inv} value={f.phone} disabled={disabled} onChange={set('phone')} />}</Field>
        <Field label="Email" error={errors.email}>{(id, inv) => <Input id={id} type="email" aria-invalid={inv} value={f.email} disabled={disabled} onChange={set('email')} />}</Field>
        <Field label="Date of birth" required error={errors.dob}>{(id, inv) => <Input id={id} type="date" aria-invalid={inv} value={f.dob} disabled={disabled} onChange={set('dob')} />}</Field>
        <Field label="Blood group" error={errors.blood_group}>{(id, inv) => <Input id={id} aria-invalid={inv} value={f.blood_group} disabled={disabled} onChange={set('blood_group')} />}</Field>
        <Field label="Address" required className="sm:col-span-2" error={errors.address}>{(id, inv) => <Textarea id={id} aria-invalid={inv} value={f.address} disabled={disabled} onChange={set('address')} />}</Field>
      </div>
      <Actions onSkip={onSkip}>
        <Button loading={save.isPending} disabled={disabled || !f.name.trim() || !f.phone.trim()} onClick={submit}>
          Save and next
        </Button>
      </Actions>
    </>
  );
}

export function IdentityStep({ e, onSaved, onSkip, disabled }) {
  const idn = e.identity;
  const [f, setF] = useState({ pan: '', aadhaar: '', uan: idn.uan ?? '', esi_number: idn.esi_number ?? '' });
  const { save, errors } = useProfileSave(e, onSaved);
  const set = (k) => (ev) => setF((x) => ({ ...x, [k]: ev.target.value }));
  const submit = () => {
    const identity = {};
    if (f.pan) identity.pan = f.pan.toUpperCase().trim();
    if (f.aadhaar) identity.aadhaar = f.aadhaar.replace(/\s/g, '');
    if (f.uan !== (idn.uan ?? '')) identity.uan = f.uan || null;
    if (f.esi_number !== (idn.esi_number ?? '')) identity.esi_number = f.esi_number || null;
    if (!Object.keys(identity).length) return onSaved();
    save.mutate({ identity });
  };
  return (
    <>
      <p className="mb-3 text-[13px] text-muted-foreground">PAN and Aadhaar on file are not shown in full. Leave them blank to keep what is on file.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="PAN" required error={errors.pan} hint={idn.has_pan ? `On file: ${idn.pan}` : 'Missing'}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono uppercase" placeholder="ABCDE1234F" value={f.pan} disabled={disabled} onChange={set('pan')} />}
        </Field>
        <Field label="Aadhaar" required error={errors.aadhaar} hint={idn.aadhaar_masked ? `On file: ${idn.aadhaar_masked}` : 'Missing'}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" placeholder="12 digits" value={f.aadhaar} disabled={disabled} onChange={set('aadhaar')} />}
        </Field>
        <Field label="UAN" error={errors.uan} hint="PF account number, 12 digits">
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.uan} disabled={disabled} onChange={set('uan')} />}
        </Field>
        <Field label="ESI number" error={errors.esi_number}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.esi_number} disabled={disabled} onChange={set('esi_number')} />}
        </Field>
      </div>
      <Actions onSkip={onSkip}>
        <Button loading={save.isPending} disabled={disabled} onClick={submit}>
          Save and next
        </Button>
      </Actions>
    </>
  );
}

export function BankStep({ e, onSaved, onSkip, disabled }) {
  const idn = e.identity;
  const [f, setF] = useState({ bank_account: '', bank_ifsc: idn.bank_ifsc ?? '', bank_name: idn.bank_name ?? '' });
  const { save, errors } = useProfileSave(e, onSaved);
  const set = (k) => (ev) => setF((x) => ({ ...x, [k]: ev.target.value }));
  const submit = () => {
    const identity = {};
    if (f.bank_account) identity.bank_account = f.bank_account.replace(/\s/g, '');
    if (f.bank_ifsc !== (idn.bank_ifsc ?? '')) identity.bank_ifsc = f.bank_ifsc.toUpperCase().trim() || null;
    if (f.bank_name !== (idn.bank_name ?? '')) identity.bank_name = f.bank_name || null;
    if (!Object.keys(identity).length) return onSaved();
    save.mutate({ identity });
  };
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Account number" required error={errors.bank_account} hint={idn.has_bank ? `On file: ${idn.bank_account}. Leave blank to keep it.` : 'Missing'}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.bank_account} disabled={disabled} onChange={set('bank_account')} />}
        </Field>
        <Field label="IFSC" required error={errors.bank_ifsc}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono uppercase" placeholder="SBIN0001234" value={f.bank_ifsc} disabled={disabled} onChange={set('bank_ifsc')} />}
        </Field>
        <Field label="Bank name" className="sm:col-span-2" error={errors.bank_name}>
          {(id, inv) => <Input id={id} aria-invalid={inv} value={f.bank_name} disabled={disabled} onChange={set('bank_name')} />}
        </Field>
      </div>
      <Actions onSkip={onSkip}>
        <Button loading={save.isPending} disabled={disabled} onClick={submit}>
          Save and next
        </Button>
      </Actions>
    </>
  );
}

/** Mark a checklist step done or not done. The server refuses a data step whose data is missing. */
function useTick(e, onSaved) {
  const refresh = useRefresh(e);
  return useMutation({
    mutationFn: ({ code, done }) => api.post(`/employees/${e.id}/onboarding/${code}`, { done }),
    onSuccess: (_r, { done }) => {
      refresh();
      if (done) onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function PayStep({ e, item, onSaved, onSkip, disabled }) {
  const tick = useTick(e, onSaved);
  const s = e.salary;
  return (
    <>
      <SalaryAssignment e={e} salary={s} />
      <div className="mt-3 text-[14px]">
        {s ? (
          <p className="m-0">
            Salary: <strong className="num">{formatINR(s.mode === 'CTC' ? s.amount : s.monthly_gross, { paise: true })}</strong> {s.mode === 'CTC' ? 'a year (CTC)' : 'a month (gross)'}, from {String(s.valid_from).slice(0, 10)}. To change the amount, use Salary and statutory.
          </p>
        ) : (
          <Notice tone="warning">No salary on record. Add one under Salary and statutory before activating.</Notice>
        )}
      </div>
      <Actions onSkip={onSkip}>
        {item.done_at ? (
          <Button onClick={onSaved}>Next</Button>
        ) : (
          <Button loading={tick.isPending} disabled={disabled || !s} onClick={() => tick.mutate({ code: 'PAY', done: true })}>
            Confirm pay and next
          </Button>
        )}
      </Actions>
    </>
  );
}

export function StatutoryStep({ e, onSaved, onSkip, disabled }) {
  const st = e.statutory ?? { pf_enabled: true, eps_enabled: true, esi_enabled: false, pt_state: PT_STATES[0], tax_regime_code: 'NEW' };
  const before = { pf_enabled: st.pf_enabled, eps_enabled: st.eps_enabled ?? true, esi_enabled: st.esi_enabled, pt_state: st.pt_state, tax_regime_code: st.tax_regime_code };
  const [f, setF] = useState(before);
  const refresh = useRefresh(e);
  const save = useMutation({
    // An empty change still records the step: HR has reviewed the statutory setup.
    mutationFn: () => api.patch(`/employees/${e.id}/statutory`, Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== before[k]))),
    onSuccess: () => {
      toast.success('Saved');
      refresh();
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provident fund" hint="12% of PF wages, up to the ceiling">
          {(id) => <div className="flex h-9 items-center"><Switch id={id} checked={f.pf_enabled} disabled={disabled} onCheckedChange={(v) => set('pf_enabled', v)} label="PF" /></div>}
        </Field>
        <Field label="Pension (EPS)" hint="Off for someone not eligible, e.g. over 58">
          {(id) => <div className="flex h-9 items-center"><Switch id={id} checked={f.eps_enabled} disabled={disabled || !f.pf_enabled} onCheckedChange={(v) => set('eps_enabled', v)} label="EPS" /></div>}
        </Field>
        <Field label="ESI" hint="Applies only within the ESI wage ceiling">
          {(id) => <div className="flex h-9 items-center"><Switch id={id} checked={f.esi_enabled} disabled={disabled} onCheckedChange={(v) => set('esi_enabled', v)} label="ESI" /></div>}
        </Field>
        <Field label="Professional tax state">
          {(id) => (
            <Select id={id} value={f.pt_state} disabled={disabled} onChange={(ev) => set('pt_state', ev.target.value)}>
              {[...new Set([f.pt_state, ...PT_STATES])].map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Tax regime">
          {(id) => (
            <Select id={id} value={f.tax_regime_code} disabled={disabled} onChange={(ev) => set('tax_regime_code', ev.target.value)}>
              <option value="NEW">New regime</option>
              <option value="OLD">Old regime</option>
            </Select>
          )}
        </Field>
      </div>
      <Actions onSkip={onSkip}>
        <Button loading={save.isPending} disabled={disabled} onClick={() => save.mutate()}>
          Save and next
        </Button>
      </Actions>
    </>
  );
}

export function JoiningLetterStep({ e, onSaved, onSkip, disabled }) {
  const refresh = useRefresh(e);
  const letters = useQuery({ queryKey: ['letters', e.id], queryFn: () => api.get(`/employees/${e.id}/letters`).then((r) => r.data) });
  const issued = (letters.data ?? []).find((l) => l.kind === 'JOINING' && l.issued_on);
  const open = (id) => window.open(`/print/letter/${e.id}/${id}`, '_blank');
  const issue = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/letters`, { kind: 'JOINING', issue: true }),
    onSuccess: (r) => {
      toast.success('Joining letter issued. Its figures are frozen as of today.');
      refresh();
      open(r.data.id);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <>
      <p className="m-0 text-[14px] text-muted-foreground">The joining letter states the designation, joining date and salary on record today, and reprints exactly as issued.</p>
      {issued && (
        <div className="mt-3 flex items-center gap-2 text-[14px]">
          <Chip tone="success">Issued {issued.issued_on}</Chip>
          <Button size="sm" variant="outline" onClick={() => open(issued.id)}>
            Open letter
          </Button>
        </div>
      )}
      <Actions onSkip={onSkip}>
        {issued ? (
          <Button onClick={onSaved}>Next</Button>
        ) : (
          <Button loading={issue.isPending} disabled={disabled || letters.isLoading} onClick={() => issue.mutate()}>
            Issue joining letter
          </Button>
        )}
      </Actions>
    </>
  );
}

const TICK_TEXT = {
  SAFETY: 'Safety induction given: site rules, PPE and emergency procedures.',
  MEDICAL: 'Medical fitness certificate received.',
  ORIENTATION: 'Site orientation done: the site, the team and the tablet for punching.',
};

export function TickStep({ e, item, onSaved, onSkip, disabled }) {
  const tick = useTick(e, onSaved);
  return (
    <>
      <p className="m-0 text-[14px] text-muted-foreground">{TICK_TEXT[item.code] ?? item.label}</p>
      <Actions onSkip={item.done_at ? undefined : onSkip}>
        {item.done_at ? (
          <>
            <Button variant="outline" loading={tick.isPending} disabled={disabled} onClick={() => tick.mutate({ code: item.code, done: false })}>
              Mark not done
            </Button>
            <Button onClick={onSaved}>Next</Button>
          </>
        ) : (
          <Button loading={tick.isPending} disabled={disabled} onClick={() => tick.mutate({ code: item.code, done: true })}>
            Mark done and next
          </Button>
        )}
      </Actions>
    </>
  );
}
