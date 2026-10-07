import { useCallback, useState } from 'react';
import { useNewFromUrl } from '@/hooks';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileSignature, Play, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { Money, Mono, PageHeader, PersonLink } from '@/components/bits';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog, TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';
import { SalaryPreviewPanel, useSalaryPreview } from '../../components/people/SalaryPreview';
import { agreement, SalaryAmountFields, StatutoryChoice } from '../../components/people/SalaryEntry';
import { refreshEmployeePay } from '../../components/people/profile-tabs/SalaryHistory';

export default function Offers() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [tab, setTab] = useState('OFFER');
  const [issuing, setIssuing] = useState(false);
  useNewFromUrl(useCallback(() => setIssuing(true), []));
  const q = useQuery({ queryKey: ['offers'], queryFn: () => api.get('/offers').then((r) => r.data) });
  const act = useMutation({
    mutationFn: ({ path }) => api.post(path),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['offers'] });
      qc.invalidateQueries({ queryKey: ['people'] });
      refreshEmployeePay(qc, v.employee_id);
      setTab(v.next);
      toast.success(v.next === 'ACCEPTED' ? 'Marked accepted' : 'Onboarding started: the salary record now runs from the joining date.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = (s) => (q.data ?? []).filter((p) => p.status === s);
  const tabs = [
    { value: 'OFFER', label: 'Offered', badge: <span className="text-muted-foreground">{rows('OFFER').length}</span> },
    { value: 'ACCEPTED', label: 'Accepted', badge: <span className="text-muted-foreground">{rows('ACCEPTED').length}</span> },
    { value: 'ONBOARDING', label: 'Onboarding', badge: <span className="text-muted-foreground">{rows('ONBOARDING').length}</span> },
  ];
  return (
    <div>
      <PageHeader
        title="Offers and onboarding"
        description="Status moves one way: offer → accepted → onboarding → active. Nobody is paid before activation."
        actions={
          <Button onClick={() => setIssuing(true)}>
            <Plus /> Issue an offer
          </Button>
        }
      />

      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList tabs={tabs} />
        {['OFFER', 'ACCEPTED', 'ONBOARDING'].map((s) => (
          <TabsContent key={s} value={s} className="pt-4">
            <Card>
              {q.isLoading ? (
                <SkeletonRows rows={5} />
              ) : q.isError ? (
                <ErrorState error={q.error} onRetry={() => q.refetch()} />
              ) : !rows(s).length ? (
                <EmptyState
                  title={s === 'OFFER' ? 'No open offers' : s === 'ACCEPTED' ? 'Nobody waiting to start onboarding' : 'Nobody onboarding'}
                  body="Issue an offer to start."
                  action={s === 'OFFER' ? <Button onClick={() => setIssuing(true)}>Issue an offer</Button> : undefined}
                />
              ) : (
                <div className="overflow-x-auto"><table className="data-table w-full">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Pay group</th>
                      <th className="text-right">Offered</th>
                      <th>Join by</th>
                      <th>Offer</th>
                      <th>{s === 'ONBOARDING' ? 'Checklist' : ''}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows(s).map((p) => (
                      <tr key={p.id}>
                        <td>
                          <PersonLink id={p.id} name={p.name} code={p.code} tab={s === 'ONBOARDING' ? 'onboarding' : 'overview'} />
                        </td>
                        <td>
                          {p.designation} · {p.department.name}
                        </td>
                        <td>{p.pay_group.name}</td>
                        <td className="text-right">
                          {p.offer && (
                            <>
                              <Money value={p.offer.mode === 'CTC' ? p.offer.amount : p.offer.amount * 12} /> <span className="text-muted-foreground">{p.offer.mode === 'CTC' ? 'CTC a year' : 'gross a year'}</span>
                            </>
                          )}
                        </td>
                        <td className="num">{p.joined_on}</td>
                        <td>
                          {p.offer && (
                            <Link to={`/people/${p.id}?tab=letters`} className="hover:underline">
                              <Mono>{p.offer.ref}</Mono>
                            </Link>
                          )}
                        </td>
                        <td>{s === 'ONBOARDING' && `${p.onboarding.required_left ? `${p.onboarding.required_left} required left` : 'Ready to activate'}`}</td>
                        <td className="text-right">
                          {s === 'OFFER' && p.offer && (
                            <Button size="sm" onClick={() => act.mutate({ path: `/offers/${p.offer.id}/accept`, next: 'ACCEPTED', employee_id: p.id })} loading={act.isPending}>
                              <Check /> Mark accepted
                            </Button>
                          )}
                          {s === 'ACCEPTED' && p.offer && (
                            <Button size="sm" onClick={() => act.mutate({ path: `/offers/${p.offer.id}/onboard`, next: 'ONBOARDING', employee_id: p.id })} loading={act.isPending}>
                              <Play /> Start onboarding
                            </Button>
                          )}
                          {s === 'ONBOARDING' && (
                            <Button size="sm" variant="outline" onClick={() => nav(`/people/${p.id}?tab=onboarding`)}>
                              Open checklist
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Card>
          </TabsContent>
        ))}
      </TabsRoot>
      {issuing && <IssueOfferDialog onClose={() => setIssuing(false)} />}
    </div>
  );
}

function IssueOfferDialog({ onClose }) {
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const in14 = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({
    name: '',
    gender: 'MALE',
    phone: '',
    department_id: '',
    designation: '',
    pay_group_id: '',
    structure_id: '',
    mode: 'GROSS',
    amount: '',
    pf_enabled: true,
    esi_enabled: true,
    join_by: in30,
    valid_till: in14,
    pt_state: 'Andhra Pradesh',
  });
  const [chosen, setChosen] = useState();
  const [errors, setErrors] = useState({});
  const set = (k, v) => {
    setF((x) => ({ ...x, [k]: v }));
    if (['mode', 'amount', 'structure_id', 'gender', 'pt_state', 'join_by', 'pf_enabled', 'esi_enabled'].includes(k)) setChosen(undefined);
  };
  const previewArgs = { ...agreement(f.mode, f.amount), structure_id: f.structure_id, gender: f.gender, pt_state: f.pt_state, date: f.join_by, pf_enabled: f.pf_enabled, esi_enabled: f.esi_enabled, chosen_gross: chosen };
  const pv = useSalaryPreview(previewArgs, !!f.structure_id);
  const save = useMutation({
    mutationFn: () => api.post('/offers', { ...f, ...agreement(f.mode, f.amount), esi_enabled: f.esi_enabled && (pv.data?.esi_within_ceiling ?? true), ...(chosen ? { chosen_gross: chosen } : {}) }),
    onSuccess: async (r) => {
      toast.success(`Offer ${r.data.ref} issued. The letter's figures are frozen.`);
      qc.invalidateQueries({ queryKey: ['offers'] });
      refreshEmployeePay(qc, r.data.employee_id);
      onClose();
      try {
        const letters = await api.get(`/employees/${r.data.employee_id}/letters`);
        const offer = letters.data.find((l) => l.kind === 'OFFER');
        if (offer) window.open(`/print/letter/${r.data.employee_id}/${offer.id}`, '_blank');
      } catch (err) {
        toast.error(`Offer issued, but the letter could not be opened. Open it from the employee's Letters tab. ${errorMessage(err)}`);
      }
    },
    onError: (e) => {
      if (e instanceof ApiError && e.field) setErrors({ [e.field]: e.message });
      toast.error(errorMessage(e));
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="Issue an offer"
      description="As the amount is typed, the preview shows the breakdown, employer contributions, annual CTC and approximate take-home. Saving generates the offer letter with exactly those figures."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.name.trim() || !f.phone || !f.department_id || !f.designation.trim() || !f.pay_group_id || !f.structure_id || agreement(f.mode, f.amount).amount <= 0 || !pv.data || pv.isFetching || pv.isInputPending || (pv.data?.solution?.ambiguous && !chosen)} onClick={() => save.mutate()}>
            <FileSignature /> Issue offer and print letter
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid grid-cols-2 content-start gap-3">
          <Field label="Name" required className="col-span-2" error={errors.name}>
            {(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} />}
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
          <Field label="Pay group" required className="col-span-2" hint="Calendar, shift and attendance policies.">
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
          <Field label="Salary structure" required className="col-span-2" hint="This employee's salary components." error={errors.structure_id}>
            {(id) => (
              <Select id={id} value={f.structure_id} onChange={(e) => set('structure_id', e.target.value)}>
                <option value="">Choose a structure…</option>
                {lk?.structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </Field>
          <SalaryAmountFields label="Offered as" mode={f.mode} annual={f.amount} onMode={(v) => set('mode', v)} onAnnual={(v) => set('amount', v)} error={errors.amount} />
          <div className="col-span-2">
            <StatutoryChoice pf={f.pf_enabled} esi={f.esi_enabled} onPf={(v) => set('pf_enabled', v)} onEsi={(v) => set('esi_enabled', v)} preview={pv.data} />
          </div>
          <Field label="Joining date">{(id) => <Input id={id} type="date" value={f.join_by} onChange={(e) => set('join_by', e.target.value)} />}</Field>
          <Field label="Offer valid till">{(id) => <Input id={id} type="date" value={f.valid_till} onChange={(e) => set('valid_till', e.target.value)} />}</Field>
          <Field label="Works in (PT state)" className="col-span-2" hint="Defaults professional tax. It stays on the person, because people move.">
            {(id) => (
              <Select id={id} value={f.pt_state} onChange={(e) => set('pt_state', e.target.value)}>
                {lk?.pt_states.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
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
