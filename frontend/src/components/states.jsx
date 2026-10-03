import { AlertTriangle, Inbox, Lock, RefreshCw, SearchX, ShieldAlert, WifiOff } from 'lucide-react';
import { DAY_STATUS_LABELS, DAY_STATUS_TONE } from '@ajpwer/shared';
import { Button } from './ui/button';
import { cn } from '@/utils';
import { ApiError } from '@/services/api';

/** Skeleton rows matching the real layout — never a spinner on a blank page. */
export function SkeletonRows({ rows = 8, cols = 6 }) {
  return (
    <div className="divide-y" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-10 items-center gap-4 px-3">
          {Array.from({ length: cols }).map((__, c) => (
            <div key={c} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${c === 0 ? 18 : 8 + ((r * 7 + c * 13) % 12)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ className }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden />;
}

/** Empty, no data yet: what the screen is for and the action that creates the first record. */
export function EmptyState({ title, body, action, icon }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">{icon ?? <Inbox className="size-6" />}</div>
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <p className="max-w-md text-[14px] text-muted-foreground">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Empty, filtered to nothing — a different message from the one above. */
export function NoMatches({ onClear }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <SearchX className="size-6" />
      </div>
      <h3 className="font-display text-base font-semibold">No one matches these filters</h3>
      <Button variant="outline" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

/** What failed, in plain words, and a retry. Never a stack trace. */
export function ErrorState({ error, onRetry, compact }) {
  if (error instanceof ApiError && error.status === 403) return <PermissionDenied message={error.message} />;
  const message = error instanceof ApiError ? error.message : 'This could not be loaded.';
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 text-center', compact ? 'py-6' : 'py-14')} role="alert">
      <div className="rounded-full bg-destructive/10 p-3 text-destructive">
        {error instanceof ApiError && error.code === 'NETWORK' ? <WifiOff className="size-6" /> : <AlertTriangle className="size-6" />}
      </div>
      <p className="max-w-md text-[14px]">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  );
}

/** Why, and who to ask. */
export function PermissionDenied({ message }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <ShieldAlert className="size-6" />
      </div>
      <h3 className="font-display text-base font-semibold">You do not have access to this</h3>
      <p className="max-w-md text-[14px] text-muted-foreground">{message ?? 'Your role does not include this screen. Ask the HR administrator to change your role.'}</p>
    </div>
  );
}

/** Explain what locked it and what reopens it. */
export function LockedNotice({ title, children, action }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3">
      <Lock className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning" />
      <div className="flex-1 text-[14px]">
        <p className="font-medium">{title}</p>
        <div className="mt-0.5 text-muted-foreground">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function Notice({ tone = 'info', children, icon }) {
  const tones = {
    info: 'border-info/30 bg-info/10',
    warning: 'border-warning/40 bg-warning/10',
    destructive: 'border-destructive/40 bg-destructive/10',
    success: 'border-success/40 bg-success/10',
  };
  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-[14px]', tones[tone])} role={tone === 'destructive' ? 'alert' : undefined}>
      {icon ?? <AlertTriangle className="mt-0.5 size-4 shrink-0 opacity-70" />}
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ─── Chips: never meaning by colour alone ───────────────────────────────────

const TONE_CLASS = {
  success: 'bg-success/12 text-success border-success/30',
  warning: 'bg-warning/15 text-warning-foreground border-warning/40 dark:text-warning',
  destructive: 'bg-destructive/10 text-destructive border-destructive/30',
  muted: 'bg-muted text-muted-foreground border-border',
  info: 'bg-info/10 text-info border-info/30',
  default: 'bg-secondary text-secondary-foreground border-border',
};

export function Chip({ tone = 'default', children, className, title }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px] font-medium leading-4', TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

export function DayChip({ status, overridden }) {
  return (
    <Chip tone={DAY_STATUS_TONE[status]} title={overridden ? 'Corrected by HR' : undefined}>
      {DAY_STATUS_LABELS[status]}
      {overridden && <span aria-label="corrected">•</span>}
    </Chip>
  );
}

const EMP_TONE = { OFFER: 'info', ACCEPTED: 'info', ONBOARDING: 'warning', ACTIVE: 'success', NOTICE: 'warning', EXITED: 'muted' };
export function EmployeeStatusChip({ status }) {
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  // NOTICE is the stored status between recording an exit and the last day; there is no notice period.
  return <Chip tone={EMP_TONE[status] ?? 'default'}>{label === 'Notice' ? 'Leaving' : label}</Chip>;
}

const PERIOD_TONE = { DRAFT: 'muted', RUN: 'info', LOCKED: 'warning', PAID: 'success' };
export function PeriodChip({ state }) {
  return <Chip tone={PERIOD_TONE[state] ?? 'default'}>{state === 'RUN' ? 'Run, not locked' : state.charAt(0) + state.slice(1).toLowerCase()}</Chip>;
}

export function SeverityChip({ severity }) {
  return <Chip tone={severity === 'BLOCKING' ? 'destructive' : 'warning'}>{severity === 'BLOCKING' ? 'Blocking' : 'Warning'}</Chip>;
}

export function OfflineBanner() {
  return (
    <div className="no-print flex items-center justify-center gap-2 bg-destructive px-4 py-1.5 text-[14px] text-destructive-foreground" role="status">
      <WifiOff className="size-4" /> You are offline. Nothing is saved until the connection returns — changes are not queued in the admin app.
    </div>
  );
}
