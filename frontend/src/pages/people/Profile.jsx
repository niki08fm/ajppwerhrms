import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Lock, LogOut, Pencil, Plus, TrendingUp } from 'lucide-react';
import { formatINR } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, hhmm, longDate, monthLabel } from '@/utils';
import { Mono } from '@/components/bits';
import { Chip, EmployeeStatusChip, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';
import { DeptAvatar } from '@/components/attendance/DeptAvatar';
import { EditDialog, OverviewTab } from '../../components/people/profile-tabs/Overview';
import { AttendanceTab } from '../../components/people/profile-tabs/Attendance';
import { LeaveTab } from '../../components/people/profile-tabs/LeaveTab';
import { PayTab } from '../../components/people/profile-tabs/Pay';
import { TaxTab } from '../../components/people/profile-tabs/Tax';
import { ReviseDialog, SalaryHistoryTab } from '../../components/people/profile-tabs/SalaryHistory';
import { PayslipsTab } from '../../components/people/profile-tabs/Payslips';
import { LoansTab } from '../../components/people/profile-tabs/Loans';
import { DocumentsTab } from '../../components/people/profile-tabs/Documents';
import { LettersTab } from '../../components/people/profile-tabs/Letters';
import { OnboardingTab } from '../../components/people/profile-tabs/Onboarding';
import { ExitDialog, ExitTab, useExit } from '../../components/people/profile-tabs/Exit';
import { TimelineTab } from '../../components/people/profile-tabs/Timeline';
import { SalaryHoldCard, useHold } from '../../components/people/profile-tabs/SalaryHold';
import { GrantDialog } from '../payroll/Money';

const TABS = [
  ['overview', 'Overview'],
  ['attendance', 'Attendance'],
  ['salary', 'Salary and statutory'],
  ['payslips', 'Payslips'],
  ['leave', 'Leave'],
  ['loans', 'Advances'],
  ['letters', 'Letters'],
  ['exit', 'Exit and F&F'],
  ['timeline', 'Timeline'],
];

/** The sections of the Salary tab, in reading order. */
const SALARY_SECTIONS = [
  ['pay', 'Breakup and statutory'],
  ['history', 'Revisions'],
  ['tax', 'Income tax'],
];

/** Old tab names (links from other screens, saved views) and where they live now. */
const MOVED = {
  time: ['attendance'],
  pay: ['salary', 'pay'],
  tax: ['salary', 'tax'],
  records: ['letters'],
  documents: ['letters', 'documents'],
  onboarding: ['overview', 'onboarding'],
  face: ['overview', 'onboarding'],
  edit: ['overview'],
};

/** The company comes from the employee ID: AJ for AJ Power, TP for Techpi. */
const companyOf = (code) => (code?.startsWith('TP') ? 'Techpi' : 'AJ Power');

/** "4 yrs 6 mos" from a joining date to today. */
function tenure(from, to) {
  if (!from || !to) return '';
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  if (months < 0) return 'Not joined yet';
  const y = Math.floor(months / 12);
  months %= 12;
  return [y ? `${y} yr${y > 1 ? 's' : ''}` : null, months || !y ? `${months} mo${months === 1 ? '' : 's'}` : null].filter(Boolean).join(' ');
}

/** One of the six figures under the name; tapping it opens the tab with the detail. */
function Fact({ label, value, sub, onClick }) {
  return (
    <button type="button" onClick={onClick} className="min-w-0 rounded-lg border border-transparent bg-muted/60 px-3.5 py-3 text-left transition-colors hover:border-primary/40">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      {/* Wraps rather than truncates: a cut-off figure is worse than a second line. */}
      <div className="font-semibold leading-snug break-words num">{value}</div>
      {sub && <div className="text-[12px] text-muted-foreground">{sub}</div>}
    </button>
  );
}

/** Who this is, where they stand today, and the things HR does to a person — always above the tabs. */
function Header({ e, go, onAction }) {
  const { data: lk } = useLookups();
  const today = lk?.today;
  const month = today?.slice(0, 7);
  const hold = useHold(e.id);
  const leave = useQuery({ queryKey: ['emp-leave', e.id], queryFn: () => api.get(`/employees/${e.id}/leave-balances`).then((r) => r.data) });
  const att = useQuery({ queryKey: ['emp-attendance', e.id, month], queryFn: () => api.get(`/employees/${e.id}/attendance`, { month }).then((r) => r.data), enabled: !!month });
  const pay = useQuery({ queryKey: ['employee-pay', e.id], queryFn: () => api.get(`/employees/${e.id}/pay`).then((r) => r.data), enabled: !!e.salary });
  const money = useQuery({ queryKey: ['advances-loans', e.id], queryFn: () => api.get('/advances-loans', { q: e.code }).then((r) => r.data) });

  const pl = leave.data?.types?.find((t) => t.auto_apply) ?? leave.data?.types?.find((t) => t.closing !== null);
  // The month so far: days still to come are not counted as absences.
  const past = att.data?.days.filter((d) => d.date <= today && d.status !== 'NOT_JOINED' && d.status !== 'EXITED') ?? null;
  const paid = past ? Math.round(past.reduce((a, d) => a + d.day_value, 0) * 100) / 100 : null;
  const late = past ? past.filter((d) => d.late_min > 0).length : 0;
  const running = money.data?.rows.filter((r) => r.employee.id === e.id && r.status === 'ACTIVE') ?? [];
  const due = running.reduce((a, r) => a + r.outstanding, 0);
  const shift = e.rules?.shift;
  const working = e.status === 'ACTIVE' || e.status === 'NOTICE';

  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 px-5 pt-5">
        <DeptAvatar name={e.name} token={e.department.colour} size={60} />
        {/* A base width, so on a phone the buttons drop below the name instead of squeezing it. */}
        <div className="min-w-0 flex-[1_1_16rem]">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-[28px] leading-tight font-semibold">{e.name}</h1>
            <EmployeeStatusChip status={e.status} />
            <Chip tone="muted">{companyOf(e.code)}</Chip>
            {e.last_day && <Chip tone="warning">Last day {longDate(e.last_day)}</Chip>}
            {hold.data?.current && <Chip tone="warning">Salary on hold since {monthLabel(hold.data.current.from_ym)}</Chip>}
            {e.read_only && (
              <Chip tone="muted">
                <Lock className="size-3" /> Read-only after exit
              </Chip>
            )}
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            {[e.designation, e.department.name].filter(Boolean).join(' · ')} · <Mono>{e.code}</Mono>
            {e.phone ? ` · ${e.phone}` : ''}
          </div>
        </div>
        {!e.read_only && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => onAction('edit')}>
              <Pencil /> Edit details
            </Button>
            {working && e.salary && (
              <Button variant="outline" onClick={() => onAction('revise')}>
                <TrendingUp /> Revise salary
              </Button>
            )}
            {working && (
              <Button variant="outline" onClick={() => onAction('advance')}>
                <Plus /> Give advance
              </Button>
            )}
            {e.status === 'ACTIVE' && (
              <Button variant="outline" className="text-destructive" onClick={() => onAction('exit')}>
                <LogOut /> Record exit
              </Button>
            )}
            {e.status === 'NOTICE' && (
              <Button variant="outline" className="text-destructive" onClick={() => go('exit')}>
                <LogOut /> Exit and F&amp;F
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2.5 p-5 md:grid-cols-3 xl:grid-cols-6">
        <Fact label="Joined" value={longDate(e.joined_on)} sub={tenure(e.joined_on, today)} onClick={() => go('overview')} />
        <Fact label="Pay group · shift" value={e.pay_group.name} sub={shift ? `${shift.name} ${hhmm(shift.start_min)}–${hhmm(shift.end_min)}` : undefined} onClick={() => go('overview')} />
        <Fact
          label="Monthly gross"
          value={e.salary ? formatINR(e.salary.monthly_gross) : '—'}
          sub={pay.data?.preview ? `Take-home ≈ ${formatINR(pay.data.preview.take_home)}` : e.salary ? (e.salary.mode === 'CTC' ? 'Agreed as CTC' : 'Agreed as gross') : 'No salary yet'}
          onClick={() => go('salary')}
        />
        <Fact
          label={month ? `${monthLabel(month).split(' ')[0]} so far` : 'This month'}
          value={past ? `${paid} days paid` : '—'}
          sub={past ? `${Math.round((past.length - paid) * 100) / 100} LOP · ${late} late` : undefined}
          onClick={() => go('attendance')}
        />
        <Fact label={pl ? pl.name : 'Leave'} value={pl && pl.balance !== null ? `${pl.balance} days left` : '—'} sub={pl ? `${pl.used_ytd + pl.auto_ytd} taken this leave year` : undefined} onClick={() => go('leave')} />
        <Fact
          label="Advance"
          value={due ? `${formatINR(due)} due` : 'None'}
          sub={running.length === 1 ? `${formatINR(running[0].instalment)} a month · ${running[0].instalments_left} left` : running.length > 1 ? `${running.length} running` : 'Nothing to recover'}
          onClick={() => go('loans')}
        />
      </div>
    </Card>
  );
}

/** A section of a merged tab, with an anchor older links can land on. */
function Section({ id, children }) {
  return (
    <section id={id} className="scroll-mt-20">
      {children}
    </section>
  );
}

/** The exit dialog needs the person's exit record; it loads only when HR asks to record one. */
function RecordExit({ e, onClose }) {
  const x = useExit(e.id);
  if (!x.data) return null;
  return <ExitDialog e={e} x={x.data} onClose={onClose} />;
}

/** Full screen at its own route — /people/:id?tab=salary&section=tax — never a side panel. */
export default function Profile() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab') ?? 'overview';
  const [tab, movedSection] = TABS.some(([v]) => v === raw) ? [raw] : (MOVED[raw] ?? ['overview']);
  const section = sp.get('section') ?? movedSection;
  const [action, setAction] = useState(null);
  const q = useQuery({ queryKey: ['employee', id], queryFn: () => api.get(`/employees/${id}`).then((r) => r.data) });

  // Land on the section an older link asked for.
  useEffect(() => {
    if (!section || !q.data) return;
    const t = setTimeout(() => document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    return () => clearTimeout(t);
  }, [section, tab, q.data]);

  if (q.isLoading)
    return (
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-56" />
        <SkeletonBlock className="h-10" />
        <SkeletonBlock className="h-96" />
      </div>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  const setTab = (t) => setSp({ tab: t }, { replace: true });
  const onboardingFirst = e.status !== 'ACTIVE' && e.status !== 'NOTICE' && e.status !== 'EXITED';
  const close = () => setAction(null);

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 text-[13px] text-muted-foreground">
        <Link to="/people" className="hover:text-foreground hover:underline">
          Employees
        </Link>{' '}
        › <span className="font-medium text-foreground">{e.name}</span>
      </nav>
      <Header e={e} go={setTab} onAction={setAction} />

      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList
          tabs={TABS.map(([v, l]) => ({
            value: v,
            label: l,
            badge:
              v === 'overview' && e.onboarding.required_left > 0 && e.status !== 'ACTIVE' ? (
                <span className="rounded-full bg-warning/25 px-1.5 text-[12px] leading-5 text-warning-foreground num">{e.onboarding.required_left}</span>
              ) : undefined,
          }))}
        />

        <div className="pt-5">
          <TabsContent value="overview">
            {tab === 'overview' && (
              <div className="flex flex-col gap-5">
                {onboardingFirst && (
                  <Section id="section-onboarding">
                    <OnboardingTab e={e} />
                  </Section>
                )}
                <OverviewTab e={e} />
                {!onboardingFirst && (
                  <Section id="section-onboarding">
                    <OnboardingTab e={e} />
                  </Section>
                )}
              </div>
            )}
          </TabsContent>
          <TabsContent value="attendance">{tab === 'attendance' && <AttendanceTab e={e} />}</TabsContent>
          <TabsContent value="salary">
            {tab === 'salary' && (
              <div className="flex flex-col gap-5">
                <div className="sticky top-0 z-20 -mx-1 flex flex-wrap gap-1 rounded-lg border bg-card/95 p-1 shadow-sm backdrop-blur">
                  {SALARY_SECTIONS.map(([k, l]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => document.getElementById(`section-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      className={cn('rounded-md px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground')}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <Section id="section-pay">
                  <div className="flex flex-col gap-5">
                    <SalaryHoldCard e={e} />
                    <PayTab e={e} />
                  </div>
                </Section>
                <Section id="section-history">
                  <SalaryHistoryTab e={e} />
                </Section>
                <Section id="section-tax">
                  <TaxTab e={e} />
                </Section>
              </div>
            )}
          </TabsContent>
          <TabsContent value="payslips">{tab === 'payslips' && <PayslipsTab e={e} />}</TabsContent>
          <TabsContent value="leave">{tab === 'leave' && <LeaveTab e={e} />}</TabsContent>
          <TabsContent value="loans">{tab === 'loans' && <LoansTab e={e} />}</TabsContent>
          <TabsContent value="letters">
            {tab === 'letters' && (
              <div className="flex flex-col gap-5">
                <Section id="section-letters">
                  <LettersTab e={e} />
                </Section>
                <Section id="section-documents">
                  <DocumentsTab e={e} />
                </Section>
              </div>
            )}
          </TabsContent>
          <TabsContent value="exit">{tab === 'exit' && <ExitTab e={e} />}</TabsContent>
          <TabsContent value="timeline">{tab === 'timeline' && <TimelineTab e={e} />}</TabsContent>
        </div>
      </TabsRoot>

      {action === 'edit' && <EditDialog e={e} onClose={close} />}
      {action === 'revise' && <ReviseDialog e={e} onClose={close} />}
      {action === 'advance' && <GrantDialog type="ADVANCE" employee={{ id: e.id, name: e.name }} onClose={close} />}
      {action === 'exit' && <RecordExit e={e} onClose={close} />}
    </div>
  );
}
