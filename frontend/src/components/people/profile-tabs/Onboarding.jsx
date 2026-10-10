import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '@/services/api';
import { istTime } from '@/utils';
import { Chip } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/overlay';

/** A step that needs data opens the thing it is about. Face registration happens at a site after activation. */
export function OnboardingTab({ e }) {
  const qc = useQueryClient();
  const [, setSp] = useSearchParams();
  const refresh = () => qc.invalidateQueries({ queryKey: ['employee', e.id] });
  const goTab = (t) =>
    setSp((p) => {
      const n = new URLSearchParams(p);
      n.set('tab', t);
      return n;
    });

  const tick = useMutation({
    mutationFn: ({ code, done }) => api.post(`/employees/${e.id}/onboarding/${code}`, { done }),
    onSuccess: refresh,
    onError: (err, vars) => {
      const opens = err instanceof ApiError ? err.details?.opens : undefined;
      toast.message(errorMessage(err), { description: opens ? 'Opening it now.' : undefined });
      if (opens === 'edit') goTab('overview');
      else if (opens === 'letters') goTab('letters');
      else if (opens === 'pay') goTab('pay');
      void vars;
    },
  });
  const activate = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/activate`),
    onSuccess: () => {
      toast.success(`${e.name} is active. They appear in attendance from their joining date and in the next payroll run.`);
      refresh();
      qc.invalidateQueries({ queryKey: ['people'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Stale profile responses may still contain the retired FACE checklist item.
  const items = e.onboarding.items.filter((it) => it.code !== 'FACE');
  const ob = {
    items,
    total: items.length,
    done: items.filter((it) => it.done_at).length,
    required_left: items.filter((it) => it.required && !it.done_at).length,
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title="Onboarding checklist"
          description={`${ob.done} of ${ob.total} done. ${ob.required_left ? `${ob.required_left} required step${ob.required_left > 1 ? 's' : ''} left.` : 'All required steps are done.'}`}
        />
        <ul className="divide-y">
          {ob.items.map((it) => (
            <li key={it.code} className="flex items-center gap-3 px-4 py-2.5">
              <Checkbox label={it.label} checked={!!it.done_at} disabled={e.read_only || tick.isPending} onCheckedChange={(v) => tick.mutate({ code: it.code, done: v })} />
              <div className="flex-1">
                <div className="flex items-center gap-2 text-[14px]">
                  {it.label} {it.required ? <Chip tone="info">Required</Chip> : <Chip>Optional</Chip>}
                </div>
                {it.done_at && (
                  <div className="text-[13px] text-muted-foreground">
                    Done {istTime(it.done_at, true)} by {it.done_by}
                  </div>
                )}
              </div>
              {it.done_at ? <CheckCircle2 className="size-4 text-success" aria-label="Done" /> : <Circle className="size-4 text-muted-foreground" aria-label="Not done" />}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Activate" />
        <div className="flex flex-col gap-3 p-4 text-[14px]">
          {e.status === 'ONBOARDING' ? (
            <>
              <p className="text-muted-foreground">Nobody is paid before activation. Activating adds {e.name.split(' ')[0]} to attendance from the joining date and to the next payroll run.</p>
              <Button size="lg" disabled={ob.required_left > 0} loading={activate.isPending} onClick={() => activate.mutate()}>
                <Rocket /> {ob.required_left > 0 ? `${ob.required_left} required step${ob.required_left > 1 ? 's' : ''} remain` : 'Activate'}
              </Button>
            </>
          ) : (
            <p>
              Status: <strong>{e.status.toLowerCase()}</strong>.{' '}
              {e.status === 'ACTIVE' ? 'Activated.' : e.status === 'OFFER' || e.status === 'ACCEPTED' ? 'Start onboarding from Offers and onboarding.' : ''}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
