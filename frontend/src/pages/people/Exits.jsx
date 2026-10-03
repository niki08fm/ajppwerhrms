import { useCallback, useState } from 'react';
import { useNewFromUrl } from '@/hooks';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { UserMinus } from 'lucide-react';
import { api } from '@/services/api';
import { Money, PageHeader, PersonLink } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SeverityChip, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/overlay';
import { Select } from '@/components/ui/form';
import { exitName, longDate, monthLabel } from '@/utils';
import { ExitDialog } from '../../components/people/profile-tabs/Exit';
import { fnfStatus } from './SettlementStatement';

export default function Exits() {
  const q = useQuery({
    queryKey: ['exits'],
    queryFn: () => api.get('/settlements').then((r) => r.data),
  });
  const [picking, setPicking] = useState(false);
  useNewFromUrl(useCallback(() => setPicking(true), []));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Exits and settlement"
        description="Record an exit with its last working day — there is no notice period. On the person's exit screen, tick the checklist and process the F&F into a month's payroll, or record it as paid separately."
        actions={
          <Button onClick={() => setPicking(true)}>
            <UserMinus /> Record an exit
          </Button>
        }
      />

      <Card>
        <CardHeader title="Leaving" description="Each F&F is worked out live until it is paid. Open a person to finish their exit." />
        {q.isLoading ? (
          <SkeletonRows rows={5} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.open.length ? (
          <EmptyState title="Nobody is leaving" body="Record an exit from here or from the person's Exit tab." />
        ) : (
          <div className="overflow-x-auto"><table className="data-table w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Exit</th>
                <th>Last day</th>
                <th className="text-right">Earnings</th>
                <th className="text-right">Deductions</th>
                <th className="text-right">Net</th>
                <th>Clearance</th>
                <th>F&F</th>
              </tr>
            </thead>
            <tbody>
              {q.data.open.map((r) => {
                const live = r.live && 'net' in r.live ? r.live : null;
                return (
                  <tr key={r.employee.id}>
                    <td>
                      <Link to={`/people/${r.employee.id}?tab=exit`} className="font-medium hover:underline">
                        {r.employee.name}
                      </Link>{' '}
                      <span className="text-[13px] text-muted-foreground">{r.employee.department}</span>
                    </td>
                    <td>{exitName(r.exit_reason)}</td>
                    <td className="num">{longDate(r.last_day)}</td>
                    <td className="text-right">{live && <Money value={live.total_earnings} />}</td>
                    <td className="text-right">{live && <Money value={live.total_deductions} />}</td>
                    <td className="text-right font-medium">
                      {live && (live.net < 0 ? <Money value={-live.net} className="text-destructive" negativeLabel="" /> : <Money value={live.net} />)}{' '}
                      {live && live.net < 0 && <Chip tone="destructive">Recoverable</Chip>}
                    </td>
                    <td>
                      {r.live && 'error' in r.live ? (
                        <span className="text-[13px] text-destructive">{r.live.error}</span>
                      ) : live?.clearance.length ? (
                        <span className="flex flex-wrap gap-1">
                          {live.clearance.map((c) => (
                            <span key={c.code} title={c.message}>
                              <SeverityChip severity={c.severity} />
                            </span>
                          ))}
                        </span>
                      ) : (
                        <Chip tone="success">Clear</Chip>
                      )}
                    </td>
                    <td>{r.settlement ? <Chip tone={r.settlement.state === 'INCLUDED' ? 'info' : 'muted'}>{fnfStatus(r.settlement)}</Chip> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
      {q.data && q.data.recoverable.length > 0 && (
        <Card>
          <CardHeader title="Recoverable" description="A negative F&F never goes in a bank file. Each needs a deliberate decision to write it off or pursue it." />
          <ul className="divide-y text-[14px]">
            {q.data.recoverable.map((r) => (
              <li key={r.employee.id} className="flex items-center justify-between px-4 py-2">
                <PersonLink id={r.employee.id} name={r.employee.name} />
                <span className="flex items-center gap-2">
                  <Money value={r.amount} /> {r.decision ? <Chip>{r.decision === 'WRITE_OFF' ? 'Written off' : 'Pursuing'}</Chip> : <Chip tone="warning">Decision needed</Chip>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {q.data && q.data.paid.length > 0 && (
        <Card>
          <CardHeader title="Settled" />
          <div className="overflow-x-auto"><table className="data-table w-full">
            <tbody>
              {q.data.paid.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/exits/${s.employee.id}`} className="hover:underline">
                      {s.employee.name}
                    </Link>
                  </td>
                  <td className="num">Last day {longDate(s.last_day)}</td>
                  <td className="text-right">
                    <Money value={s.net} />
                  </td>
                  <td className="text-muted-foreground">{s.paid_separately ? `Paid separately on ${longDate(s.paid_separately.paid_on)} (${s.paid_separately.payment_ref})` : `Paid with ${monthLabel(s.period_ym)} payroll`}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
      {picking && <PickPerson onClose={() => setPicking(false)} />}
    </div>
  );
}

function PickPerson({ onClose }) {
  const q = useQuery({ queryKey: ['people', 'active-for-exit'], queryFn: () => api.get('/employees', { 'filter[status]': 'ACTIVE', limit: 200 }).then((r) => r.data) });
  const [id, setId] = useState('');
  const [go, setGo] = useState(false);
  const person = q.data?.find((p) => p.id === id);
  const exit = useQuery({ queryKey: ['exit', id], queryFn: () => api.get(`/employees/${id}/exit`).then((r) => r.data), enabled: go && !!id });
  if (go && person && exit.data) return <ExitDialog e={{ id: person.id, name: person.name }} x={exit.data} onClose={onClose} />;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Who is leaving?"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!id} loading={go && exit.isLoading} onClick={() => setGo(true)}>
            Continue
          </Button>
        </>
      }
    >
      <Select value={id} onChange={(e) => setId(e.target.value)} aria-label="Person">
        <option value="">Choose an active employee…</option>
        {q.data?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.code}) — {p.designation}
          </option>
        ))}
      </Select>
    </Dialog>
  );
}
