import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PauseCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useNewFromUrl } from '@/hooks';
import { longDate, monthLabel } from '@/utils';
import { Money, PageHeader, PersonLink, Stat } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { heldMonthStatus, HoldDialog, ReleaseDialog } from '../../components/payroll/HoldDialogs';

const TONE = { HELD: 'warning', QUEUED: 'info', PAID: 'success', PAID_SEPARATELY: 'success' };

/** One hold: who, since when and why, and each held month with what became of it. */
function HoldRow({ h, onRelease, onStop, busy }) {
  const held = h.months.filter((m) => m.state === 'HELD');
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <PersonLink id={h.employee.id} name={h.employee.name} code={h.employee.code} tab="pay" />
          {!h.released_at ? <Chip tone="warning">On hold since {monthLabel(h.from_ym)}</Chip> : <Chip tone="muted">Released {longDate(String(h.released_at).slice(0, 10))}</Chip>}
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {h.reason} · held by {h.created_by}
          {h.release_note ? ` · ${h.release_note}` : ''}
        </p>
        {h.months.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {h.months.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="w-32 font-medium">{monthLabel(m.period_ym)}</span>
                <Money value={m.amount} className="w-24 text-right font-semibold" />
                <Chip tone={TONE[m.state]}>{heldMonthStatus(m)}</Chip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] text-muted-foreground">{h.released_at ? 'Nothing was held.' : `Nothing held yet: ${monthLabel(h.from_ym)} payroll has not been run.`}</p>
        )}
      </div>
      {!h.released_at || held.length ? (
        <div className="flex shrink-0 gap-2">
          {held.length > 0 && (
            <Button size="sm" onClick={() => onRelease(h)}>
              Release
            </Button>
          )}
          {!h.released_at && !h.months.length && (
            <Button size="sm" variant="outline" loading={busy} onClick={() => onStop(h)}>
              Stop holding
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Held salaries. A held month is calculated in its payroll and kept out of the bank file;
 * here HR sees every one and releases it — into a later payroll, or as paid separately.
 */
export default function HeldSalaries() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['held-salaries'], queryFn: () => api.get('/held-salaries').then((r) => r.data) });
  const [holding, setHolding] = useState(false);
  const [releasing, setReleasing] = useState(null);
  useNewFromUrl(useCallback(() => setHolding(true), []));
  const stop = useMutation({
    mutationFn: (h) => api.post(`/employees/${h.employee.id}/hold/stop`, {}),
    onSuccess: () => {
      toast.success('Hold stopped. Nothing had been held.');
      qc.invalidateQueries({ queryKey: ['held-salaries'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data;
  const open = d?.holds.filter((h) => !h.released_at || h.months.some((m) => m.state === 'HELD' || m.state === 'QUEUED')) ?? [];
  const past = d?.holds.filter((h) => !open.includes(h)) ?? [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Held salaries"
        description="A held salary is calculated in its month's payroll — payslip, PF, ESI, TDS — and kept out of the bank file. Release it into a later payroll, where it is paid as its own line, or record it as paid separately. Each held month is paid once."
        actions={
          <Button onClick={() => setHolding(true)} disabled={!d}>
            <PauseCircle /> Hold a salary
          </Button>
        }
      />
      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="On hold now" value={d.totals.standing} sub={d.totals.standing === 1 ? 'person' : 'people'} tone={d.totals.standing ? 'warning' : undefined} />
            <Stat label="Held, not yet released" value={<Money value={d.totals.unpaid} />} sub={`${d.totals.unpaid_months} month${d.totals.unpaid_months === 1 ? '' : 's'}`} />
            <Stat label="Next payroll not yet run" value={monthLabel(d.open_months[0])} sub="a new hold can start here" />
          </div>
          <Card>
            <CardHeader title="On hold and to be paid" description="Release a held salary once it is decided. Months released into a payroll are paid when that payroll runs." />
            {open.length ? (
              <ul className="divide-y">
                {open.map((h) => (
                  <HoldRow key={h.id} h={h} onRelease={setReleasing} onStop={(x) => stop.mutate(x)} busy={stop.isPending && stop.variables?.id === h.id} />
                ))}
              </ul>
            ) : (
              <EmptyState title="Nobody's salary is held" body="Hold one from here, from the person's Pay tab, or from step 3 of a payroll." />
            )}
          </Card>
          {past.length > 0 && (
            <Card>
              <CardHeader title="Released and paid" />
              <ul className="divide-y">
                {past.map((h) => (
                  <HoldRow key={h.id} h={h} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      {holding && d && <HoldDialog openMonths={d.open_months} onClose={() => setHolding(false)} />}
      {releasing && d && <ReleaseDialog hold={releasing} openMonths={d.open_months} runMonths={d.run_months} onClose={() => setReleasing(null)} />}
    </div>
  );
}
