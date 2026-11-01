import { ClipboardList, ArrowRightLeft, ChevronRight, FileSpreadsheet, LogOut, MoreHorizontal, ScanFace, UserPlus, Users } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/states';

/** An employee's phone starts with one task. Supervisor tools have their own screen. */
export function PhoneAttendanceHome({ online, summary, onPunch, onRegister, onPeople }) {
  const counts = summary.data?.counts;
  return <div className="space-y-4">
    <Card className="space-y-5 border-primary/20 p-5 text-center">
      <div><h3 className="text-xl font-semibold">Ready to punch?</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Scan your face, check your name and confirm your punch.</p></div>
      <Button size="xl" className="h-20 w-full text-lg" disabled={!online} onClick={onPunch}><ScanFace /> Punch in / out</Button>
      <p className="text-xs leading-relaxed text-muted-foreground">You can leave and return during the day. Each visit has its own punch in and punch out.</p>
    </Card>
    <Button variant="outline" className="w-full justify-between" disabled={!online} onClick={onRegister}><span className="inline-flex items-center gap-2"><UserPlus /> Register face</span><ChevronRight aria-hidden /></Button>
    <p className="text-center text-xs text-muted-foreground">Register once. Use the punch button for every visit.</p>
    {summary.isError ? <ErrorState error={summary.error} onRetry={() => summary.refetch()} compact /> : <Card className="flex items-center justify-between gap-3 p-4">
      <div className="space-y-1"><p className="text-sm"><b className="num">{counts?.on_site_now ?? '—'}</b> on site now</p><p className="text-xs text-muted-foreground">{counts?.punched_in_today ?? '—'} people arrived today</p></div>
      <Button aria-label="View people" variant="ghost" disabled={summary.isLoading} onClick={onPeople}><Users aria-hidden /> People</Button>
    </Card>}
  </div>;
}

export function PhoneSiteTools({ online, summary, onView, onRegister, onPeople, onDepartment, onSignOut }) {
  const counts = summary.data?.counts;
  const tools = [
    ['Register face', 'For a first registration or an HR-approved replacement.', UserPlus, onRegister, !online],
    ['Manual attendance', 'Enter the paper register and send it to HR.', FileSpreadsheet, () => onView('manual'), false],
    ['Transfer requests', 'Request an employee move to another site.', ArrowRightLeft, () => onView('transfers'), false],
    ['People on site', 'See who is currently punched in.', Users, onPeople, summary.isLoading || summary.isError],
  ];
  return <div className="space-y-4">
    <Card className="divide-y overflow-hidden">{tools.map(([title, description, Icon, action, disabled]) => <button key={title} type="button" aria-label={title} disabled={disabled} onClick={action} className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted disabled:opacity-50">
      <Icon className="size-5 shrink-0 text-primary" aria-hidden /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{description}</span></span><ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>)}</Card>
    <details className="rounded-lg border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Site summary</summary>
      {summary.isError ? <ErrorState error={summary.error} onRetry={() => summary.refetch()} compact /> : <div className="space-y-4 border-t p-4">
        <dl className="grid grid-cols-2 gap-4">{[['On site', counts?.on_site_now], ['Arrived today', counts?.punched_in_today], ['Signed out', counts?.signed_out], ['Late in', counts?.late_in], ['Left early', counts?.early_out]].map(([label, count]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-semibold num">{count ?? '—'}</dd></div>)}</dl>
        <ul className="divide-y">{(summary.data?.departments ?? []).map((department) => <li key={department.id}><button className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm" onClick={() => onDepartment(department)}><span>{department.name}</span><span className="font-medium num">{department.count}</span></button></li>)}</ul>
      </div>}
    </details>
    <Button variant="outline" className="w-full" onClick={onSignOut}><LogOut /> Sign out of this site</Button>
  </div>;
}

export function PhoneSiteNavigation({ tab, more, onAttendance, onRegisters, onMore }) {
  const active = more || ['manual', 'transfers'].includes(tab) ? 'more' : ['day', 'month'].includes(tab) ? 'registers' : 'attendance';
  return <nav aria-label="Site navigation" className="site-phone-navigation fixed inset-x-0 bottom-0 z-30 flex border-t bg-card px-2 pt-1 shadow-[0_-4px_16px_rgba(0,0,0,0.04)]">
    {[
      ['attendance', 'Attendance', ScanFace, onAttendance],
      ['registers', 'Registers', ClipboardList, onRegisters],
      ['more', 'More', MoreHorizontal, onMore],
    ].map(([value, label, Icon, action]) => <button key={value} type="button" aria-current={active === value ? 'page' : undefined} onClick={action} className={cn('flex min-h-16 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium', active === value ? 'bg-primary/5 text-primary' : 'text-muted-foreground')}><Icon className="size-5" aria-hidden />{label}</button>)}
  </nav>;
}
