import { forwardRef, useId } from 'react';
import { cn } from '@/utils';

/* Controls sit slightly inset: a cool fill, a quiet border, and a teal ring when focused. */
const base =
  'w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-[border-color,box-shadow] placeholder:text-muted-foreground hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive';

export const Input = forwardRef(({ className, ...props }, ref) => <input ref={ref} className={cn(base, 'h-9', className)} {...props} />);
Input.displayName = 'Input';

export const Textarea = forwardRef(({ className, ...props }, ref) => <textarea ref={ref} className={cn(base, 'min-h-[80px] py-2', className)} {...props} />);
Textarea.displayName = 'Textarea';

export const Select = forwardRef(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      base,
      'h-9 pr-8 appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2712%27%20height%3D%2712%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23888%27%20stroke-width%3D%272%27%3E%3Cpath%20d%3D%27m6%209%206%206%206-6%27/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_10px_center] bg-no-repeat',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

export function Label({ htmlFor, children, className }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-[13px] font-medium text-foreground', className)}>
      {children}
    </label>
  );
}

/** A labelled field with its error sitting under it. */
export function Field({ label, hint, error, children, className, required }) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children(id, !!error)}
      {error ? (
        <p className="text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Rupee input: shows ₹, stores rupees as the person typed them. */
export const MoneyInput = forwardRef(({ className, ...props }, ref) => (
  <div className="relative">
    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
    <Input ref={ref} inputMode="decimal" className={cn('pl-7 num', className)} {...props} />
  </div>
));
MoneyInput.displayName = 'MoneyInput';

/** A choice between a few options shown as cards. Native radios, so the keyboard and screen readers work as usual. */
export function ChoiceCards({ name, value, onChange, options, className }) {
  return (
    <div role="radiogroup" className={cn('grid gap-2', className)}>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
            value === o.value ? 'border-primary bg-primary/5 ring-1 ring-primary/25' : 'border-border hover:border-primary/40',
            o.disabled && 'cursor-not-allowed opacity-55',
          )}
        >
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="mt-1 size-4 accent-primary" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{o.label}</span>
            {o.description && <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{o.description}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** A few short options side by side; the chosen one is raised. */
export function Segmented({ value, onChange, options, label, className }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-md border bg-muted p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
            value === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
