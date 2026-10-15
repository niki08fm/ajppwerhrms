import { useCallback, useState } from 'react';
import { useNewFromUrl } from '@/hooks';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, FileSignature, Play, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { Money, Mono, PageHeader, PersonLink } from '@/components/bits';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Checkbox, Dialog, TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';
import { SalaryPreviewPanel, useSalaryPreview } from '../../components/people/SalaryPreview';
import { agreement, SalaryAmountFields, StatutoryChoice } from '../../components/people/SalaryEntry';
import { hasPaise } from '../../components/people/SalaryDisplay';
import { refreshEmployeePay } from '../../components/people/profile-tabs/SalaryHistory';

export default function Offers() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [tab, setTab] = useState('OFFER');
  const [issuing, setIssuing] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [onboarding, setOnboarding] = useState(null);
  const [revoking, setRevoking] = useState(null);
  useNewFromUrl(useCallback(() => setIssuing(true), []));
  const q = useQuery({ queryKey: ['offers'], queryFn: () => api.get('/offers').then((r) => r.data) });
  const refresh = (employeeIds = []) => {
    qc.invalidateQueries({ queryKey: ['offers'] });
    qc.invalidateQueries({ queryKey: ['people'] });
    qc.invalidateQueries({ queryKey: ['departments'] });
    for (const id of employeeIds) refreshEmployeePay(qc, id);
  };
  const accept = useMutation({
    mutationFn: (p) => api.post(`/offers/${p.offer.id}/accept`),
    onSuccess: (_d, p) => {
      refresh([p.id]);
      setTab('ACCEPTED');
      toast.success(`${p.name} marked accepted. Onboard them from Accepted once the joining date is known.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = (s) => (q.data ?? []).filter((p) => p.status === s);
  const accepted = rows('ACCEPTED');
  const picked = accepted.filter((p) => selected.has(p.offer?.id));
  const toggle = (id, on) =>
    setSelected((x) => {
      const n = new Set(x);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const tabs = [
    { value: 'OFFER', label: 'Offered', badge: <span className="text-muted-foreground">{rows('OFFER').length}</span> },
    { value: 'ACCEPTED', label: 'Accepted', badge: <span className="text-muted-foreground">{accepted.length}</span> },
    { value: 'ONBOARDING', label: 'Onboarding', badge: <span className="text-muted-foreground">{rows('ONBOARDING').length}</span> },
    { value: 'REVOKED', label: 'Revoked', badge: <span className="text-muted-foreground">{rows('REVOKED').length}</span> },
  ];
  const EMPTY = {
    OFFER: ['No open offers', 'Issue an offer to start.'],
    ACCEPTED: ['Nobody waiting to start onboarding', 'Accepted offers wait here until their joining date is given.'],
    ONBOARDING: ['Nobody onboarding', 'Onboard accepted candidates by giving their joining date.'],
    REVOKED: ['No revoked offers', 'An offer revoked from Offered or Accepted stays on record here.'],
  };
  return (
    <div>
      <PageHeader
        title="Offers and onboarding"
        description="Offer → accepted → onboarding (joining date and joining letter) → active. Nobody is paid before activation."
        actions={
          <Button onClick={() => setIssuing(true)}>
            <Plus /> Issue an offer
          </Button>
        }
      />

      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList tabs={tabs} />
        {['OFFER', 'ACCEPTED', 'ONBOARDING', 'REVOKED'].map((s) => (
          <TabsContent key={s} value={s} className="pt-4">
            <Card>
              {s === 'ACCEPTED' && accepted.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-[14px]">
                  <span className="text-muted-foreground">{picked.length ? `${picked.length} selected` : 'Select people to onboard them together from one joining date.'}</span>
                  <Button size="sm" disabled={!picked.length} onClick={() => setOnboarding(picked)}>
                    <Play /> Onboard selected
                  </Button>
                </div>
              )}
              {q.isLoading ? (
                <SkeletonRows rows={5} />
              ) : q.isError ? (
                <ErrorState error={q.error} onRetry={() => q.refetch()} />
              ) : !rows(s).length ? (
                <EmptyState title={EMPTY[s][0]} body={EMPTY[s][1]} action={s === 'OFFER' ? <Button onClick={() => setIssuing(true)}>Issue an offer</Button> : undefined} />
              ) : s === 'REVOKED' ? (
                <div className="overflow-x-auto"><table className="data-table w-full">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Offer</th>
                      <th>Revoked</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows(s).map((p) => (
                      <tr key={p.offer.id}>
                        <td>
                          {p.name} <Mono className="text-muted-foreground">{p.code}</Mono>
                        </td>
                        <td>{p.designation} · {p.department.name}</td>
                        <td><Mono>{p.offer.ref}</Mono></td>
                        <td className="num">{p.offer.revoked_on} <span className="text-muted-foreground">by {p.offer.revoked_by}</span></td>
                        <td className="whitespace-normal">{p.offer.revoke_reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              ) : (
                <div className="overflow-x-auto"><table className="data-table w-full">
                  <thead>
                    <tr>
                      {s === 'ACCEPTED' && (
                        <th className="w-8">
                          <Checkbox
                            label="Select everyone"
                            checked={picked.length === accepted.length ? true : picked.length ? 'indeterminate' : false}
                            onCheckedChange={(v) => setSelected(new Set(v ? accepted.map((p) => p.offer?.id).filter(Boolean) : []))}
                          />
                        </th>
                      )}
                      <th>Name</th>
                      <th>Role</th>
                      <th>Pay group</th>
                      <th className="text-right">Offered</th>
                      <th>Joining date</th>
                      <th>Offer</th>
                      <th>{s === 'ONBOARDING' ? 'Checklist' : ''}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows(s).map((p) => (
                      <tr key={p.id}>
                        {s === 'ACCEPTED' && (
                          <td>
                            {p.offer && <Checkbox label={`Select ${p.name}`} checked={selected.has(p.offer.id)} onCheckedChange={(v) => toggle(p.offer.id, v)} />}
                          </td>
                        )}
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
                              <Money value={p.offer.mode === 'CTC' ? p.offer.amount : p.offer.amount * 12} paise={p.offer.mode === 'CTC' && hasPaise(p.offer.amount)} /> <span className="text-muted-foreground">{p.offer.mode === 'CTC' ? 'CTC a year' : 'gross a year'}</span>
                            </>
                          )}
                        </td>
                        <td className="num">{p.joined_on ?? <span className="text-muted-foreground">Not set yet</span>}</td>
                        <td>
                          {p.offer && (
                            <Link to={`/people/${p.id}?tab=letters`} className="hover:underline">
                              <Mono>{p.offer.ref}</Mono>
                            </Link>
                          )}
                        </td>
                        <td>{s === 'ONBOARDING' && `${p.onboarding.required_left ? `${p.onboarding.required_left} required left` : 'Ready to activate'}`}</td>
                        <td className="whitespace-nowrap text-right">
                          {s === 'OFFER' && p.offer && (
                            <Button size="sm" onClick={() => accept.mutate(p)} loading={accept.isPending && accept.variables?.id === p.id}>
                              <Check /> Mark accepted
                            </Button>
                          )}
                          {s === 'ACCEPTED' && p.offer && (
                            <Button size="sm" onClick={() => setOnboarding([p])}>
                              <Play /> Onboard
                            </Button>
                          )}
                          {(s === 'OFFER' || s === 'ACCEPTED') && p.offer && (
                            <Button size="icon" variant="ghost" className="ml-1 size-8 align-middle text-muted-foreground hover:text-destructive" aria-label={`Revoke the offer to ${p.name}`} title="Revoke offer" onClick={() => setRevoking(p)}>
                              <Ban />
                            </Button>
                          )}
                          {s === 'ONBOARDING' && (
                            <Button size="sm" variant="outline" onClick={() => nav(`/people/${p.id}?tab=onboarding`)}>
                              Open onboarding
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
      {onboarding && (
        <OnboardDialog
          people={onboarding}
          onClose={() => setOnboarding(null)}
          onDone={(ids) => {
            refresh(ids);
            setSelected(new Set());
            setOnboarding(null);
            if (ids.length === 1) nav(`/people/${ids[0]}?tab=onboarding`);
            else setTab('ONBOARDING');
          }}
        />
      )}
      {revoking && (
        <RevokeDialog
          person={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            refresh();
            setSelected((x) => {
              const n = new Set(x);
              n.delete(revoking.offer.id);
              return n;
            });
            setRevoking(null);
          }}
        />
      )}
    </div>
  );
}

/** Start onboarding one or several accepted candidates from one joining date; their joining letters are issued. */
function OnboardDialog({ people, onClose, onDone }) {
  const known = [...new Set(people.map((p) => p.joined_on).filter(Boolean))];
  const [date, setDate] = useState(known.length === 1 ? known[0] : '');
  const save = useMutation({
    mutationFn: () =>
      people.length === 1
        ? api.post(`/offers/${people[0].offer.id}/onboard`, { joined_on: date })
        : api.post('/offers/onboard', { offer_ids: people.map((p) => p.offer.id), joined_on: date }),
    onSuccess: () => {
      toast.success(people.length === 1 ? `${people[0].name} is onboarding. The joining letter is issued.` : `${people.length} people are onboarding. Their joining letters are issued.`);
      onDone(people.map((p) => p.id));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={people.length === 1 ? `Onboard ${people[0].name}` : `Onboard ${people.length} people`}
      description="Gives the joining date, starts the offered salary from that date and issues the joining letter. The onboarding formalities follow on each profile."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!date} onClick={() => save.mutate()}>
            <Play /> Onboard and issue joining {people.length === 1 ? 'letter' : 'letters'}
          </Button>
        </>
      }
    >
      <Field label={people.length === 1 ? 'Joining date' : 'Joining date for everyone'} required>
        {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
      </Field>
      {people.length > 1 && (
        <ul className="mt-3 max-h-56 divide-y overflow-y-auto rounded-md border text-[14px]">
          {people.map((p) => (
            <li key={p.id} className="flex justify-between gap-3 px-3 py-1.5">
              <span>{p.name}</span>
              <span className="text-muted-foreground">{p.designation}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Revoke an open or accepted offer, with the reason kept on record. */
function RevokeDialog({ person, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/offers/${person.offer.id}/revoke`, { reason }),
    onSuccess: () => {
      toast.success(`The offer to ${person.name} is revoked. It stays on record under Revoked.`);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Revoke the offer to ${person.name}`}
      description={`${person.offer.ref}. ${person.name} leaves the pipeline and every list; the offer and its letter stay on record.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate()}>
            <Ban /> Revoke offer
          </Button>
        </>
      }
    >
      <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, e.g. candidate declined" aria-label="Reason" />
    </Dialog>
  );
}

function IssueOfferDialog({ onClose }) {
  const { data: lk } = useLookups();
  const qc = useQueryClient();
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
    join_by: '',
    valid_till: in14,
    pt_state: 'Andhra Pradesh',
  });
  const [chosen, setChosen] = useState();
  const [errors, setErrors] = useState({});
  const set = (k, v) => {
    setF((x) => ({ ...x, [k]: v }));
    if (['mode', 'amount', 'structure_id', 'gender', 'pt_state', 'join_by', 'pf_enabled', 'esi_enabled'].includes(k)) setChosen(undefined);
  };
  const previewArgs = { ...agreement(f.mode, f.amount), structure_id: f.structure_id, gender: f.gender, pt_state: f.pt_state, date: f.join_by || undefined, pf_enabled: f.pf_enabled, esi_enabled: f.esi_enabled, chosen_gross: chosen };
  const pv = useSalaryPreview(previewArgs, !!f.structure_id);
  const save = useMutation({
    mutationFn: () => api.post('/offers', { ...f, join_by: f.join_by || null, ...agreement(f.mode, f.amount), esi_enabled: f.esi_enabled && (pv.data?.esi_within_ceiling ?? true), ...(chosen ? { chosen_gross: chosen } : {}) }),
    onSuccess: async (r) => {
      toast.success(`Offer ${r.data.ref} issued. The letter's figures are frozen.`);
      qc.invalidateQueries({ queryKey: ['offers'] });
      qc.invalidateQueries({ queryKey: ['departments'] });
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
          <Button loading={save.isPending} disabled={!f.name.trim() || !f.phone || !f.department_id || !f.designation.trim() || !f.pay_group_id || !f.structure_id || agreement(f.mode, f.amount).amount <= 0 || !pv.data || pv.isFetching || pv.isInputPending || pv.data?.solution?.approximate || (pv.data?.solution?.ambiguous && !chosen)} onClick={() => save.mutate()}>
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
          <Field label="Joining date" hint="Optional. Give it now, or when onboarding starts.">{(id) => <Input id={id} type="date" value={f.join_by} onChange={(e) => set('join_by', e.target.value)} />}</Field>
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
