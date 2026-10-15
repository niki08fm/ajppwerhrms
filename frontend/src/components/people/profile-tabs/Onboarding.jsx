import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, CircleDot, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { cn, istTime } from '@/utils';
import { Chip } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { BankStep, IdentityStep, JoiningLetterStep, PayStep, PersonalStep, StatutoryStep, TickStep } from './OnboardingSteps';

/** The order HR works through joining: who they are, how they are paid, then the letter and inductions. */
const ORDER = ['PERSONAL', 'IDENTITY', 'BANK', 'PAY', 'STATUTORY', 'JOINING_LETTER', 'SAFETY', 'MEDICAL', 'ORIENTATION'];
const FORMS = {
  PERSONAL: PersonalStep,
  IDENTITY: IdentityStep,
  BANK: BankStep,
  PAY: PayStep,
  STATUTORY: StatutoryStep,
  JOINING_LETTER: JoiningLetterStep,
};
/** What a data step still needs before it counts as done. */
const NEEDS = {
  PERSONAL: 'Date of birth, address and phone complete this step.',
  IDENTITY: 'PAN and Aadhaar complete this step.',
  BANK: 'An account number and IFSC complete this step.',
};

/**
 * Joining, step by step: each step opens its form beside the list, saving it ticks the step,
 * and the person is activated once, when every required step is done.
 */
export function OnboardingTab({ e }) {
  const qc = useQueryClient();
  // Stale profile responses may still contain the retired FACE checklist item. Steps this screen does not know come last.
  const known = e.onboarding.items.filter((it) => it.code !== 'FACE');
  const items = [...ORDER.map((code) => known.find((it) => it.code === code)).filter(Boolean), ...known.filter((it) => !ORDER.includes(it.code))];
  const firstOpen = items.find((it) => !it.done_at)?.code ?? items[0]?.code;
  const [current, setCurrent] = useState(firstOpen);
  useEffect(() => {
    if (!items.some((it) => it.code === current)) setCurrent(firstOpen);
  }, [items, current, firstOpen]);

  const required = items.filter((it) => it.required);
  const requiredLeft = required.filter((it) => !it.done_at).length;
  const editable = e.status === 'ONBOARDING' && !e.read_only;
  const next = (code) => () => {
    const i = items.findIndex((it) => it.code === code);
    // The next step after this one that is not done, else the next one in order.
    const after = items.slice(i + 1);
    setCurrent((after.find((it) => !it.done_at) ?? after[0] ?? items.find((it) => !it.done_at) ?? items[i])?.code);
  };

  const activate = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/activate`),
    onSuccess: () => {
      toast.success(`${e.name} is active. They appear in attendance from their joining date and in the next payroll run.`);
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['people'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const item = items.find((it) => it.code === current);
  const Form = item && (FORMS[item.code] ?? TickStep);
  const index = item ? items.indexOf(item) + 1 : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(16rem,20rem)_1fr]">
      <Card className="h-fit overflow-hidden">
        <CardHeader
          title="Onboarding"
          description={requiredLeft ? `${required.length - requiredLeft} of ${required.length} required steps done.` : 'All required steps are done.'}
        />
        <ol className="divide-y border-t">
          {items.map((it, i) => {
            const active = it.code === current;
            return (
              <li key={it.code}>
                <button
                  type="button"
                  onClick={() => setCurrent(it.code)}
                  aria-current={active ? 'step' : undefined}
                  className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left text-[14px] hover:bg-accent', active && 'bg-accent font-medium')}
                >
                  {it.done_at ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Done" />
                  ) : active ? (
                    <CircleDot className="size-4 shrink-0 text-primary" aria-label="Open" />
                  ) : (
                    <Circle className="size-4 shrink-0 text-muted-foreground" aria-label="To do" />
                  )}
                  <span className="flex-1">
                    {i + 1}. {it.label}
                  </span>
                  {!it.required && <span className="text-[12px] text-muted-foreground">Optional</span>}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-col gap-2 border-t p-4 text-[14px]">
          {e.status === 'ONBOARDING' ? (
            <>
              <Button size="lg" disabled={requiredLeft > 0 || e.read_only} loading={activate.isPending} onClick={() => activate.mutate()}>
                <Rocket /> {requiredLeft > 0 ? `${requiredLeft} required step${requiredLeft > 1 ? 's' : ''} left` : 'Activate'}
              </Button>
              <p className="m-0 text-[13px] text-muted-foreground">
                Nobody is paid before activation. Activating adds {e.name.split(' ')[0]} to attendance from the joining date ({e.joined_on}) and to the next payroll run.
              </p>
            </>
          ) : (
            <p className="m-0">
              Status: <strong>{e.status.toLowerCase()}</strong>.{' '}
              {e.status === 'ACTIVE' ? 'Activated.' : e.status === 'OFFER' || e.status === 'ACCEPTED' ? 'Start onboarding from Offers and onboarding.' : ''}
            </p>
          )}
        </div>
      </Card>

      {item && (
        <Card className="h-fit">
          <CardHeader
            title={`${index}. ${item.label}`}
            description={
              item.done_at
                ? `Done ${istTime(item.done_at, true)} by ${item.done_by}.`
                : NEEDS[item.code] ?? (item.required ? 'Required before activation.' : 'Optional.')
            }
            actions={item.done_at ? <Chip tone="success">Done</Chip> : item.required ? <Chip tone="info">Required</Chip> : <Chip>Optional</Chip>}
          />
          <div className="p-4">
            <Form key={`${item.code}-${e.updated_at}`} e={e} item={item} disabled={!editable} onSaved={next(item.code)} onSkip={next(item.code)} />
          </div>
        </Card>
      )}
    </div>
  );
}
