import { inr, toPaise } from '@/utils';
import { Field, MoneyInput, Segmented } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';

/**
 * Salary is typed as a yearly figure: annual gross or annual CTC. A gross is stored as
 * the monthly gross rounded up to whole rupees; a CTC is kept as typed and its gross worked out
 * (CTC less the employer's PF and ESI).
 */
export function agreement(mode, annualText) {
  const annual = toPaise(annualText) || 0;
  return { mode, amount: mode === 'GROSS' ? Math.ceil(annual / 1200) * 100 : annual };
}

/** The other way: what to show in the box for a stored agreement. */
export const annualText = (mode, amount, monthlyGross) => String(((mode === 'GROSS' ? monthlyGross ?? amount : amount) * (mode === 'GROSS' ? 12 : 1)) / 100);

export const MODE_OPTIONS = [
  { value: 'GROSS', label: 'Gross' },
  { value: 'CTC', label: 'CTC' },
];

/** "Agreed as" and the yearly amount, with the monthly figure under it. */
export function SalaryAmountFields({ mode, annual, onMode, onAnnual, error, label = 'Agreed as' }) {
  const a = toPaise(annual) || 0;
  const monthly = Math.ceil(a / 1200) * 100;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        <Segmented label={label} value={mode} onChange={onMode} options={MODE_OPTIONS} className="self-start" />
      </div>
      <Field
        label={mode === 'CTC' ? 'Annual CTC' : 'Annual gross'}
        required
        error={error}
        hint={a ? (mode === 'CTC' ? `${inr(monthly)} a month, PF and ESI included` : `${inr(monthly)} a month gross`) : 'A yearly figure'}
      >
        {(id, inv) => <MoneyInput id={id} aria-invalid={inv} value={annual} onChange={(e) => onAnnual(e.target.value)} />}
      </Field>
    </>
  );
}

/**
 * Whether the salary includes PF; ESI follows the gross. ESI has no switch: it applies when
 * the monthly gross is within the ESI ceiling.
 */
export function StatutoryChoice({ pf, onPf, preview }) {
  const eligible = preview ? preview.esi_within_ceiling !== false : null;
  const esiWage = preview?.esi_wage ?? preview?.gross;
  let esiSummary = 'Applies when the monthly gross is within the ESI ceiling';
  if (eligible === true) esiSummary = `Applies: gross${typeof esiWage === 'number' ? ` ${inr(esiWage)}` : ''} is within the ceiling`;
  else if (eligible === false) esiSummary = 'Does not apply: gross is above the ceiling';
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm font-medium">Provident fund (PF)</span>
          <span className="block text-[12px] text-muted-foreground">Employee and employer 12% of the PF wage</span>
        </span>
        <Switch checked={pf} onCheckedChange={onPf} label="PF" />
      </div>
      <div className="flex items-center justify-between gap-3 border-t pt-2">
        <span>
          <span className="block text-sm font-medium">ESI</span>
          <span className="block text-[12px] text-muted-foreground">{esiSummary}</span>
        </span>
        <span className="text-[13px] text-muted-foreground">{eligible === null ? 'By gross' : eligible ? 'Applies' : 'No'}</span>
      </div>
    </div>
  );
}
