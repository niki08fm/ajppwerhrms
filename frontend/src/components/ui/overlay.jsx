import * as D from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import * as Tip from '@radix-ui/react-tooltip';
import * as Pop from '@radix-ui/react-popover';
import * as Sw from '@radix-ui/react-switch';
import * as Cb from '@radix-ui/react-checkbox';
import * as DM from '@radix-ui/react-dropdown-menu';
import { Check, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Dialog (focus-trapped, closes on Escape) ───────────────────────────────

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in" />
        <D.Content
          className={cn('fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-lg border bg-card shadow-xl', wide ? 'max-w-4xl' : 'max-w-lg')}
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div>
              <D.Title className="font-display text-lg font-semibold">{title}</D.Title>
              {description && <D.Description className="mt-1 text-[13px] text-muted-foreground">{description}</D.Description>}
            </div>
            <D.Close className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** A side drawer — used only mid-task (correcting a day during a payroll run). */
export function Drawer({ open, onOpenChange, title, description, children, footer }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-card shadow-2xl">
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div>
              <D.Title className="font-display text-lg font-semibold">{title}</D.Title>
              {description && <D.Description className="mt-1 text-[13px] text-muted-foreground">{description}</D.Description>}
            </div>
            <D.Close className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

export const TabsRoot = Tabs.Root;
export const TabsContent = Tabs.Content;

export function TabsList({ tabs, className }) {
  return (
    <Tabs.List className={cn('flex gap-1 overflow-x-auto border-b scrollbar-thin', className)}>
      {tabs.map((t) => (
        <Tabs.Trigger
          key={t.value}
          value={t.value}
          className="relative -mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
        >
          {t.label}
          {t.badge}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
}

// ─── Tooltip, popover ───────────────────────────────────────────────────────

export function Tooltip({ content, children }) {
  return (
    <Tip.Provider delayDuration={250}>
      <Tip.Root>
        <Tip.Trigger asChild>{children}</Tip.Trigger>
        <Tip.Portal>
          <Tip.Content sideOffset={4} className="z-50 max-w-xs rounded-md bg-foreground px-2 py-1 text-[12px] text-background shadow">
            {content}
          </Tip.Content>
        </Tip.Portal>
      </Tip.Root>
    </Tip.Provider>
  );
}

export function Popover({ trigger, children, align = 'start' }) {
  return (
    <Pop.Root>
      <Pop.Trigger asChild>{trigger}</Pop.Trigger>
      <Pop.Portal>
        <Pop.Content align={align} sideOffset={4} className="z-50 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg">
          {children}
        </Pop.Content>
      </Pop.Portal>
    </Pop.Root>
  );
}

// ─── Switch, checkbox ───────────────────────────────────────────────────────

export function Switch({ checked, onCheckedChange, disabled, id, label }) {
  return (
    <Sw.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent bg-input transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
    >
      <Sw.Thumb className="block size-4 rounded-full bg-card shadow transition-transform data-[state=checked]:translate-x-4" />
    </Sw.Root>
  );
}

export function Checkbox({ checked, onCheckedChange, label, disabled }) {
  return (
    <Cb.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={label}
      disabled={disabled}
      className="flex size-4 shrink-0 items-center justify-center rounded border border-input bg-card data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:bg-primary text-primary-foreground"
    >
      <Cb.Indicator>{checked === 'indeterminate' ? <Minus className="size-3" /> : <Check className="size-3" />}</Cb.Indicator>
    </Cb.Root>
  );
}

// ─── Dropdown menu ──────────────────────────────────────────────────────────

export function Menu({ trigger, items, align = 'end' }) {
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} sideOffset={4} className="z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
          {items.map((it, i) =>
            it === 'sep' ? (
              <DM.Separator key={i} className="my-1 h-px bg-border" />
            ) : (
              <DM.Item
                key={i}
                disabled={it.disabled}
                onSelect={it.onSelect}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50',
                  it.destructive && 'text-destructive',
                )}
              >
                {it.label}
              </DM.Item>
            ),
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
