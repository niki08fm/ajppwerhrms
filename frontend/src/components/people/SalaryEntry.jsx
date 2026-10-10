import { inr, toPaise } from '@/utils';
import { Field, MoneyInput, Segmented } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';

/**
 * Salary is typed as a yearly figure: annual gross or annual CTC. A gross is stored as
 * the monthly gross it divides into; a CTC is kept as typed and its gross worked out
 * (CTC less the employer's PF and ESI).
 */
export function agreement(mode, annualText) {
  const annual = toPaise(annualText) || 0;
  return { mode, amount: mode === 'GROSS' ? Math.round(annual / 12) : annual };
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
        hint={a ? (mode === 'CTC' ? `${inr(Math.round(a / 12))} a month, PF and ESI included` : `${inr(Math.round(a / 12))} a month gross`) : 'A yearly figure'}
      >
        {(id, inv) => <MoneyInput id={id} aria-invalid={inv} value={annual} onChange={(e) => onAnnual(e.target.value)} />}
      </Field>
    </>
  );
}

/**
 * Whether the salary includes PF and ESI. A CTC can have an eligible gross even
 * when the preview with ESI switched off is above the ceiling.
 */
export function StatutoryChoice({ pf, esi, onPf, onEsi, preview }) {
  const eligible = preview ? preview.esi_within_ceiling !== false : true;
  const candidate = preview?.esi_eligible_gross;
  const canEnable = eligible || (typeof candidate === 'number' && candidate > 0);
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
          <span className="block text-[12px] text-muted-foreground">
            {eligible ? 'Eligible: gross within the ESI ceiling' : canEnable ? `Switch on ESI to use eligible gross ${inr(candidate)} a month` : 'Not eligible: gross above the ESI ceiling'}
          </span>
        </span>
        <Switch checked={esi && eligible} disabled={!canEnable} onCheckedChange={onEsi} label="ESI" />
      </div>
    </div>
  );
}
