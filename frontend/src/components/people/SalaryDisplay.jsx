import { Money } from '@/components/bits';
import { Notice } from '@/components/states';
import { inr } from '@/utils';

/** Monthly figures stay in rupees; annual CTC retains any calculated paise. */
export const hasPaise = (value) => typeof value === 'number' && Number.isFinite(value) && Math.round(value) % 100 !== 0;
export const exactInr = (value) => inr(value, hasPaise(value));

export function CtcMismatchNotice({ amount, preview, sample = false }) {
  if (!preview?.solution?.approximate) return null;
  if (preview.solution.reason === 'CTC_COMPONENT_CYCLE') {
    return <Notice tone="warning">These salary components do not settle on a consistent CTC. Adjust the components before saving.</Notice>;
  }
  const calculated = preview.ctc.calculated_annual_ctc ?? preview.ctc.annual_ctc;
  const difference = Math.abs(Math.round(calculated - amount));
  return (
    <Notice tone="warning">
      Entered annual CTC <Money value={amount} paise={hasPaise(amount)} />; calculated <Money value={calculated} paise={hasPaise(calculated)} /> (difference <Money value={difference} paise={hasPaise(difference)} />).{' '}
      {sample ? 'Adjust the sample amount or components to match this CTC.' : 'Adjust the amount or structure before saving.'}
    </Notice>
  );
}
