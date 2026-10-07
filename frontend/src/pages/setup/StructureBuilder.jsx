import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { describeComponentRule, formatINR, isPercentCalc, MONTH_NAMES, PERCENT_OF, SPECIAL_ALLOWANCE } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { useDebounced } from '@/hooks';
import { useLookups } from '@/hooks/useLookups';
import { cn, toPaise } from '@/utils';
import { PageHeader, ProportionBar } from '@/components/bits';
import { ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';
import { SalaryBreakup } from '../../components/people/SalaryBreakup';

const colourFor = (i) => `chart-${(i % 5) + 1}`;
const blank = (i, over = {}) => ({
  name: '',
  kind: 'PERCENT',
  of: 'PCT_GROSS',
  value: '',
  max: '',
  frequency: 'MONTHLY',
  pay_month: null,
  is_taxable: true,
  counts_as_wages: false,
  colour: colourFor(i),
  ...over,
});

const DEFAULT_ROWS = [
  blank(0, { name: 'Basic', of: 'PCT_GROSS', value: '50', counts_as_wages: true }),
  blank(1, { name: 'HRA', of: 'PCT_BASIC', value: '40' }),
  blank(2, { name: 'DA', kind: 'FIXED', value: '0', counts_as_wages: true }),
];
const DEFAULT_SPECIAL = { is_taxable: true, counts_as_wages: false };

const isBasicName = (name) => name.trim().toLowerCase() === 'basic';

function toComponent(r, i) {
  const calc_type = r.kind === 'FIXED' ? 'FIXED' : r.of;
  return {
    seq: i + 1,
    name: r.name.trim(),
    calc_type,
    calc_value: r.kind === 'FIXED' ? toPaise(r.value) : Number(r.value) || 0,
    max_amount: r.kind === 'PERCENT' && r.max.trim() && toPaise(r.max) > 0 ? toPaise(r.max) : null,
    frequency: r.frequency,
    pay_month: r.frequency === 'YEARLY' ? (r.pay_month ?? 3) : null,
    is_taxable: r.is_taxable,
    counts_as_wages: r.frequency === 'MONTHLY' && r.counts_as_wages,
    colour: r.colour,
  };
}

function specialComponent(s, seq) {
  return {
    seq,
    name: SPECIAL_ALLOWANCE,
    calc_type: 'BALANCE',
    calc_value: 0,
    max_amount: null,
    frequency: 'MONTHLY',
    pay_month: null,
    is_taxable: s.is_taxable,
    counts_as_wages: s.counts_as_wages,
    colour: colourFor(seq - 1),
  };
}

/** Two-way choice shown as buttons, so "percentage or fixed" is one click and always visible. */
function KindToggle({ value, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 overflow-hidden rounded-md border text-[13px]">
      {[
        ['PERCENT', 'Percentage'],
        ['FIXED', 'Fixed'],
      ].map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={cn('px-2 transition-colors', value === k ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted')}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export default function StructureBuilder() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const from = sp.get('from');
  const src = useQuery({ queryKey: ['structure', from], queryFn: () => api.get(`/structures/${from}`).then((r) => r.data), enabled: !!from });
  const [name, setName] = useState('');
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [special, setSpecial] = useState(DEFAULT_SPECIAL);
  // The sample the preview is worked out at: entered as a monthly gross or an annual CTC, with PF and ESI on or off.
  const [sampleMode, setSampleMode] = useState('GROSS');
  const [sample, setSample] = useState('24000');
  const [pfOn, setPfOn] = useState(true);
  const [esiOn, setEsiOn] = useState(true);
  const [ptState, setPtState] = useState(null);
  const { data: lk } = useLookups();
  useEffect(() => {
    const s = src.data;
    if (!s) return;
    setName(`${s.name} (copy)`);
    setRows(
      s.components
        .filter((c) => c.calc_type !== 'BALANCE')
        .map((c, i) => ({
          name: c.name,
          kind: isPercentCalc(c.calc_type) ? 'PERCENT' : 'FIXED',
          of: isPercentCalc(c.calc_type) ? c.calc_type : 'PCT_GROSS',
          value: c.calc_type === 'FIXED' ? String(c.calc_value / 100) : String(c.calc_value),
          max: c.max_amount ? String(c.max_amount / 100) : '',
          frequency: c.frequency,
          pay_month: c.pay_month,
          is_taxable: c.is_taxable,
          counts_as_wages: c.counts_as_wages,
          colour: c.colour || colourFor(i),
        })),
    );
    const bal = s.components.find((c) => c.calc_type === 'BALANCE' && c.frequency === 'MONTHLY');
    setSpecial(bal ? { is_taxable: bal.is_taxable, counts_as_wages: bal.counts_as_wages } : DEFAULT_SPECIAL);
  }, [src.data]);

  const comps = [...rows.map(toComponent), specialComponent(special, rows.length + 1)];
  const debounced = useDebounced({ comps, sample: { mode: sampleMode, amount: toPaise(sample), pf_enabled: pfOn, esi_enabled: esiOn, ...(ptState ? { pt_state: ptState } : {}) } }, 200);
  // Live preview at a sample gross, updating as the user types.
  const preview = useQuery({
    queryKey: ['structure-validate', debounced],
    queryFn: () => api.post('/structures/validate', { components: debounced.comps, sample: debounced.sample }).then((r) => r.data),
    enabled: (!from || !!src.data) && debounced.comps.every((c) => c.name) && debounced.sample.amount > 0,
    placeholderData: (p) => p,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => api.post('/structures', { name, components: comps, ...(from ? { duplicated_from: from } : {}) }),
    onSuccess: () => {
      toast.success('Structure created');
      qc.invalidateQueries({ queryKey: ['structures'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      nav('/setup/structures');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, d) =>
    setRows((rs) => {
      const n = [...rs];
      const [x] = n.splice(i, 1);
      n.splice(i + d, 0, x);
      return n;
    });
  const p = preview.data;
  const blankNames = rows.some((r) => !r.name.trim());
  const reservedName = rows.some((r) => r.name.trim().toLowerCase() === SPECIAL_ALLOWANCE.toLowerCase());
  const usesCtc = rows.some((r) => r.kind === 'PERCENT' && r.of === 'PCT_CTC');
  const cappedAt = (n) => p?.breakup.structure.monthly.find((c) => c.name === n && c.max_amount !== null && c.amount === c.max_amount);
  const cappedNames = new Set((p?.breakup.structure.monthly ?? []).filter((c) => c.max_amount !== null && c.amount === c.max_amount).map((c) => c.name));
  const ruleNames = Object.fromEntries(comps.map((c) => [c.name, describeComponentRule(c)]));
  if (from && src.isLoading) return <SkeletonBlock className="h-80" />;
  if (from && src.isError) return <ErrorState error={src.error} onRetry={() => src.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Salary structures', to: '/setup/structures' }, { label: from ? 'Duplicate and edit' : 'New structure' }]}
        title={from ? 'Duplicate and edit' : 'New salary structure'}
        description={
          from
            ? 'A new structure built from a copy. The original is untouched, and so is everyone paid on it.'
            : "Build it here, then choose it in the employee's Salary section when adding or revising their salary."
        }
      />
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="min-w-0">
            <CardHeader
              title="Components"
              description="For each one: its name, then percentage or fixed, then what the percentage is of. Basic is worked out first; whatever is left of gross is the Special Allowance."
            />
            <CardBody className="flex flex-col gap-3">
              <Field label="Structure name" required hint="The effective date is chosen on the employee's salary revision. Each employee can have their own salary structure." className="max-w-xl">
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Site staff 2027" />}
              </Field>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[880px] text-[14px]">
                  <thead className="text-left text-[13px] text-muted-foreground">
                    <tr>
                      <th className="py-1" />
                      <th>Component name</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th title="Optional. Caps a percentage; anything above it goes to the Special Allowance. There is no minimum.">Maximum</th>
                      <th>Paid</th>
                      <th>Taxable</th>
                      <th title="Tick on Basic, and on a dearness allowance if you use one. It decides which components form the PF base, and nothing else.">PF wage*</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const basicRow = isBasicName(r.name);
                      const capped = cappedAt(r.name.trim());
                      return (
                        <tr key={i} className="border-t align-top">
                          <td className="py-1.5 pr-1">
                            <div className="flex flex-col">
                              <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" className="disabled:opacity-30">
                                <ArrowUp className="size-3.5" />
                              </button>
                              <button disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className="disabled:opacity-30">
                                <ArrowDown className="size-3.5" />
                              </button>
                            </div>
                          </td>
                          <td className="w-36 py-1.5 pr-2">
                            <Input value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="e.g. Conveyance" aria-label="Component name" aria-invalid={!r.name.trim()} />
                          </td>
                          <td className="py-1.5 pr-2">
                            <KindToggle value={r.kind} onChange={(kind) => set(i, { kind, max: kind === 'FIXED' ? '' : r.max })} label={`${r.name || 'Component'}: percentage or fixed`} />
                          </td>
                          <td className="py-1.5 pr-2">
                            {r.kind === 'FIXED' ? (
                              <MoneyInput value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="w-32" aria-label="Fixed amount" />
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <div className="relative w-[4.5rem]">
                                  <Input value={r.value} inputMode="decimal" onChange={(e) => set(i, { value: e.target.value })} className="pr-6 num" aria-label="Percent" />
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
                                </div>
                                <span className="text-muted-foreground">of</span>
                                <Select value={r.of} onChange={(e) => set(i, { of: e.target.value })} className="w-24" aria-label="Percentage of">
                                  {PERCENT_OF.map((o) => (
                                    <option key={o.calc_type} value={o.calc_type} disabled={basicRow && o.calc_type === 'PCT_BASIC'} title={o.explain}>
                                      {o.label}
                                    </option>
                                  ))}
                                </Select>
                              </div>
                            )}
                          </td>
                          <td className="w-32 py-1.5 pr-2">
                            {r.kind === 'PERCENT' ? (
                              <div className="flex flex-col gap-0.5">
                                <MoneyInput value={r.max} onChange={(e) => set(i, { max: e.target.value })} placeholder="No limit" aria-label={`Maximum for ${r.name || 'component'}`} />
                                {capped && <span className="text-[12px] text-muted-foreground">Capped at this gross</span>}
                              </div>
                            ) : (
                              <span className="text-[13px] text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2">
                            <div className="flex gap-1">
                              <Select
                                value={r.frequency}
                                onChange={(e) => set(i, { frequency: e.target.value, pay_month: e.target.value === 'YEARLY' ? (r.pay_month ?? 10) : null })}
                                aria-label="Frequency"
                              >
                                <option value="MONTHLY">Monthly</option>
                                <option value="YEARLY" disabled={basicRow}>Yearly</option>
                              </Select>
                              {r.frequency === 'YEARLY' && (
                                <Select value={r.pay_month ?? 10} onChange={(e) => set(i, { pay_month: Number(e.target.value) })} aria-label="Payout month">
                                  {MONTH_NAMES.map((m, k) => (
                                    <option key={m} value={k + 1}>
                                      {m.slice(0, 3)}
                                    </option>
                                  ))}
                                </Select>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5">
                            <Switch checked={r.is_taxable} onCheckedChange={(v) => set(i, { is_taxable: v })} label="Taxable" />
                          </td>
                          <td className="py-2.5">
                            <Switch checked={r.counts_as_wages} disabled={r.frequency === 'YEARLY'} onCheckedChange={(v) => set(i, { counts_as_wages: v })} label="Counts as PF wage" />
                          </td>
                          <td className="py-1.5">
                            <Button size="icon" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${r.name || 'component'}`}>
                              <Trash2 />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="border-t bg-muted/40 align-top">
                      <td className="py-2.5 pl-0.5">
                        <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                      </td>
                      <td className="py-2.5 pr-2 font-medium">{SPECIAL_ALLOWANCE}</td>
                      <td className="py-2.5 pr-2" colSpan={3}>
                        <span className="text-[13px] text-muted-foreground">Automatic: whatever is left of gross after the components above. Never negative.</span>
                      </td>
                      <td className="py-2.5 pr-2 text-[13px] text-muted-foreground">Monthly</td>
                      <td className="py-2.5">
                        <Switch checked={special.is_taxable} onCheckedChange={(v) => setSpecial({ ...special, is_taxable: v })} label="Special Allowance taxable" />
                      </td>
                      <td className="py-2.5">
                        <Switch checked={special.counts_as_wages} onCheckedChange={(v) => setSpecial({ ...special, counts_as_wages: v })} label="Special Allowance counts as PF wage" />
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button variant="outline" size="sm" onClick={() => setRows([...rows, blank(rows.length)])}>
                  <Plus /> Add component
                </Button>
                <p className="max-w-md text-right text-[13px] text-muted-foreground">
                  * PF wage: tick it on Basic, and on a dearness allowance if you use one. It decides which components form the PF base, and nothing else.
                </p>
              </div>
            </CardBody>
          </Card>
          <StatutoryCard rates={p?.rates} />
        </div>
        <Card className="h-fit 2xl:sticky 2xl:top-4">
          <CardHeader title="Salary breakup" description="A sample person on this structure. Updates as you type." />
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <div role="radiogroup" aria-label="Sample entered as" className="inline-flex h-8 w-fit overflow-hidden rounded-md border text-[13px]">
                {[
                  ['GROSS', 'Monthly gross'],
                  ['CTC', 'Annual CTC'],
                ].map(([m, text]) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={sampleMode === m}
                    onClick={() => {
                      if (m === sampleMode) return;
                      setSampleMode(m);
                      setSample(m === 'CTC' ? '400000' : '24000');
                    }}
                    className={cn('px-2.5', sampleMode === m ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted')}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <Field label={sampleMode === 'CTC' ? 'Sample annual CTC' : 'Sample monthly gross'}>{(id) => <MoneyInput id={id} value={sample} onChange={(e) => setSample(e.target.value)} />}</Field>
              <div className="grid grid-cols-2 gap-2 text-[14px]">
                <label className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                  PF
                  <Switch checked={pfOn} onCheckedChange={setPfOn} label="PF on for the sample" />
                </label>
                <label className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                  ESI
                  <Switch checked={esiOn} onCheckedChange={setEsiOn} label="ESI on for the sample" />
                </label>
              </div>
              <Field label="Professional tax state">
                {(id) => (
                  <Select id={id} value={ptState ?? p?.pt_state ?? ''} onChange={(e) => setPtState(e.target.value)}>
                    {(lk?.pt_states ?? (p?.pt_state ? [p.pt_state] : [])).map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {usesCtc && p && (
              <p className="text-[13px] text-muted-foreground">
                “% of CTC” is a share of this annual CTC, <span className="num font-medium text-foreground">{formatINR(p.breakup.ctc.ctc_basis)}</span>, spread over twelve months.
              </p>
            )}
            {p?.breakup.solution?.ambiguous && <Notice tone="warning">This CTC has two valid grosses either side of the ESI ceiling; the one without ESI is shown.</Notice>}
            {p?.breakup.solution?.approximate && <Notice tone="warning">No monthly gross reproduces this CTC exactly on this structure; the nearest is shown.</Notice>}
            {blankNames && <Notice tone="warning">Every component needs a name.</Notice>}
            {reservedName && <Notice tone="destructive">{SPECIAL_ALLOWANCE} is added automatically. Give this component another name.</Notice>}
            {preview.isError && <Notice tone="destructive">{errorMessage(preview.error)}</Notice>}
            {p?.errors.map((e) => (
              <Notice key={e} tone="destructive">
                {e}
              </Notice>
            ))}
            {p?.warnings.map((w) => (
              <Notice key={w} tone="warning">
                {w}
              </Notice>
            ))}
            {p && (
              <div className={cn('flex flex-col gap-3', preview.isFetching && 'opacity-70')}>
                <ProportionBar parts={p.breakup.structure.monthly.map((c) => ({ label: c.name, value: c.amount, colour: c.colour }))} />
                <SalaryBreakup p={p.breakup} rates={p.rates} rules={ruleNames} capped={cappedNames} />
                <p className="text-[12px] text-muted-foreground">Income tax on the new regime with no declarations. PF restricted to the {formatINR(p.rates.pf.ceiling)} ceiling.</p>
              </div>
            )}
            <Button size="lg" disabled={!name.trim() || blankNames || reservedName || !!p?.errors.length || preview.isError} loading={save.isPending} onClick={() => save.mutate()}>
              Create structure
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/**
 * PF and ESI are not components anyone types in: they are worked out from the
 * statutory rates, the components switched on as PF wage, and gross. This says
 * how, and where each part is set; the amounts are in the salary breakup.
 */
function StatutoryCard({ rates }) {
  const pf = rates?.pf;
  const esi = rates?.esi;
  const rows = [
    ['PF — employee', pf ? `${pf.employee_pct}% of the PF wage (the components switched on as PF wage), on at most ${formatINR(pf.ceiling)}` : '—', 'Deduction'],
    [
      'PF — company',
      pf
        ? `${pf.employer_pct}% of the same wage (pension ${pf.eps_pct}% on up to ${formatINR(pf.eps_wage_ceiling)}, the rest to EPF). EDLI and admin charges are paid with the PF challan and are not part of CTC.`
        : '—',
      'Company contribution',
    ],
    ['ESI — employee', esi ? `${esi.employee_pct}% of gross, while gross is ${formatINR(esi.ceiling)} or less` : '—', 'Deduction'],
    ['ESI — company', esi ? `${esi.employer_pct}% of gross, only when the person is eligible (gross ${formatINR(esi.ceiling)} or less)` : '—', 'Company contribution'],
    ['Professional tax', "From the slabs for the person's work state", 'Deduction'],
    ['Income tax (TDS)', "From the person's tax regime and declarations", 'Deduction'],
  ];
  return (
    <Card className="min-w-0">
      <CardHeader
        title="PF, ESI, professional tax and TDS"
        description="Not components you type in: they are worked out automatically for everyone on this structure. The amounts are in the salary breakup."
      />
      <CardBody className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[14px]">
            <thead className="text-left text-[13px] text-muted-foreground">
              <tr>
                <th className="py-1">Item</th>
                <th>How it is worked out</th>
                <th>Section</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, how, section]) => (
                <tr key={name} className="border-t align-top">
                  <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{name}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{how}</td>
                  <td className="py-1.5 whitespace-nowrap">{section}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-[13px] sm:grid-cols-3">
          <div>
            <div className="font-semibold text-foreground">The rates</div>
            <p className="text-muted-foreground">
              12%, the {pf ? formatINR(pf.ceiling) : 'PF'} ceiling, ESI percentages and its ceiling:{' '}
              <Link to="/setup/statutory" className="font-medium text-primary hover:underline">
                Setup → Statutory rules
              </Link>
              . One set for the whole company, with an effective date.
            </p>
          </div>
          <div>
            <div className="font-semibold text-foreground">What counts as PF wage</div>
            <p className="text-muted-foreground">The PF wage switch on each component above — normally Basic and DA.</p>
          </div>
          <div>
            <div className="font-semibold text-foreground">For one person</div>
            <p className="text-muted-foreground">
              PF on or off, restrict to the ceiling, voluntary PF, ESI on or off, PT state and tax regime: their profile → Salary and statutory → Statutory. These settings can differ for each employee.
            </p>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
