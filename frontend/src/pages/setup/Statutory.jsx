import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatINR, pfMaxContribution } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { toPaise, toRupeesInput } from '@/utils';
import { Money, PageHeader } from '@/components/bits';
import { Chip, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

export default function Statutory() {
  const rates = useQuery({ queryKey: ['statutory-rates'], queryFn: () => api.get('/statutory-rates').then((r) => r.data) });
  const pt = useQuery({ queryKey: ['pt-slabs'], queryFn: () => api.get('/pt-slabs').then((r) => r.data) });
  const regimes = useQuery({ queryKey: ['tax-regimes'], queryFn: () => api.get('/tax-regimes').then((r) => r.data) });
  const [editing, setEditing] = useState(false);
  const [editPt, setEditPt] = useState(null);
  const [publishRegime, setPublishRegime] = useState(null);
  // Version history: { kind: 'rates' } | { kind: 'pt', state } | { kind: 'tax', code }
  const [history, setHistory] = useState(null);
  const c = rates.data?.current;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Statutory rules"
        description="Rates are company-wide data with an effective date, editable without code. A payroll run records which rates row it used, so reopening an old month never applies today's rates to it."
        actions={
          <>
            <Button variant="outline" onClick={() => setHistory({ kind: 'rates' })} disabled={!rates.data?.versions.length}>
              <History /> Rates history ({rates.data?.versions.length ?? 0})
            </Button>
            <Button onClick={() => setEditing(true)} disabled={!c}>
              <Pencil /> Publish new rates
            </Button>
          </>
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
            <CardBody className="text-[14px]">
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
              <p className="mt-2 text-[13px] text-muted-foreground">
                The ceiling is the only limit. With restrict-to-ceiling on, PF runs on at most {formatINR(c.pf.ceiling)} of wages, so the most anyone pays is {c.pf.employee_pct}% of that —{' '}
                {formatINR(pfMaxContribution(c.pf).employee)} — and the company matches it ({formatINR(pfMaxContribution(c.pf).total)} together). Pension stays on the statutory{' '}
                {formatINR(c.pf.eps_wage_ceiling)}. Which components form the base is one tick per component in the salary structure.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="ESI" />
            <CardBody className="text-[14px]">
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
              <p className="mt-2 text-[13px] text-muted-foreground">
                Both rounded up to the rupee. Eligibility uses selected fixed ESI wages, excluding OT. Contributions use selected earned wages after LOP, with off-day pay. Overtime is {c.esi.include_overtime === false ? 'excluded by this configuration' : 'included (standard treatment)' }.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Recovery and gratuity" />
            <CardBody className="text-[14px]">
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className="py-1.5 text-muted-foreground">Recovery cap</td>
                    <td className="text-right num">{c.recovery_cap_pct}% of gross − statutory</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[13px] text-muted-foreground">
                Gratuity is set per pay group: create a gratuity policy under{' '}
                <Link to="/setup/policies" className="text-primary hover:underline">
                  Setup → Policies
                </Link>{' '}
                and attach it to the group.
              </p>
            </CardBody>
          </Card>
        </div>
      )}
      <Card>
        <CardHeader
          title="Professional tax"
          description="Charged by the employee's own PT state. Andhra Pradesh and Telangana are confirmed; verify other states against the current schedules before relying on them. Tamil Nadu (half-yearly) is not built."
        />
        {pt.isLoading ? (
          <SkeletonBlock className="h-40" />
        ) : pt.isError ? (
          <ErrorState error={pt.error} />
        ) : (
          <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
            {pt.data.map((s) => (
              <div key={s.state} className="rounded-md border p-3 text-[14px]">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium">
                    {s.state}
                    {s.valid_from && s.valid_from !== '2000-01-01' && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">from {s.valid_from}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <Chip>{s.headcount} people</Chip>
                    {s.versions?.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setHistory({ kind: 'pt', state: s.state })} aria-label={`${s.state} version history`} title="Version history">
                        <History /> {s.versions.length}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setEditPt(s)} aria-label={`Edit ${s.state}`}>
                      <Pencil />
                    </Button>
                  </span>
                </div>
                {!s.slabs.length ? (
                  <p className="text-muted-foreground">No professional tax</p>
                ) : (
                  <table className="w-full text-[13px]">
                    <tbody>
                      {s.slabs.map((x, i) => {
                        const prev = s.slabs
                          .slice(0, i)
                          .filter((y) => y.gender_scope === x.gender_scope)
                          .at(-1);
                        return (
                          <tr key={x.id} className="border-t">
                            <td className="py-1">
                              {x.gender_scope !== 'ALL' && <span className="text-muted-foreground">{x.gender_scope === 'MALE' ? 'Men ' : 'Women '}</span>}
                              {prev ? `${formatINR((prev.upto_amount ?? 0) + 100)} – ` : 'Up to '}
                              {x.upto_amount === null ? 'above' : formatINR(x.upto_amount)}
                            </td>
                            <td className="text-right">
                              {x.amount ? <Money value={x.amount} /> : 'Nil'}
                              {x.feb_amount !== null && (
                                <span className="text-muted-foreground">
                                  {' '}
                                  · Feb <Money value={x.feb_amount} />
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
            <button
              onClick={() => setEditPt({ state: '', headcount: 0, slabs: [] })}
              className="flex items-center justify-center gap-2 rounded-md border border-dashed p-3 text-[14px] text-muted-foreground hover:bg-accent"
            >
              <Plus className="size-4" /> Add a state
            </button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Income tax regimes"
          description="Everyone defaults to the new regime. Each tax year's rates start on 1 April; confirm them against the Finance Act before the year's first run. Monthly TDS nets what was already deducted this year. Surcharge above ₹50 lakh is not built."
          actions={regimes.data?.length ? <Button variant="outline" onClick={() => setPublishRegime(regimes.data[0])}><Plus /> Publish a tax year</Button> : null}
        />
        {regimes.isLoading ? (
          <SkeletonBlock className="h-40" />
        ) : regimes.isError ? (
          <ErrorState error={regimes.error} />
        ) : (
          <div className="grid gap-4 p-3 md:grid-cols-2">
            {regimes.data.map((r) => (
              <div key={r.id} className="rounded-md border p-3 text-[14px]">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-display font-semibold">
                    {r.name}
                    <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">{r.from_start ? `from ${r.valid_from} (and earlier)` : `from ${r.valid_from}`}{r.valid_to ? ` to ${r.valid_to}` : ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Chip>{r.headcount} people</Chip>
                    <Button size="sm" variant="ghost" onClick={() => setHistory({ kind: 'tax', code: r.code })} aria-label={`${r.code} regime version history`} title="Version history">
                      <History />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPublishRegime(r)} aria-label={`Publish a tax year from ${r.name}`}>
                      <Pencil />
                    </Button>
                  </span>
                </div>
                <table className="w-full text-[13px]">
                  <tbody>
                    {r.slabs.map((s, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1">
                          {i === 0 ? 'Up to' : `${formatINR(r.slabs[i - 1].upto_amount)} –`} {s.upto_amount === null ? 'above' : formatINR(s.upto_amount)}
                        </td>
                        <td className="text-right num">{s.rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[13px] text-muted-foreground">
                  Standard deduction {formatINR(r.std_deduction)} · rebate {r.rebate_max === null ? 'in full' : `up to ${formatINR(r.rebate_max)}`} up to {formatINR(r.rebate_limit)} taxable · marginal
                  relief {r.marginal_relief ? 'yes' : 'no'} · 80C/HRA {r.allows_80c ? 'allowed' : 'not allowed'} · cess {r.cess_pct}%
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>
      {editing && c && <RatesDialog current={c} onClose={() => setEditing(false)} />}
      {editPt && <PtDialog state={editPt} onClose={() => setEditPt(null)} />}
      {publishRegime && <RegimeDialog from={publishRegime} onClose={() => setPublishRegime(null)} />}
      {history?.kind === 'rates' && rates.data && (
        <VersionHistory
          title="Statutory rates history"
          rows={rates.data.versions.map((v) => ({ key: v.id, from: v.valid_from, to: v.valid_to, fromStart: v.from_start, current: v.id === c?.id,
            summary: `PF ${v.pf.employee_pct}% up to ${formatINR(v.pf.ceiling)} · ESI ${v.esi.employee_pct}% + ${v.esi.employer_pct}% within ${formatINR(v.esi.ceiling)} · recovery cap ${Number(v.recovery_cap_pct)}%` }))}
          remove={(row) => api.delete(`/statutory-rates/${row.key}`)}
          queryKey={['statutory-rates']}
          onClose={() => setHistory(null)}
        />
      )}
      {history?.kind === 'pt' && pt.data && (() => {
        const st = pt.data.find((x) => x.state === history.state);
        if (!st) return null;
        return (
          <VersionHistory
            title={`${st.state}: professional tax history`}
            rows={st.versions.map((v) => ({ key: v.valid_from, from: v.valid_from, to: v.valid_to, fromStart: v.from_start, current: v.valid_from === st.valid_from,
              summary: v.slabs.length ? v.slabs.map((x) => `${x.upto_amount === null ? 'above' : `≤ ${formatINR(x.upto_amount)}`}: ${x.amount ? formatINR(x.amount) : 'nil'}`).join(' · ') : 'No professional tax' }))}
            remove={(row) => api.delete(`/pt-slabs/${encodeURIComponent(st.state)}/versions/${row.key}`)}
            queryKey={['pt-slabs']}
            onClose={() => setHistory(null)}
          />
        );
      })()}
      {history?.kind === 'tax' && regimes.data && (
        <VersionHistory
          title={`${history.code === 'NEW' ? 'New' : 'Old'} regime: tax years`}
          rows={regimes.data.filter((r) => r.code === history.code).map((r) => ({ key: r.id, from: r.valid_from, to: r.valid_to, fromStart: r.from_start, current: false,
            summary: `${r.name} · standard deduction ${formatINR(r.std_deduction)} · ${r.slabs.length} slabs` }))}
          remove={(row) => api.delete(`/tax-regimes/${row.key}`)}
          queryKey={['tax-regimes']}
          onClose={() => setHistory(null)}
        />
      )}
    </div>
  );
}

/**
 * The versions of a dated setting, newest first. Each runs until the day before the next;
 * the earliest also covers the time before it. Deleting one hands its dates to the one before
 * (or, for the earliest, to the next). Locked or paid payroll refuses a delete that reaches it.
 */
function VersionHistory({ title, rows, remove, queryKey, onClose }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(null);
  const del = useMutation({
    mutationFn: (row) => remove(row),
    onSuccess: () => {
      toast.success('Version deleted. Generated months it touched are flagged to be regenerated.');
      setConfirm(null);
      qc.invalidateQueries({ queryKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const heir = (row) => {
    const i = rows.indexOf(row);
    if (rows.length === 1) return null;
    // Rows are newest first: the one before in time is the next row in the list.
    return i === rows.length - 1 ? `${rows[i - 1].from} will then apply from the start.` : `${rows[i + 1].from} will run on${row.to ? ` until ${row.to}` : ''}.`;
  };
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description="Each version applies from its date until the day before the next one; the earliest also covers the time before it. Versions never overlap. Locked or paid payroll keeps the version it used."
    >
      <table className="w-full text-[14px]">
        <thead className="text-left text-[13px] text-muted-foreground">
          <tr><th className="pb-2 font-medium">Dates</th><th className="pb-2 font-medium">Rates</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t align-top">
              <td className="py-2.5 pr-3 whitespace-nowrap">
                {row.fromStart ? `From the start` : row.from}
                <div className="text-muted-foreground">to {row.to ?? 'ongoing'}</div>
                {row.fromStart && <div className="text-[12px] text-muted-foreground">(dated {row.from})</div>}
                {row.current && <Chip tone="success">In force</Chip>}
              </td>
              <td className="py-2.5 pr-3 text-[13px]">{row.summary}</td>
              <td className="py-2.5 text-right">
                <Button size="sm" variant="ghost" className="text-destructive" disabled={rows.length === 1} title={rows.length === 1 ? 'The only version: publish a correction on the same date instead.' : undefined} aria-label={`Delete the version from ${row.from}`} onClick={() => setConfirm(row)}>
                  <Trash2 /> Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirm && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`Delete the version from ${confirm.from}?`}
          description={heir(confirm) ?? ''}
          footer={<><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="destructive" loading={del.isPending} onClick={() => del.mutate(confirm)}>Delete version</Button></>}
        >
          <p className="text-[14px]">Refused if it would change a month whose payroll is locked or paid.</p>
        </Dialog>
      )}
    </Dialog>
  );
}

function RatesDialog({ current, onClose }) {
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
    esi_include_ot: current.esi.include_overtime !== false ? 'include' : 'exclude',
    cap: String(current.recovery_cap_pct),
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch('/statutory-rates', {
        valid_from: f.valid_from,
        pf: {
          employee_pct: Number(f.pf_emp),
          employer_pct: Number(f.pf_er),
          ceiling: toPaise(f.ceiling),
          eps_pct: Number(f.eps),
          eps_wage_ceiling: toPaise(f.eps_ceiling),
          edli_pct: Number(f.edli),
          admin_pct: Number(f.admin),
        },
        esi: { ceiling: toPaise(f.esi_ceiling), employee_pct: Number(f.esi_emp), employer_pct: Number(f.esi_er), include_overtime: f.esi_include_ot === 'include' },
        recovery_cap_pct: Number(f.cap),
      }),
    onSuccess: () => {
      toast.success('New rates published');
      qc.invalidateQueries({ queryKey: ['statutory-rates'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const num = (k, label, suffix = '%') => (
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
  const money = (k, label, hint) => (
    <Field label={label} hint={hint}>
      {(id) => <MoneyInput id={id} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
    </Field>
  );
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
        <Field label="Overtime in ESI contributions" className="sm:col-span-2" hint="Standard ESI treatment includes OT in contributions, but not in the eligibility ceiling. Confirm any exclusion with your payroll adviser.">
          {(id) => <Select id={id} value={f.esi_include_ot} onChange={(e) => setF({ ...f, esi_include_ot: e.target.value })}>
            <option value="include">Include overtime (standard)</option>
            <option value="exclude">Exclude overtime</option>
          </Select>}
        </Field>
        {num('cap', 'Recovery cap')}
      </div>
    </Dialog>
  );
}

function PtDialog({ state, onClose }) {
  const qc = useQueryClient();
  const [name, setName] = useState(state.state);
  const [from, setFrom] = useState('');
  const [rows, setRows] = useState(state.slabs.map((s) => ({ gender_scope: s.gender_scope, upto: toRupeesInput(s.upto_amount), amount: toRupeesInput(s.amount), feb: toRupeesInput(s.feb_amount) })));
  useEffect(() => void 0, []);
  const save = useMutation({
    mutationFn: () =>
      api.patch('/pt-slabs', {
        state: name,
        ...(from ? { valid_from: from } : {}),
        slabs: rows.map((r) => ({
          state: name,
          gender_scope: r.gender_scope,
          upto_amount: r.upto ? toPaise(r.upto) : null,
          amount: toPaise(r.amount || '0'),
          feb_amount: r.feb ? toPaise(r.feb) : null,
        })),
      }),
    onSuccess: (r) => {
      toast.success(`Slabs saved, in force from ${r.data.valid_from}`);
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
      description="Slabs are inclusive upper bounds of monthly gross. Leave the last slab's upper bound blank. No slabs means the state levies no professional tax. Earlier months keep the slabs in force then."
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
        <Field label="Effective from" hint="Leave blank for the first month that is not locked or paid.">
          {(id) => <Input id={id} type="date" className="max-w-xs" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
        <table className="text-[14px]">
          <thead className="text-left text-[13px] text-muted-foreground">
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
                  <Select value={r.gender_scope} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, gender_scope: e.target.value } : x)))} aria-label="Applies to">
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

/** Publish a regime's rates for a tax year, starting from an existing year's figures. */
function RegimeDialog({ from, onClose }) {
  const qc = useQueryClient();
  const nextYear = Number(from.valid_from.slice(0, 4)) + 1;
  const [f, setF] = useState({
    code: from.code,
    name: from.name,
    year: String(nextYear),
    std: toRupeesInput(from.std_deduction),
    rebateLimit: toRupeesInput(from.rebate_limit),
    rebateMax: from.rebate_max === null ? '' : toRupeesInput(from.rebate_max),
    marginal: from.marginal_relief,
    allows80c: from.allows_80c,
    allowsHra: from.allows_hra,
    cess: String(from.cess_pct),
  });
  const [slabs, setSlabs] = useState(from.slabs.map((x) => ({ upto: x.upto_amount === null ? '' : toRupeesInput(x.upto_amount), rate: String(x.rate) })));
  const save = useMutation({
    mutationFn: () =>
      api.post('/tax-regimes', {
        code: f.code,
        name: f.name,
        valid_from: `${f.year}-04-01`,
        std_deduction: toPaise(f.std || '0'),
        rebate_limit: toPaise(f.rebateLimit || '0'),
        rebate_max: f.rebateMax ? toPaise(f.rebateMax) : null,
        marginal_relief: f.marginal,
        allows_80c: f.allows80c,
        allows_hra: f.allowsHra,
        cess_pct: Number(f.cess),
        slabs: slabs.map((x, i) => ({ upto_amount: i === slabs.length - 1 ? null : toPaise(x.upto || '0'), rate: Number(x.rate) })),
      }),
    onSuccess: () => {
      toast.success(`Rates for tax year ${f.year}-${String(Number(f.year) + 1).slice(2)} published`);
      qc.invalidateQueries({ queryKey: ['tax-regimes'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const money = (k, label, hint) => (
    <Field label={label} hint={hint}>
      {(id) => <MoneyInput id={id} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
    </Field>
  );
  const flag = (k, label) => (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={f[k] ? 'yes' : 'no'} onChange={(e) => setF({ ...f, [k]: e.target.value === 'yes' })}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      )}
    </Field>
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="Publish a tax year"
      description="The rates start on 1 April of the year chosen and apply to the whole tax year. Re-publishing a year corrects it, until its payroll is locked."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.name.trim() || slabs.length === 0} loading={save.isPending} onClick={() => save.mutate()}>
            Publish
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Regime">
          {(id) => (
            <Select id={id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>
              <option value="NEW">New regime</option>
              <option value="OLD">Old regime</option>
            </Select>
          )}
        </Field>
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Tax year starting April" hint={`${f.year}-${String(Number(f.year) + 1).slice(2)}`}>
          {(id) => <Input id={id} type="number" min={2000} max={2100} value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} className="num" />}
        </Field>
        <Field label="Cess">{(id) => <Input id={id} value={f.cess} onChange={(e) => setF({ ...f, cess: e.target.value })} className="num" />}</Field>
        {money('std', 'Standard deduction')}
        {money('rebateLimit', 'Rebate up to taxable')}
        {money('rebateMax', 'Rebate at most', 'Blank: the full tax')}
        {flag('marginal', 'Marginal relief')}
        {flag('allows80c', '80C and 80D allowed')}
        {flag('allowsHra', 'HRA exemption allowed')}
      </div>
      <table className="mt-4 text-[14px]">
        <thead className="text-left text-[13px] text-muted-foreground">
          <tr>
            <th>Taxable income up to</th>
            <th>Rate</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {slabs.map((x, i) => (
            <tr key={i}>
              <td className="py-1 pr-2">
                {i === slabs.length - 1 ? (
                  <span className="text-muted-foreground">and above</span>
                ) : (
                  <MoneyInput value={x.upto} onChange={(e) => setSlabs(slabs.map((y, j) => (j === i ? { ...y, upto: e.target.value } : y)))} aria-label="Up to" />
                )}
              </td>
              <td className="py-1 pr-2">
                <Input value={x.rate} onChange={(e) => setSlabs(slabs.map((y, j) => (j === i ? { ...y, rate: e.target.value } : y)))} aria-label="Rate %" className="w-20 num" />
              </td>
              <td>
                <Button size="icon" variant="ghost" onClick={() => setSlabs(slabs.filter((_, j) => j !== i))} aria-label="Remove slab">
                  <Trash2 />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={() => setSlabs([...slabs.slice(0, -1), { upto: '', rate: '' }, ...slabs.slice(-1)])}>
        <Plus /> Add slab
      </Button>
    </Dialog>
  );
}
