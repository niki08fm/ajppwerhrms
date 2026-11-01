import { payrollStepLabel } from '@/utils/payroll-workflow';
import { Check } from 'lucide-react';
import { GENERATE_STEP, LAST_REVIEW_STEP, PAYROLL_STEPS } from '@ajpwer/shared';
import { cn, longDate } from '@/utils';
import { Chip } from '@/components/states';
import { Card } from '@/components/ui/card';

/** The first review not yet submitted, or the generate stage when all are ready. */
export function currentStep(period) {
  for (let s = 1; s <= LAST_REVIEW_STEP; s++) if (!period.steps_submitted.includes(s)) return s;
  return GENERATE_STEP;
}

/** When and by whom a step was last submitted, from the step log. */
export function submittedBy(period, n) {
  const e = [...(period.step_log ?? [])].reverse().find((x) => x.step === n && x.action === 'submit');
  return e ? { by: e.by, on: String(e.at).slice(0, 10) } : null;
}

export const stepLabel = payrollStepLabel;

const STATE_WORD = { RUN: 'Generated', LOCKED: 'Locked', PAID: 'Paid' };

/**
 * The seven steps of a month, in order: done, the one to do now, and the ones waiting.
 * A done step or the current one opens; a waiting one does not.
 */
const REVIEW_DETAIL = {
  1: 'Paid days, absences and overtime',
  2: 'Joining dates and last working days',
  3: 'Bank, tax and statutory details',
  4: 'Salaries to hold or release',
  5: 'Settlements to pay or defer',
  6: 'Bonuses, deductions and recoveries',
  7: 'Payslips, bank files and reports',
};

export function StepTracker({ period, selected, onOpen, notes = {}, detailed = false, horizontal = false }) {
  if (horizontal) return <HorizontalStepTracker period={period} selected={selected} onOpen={onOpen} notes={notes} />;
  const cur = currentStep(period);
  const generated = period.state !== 'DRAFT';
  const done = (n) => n === GENERATE_STEP ? generated : period.steps_submitted.includes(n);
  const doneCount = period.steps_submitted.filter((n) => n <= LAST_REVIEW_STEP).length;
  return (
    <Card className={cn('payroll-checklist overflow-hidden', detailed && 'payroll-checklist-detailed')}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <h3 className="text-sm font-semibold">{detailed ? 'Review checklist' : 'Payroll steps'}</h3>
        <Chip tone={generated || doneCount === LAST_REVIEW_STEP ? 'success' : 'muted'}>{generated ? STATE_WORD[period.state] : `${doneCount} of ${LAST_REVIEW_STEP} steps done`}</Chip>
      </div>
      <nav aria-label="Payroll steps" className={cn('grid gap-2 p-3', detailed ? 'md:grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-7')}>
        {PAYROLL_STEPS.map((s) => {
          const complete = done(s.n);
          const available = complete || generated || s.n === cur;
          const active = selected ? selected === s.n : !generated && s.n === cur;
          const by = complete ? submittedBy(period, s.n) : null;
          const status = complete ? s.n === GENERATE_STEP ? STATE_WORD[period.state] : 'Confirmed' : s.n === cur ? 'Ready' : 'Upcoming';
          return (
            <button type="button" key={s.n} disabled={!available} aria-current={active ? 'step' : undefined} onClick={() => onOpen(s.n)}
              title={by ? `Confirmed by ${by.by} on ${longDate(by.on)}` : undefined}
              className={cn('payroll-step flex items-start gap-2.5 rounded-md border px-3 py-3 text-left transition-colors disabled:cursor-default', active ? 'border-primary/50 bg-primary/[0.055]' : 'border-transparent enabled:hover:border-border enabled:hover:bg-muted/50', !available && 'text-muted-foreground')}>
              <span aria-hidden className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold num', complete ? 'bg-success/10 text-success' : active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                {complete ? <Check className="size-3.5" /> : s.n}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-snug">{stepLabel(s.n)}</span>
                <span className={cn('mt-1 text-xs leading-relaxed text-muted-foreground', detailed || active ? 'block' : 'sr-only')}>{detailed ? REVIEW_DETAIL[s.n] : notes[s.n] ?? status}</span>
              </span>
              {detailed && <span className={cn('shrink-0 pt-0.5 text-xs', active ? 'font-medium text-primary' : 'text-muted-foreground')}>{status}</span>}
            </button>
          );
        })}
      </nav>
    </Card>
  );
}

function HorizontalStepTracker({ period, selected, onOpen, notes = {} }) {
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
        : 'Review the reports, then lock the payroll.'
    : cur === GENERATE_STEP
      ? 'All six reviews are complete. You can generate payroll.'
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
                ? `Confirmed ${longDate(by.on).replace(/ \d{4}$/, '')}`
                : 'Confirmed'
            : isCur
              ? (notes[s.n] ?? 'Start here')
              : 'Not started';
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
