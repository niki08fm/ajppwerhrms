import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { SalaryPreviewPanel, useSalaryPreview } from './SalaryPreview';
import { agreement, SalaryAmountFields, StatutoryChoice } from './SalaryEntry';

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
    structure_id: '',
    joined_on: '',
    status: 'ONBOARDING',
    mode: 'GROSS',
    amount: '',
    pf_enabled: true,
    esi_enabled: true,
    pt_state: 'Andhra Pradesh',
    tax_regime_code: 'NEW',
  });
  const [chosen, setChosen] = useState();
  const [errors, setErrors] = useState({});
  const set = (k, v) => {
    setF((x) => ({ ...x, [k]: v }));
    if (['mode', 'amount', 'structure_id', 'gender', 'pt_state', 'joined_on', 'pf_enabled', 'esi_enabled'].includes(k)) setChosen(undefined);
  };
  const previewArgs = { ...agreement(f.mode, f.amount), structure_id: f.structure_id, gender: f.gender, pt_state: f.pt_state, date: f.joined_on || undefined, pf_enabled: f.pf_enabled, esi_enabled: f.esi_enabled, chosen_gross: chosen };
  const pv = useSalaryPreview(previewArgs, !!f.structure_id);

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
        pf_enabled: f.pf_enabled,
        esi_enabled: f.esi_enabled && (pv.data?.esi_within_ceiling ?? true),
        salary: { ...agreement(f.mode, f.amount), structure_id: f.structure_id, ...(chosen ? { chosen_gross: chosen } : {}) },
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

  const amount = agreement(f.mode, f.amount).amount;
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
          <Button loading={create.isPending} onClick={() => create.mutate()} disabled={!f.name.trim() || !f.phone || !f.designation.trim() || !f.department_id || !f.pay_group_id || !f.structure_id || !f.joined_on || amount <= 0 || !pv.data || pv.isFetching || pv.isInputPending || (pv.data?.solution?.ambiguous && !chosen)}>
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
          <Field label="Pay group" required hint="Calendar, weekly off, shift and attendance policies.">
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
          <Field label="Salary structure" required className="col-span-2" hint="Attached to this employee. You can change it later in Salary and statutory." error={errors['salary.structure_id'] ?? errors.structure_id}>
            {(id) => (
              <Select id={id} value={f.structure_id} onChange={(e) => set('structure_id', e.target.value)}>
                <option value="">Choose a structure…</option>
                {lk?.structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
          <SalaryAmountFields label="Pay agreed as" mode={f.mode} annual={f.amount} onMode={(v) => set('mode', v)} onAnnual={(v) => set('amount', v)} error={errors.amount} />
          <div className="col-span-2">
            <StatutoryChoice pf={f.pf_enabled} esi={f.esi_enabled} onPf={(v) => set('pf_enabled', v)} onEsi={(v) => set('esi_enabled', v)} preview={pv.data} />
          </div>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <h4 className="mb-2 font-display font-semibold">Preview</h4>
          {f.structure_id ? (
            <SalaryPreviewPanel
              args={previewArgs}
              chosen={chosen}
              onChoose={setChosen}
            />
          ) : (
            <p className="text-[14px] text-muted-foreground">Pick a salary structure to see the breakdown.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
