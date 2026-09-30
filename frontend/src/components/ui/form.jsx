import { forwardRef, useId } from 'react';
import { cn } from '@/utils';

const base =
  'w-full rounded-md border border-input bg-card px-2.5 text-[13px] shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive';

export const Input = forwardRef(({ className, ...props }, ref) => <input ref={ref} className={cn(base, 'h-8', className)} {...props} />);
Input.displayName = 'Input';

export const Textarea = forwardRef(({ className, ...props }, ref) => <textarea ref={ref} className={cn(base, 'min-h-[72px] py-2', className)} {...props} />);
Textarea.displayName = 'Textarea';

export const Select = forwardRef(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      base,
      'h-8 pr-7 appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2712%27%20height%3D%2712%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%23888%27%20stroke-width%3D%272%27%3E%3Cpath%20d%3D%27m6%209%206%206%206-6%27/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_8px_center] bg-no-repeat',
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
    <label htmlFor={htmlFor} className={cn('text-[12px] font-medium text-foreground', className)}>
      {children}
    </label>
  );
}

/** A labelled field with its error sitting under it. */
export function Field({ label, hint, error, children, className, required }) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children(id, !!error)}
      {error ? (
        <p className="text-[12px] text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Rupee input: shows ₹, stores rupees as the person typed them. */
export const MoneyInput = forwardRef(({ className, ...props }, ref) => (
  <div className="relative">
    <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">₹</span>
    <Input ref={ref} inputMode="decimal" className={cn('pl-6 num', className)} {...props} />
  </div>
));
MoneyInput.displayName = 'MoneyInput';
