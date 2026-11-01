import { Check, ClipboardCheck, CircleAlert } from 'lucide-react';
import { GENERATE_STEP, LAST_REVIEW_STEP, PAYROLL_STEPS } from '@ajpwer/shared';
import { Chip } from '@/components/states';
import { Card } from '@/components/ui/card';
import { cn } from '@/utils';
import { currentStep, stepLabel } from './Tracker';

export function ReviewSummary({ period, blocking, onOpen }) {
  const cur = currentStep(period);
  const completed = period.steps_submitted.filter(s => s <= LAST_REVIEW_STEP).length;
  return <Card className="payroll-verification">
    <div className="payroll-verification-head"><div><h2>Verification summary</h2><Chip tone={completed === LAST_REVIEW_STEP && !blocking ? 'success' : 'warning'}>{completed === LAST_REVIEW_STEP && !blocking ? 'Ready to generate' : 'Needs review'}</Chip></div><span>Your confirmed reviews stay saved</span></div>
    <div className="payroll-verification-body">
      <nav aria-label="Payroll reviews" className="payroll-review-timeline">
        {PAYROLL_STEPS.filter(s => s.n <= LAST_REVIEW_STEP).map(s => {
          const done = period.steps_submitted.includes(s.n), issue = s.n === 3 && blocking > 0;
          return <button key={s.n} className="payroll-review-point" disabled={!done && s.n !== cur} aria-current={s.n === cur ? 'step' : undefined} onClick={() => onOpen(s.n)}>
            <span className={cn('payroll-review-node', done && 'complete', issue && 'issue')}>{issue ? <CircleAlert className="size-3.5" /> : done ? <Check className="size-3.5" /> : null}</span>
            <strong>{stepLabel(s.n)}</strong><small>{issue ? 'Needs attention' : done ? 'Confirmed' : s.n === cur ? 'Ready to review' : 'Not started'}</small>
          </button>;
        })}
      </nav>
      <div className="payroll-verification-message"><ClipboardCheck aria-hidden /><div><h3>Let’s get your payroll ready.</h3><p>{cur === GENERATE_STEP ? 'All six reviews are confirmed. Check the generation preview before creating payslips.' : `${LAST_REVIEW_STEP - completed} reviews remain. Continue with ${stepLabel(cur).toLowerCase()}.`}{blocking > 0 ? ` ${blocking} blocking check${blocking === 1 ? '' : 's'} to resolve.` : ''}</p></div></div>
    </div>
  </Card>;
}
