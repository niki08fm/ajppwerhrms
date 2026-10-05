import { Check } from 'lucide-react';
import { GENERATE_STEP, LAST_REVIEW_STEP, PAYROLL_STEPS } from '@ajpwer/shared';
import { cn, longDate } from '@/utils';
import { Chip } from '@/components/states';
import { Card } from '@/components/ui/card';

/** The first step not yet submitted, or 6 (generate) when all five are. */
export function currentStep(period) {
  for (let s = 1; s <= LAST_REVIEW_STEP; s++) if (!period.steps_submitted.includes(s)) return s;
  return GENERATE_STEP;
}

/** When and by whom a step was last submitted, from the step log. */
export function submittedBy(period, n) {
  const e = [...(period.step_log ?? [])].reverse().find((x) => x.step === n && x.action === 'submit');
  return e ? { by: e.by, on: String(e.at).slice(0, 10) } : null;
}

const SHORT = { 1: 'Attendance', 2: 'Joiners and exits', 3: 'Held salary', 4: 'F&F', 5: 'Adhoc', 6: 'Generate' };
export const stepLabel = (n) => SHORT[n] ?? PAYROLL_STEPS.find((s) => s.n === n)?.label ?? `Step ${n}`;

const STATE_WORD = { RUN: 'Generated', LOCKED: 'Locked', PAID: 'Paid' };

/**
 * The six steps of a month, in order: done, the one to do now, and the ones waiting.
 * A done step or the current one opens; a waiting one does not.
 */
export function StepTracker({ period, selected, onOpen, notes = {} }) {
  const cur = currentStep(period);
  const generated = period.state !== 'DRAFT';
  const done = (n) => (n === GENERATE_STEP ? generated : period.steps_submitted.includes(n));
  const doneCount = PAYROLL_STEPS.filter((s) => s.n <= LAST_REVIEW_STEP && period.steps_submitted.includes(s.n)).length;
  const head = generated
    ? { tone: period.state === 'PAID' ? 'success' : 'info', text: STATE_WORD[period.state] }
    : { tone: doneCount === LAST_REVIEW_STEP ? 'success' : 'warning', text: `${doneCount} of ${LAST_REVIEW_STEP} steps done` };
  const next = generated
    ? period.state === 'PAID'
      ? `Paid${period.payment_ref ? ` · ref ${period.payment_ref}` : ''}`
      : period.state === 'LOCKED'
        ? 'Payslips are final. Mark it paid once the bank transfer has gone.'
        : 'Check the generated payroll, then lock it.'
    : cur === GENERATE_STEP
      ? 'All five steps are submitted — generate the payroll.'
      : `Next: step ${cur} · ${stepLabel(cur)}${notes[cur] ? ` — ${notes[cur]}` : ''}`;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex items-center gap-2.5">
          <h3 className="m-0 font-semibold">Payroll steps</h3>
          <Chip tone={head.tone}>{head.text}</Chip>
        </div>
        <span className="text-[13px] text-muted-foreground">{next}</span>
      </div>
      <nav aria-label="Payroll steps" className="flex items-start overflow-x-auto px-4 py-4">
        {PAYROLL_STEPS.map((s, i) => {
          const d = done(s.n);
          const isCur = !d && !generated && s.n === cur;
          const waiting = !d && !isCur;
          const by = s.n !== GENERATE_STEP && d ? submittedBy(period, s.n) : null;
          const note = d
            ? s.n === GENERATE_STEP
              ? STATE_WORD[period.state]
              : by
                ? `Submitted ${longDate(by.on).replace(/ \d{4}$/, '')}`
                : 'Submitted'
            : isCur
              ? (notes[s.n] ?? 'To do now')
              : 'Waiting';
          return (
            <div key={s.n} className={cn('flex items-start', i > 0 && 'min-w-0 flex-1')}>
              {i > 0 && <span aria-hidden className={cn('mt-[19px] h-0.5 min-w-4 flex-1 rounded-full', done(s.n - 1) ? 'bg-primary' : 'bg-border')} />}
              <button
                type="button"
                disabled={waiting}
                aria-current={selected === s.n ? 'step' : undefined}
                onClick={() => onOpen(s.n)}
                className="group flex w-28 shrink-0 flex-col items-center gap-1.5 rounded-lg px-1 py-1 text-center disabled:cursor-default"
              >
                <span
                  className={cn(
                    'flex size-9 items-center justify-center rounded-full border-2 text-[13px] font-semibold transition-shadow',
                    d ? 'border-primary bg-primary text-primary-foreground' : isCur ? 'border-primary bg-card text-primary' : 'border-border bg-muted text-muted-foreground',
                    selected === s.n && 'ring-4 ring-primary/20',
                    !waiting && 'group-hover:ring-4 group-hover:ring-primary/15',
                  )}
                >
                  {d ? <Check className="size-4" /> : s.n}
                </span>
                <span className={cn('text-[13px] font-semibold leading-tight', waiting && 'text-muted-foreground')}>{stepLabel(s.n)}</span>
                <span className={cn('text-[12px] leading-tight', d ? 'text-success' : isCur ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground')}>{note}</span>
              </button>
            </div>
          );
        })}
      </nav>
    </Card>
  );
}
