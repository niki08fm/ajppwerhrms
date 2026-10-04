import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PauseCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { monthLabel } from '@/utils';
import { Money } from '@/components/bits';
import { Chip } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { heldMonthStatus, HoldDialog, ReleaseDialog } from '../../payroll/HoldDialogs';

export const useHold = (id) => useQuery({ queryKey: ['hold', id], queryFn: () => api.get(`/employees/${id}/hold`).then((r) => r.data) });

const TONE = { HELD: 'warning', QUEUED: 'info', PAID: 'success', PAID_SEPARATELY: 'success' };

function Months({ months }) {
  return (
    <ul className="divide-y text-sm">
      {months.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
          <span className="w-32 font-medium">{monthLabel(m.period_ym)}</span>
          <Money value={m.amount} className="w-24 text-right font-semibold" />
          <Chip tone={TONE[m.state]}>{heldMonthStatus(m)}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** Hold this person's salary, or release it — on their Pay tab, where HR looks for it. */
export function SalaryHoldCard({ e, compact = false }) {
  const qc = useQueryClient();
  const q = useHold(e.id);
  const [dialog, setDialog] = useState(null);
  const stop = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/hold/stop`, {}),
    onSuccess: () => {
      toast.success('Hold stopped. Nothing had been held.');
      for (const key of [['hold', e.id], ['held-salaries']]) qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const d = q.data;
  if (!d) return null;
  const cur = d.current;
  const canHold = (e.status === 'ACTIVE' || e.status === 'NOTICE') && !e.read_only;
  // Months released from earlier holds and still waiting to be paid, then everything settled.
  const pastMonths = d.history.flatMap((h) => h.months);
  if (!cur && !canHold && !pastMonths.length) return null;
  const held = cur?.months.filter((m) => m.state === 'HELD') ?? [];
  // Paid as usual and never held: just the one button.
  if (compact && !cur && !pastMonths.length)
    return (
      <>
        <Button variant="outline" onClick={() => setDialog('hold')}>
          <PauseCircle /> Hold salary
        </Button>
        {dialog === 'hold' && <HoldDialog employee={e} openMonths={d.open_months} onClose={() => setDialog(null)} />}
      </>
    );
  return (
    <Card className={cur ? 'border-warning/50' : undefined}>
      <CardHeader
        title={cur ? `Salary on hold since ${monthLabel(cur.from_ym)}` : 'Salary hold'}
        description={
          cur
            ? `${cur.reason} — held by ${cur.created_by}. Each month is calculated as usual and kept out of the bank file until released.`
            : 'Paid as usual. Holding a salary keeps it out of the bank file — still calculated, with PF, ESI and TDS — until you release it.'
        }
        actions={
          cur ? (
            <span className="flex gap-2">
              {held.length > 0 && (
                <Button size="sm" onClick={() => setDialog('release')}>
                  Release <Money value={held.reduce((a, m) => a + m.amount, 0)} />
                </Button>
              )}
              {!cur.months.length && (
                <Button size="sm" variant="outline" loading={stop.isPending} onClick={() => stop.mutate()}>
                  Stop holding
                </Button>
              )}
            </span>
          ) : (
            canHold && (
              <Button size="sm" variant="outline" onClick={() => setDialog('hold')}>
                <PauseCircle /> Hold salary
              </Button>
            )
          )
        }
      />
      {cur && (cur.months.length ? <Months months={cur.months} /> : <p className="px-5 py-3 text-[13px] text-muted-foreground">Nothing held yet: {monthLabel(cur.from_ym)} payroll has not been run.</p>)}
      {pastMonths.length > 0 && (
        <>
          <div className="border-t px-5 pt-3 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Held before</div>
          <Months months={pastMonths} />
        </>
      )}
      {dialog === 'hold' && <HoldDialog employee={e} openMonths={d.open_months} onClose={() => setDialog(null)} />}
      {dialog === 'release' && cur && <ReleaseDialog hold={{ ...cur, employee: { id: e.id, name: e.name } }} openMonths={d.open_months} runMonths={d.run_months} onClose={() => setDialog(null)} />}
    </Card>
  );
}
