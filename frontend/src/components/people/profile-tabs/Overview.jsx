import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { CALENDAR_METHOD_INFO, formatINR, formatMinutes, GRATUITY_PART_YEAR_LABELS, MONTH_NAMES, OT_BASE_LABELS } from '@ajpwer/shared';
import { leaveTypeSummary } from '../../setup/LeaveRulesForm';
import { api, ApiError, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { hhmm, longDate } from '@/utils';
import { KV, Mono } from '@/components/bits';
import { Chip, Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

function describePolicy(kind, r) {
  if (!r) return '';
  switch (kind) {
    case 'ATTENDANCE':
      return r.half_day_upto_min === null
        ? `${formatMinutes(r.standard_min)} day, half day from ${formatMinutes(r.half_day_min)}, ${r.grace_min} min grace`
        : `${formatMinutes(r.standard_min)} day, half day up to ${formatMinutes(r.half_day_upto_min)}, ${r.grace_min} min grace`;
    case 'OVERTIME':
      return `${r.multiplier}× on ${OT_BASE_LABELS[r.base]}, ${r.counts_from === 'SHIFT_END' ? 'from shift end' : 'beyond the standard day'}, after ${r.after_min} min, rounded down to ${r.rounding_min} min${r.monthly_cap_min ? `, cap ${formatMinutes(r.monthly_cap_min)} a month` : ''}`;
    case 'WEEKOFF_PAY':
    case 'HOLIDAY_PAY':
      return `${r.paid ? 'Paid' : 'Unpaid'}${r.paid && r.sandwich ? ', sandwich rule on' : ''}`;
    case 'HOLIDAY_WORK': {
      const h = r.holiday;
      const w = r.weekly_off;
      return `Holiday ${h.mode === 'PAY' ? `${h.rate_pct}%` : 'nothing extra'} · weekly off ${w.mode === 'PAY' ? `${w.rate_pct}%` : 'nothing extra'}`;
    }
    case 'LEAVE': {
      const a = r.types.find((t) => t.auto_apply && t.active);
      const others = r.types.filter((t) => t.active && !t.auto_apply).map((t) => t.code);
      return `Leave year from ${MONTH_NAMES[(r.year_start_month ?? 1) - 1]}. ${a ? `Absences are paid from ${a.name} (${leaveTypeSummary(a)}).` : 'Absences are loss of pay.'}${others.length ? ` HR records ${others.join(', ')}.` : ''}`;
    }
    case 'GRATUITY':
      return `From ${r.min_years} years: last ${OT_BASE_LABELS[r.base].toLowerCase()} × ${r.days_per_year} × years ÷ ${r.divisor} (${GRATUITY_PART_YEAR_LABELS[r.part_year].toLowerCase()}), ${r.max_amount === null ? 'no ceiling' : `up to ${formatINR(r.max_amount)}`}`;
  }
  return '';
}

export function OverviewTab({ e }) {
  const [editing, setEditing] = useState(false);
  const r = e.rules;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="flex flex-col gap-4 xl:col-span-2">
        <Card>
          <CardHeader
            title="Personal details"
            actions={
              !e.read_only && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
              )
            }
          />

          <CardBody>
            <KV
              cols={3}
              items={[
                ['Phone', e.phone],
                ['Email', e.email],
                ['Date of birth', longDate(e.dob)],
                ['Gender', e.gender.charAt(0) + e.gender.slice(1).toLowerCase()],
                ['Blood group', e.blood_group],
                ['Address', e.address],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Identity and bank" description="PAN, Aadhaar and bank details are encrypted at rest. Every read of this panel is logged." />
          <CardBody>
            <KV
              cols={3}
              items={[
                ['PAN', e.identity.pan ? <Mono>{e.identity.pan}</Mono> : <Chip tone="warning">Missing</Chip>],
                ['Aadhaar', e.identity.aadhaar_masked ? <Mono>{e.identity.aadhaar_masked}</Mono> : <Chip tone="warning">Missing</Chip>],
                ['UAN', e.identity.uan ? <Mono>{e.identity.uan}</Mono> : <Chip tone="warning">Missing</Chip>],
                ['ESI number', e.identity.esi_number ? <Mono>{e.identity.esi_number}</Mono> : '—'],
                ['Bank account', e.identity.has_bank ? <Mono>{e.identity.bank_account}</Mono> : <Chip tone="destructive">No bank account — blocks payroll</Chip>],
                ['IFSC', e.identity.bank_ifsc ? <Mono>{e.identity.bank_ifsc}</Mono> : '—'],
                ['Bank', e.identity.bank_name],
                ['Face', e.face.enrolled ? `Enrolled ${longDate(String(e.face.enrolled_at).slice(0, 10))}` : e.face.needs_registration ? <Chip tone="warning">Register again (new face system)</Chip> : <Chip tone="warning">Not enrolled</Chip>],
              ]}
            />
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Rules that apply" description={`All read from the pay group ${r.pay_group.name}. None of it is set on the person.`} />
        <CardBody className="flex flex-col gap-3 text-[14px]">
          <div>
            <div className="text-[13px] text-muted-foreground">Calendar method</div>
            <div>
              {CALENDAR_METHOD_INFO[r.calendar_method]?.label} — {CALENDAR_METHOD_INFO[r.calendar_method]?.explain}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[13px] text-muted-foreground">Weekly off</div>
              <div>{r.weekly_off.join(', ') || 'None'}</div>
            </div>
            <div>
              <div className="text-[13px] text-muted-foreground">Shift</div>
              <div>
                {r.shift.name} ({hhmm(r.shift.start_min)}–{hhmm(r.shift.end_min)})
              </div>
            </div>
          </div>
          <div>
            <div className="text-[13px] text-muted-foreground">Salary structure</div>
            <div>{r.structure ? r.structure.name : '—'}</div>
          </div>
          <div className="border-t pt-3">
            <div className="mb-1 text-[13px] text-muted-foreground">Policies in force today</div>
            <ul className="flex flex-col gap-2">
              {r.policies.map((p) => (
                <li key={p.kind}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{p.label}</span>
                    {p.id ? (
                      <Chip>
                        v{p.version} · from {p.valid_from}
                      </Chip>
                    ) : (
                      <Chip tone="warning">None attached</Chip>
                    )}
                  </div>
                  <div className="text-[13px] text-muted-foreground">{p.id ? `${p.name}: ${describePolicy(p.kind, p.rules)}` : p.missing}</div>
                </li>
              ))}
            </ul>
          </div>
          <p className="border-t pt-3 text-[13px] text-muted-foreground">
            To change any of this for {e.name.split(' ')[0]}, change the pay group's rules under{' '}
            <Link to="/setup/pay-groups" className="text-primary hover:underline">
              Setup → Pay groups
            </Link>
            , or move them to another group. There is no per-person overtime or leave setting.
          </p>
        </CardBody>
      </Card>
      {editing && <EditDialog e={e} onClose={() => setEditing(false)} />}
    </div>
  );
}

function EditDialog({ e, onClose }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const [f, setF] = useState({
    name: e.name,
    phone: e.phone,
    email: e.email ?? '',
    dob: e.dob ?? '',
    address: e.address ?? '',
    blood_group: e.blood_group ?? '',
    designation: e.designation,
    department_id: e.department.id,
    pay_group_id: e.pay_group.id,
    pan: '',
    aadhaar: '',
    uan: e.identity.uan ?? '',
    esi_number: e.identity.esi_number ?? '',
    bank_account: '',
    bank_ifsc: e.identity.bank_ifsc ?? '',
    bank_name: e.identity.bank_name ?? '',
  });
  const [errors, setErrors] = useState({});
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const groupChanged = f.pay_group_id !== e.pay_group.id;
  const newGroup = lk?.pay_groups.find((g) => g.id === f.pay_group_id);

  const save = useMutation({
    mutationFn: () => {
      const identity = {};
      if (f.pan) identity.pan = f.pan.toUpperCase();
      if (f.aadhaar) identity.aadhaar = f.aadhaar.replace(/\s/g, '');
      if (f.uan !== (e.identity.uan ?? '')) identity.uan = f.uan || null;
      if (f.esi_number !== (e.identity.esi_number ?? '')) identity.esi_number = f.esi_number || null;
      if (f.bank_account) identity.bank_account = f.bank_account;
      if (f.bank_ifsc !== (e.identity.bank_ifsc ?? '')) identity.bank_ifsc = f.bank_ifsc.toUpperCase() || null;
      if (f.bank_name !== (e.identity.bank_name ?? '')) identity.bank_name = f.bank_name || null;
      return api.patch(`/employees/${e.id}`, {
        name: f.name,
        phone: f.phone,
        email: f.email || null,
        dob: f.dob || null,
        address: f.address || null,
        blood_group: f.blood_group || null,
        designation: f.designation,
        department_id: f.department_id,
        pay_group_id: f.pay_group_id,
        ...(Object.keys(identity).length ? { identity } : {}),
        updated_at: e.updated_at,
      });
    },
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['people'] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.field) setErrors({ [err.field.replace('identity.', '')]: err.message });
      toast.error(errorMessage(err));
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title={`Edit ${e.name}`}
      description="Leave PAN, Aadhaar and account number blank to keep what is on file."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {groupChanged ? 'Move to new pay group and save' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['name', 'Full name'],
          ['phone', 'Phone'],
          ['email', 'Email'],
          ['designation', 'Designation'],
          ['blood_group', 'Blood group'],
        ].map(([k, l]) => (
          <Field key={k} label={l} error={errors[k]}>
            {(id, inv) => <Input id={id} aria-invalid={inv} value={f[k]} onChange={(ev) => set(k, ev.target.value)} />}
          </Field>
        ))}
        <Field label="Date of birth" error={errors.dob}>
          {(id) => <Input id={id} type="date" value={f.dob} onChange={(ev) => set('dob', ev.target.value)} />}
        </Field>
        <Field label="Department">
          {(id) => (
            <Select id={id} value={f.department_id} onChange={(ev) => set('department_id', ev.target.value)}>
              {lk?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Pay group" className="sm:col-span-2">
          {(id) => (
            <Select id={id} value={f.pay_group_id} onChange={(ev) => set('pay_group_id', ev.target.value)}>
              {lk?.pay_groups.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {groupChanged && newGroup && (
          <div className="sm:col-span-3">
            <Notice tone="warning">
              Moving {e.name.split(' ')[0]} to <strong>{newGroup.name}</strong> changes their calendar ({CALENDAR_METHOD_INFO[e.pay_group.calendar_method]?.label} →{' '}
              {CALENDAR_METHOD_INFO[newGroup.calendar_method]?.label}), weekly off, shift, salary structure and every policy at once. The pay group on the last day of a month applies to the whole
              month.
            </Notice>
          </div>
        )}
        <Field label="Address" className="sm:col-span-3">
          {(id) => <Textarea id={id} value={f.address} onChange={(ev) => set('address', ev.target.value)} />}
        </Field>
        <Field label="PAN" error={errors.pan} hint={e.identity.has_pan ? 'On file' : 'Missing'}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono uppercase" value={f.pan} onChange={(ev) => set('pan', ev.target.value)} placeholder="ABCDE1234F" />}
        </Field>
        <Field label="Aadhaar" error={errors.aadhaar} hint={e.identity.aadhaar_masked ?? 'Missing'}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.aadhaar} onChange={(ev) => set('aadhaar', ev.target.value)} placeholder="12 digits" />}
        </Field>
        <Field label="UAN" error={errors.uan}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.uan} onChange={(ev) => set('uan', ev.target.value)} />}
        </Field>
        <Field label="Bank account" error={errors.bank_account} hint={e.identity.has_bank ? `On file ${e.identity.bank_account}` : 'Missing'}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.bank_account} onChange={(ev) => set('bank_account', ev.target.value)} />}
        </Field>
        <Field label="IFSC" error={errors.bank_ifsc}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono uppercase" value={f.bank_ifsc} onChange={(ev) => set('bank_ifsc', ev.target.value)} />}
        </Field>
        <Field label="Bank name">{(id) => <Input id={id} value={f.bank_name} onChange={(ev) => set('bank_name', ev.target.value)} />}</Field>
        <Field label="ESI number" error={errors.esi_number}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.esi_number} onChange={(ev) => set('esi_number', ev.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
