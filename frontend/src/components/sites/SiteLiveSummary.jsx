import { ArrowUpRight, Clock3, LogIn, LogOut, Loader2, Timer, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { dateSpan, istTime, mins } from '@/utils';

/** The current site count stays separate from the selected attendance period. */
export default function SiteLiveSummary({ today, date, fetching, failed, updatedAt, onViewPeople }) {
  const metrics = [
    { label: 'In today', value: today.punched_in, sub: 'people who punched in', icon: LogIn, colour: 'var(--primary)' },
    { label: 'Signed out', value: today.signed_out, sub: 'people who punched out', icon: LogOut, colour: 'var(--info)' },
    { label: 'Late in', value: today.late_in, sub: 'after their grace time', icon: Clock3, colour: 'var(--warning)' },
    { label: 'OT hours', value: mins(today.ot_min), sub: 'recorded today', icon: Timer, colour: 'var(--success)' },
  ];
  return (
    <section aria-label="Today's site attendance">
      <div className="mb-3 flex items-center gap-2 text-[13px]"><span className="font-medium">Today</span><span className="text-muted-foreground">{dateSpan(date)}</span></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Card className="relative col-span-2 overflow-hidden border-primary/20 p-5 text-primary-foreground" style={{ background: 'linear-gradient(125deg, var(--primary), color-mix(in oklch, var(--primary) 78%, var(--chart-5)))' }}>
          <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-14 size-48 rounded-full border-[24px] border-current opacity-[0.07]" />
          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide"><Users className="size-4" aria-hidden="true" /> On site now</span>
              <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-current/20 bg-primary-foreground/10 px-2 py-1 text-[11px] font-medium" role="status">
                {fetching ? <><Loader2 className="size-3 animate-spin" aria-hidden="true" /> Updating</> : failed ? 'Refresh unavailable' : <><span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" /> Live</>}
              </span>
            </div>
            <div className="mt-4 flex items-baseline gap-2"><span className="num text-[48px] font-semibold leading-none">{today.on_site_now}</span><span className="text-[14px] opacity-90">people</span></div>
            <p className="mt-2 text-[12px] opacity-85">{fetching ? 'Refreshing headcount…' : failed ? 'Showing the last loaded headcount' : `Updated ${istTime(new Date(updatedAt).toISOString())} · refreshes every minute`}</p>
            <button type="button" onClick={onViewPeople} className="mt-4 flex w-fit items-center gap-1.5 rounded-sm text-[13px] font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current">View current people <ArrowUpRight className="size-3.5" aria-hidden="true" /></button>
          </div>
        </Card>
        {metrics.map(({ label, value, sub, icon: Icon, colour }) => (
          <Card key={label} className="relative flex min-w-0 flex-col overflow-hidden px-4 py-5" style={{ background: `linear-gradient(155deg, color-mix(in oklch, ${colour} 9%, var(--card)), var(--card))`, borderColor: `color-mix(in oklch, ${colour} 25%, var(--border))` }}>
            <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: colour }} aria-hidden="true" />
            <div className="mb-3 flex size-8 items-center justify-center rounded-lg" style={{ background: `color-mix(in oklch, ${colour} 14%, var(--card))` }}><Icon className="size-4" style={{ color: label === 'Late in' ? 'var(--warning-foreground)' : colour }} aria-hidden="true" /></div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="num mt-2 break-words text-[28px] font-semibold leading-none">{value}</div>
            <p className="mt-2 text-[12px] text-muted-foreground">{sub}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
