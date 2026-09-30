import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { toPaise } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { SalaryPreviewPanel } from './SalaryPreview';

/** For people already on the payroll before this system. New hires go through offers. */
export function NewEmployeeDialog({ open, onOpenChange }) {
  const { data: lk } = useLookups();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: '',
    gender: 'MALE',
    phone: '',
    department_id: '',
    designation: '',
    pay_group_id: '',
    joined_on: '',
    status: 'ONBOARDING',
    mode: 'GROSS',
    amount: '',
    pt_state: 'Andhra Pradesh',
    tax_regime_code: 'NEW',
  });
  const [chosen, setChosen] = useState();
  const [errors, setErrors] = useState({});
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const create = useMutation({
    mutationFn: () =>
      api.post('/employees', {
        name: f.name,
        gender: f.gender,
        phone: f.phone,
        department_id: f.department_id,
        designation: f.designation,
        pay_group_id: f.pay_group_id,
        joined_on: f.joined_on,
        status: f.status,
        pt_state: f.pt_state,
        tax_regime_code: f.tax_regime_code,
        salary: { mode: f.mode, amount: toPaise(f.amount), ...(chosen ? { chosen_gross: chosen } : {}) },
      }),
    onSuccess: (r) => {
      toast.success(`Added as ${r.data.code}`);
      qc.invalidateQueries({ queryKey: ['people'] });
      onOpenChange(false);
      nav(`/people/${r.data.id}?tab=onboarding`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.field) setErrors({ [e.field]: e.message });
      toast.error(errorMessage(e));
    },
  });

  const amount = toPaise(f.amount);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Add an existing employee"
      description="For people already on the payroll. New hires should go through Offers so the offer letter is recorded."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={() => create.mutate()} disabled={!f.name || !f.department_id || !f.pay_group_id || !f.joined_on || !amount}>
            Add employee
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid grid-cols-2 content-start gap-3">
          <Field label="Full name" required className="col-span-2" error={errors.name}>
            {(id, inv) => <Input id={id} aria-invalid={inv} value={f.name} onChange={(e) => set('name', e.target.value)} />}
          </Field>
          <Field label="Gender">
            {(id) => (
              <Select id={id} value={f.gender} onChange={(e) => set('gender', e.target.value)}>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
              </Select>
            )}
          </Field>
          <Field label="Phone" required error={errors.phone}>
            {(id, inv) => <Input id={id} aria-invalid={inv} value={f.phone} onChange={(e) => set('phone', e.target.value)} />}
          </Field>
          <Field label="Department" required>
            {(id) => (
              <Select id={id} value={f.department_id} onChange={(e) => set('department_id', e.target.value)}>
                <option value="">Choose…</option>
                {lk?.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Designation" required>
            {(id) => <Input id={id} value={f.designation} onChange={(e) => set('designation', e.target.value)} />}
          </Field>
          <Field label="Pay group" required hint="Calendar, weekly off, shift, structure and every policy come from here.">
            {(id) => (
              <Select id={id} value={f.pay_group_id} onChange={(e) => set('pay_group_id', e.target.value)}>
                <option value="">Choose…</option>
                {lk?.pay_groups.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Joined on" required error={errors.joined_on}>
            {(id) => <Input id={id} type="date" value={f.joined_on} onChange={(e) => set('joined_on', e.target.value)} />}
          </Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} value={f.status} onChange={(e) => set('status', e.target.value)}>
                <option value="ONBOARDING">Onboarding (checklist first)</option>
                <option value="ACTIVE">Active now</option>
              </Select>
            )}
          </Field>
          <Field label="Professional tax state" hint="Where they work — not the company's state.">
            {(id) => (
              <Select id={id} value={f.pt_state} onChange={(e) => set('pt_state', e.target.value)}>
                {lk?.pt_states.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Pay agreed as">
            {(id) => (
              <Select id={id} value={f.mode} onChange={(e) => set('mode', e.target.value)}>
                <option value="GROSS">Monthly gross</option>
                <option value="CTC">Annual CTC</option>
              </Select>
            )}
          </Field>
          <Field label={f.mode === 'CTC' ? 'Annual CTC' : 'Monthly gross'} required error={errors.amount}>
            {(id, inv) => <MoneyInput id={id} aria-invalid={inv} value={f.amount} onChange={(e) => set('amount', e.target.value)} />}
          </Field>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <h4 className="mb-2 font-display font-semibold">Preview</h4>
          {f.pay_group_id ? (
            <SalaryPreviewPanel
              args={{ mode: f.mode, amount, pay_group_id: f.pay_group_id, gender: f.gender, pt_state: f.pt_state, date: f.joined_on || undefined }}
              chosen={chosen}
              onChoose={setChosen}
            />
          ) : (
            <p className="text-[13px] text-muted-foreground">Pick a pay group to see the breakdown.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
