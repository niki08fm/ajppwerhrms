import { cn } from '@/utils';

export function Card({ className, ...props }) {
  return <div className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)} {...props} />;
}

/** Title in the display face; the description is supporting text, never a second title. */
export function CardHeader({ title, description, actions, className }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4', className)}>
      {/* A base width, so on a phone the actions drop below the title instead of squeezing it. */}
      <div className="min-w-0 flex-[1_1_12rem]">
        <h3 className="font-display text-[17px] leading-snug font-semibold">{title}</h3>
        {description && <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }) {
  return <div className={cn('p-5', className)} {...props} />;
}
