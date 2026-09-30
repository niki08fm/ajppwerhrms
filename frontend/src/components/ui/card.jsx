import { cn } from '@/lib/utils';

export function Card({ className, ...props }) {
  return <div className={cn('rounded-lg border bg-card text-card-foreground shadow-xs', className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="font-display text-[15px] font-semibold leading-tight">{title}</h3>
        {description && <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }) {
  return <div className={cn('p-4', className)} {...props} />;
}
