import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CALENDAR_METHOD_INFO, describeOvertimeBase, formatINR, formatMinutes, GRATUITY_PART_YEAR_LABELS, MONTH_NAMES, OT_BASE_LABELS } from '@ajpwer/shared';
import { leaveTypeSummary } from '../../setup/LeaveRulesForm';
import { api, ApiError, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { useSession } from '@/context/SessionContext';
import { hhmm, longDate } from '@/utils';
import { KV, Mono } from '@/components/bits';
import { Chip, Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { FaceRegistrationCard } from '@/components/people/FaceRegistrationCard';

function describePolicy(kind, r) {
  if (!r) return '';
  switch (kind) {
    case 'ATTENDANCE':
      return r.half_day_upto_min === null
        ? `${formatMinutes(r.standard_min)} day, half day from ${formatMinutes(r.half_day_min)}, ${r.grace_min} min grace`
        : `${formatMinutes(r.standard_min)} day, half day up to ${formatMinutes(r.half_day_upto_min)}, ${r.grace_min} min grace`;
    case 'OVERTIME':
      return `${r.multiplier}× on ${describeOvertimeBase(r)}, ${r.counts_from === 'SHIFT_END' ? 'from shift end' : 'beyond the standard day'}, after ${r.after_min} min, rounded down to ${r.rounding_min} min${r.monthly_cap_min ? `, cap ${formatMinutes(r.monthly_cap_min)} a month` : ''}`;
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

/** A label and its value on one line, the way the rules card reads. */
function Line({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-dashed py-2 text-[14px] last:border-0">
      <span className="shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

const yearsSince = (dob, today) => {
  if (!dob || !today) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};

/**
 * Who the person is: personal details, identity and bank numbers, the face punch, and the
 * rules their pay group applies — left to right, the way HR reads a profile.
 */
export function OverviewTab({ e }) {
  const { data: lk } = useLookups();
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(false);
  const { can } = useSession();
  // The unmasked numbers are a separate read, with its own permission and log line.
  const fullId = useQuery({
    queryKey: ['employee-identity', e.id],
    queryFn: () => api.get(`/employees/${e.id}/identity`).then((r) => r.data),
    enabled: full,
    staleTime: 0,
    gcTime: 0,
  });
  const idn = full && fullId.data ? fullId.data : e.identity;
  const age = yearsSince(e.dob, lk?.today);
  const missing = (tone = 'warning') => <Chip tone={tone}>Missing</Chip>;
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="Personal"
            actions={
              !e.read_only && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )
            }
          />
          <CardBody>
            <KV
              cols={3}
              items={[
                ['Date of birth', e.dob ? `${longDate(e.dob)}${age !== null ? ` · ${age} yrs` : ''}` : '—'],
                ['Gender', e.gender ? e.gender.charAt(0) + e.gender.slice(1).toLowerCase() : '—'],
                ['Blood group', e.blood_group || '—'],
                ['Phone', e.phone || '—'],
                ['Email', e.email || '—'],
                ['Address', e.address || '—'],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Identity and bank"
            description={full && fullId.data ? 'Full numbers shown. This view is in the log.' : 'Numbers only — no documents are stored. Every view is logged.'}
            actions={
              can('pii.read') && (
                <Button variant="ghost" size="sm" loading={fullId.isFetching} onClick={() => setFull(!full)}>
                  {full ? 'Hide' : 'Show full'}
                </Button>
              )
            }
          />
          <CardBody>
            <KV
              cols={3}
              items={[
                ['Aadhaar', idn.aadhaar_masked ? <Mono>{idn.aadhaar_masked}</Mono> : missing()],
                ['PAN', idn.pan ? <Mono>{idn.pan}</Mono> : missing()],
                ['UAN', idn.uan ? <Mono>{idn.uan}</Mono> : missing()],
                ['ESI number', idn.esi_number ? <Mono>{idn.esi_number}</Mono> : '—'],
                [
                  'Bank',
                  idn.has_bank ? (
                    `${idn.bank_name ? `${idn.bank_name} · ` : ''}${idn.bank_account}`
                  ) : (
                    <Chip tone="destructive">No bank account — blocks payroll</Chip>
                  ),
                ],
                ['IFSC', idn.bank_ifsc ? <Mono>{idn.bank_ifsc}</Mono> : '—'],
              ]}
            />
          </CardBody>
        </Card>
        <FaceRegistrationCard e={e} />
      </div>
      <PayGroupRulesCard e={e} />
      {editing && <EditDialog e={e} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function PayGroupRulesCard({ e }) {
  const r = e.rules;
  const policy = (kind) => r.policies.find((x) => x.kind === kind);
  const ruleLine = (kind, label) => {
    const p = policy(kind);
    return (
      <Line key={kind} label={label ?? p?.label ?? kind}>
        {p?.id ? describePolicy(kind, p.rules) : <span className="text-warning-foreground dark:text-warning">None attached</span>}
      </Line>
    );
  };
  return (
    <Card>
      <CardHeader title={`Rules from ${r.pay_group.name}`} description="These policies apply independently of the employee’s salary structure." />
      <CardBody className="pt-1">
        <Line label="Calendar">{CALENDAR_METHOD_INFO[r.calendar_method]?.label ?? r.calendar_method}</Line>
        <Line label="Weekly off">{r.weekly_off.length ? r.weekly_off.map((d) => d.charAt(0) + d.slice(1).toLowerCase()).join(', ') : 'None'}</Line>
        <Line label="Shift">
          {r.shift.name} {hhmm(r.shift.start_min)}–{hhmm(r.shift.end_min)}
        </Line>
        {ruleLine('ATTENDANCE', 'Attendance')}
        {ruleLine('OVERTIME', 'Overtime')}
        {ruleLine('HOLIDAY_WORK', 'Holiday / week-off work')}
        {ruleLine('LEAVE', 'Leave')}
        {ruleLine('GRATUITY', 'Gratuity')}
        {r.policies.filter((p) => !['ATTENDANCE', 'OVERTIME', 'HOLIDAY_WORK', 'LEAVE', 'GRATUITY'].includes(p.kind)).map((p) => ruleLine(p.kind))}
        <Link to="/setup/pay-groups" className="mt-2 inline-block text-[13px] text-primary hover:underline">
          Open {r.pay_group.name} pay group →
        </Link>
      </CardBody>
    </Card>
  );
}

export function EditDialog({ e, onClose }) {
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
      const core = {
        name: f.name,
        phone: f.phone,
        email: f.email || null,
        dob: f.dob || null,
        address: f.address || null,
        blood_group: f.blood_group || null,
        designation: f.designation,
        department_id: f.department_id,
        pay_group_id: f.pay_group_id,
      };
      const before = {
        ...e,
        department_id: e.department.id,
        pay_group_id: e.pay_group.id,
      };
      const changedCore = Object.fromEntries(Object.entries(core).filter(([key, value]) => value !== (before[key] ?? (typeof value === 'string' ? '' : null))));
      return api.patch(`/employees/${e.id}`, {
        ...changedCore,
        ...(Object.keys(identity).length ? { identity } : {}),
        updated_at: e.updated_at,
      });
    },
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['people'] });
      for (const key of ['timeline', 'employee-pay', 'employee-tax', 'emp-attendance', 'emp-leave']) qc.invalidateQueries({ queryKey: [key, e.id] });
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
              Moving {e.name.split(' ')[0]} to <strong>{newGroup.name}</strong> changes their calendar (
              {CALENDAR_METHOD_INFO[e.pay_group.calendar_method]?.label} → {CALENDAR_METHOD_INFO[newGroup.calendar_method]?.label}), weekly off, shift and group
              policies. Their salary amount and explicitly selected salary structure stay unchanged. The pay group on the last day of a month applies to the
              whole month.
            </Notice>
          </div>
        )}
        <Field label="Address" className="sm:col-span-3">
          {(id) => <Textarea id={id} value={f.address} onChange={(ev) => set('address', ev.target.value)} />}
        </Field>
        <Field label="PAN" error={errors.pan} hint={e.identity.has_pan ? 'On file' : 'Missing'}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              className="font-mono uppercase"
              value={f.pan}
              onChange={(ev) => set('pan', ev.target.value)}
              placeholder="ABCDE1234F"
            />
          )}
        </Field>
        <Field label="Aadhaar" error={errors.aadhaar} hint={e.identity.aadhaar_masked ?? 'Missing'}>
          {(id, inv) => (
            <Input
              id={id}
              aria-invalid={inv}
              className="font-mono"
              value={f.aadhaar}
              onChange={(ev) => set('aadhaar', ev.target.value)}
              placeholder="12 digits"
            />
          )}
        </Field>
        <Field label="UAN" error={errors.uan}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.uan} onChange={(ev) => set('uan', ev.target.value)} />}
        </Field>
        <Field label="Bank account" error={errors.bank_account} hint={e.identity.has_bank ? `On file ${e.identity.bank_account}` : 'Missing'}>
          {(id, inv) => (
            <Input id={id} aria-invalid={inv} className="font-mono" value={f.bank_account} onChange={(ev) => set('bank_account', ev.target.value)} />
          )}
        </Field>
        <Field label="IFSC" error={errors.bank_ifsc}>
          {(id, inv) => (
            <Input id={id} aria-invalid={inv} className="font-mono uppercase" value={f.bank_ifsc} onChange={(ev) => set('bank_ifsc', ev.target.value)} />
          )}
        </Field>
        <Field label="Bank name">{(id) => <Input id={id} value={f.bank_name} onChange={(ev) => set('bank_name', ev.target.value)} />}</Field>
        <Field label="ESI number" error={errors.esi_number}>
          {(id, inv) => <Input id={id} aria-invalid={inv} className="font-mono" value={f.esi_number} onChange={(ev) => set('esi_number', ev.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
