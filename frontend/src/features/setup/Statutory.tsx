import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatINR, pfMaxContribution, type EsiRates, type GratuityRates, type PfRates } from '@ajpwer/shared';
import { api, errorMessage } from '@/lib/api';
import { toPaise, toRupeesInput } from '@/lib/utils';
import { Money, PageHeader } from '@/components/bits';
import { Chip, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

interface RatesRow {
  id: string;
  valid_from: string;
  pf: PfRates;
  esi: EsiRates;
  gratuity: GratuityRates;
  recovery_cap_pct: number;
}
interface PtState {
  state: string;
  headcount: number;
  slabs: { id: string; gender_scope: 'ALL' | 'MALE' | 'FEMALE'; upto_amount: number | null; amount: number; feb_amount: number | null }[];
}
interface Regime {
  id: string;
  code: string;
  name: string;
  valid_from: string;
  std_deduction: number;
  rebate_limit: number;
  rebate_max: number | null;
  marginal_relief: boolean;
  allows_80c: boolean;
  cess_pct: number;
  headcount: number;
  slabs: { upto_amount: number | null; rate: number }[];
}

export default function Statutory() {
  const rates = useQuery({ queryKey: ['statutory-rates'], queryFn: () => api.get<{ data: { current: RatesRow | null; versions: RatesRow[] } }>('/statutory-rates').then((r) => r.data) });
  const pt = useQuery({ queryKey: ['pt-slabs'], queryFn: () => api.get<{ data: PtState[] }>('/pt-slabs').then((r) => r.data) });
  const regimes = useQuery({ queryKey: ['tax-regimes'], queryFn: () => api.get<{ data: Regime[] }>('/tax-regimes').then((r) => r.data) });
  const [editing, setEditing] = useState(false);
  const [editPt, setEditPt] = useState<PtState | null>(null);
  const c = rates.data?.current;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Statutory rules"
        description="Rates are company-wide data with an effective date, editable without code. A payroll run records which rates row it used, so reopening an old month never applies today's rates to it."
        actions={
          <Button onClick={() => setEditing(true)} disabled={!c}>
            <Pencil /> Publish new rates
          </Button>
        }
      />
      {rates.isLoading ? (
        <SkeletonBlock className="h-64" />
      ) : rates.isError ? (
        <ErrorState error={rates.error} onRetry={() => rates.refetch()} />
      ) : !c ? (
        <Notice tone="warning">No statutory rates are set. Seed the database or publish rates.</Notice>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title="Provident fund" description={`Effective ${c.valid_from}`} />
            <CardBody className="text-[13px]">
              <table className="w-full">
                <tbody>
                  {[
                    ['Employee rate', `${c.pf.employee_pct}%`],
                    ['Employer rate', `${c.pf.employer_pct}%`],
                    ['Wage ceiling', formatINR(c.pf.ceiling)],
                    ['Largest contribution', `${formatINR(pfMaxContribution(c.pf).employee)} + ${formatINR(pfMaxContribution(c.pf).employer)} a month`],
                    ['Pension (EPS) share', `${c.pf.eps_pct}% on wages up to ${formatINR(c.pf.eps_wage_ceiling)}`],
                    ['EDLI / admin (challan only, not in CTC)', `${c.pf.edli_pct}% / ${c.pf.admin_pct}%`],
                  ].map(([k, v]) => (
                    <tr key={k} className="border-b last:border-0">
                      <td className="py-1.5 text-muted-foreground">{k}</td>
                      <td className="py-1.5 text-right num">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[12px] text-muted-foreground">
                The ceiling is the only limit. With restrict-to-ceiling on, PF runs on at most {formatINR(c.pf.ceiling)} of wages, so the most anyone pays is {c.pf.employee_pct}% of that — {formatINR(pfMaxContribution(c.pf).employee)} — and the company matches it ({formatINR(pfMaxContribution(c.pf).total)} together). Pension stays on the statutory {formatINR(c.pf.eps_wage_ceiling)}. Which components form the base is one tick per component in the salary structure.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="ESI" />
            <CardBody className="text-[13px]">
              <table className="w-full">
                <tbody>
                  <tr className="border-b">
                    <td className="py-1.5 text-muted-foreground">Gross ceiling</td>
                    <td className="text-right num">{formatINR(c.esi.ceiling)}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-1.5 text-muted-foreground">Employee</td>
                    <td className="text-right num">{c.esi.employee_pct}%</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-muted-foreground">Employer</td>
                    <td className="text-right num">{c.esi.employer_pct}%</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[12px] text-muted-foreground">Both rounded up to the rupee. Eligibility is decided once per April–September and October–March period on fixed gross; contribution is on earned gross.</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Gratuity and recovery" />
            <CardBody className="text-[13px]">
              <table className="w-full">
                <tbody>
                  <tr className="border-b">
                    <td className="py-1.5 text-muted-foreground">Qualifies after</td>
                    <td className="text-right">{c.gratuity.min_years} years (flag from {c.gratuity.flag_from_years})</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-1.5 text-muted-foreground">Formula</td>
                    <td className="text-right">last basic × {c.gratuity.days_per_year} × years ÷ {c.gratuity.divisor}</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-muted-foreground">Recovery cap</td>
                    <td className="text-right num">{c.recovery_cap_pct}% of gross − statutory</td>
                  </tr>
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>
      )}
      {rates.data && rates.data.versions.length > 1 && (
        <p className="text-[12px] text-muted-foreground">
          Earlier versions: {rates.data.versions.filter((v) => v.id !== c?.id).map((v) => v.valid_from).join(', ')}
        </p>
      )}
      <Card>
        <CardHeader title="Professional tax" description="Charged by the employee's own PT state. Andhra Pradesh and Telangana are confirmed; verify other states against the current schedules before relying on them. Tamil Nadu (half-yearly) is not built." />
        {pt.isLoading ? (
          <SkeletonBlock className="h-40" />
        ) : pt.isError ? (
          <ErrorState error={pt.error} />
        ) : (
          <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
            {pt.data!.map((s) => (
              <div key={s.state} className="rounded-md border p-3 text-[13px]">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium">{s.state}</span>
                  <span className="flex items-center gap-2">
                    <Chip>{s.headcount} people</Chip>
                    <Button size="sm" variant="ghost" onClick={() => setEditPt(s)} aria-label={`Edit ${s.state}`}>
                      <Pencil />
                    </Button>
                  </span>
                </div>
                {!s.slabs.length ? (
                  <p className="text-muted-foreground">No professional tax</p>
                ) : (
                  <table className="w-full text-[12px]">
                    <tbody>
                      {s.slabs.map((x, i) => {
                        const prev = s.slabs.slice(0, i).filter((y) => y.gender_scope === x.gender_scope).at(-1);
                        return (
                          <tr key={x.id} className="border-t">
                            <td className="py-1">
                              {x.gender_scope !== 'ALL' && <span className="text-muted-foreground">{x.gender_scope === 'MALE' ? 'Men ' : 'Women '}</span>}
                              {prev ? `${formatINR((prev.upto_amount ?? 0) + 100)} – ` : 'Up to '}
                              {x.upto_amount === null ? 'above' : formatINR(x.upto_amount)}
                            </td>
                            <td className="text-right">
                              {x.amount ? <Money value={x.amount} /> : 'Nil'}
                              {x.feb_amount !== null && <span className="text-muted-foreground"> · Feb <Money value={x.feb_amount} /></span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
            <button onClick={() => setEditPt({ state: '', headcount: 0, slabs: [] })} className="flex items-center justify-center gap-2 rounded-md border border-dashed p-3 text-[13px] text-muted-foreground hover:bg-accent">
              <Plus className="size-4" /> Add a state
            </button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Income tax regimes" description="Everyone defaults to the new regime. Confirm the slabs against the Finance Act before the first live run. Surcharge above ₹50 lakh and quarterly TDS true-up are not built." />
        {regimes.isLoading ? (
          <SkeletonBlock className="h-40" />
        ) : regimes.isError ? (
          <ErrorState error={regimes.error} />
        ) : (
          <div className="grid gap-4 p-3 md:grid-cols-2">
            {regimes.data!.map((r) => (
              <div key={r.id} className="rounded-md border p-3 text-[13px]">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-display font-semibold">{r.name}</span>
                  <Chip>{r.headcount} people</Chip>
                </div>
                <table className="w-full text-[12px]">
                  <tbody>
                    {r.slabs.map((s, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1">
                          {i === 0 ? 'Up to' : `${formatINR(r.slabs[i - 1].upto_amount!)} –`} {s.upto_amount === null ? 'above' : formatINR(s.upto_amount)}
                        </td>
                        <td className="text-right num">{s.rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[12px] text-muted-foreground">
                  Standard deduction {formatINR(r.std_deduction)} · rebate {r.rebate_max === null ? 'in full' : `up to ${formatINR(r.rebate_max)}`} up to {formatINR(r.rebate_limit)} taxable · marginal relief {r.marginal_relief ? 'yes' : 'no'} · 80C/HRA {r.allows_80c ? 'allowed' : 'not allowed'} · cess {r.cess_pct}%
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>
      {editing && c && <RatesDialog current={c} onClose={() => setEditing(false)} />}
      {editPt && <PtDialog state={editPt} onClose={() => setEditPt(null)} />}
    </div>
  );
}

function RatesDialog({ current, onClose }: { current: RatesRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    valid_from: '',
    pf_emp: String(current.pf.employee_pct),
    pf_er: String(current.pf.employer_pct),
    ceiling: toRupeesInput(current.pf.ceiling),
    eps: String(current.pf.eps_pct),
    eps_ceiling: toRupeesInput(current.pf.eps_wage_ceiling),
    edli: String(current.pf.edli_pct),
    admin: String(current.pf.admin_pct),
    esi_ceiling: toRupeesInput(current.esi.ceiling),
    esi_emp: String(current.esi.employee_pct),
    esi_er: String(current.esi.employer_pct),
    cap: String(current.recovery_cap_pct),
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch('/statutory-rates', {
        valid_from: f.valid_from,
        pf: { employee_pct: Number(f.pf_emp), employer_pct: Number(f.pf_er), ceiling: toPaise(f.ceiling), eps_pct: Number(f.eps), eps_wage_ceiling: toPaise(f.eps_ceiling), edli_pct: Number(f.edli), admin_pct: Number(f.admin) },
        esi: { ceiling: toPaise(f.esi_ceiling), employee_pct: Number(f.esi_emp), employer_pct: Number(f.esi_er) },
        gratuity: current.gratuity,
        recovery_cap_pct: Number(f.cap),
      }),
    onSuccess: () => {
      toast.success('New rates published');
      qc.invalidateQueries({ queryKey: ['statutory-rates'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const num = (k: keyof typeof f, label: string, suffix = '%') => (
    <Field label={label}>
      {(id) => (
        <div className="relative">
          <Input id={id} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="pr-6 num" />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">{suffix}</span>
        </div>
      )}
    </Field>
  );
  // The ceiling is the one PF limit; the largest contribution follows from it.
  const maxPf = pfMaxContribution({ ceiling: toPaise(f.ceiling || '0'), employee_pct: Number(f.pf_emp) || 0, employer_pct: Number(f.pf_er) || 0 });
  const money = (k: keyof typeof f, label: string, hint?: string) => <Field label={label} hint={hint}>{(id) => <MoneyInput id={id} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="Publish new statutory rates"
      description="Inserts a new version with its effective date. Months already run keep the rates they used."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.valid_from} loading={save.isPending} onClick={() => save.mutate()}>
            Publish
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Effective from" required className="sm:col-span-4">
          {(id) => <Input id={id} type="date" className="max-w-xs" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} />}
        </Field>
        {num('pf_emp', 'PF employee')}
        {num('pf_er', 'PF employer')}
        {money('ceiling', 'PF wage ceiling', `Largest contribution: ${formatINR(maxPf.employee)} + ${formatINR(maxPf.employer)} a month`)}
        {num('eps', 'Pension (EPS) share')}
        {money('eps_ceiling', 'EPS wage ceiling')}
        {num('edli', 'EDLI')}
        {num('admin', 'Admin')}
        {money('esi_ceiling', 'ESI ceiling')}
        {num('esi_emp', 'ESI employee')}
        {num('esi_er', 'ESI employer')}
        {num('cap', 'Recovery cap')}
      </div>
    </Dialog>
  );
}

function PtDialog({ state, onClose }: { state: PtState; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(state.state);
  const [rows, setRows] = useState(state.slabs.map((s) => ({ gender_scope: s.gender_scope, upto: toRupeesInput(s.upto_amount), amount: toRupeesInput(s.amount), feb: toRupeesInput(s.feb_amount) })));
  useEffect(() => void 0, []);
  const save = useMutation({
    mutationFn: () => api.patch('/pt-slabs', { state: name, slabs: rows.map((r) => ({ state: name, gender_scope: r.gender_scope, upto_amount: r.upto ? toPaise(r.upto) : null, amount: toPaise(r.amount || '0'), feb_amount: r.feb ? toPaise(r.feb) : null })) }),
    onSuccess: () => {
      toast.success('Slabs saved');
      qc.invalidateQueries({ queryKey: ['pt-slabs'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title={state.state ? `Professional tax — ${state.state}` : 'Add a state'}
      description="Slabs are inclusive upper bounds of monthly gross. Leave the last slab's upper bound blank. No slabs means the state levies no professional tax."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!state.state && <Field label="State">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
        <table className="text-[13px]">
          <thead className="text-left text-[12px] text-muted-foreground">
            <tr>
              <th>Applies to</th>
              <th>Up to (monthly gross)</th>
              <th>Monthly PT</th>
              <th>February PT (if different)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <Select value={r.gender_scope} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, gender_scope: e.target.value as 'ALL' } : x)))} aria-label="Applies to">
                    <option value="ALL">Everyone</option>
                    <option value="MALE">Men</option>
                    <option value="FEMALE">Women</option>
                  </Select>
                </td>
                <td className="py-1 pr-2">
                  <MoneyInput value={r.upto} placeholder="and above" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, upto: e.target.value } : x)))} aria-label="Up to" />
                </td>
                <td className="py-1 pr-2">
                  <MoneyInput value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Monthly PT" />
                </td>
                <td className="py-1 pr-2">
                  <MoneyInput value={r.feb} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, feb: e.target.value } : x)))} aria-label="February PT" />
                </td>
                <td>
                  <Button size="icon" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove slab">
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button variant="outline" size="sm" className="w-fit" onClick={() => setRows([...rows, { gender_scope: 'ALL', upto: '', amount: '', feb: '' }])}>
          <Plus /> Add slab
        </Button>
      </div>
    </Dialog>
  );
}
