import { useState } from 'react';
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
import { ResignDialog } from '../../components/people/profile-tabs/Exit';

export default function Exits() {
  const q = useQuery({
    queryKey: ['exits'],
    queryFn: () => api.get('/settlements').then((r) => r.data),
  });
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Exits and settlement"
        description="Settlements are computed live while someone is on notice and frozen when paid with the payroll run for the month their last day falls in."
        actions={
          <Button onClick={() => setPicking(true)}>
            <UserMinus /> Record a resignation
          </Button>
        }
      />

      <Card>
        <CardHeader title="On notice" />
        {q.isLoading ? (
          <SkeletonRows rows={5} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.open.length ? (
          <EmptyState title="Nobody is leaving" body="Record a resignation from here or from the person's Exit tab." />
        ) : (
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Last day</th>
                <th className="text-right">Earnings</th>
                <th className="text-right">Deductions</th>
                <th className="text-right">Net</th>
                <th>Clearance</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {q.data.open.map((r) => {
                const live = r.live && 'net' in r.live ? r.live : null;
                return (
                  <tr key={r.employee.id}>
                    <td>
                      <Link to={`/exits/${r.employee.id}`} className="font-medium hover:underline">
                        {r.employee.name}
                      </Link>{' '}
                      <span className="text-[12px] text-muted-foreground">{r.employee.department}</span>
                    </td>
                    <td className="num">{r.last_day}</td>
                    <td className="text-right">{live && <Money value={live.total_earnings} />}</td>
                    <td className="text-right">{live && <Money value={live.total_deductions} />}</td>
                    <td className="text-right font-medium">
                      {live && (live.net < 0 ? <Money value={-live.net} className="text-destructive" negativeLabel="" /> : <Money value={live.net} />)}{' '}
                      {live && live.net < 0 && <Chip tone="destructive">Recoverable</Chip>}
                    </td>
                    <td>
                      {r.live && 'error' in r.live ? (
                        <span className="text-[12px] text-destructive">{r.live.error}</span>
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
                    <td>{r.settlement ? <Chip tone={r.settlement.state === 'INCLUDED' ? 'info' : 'default'}>{r.settlement.state === 'INCLUDED' ? 'Ticked for a run' : 'Open'}</Chip> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {q.data && q.data.recoverable.length > 0 && (
        <Card>
          <CardHeader title="Recoverable" description="Negative settlements never enter the bank file. Each needs a deliberate decision to write off or pursue." />
          <ul className="divide-y text-[13px]">
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
          <table className="data-table w-full">
            <tbody>
              {q.data.paid.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/exits/${s.employee.id}`} className="hover:underline">
                      {s.employee.name}
                    </Link>
                  </td>
                  <td className="num">Last day {s.last_day}</td>
                  <td className="text-right">
                    <Money value={s.net} />
                  </td>
                  <td className="num text-muted-foreground">Paid {s.paid_at?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  if (go && person) return <ResignDialog e={{ id: person.id, name: person.name, notice_days: 30 }} onClose={onClose} />;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Who is resigning?"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!id} onClick={() => setGo(true)}>
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
