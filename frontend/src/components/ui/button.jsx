import { forwardRef } from 'react';
import { cva } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-border bg-card text-foreground shadow-xs hover:border-primary/40 hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline px-0 h-auto',
      },
      size: {
        default: 'h-9 px-3.5',
        sm: 'h-8 px-3 text-[13px]',
        lg: 'h-10 px-5 text-[15px]',
        xl: 'h-16 px-8 text-lg rounded-xl',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export const Button = forwardRef(({ className, variant, size, loading, disabled, children, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size, className }))} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <Loader2 className="animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = 'Button';
