import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { DAY_STATUS_LABELS, DAY_STATUS_TONE, formatINR } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, initials, longDate, monthLabel } from '@/utils';
import { Mono } from '@/components/bits';
import { Chip, EmployeeStatusChip, ErrorState, SkeletonBlock } from '@/components/states';
import { Card } from '@/components/ui/card';
import { TabsContent, TabsList, TabsRoot, Tooltip } from '@/components/ui/overlay';
import { OverviewTab } from '../../components/people/profile-tabs/Overview';
import { AttendanceTab } from '../../components/people/profile-tabs/Attendance';
import { PayTab } from '../../components/people/profile-tabs/Pay';
import { TaxTab } from '../../components/people/profile-tabs/Tax';
import { SalaryHistoryTab } from '../../components/people/profile-tabs/SalaryHistory';
import { PayslipsTab } from '../../components/people/profile-tabs/Payslips';
import { LoansTab } from '../../components/people/profile-tabs/Loans';
import { DocumentsTab } from '../../components/people/profile-tabs/Documents';
import { LettersTab } from '../../components/people/profile-tabs/Letters';
import { OnboardingTab } from '../../components/people/profile-tabs/Onboarding';
import { ExitTab } from '../../components/people/profile-tabs/Exit';
import { TimelineTab } from '../../components/people/profile-tabs/Timeline';
import { SalaryHoldCard, useHold } from '../../components/people/profile-tabs/SalaryHold';

const TABS = [
  ['overview', 'Overview'],
  ['time', 'Time and leave'],
  ['pay', 'Pay'],
  ['records', 'Documents and letters'],
  ['exit', 'Exit'],
];

/** The sections of the Pay tab, in reading order. */
const PAY_SECTIONS = [
  ['pay', 'Pay and statutory'],
  ['payslips', 'Payslips'],
  ['salary', 'Salary history'],
  ['tax', 'Income tax'],
  ['loans', 'Loans and advances'],
];

/** Old tab names (links from other screens, saved views) and where they live now. */
const MOVED = {
  attendance: ['time'],
  leave: ['time'],
  pay: ['pay', 'pay'],
  payslips: ['pay', 'payslips'],
  salary: ['pay', 'salary'],
  tax: ['pay', 'tax'],
  loans: ['pay', 'loans'],
  documents: ['records', 'documents'],
  letters: ['records', 'letters'],
  onboarding: ['overview', 'onboarding'],
  face: ['overview', 'onboarding'],
  edit: ['overview'],
  timeline: ['overview', 'timeline'],
};

const LEGEND = [
  ['success', 'Present'],
  ['info', 'Leave or off day worked'],
  ['warning', 'Half day or missing punch'],
  ['destructive', 'Absent'],
  ['muted', 'Off day'],
];

const STRIP_TONE = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-info',
  muted: 'bg-border',
};

/**
 * This month as a punch strip: one cell a day, coloured by what the day was.
 * Absences and half days stand out; off days recede.
 */
function MonthStrip({ e, month, today }) {
  const q = useQuery({ queryKey: ['emp-attendance', e.id, month], queryFn: () => api.get(`/employees/${e.id}/attendance`, { month }).then((r) => r.data), enabled: !!month });
  if (!q.data) return <SkeletonBlock className="h-7 w-full" />;
  const t = q.data.totals;
  return (
    <div>
      {/* Two rows on a phone, so each day stays big enough to see. */}
      <div className="grid grid-cols-16 gap-[3px] sm:flex" role="img" aria-label={`${monthLabel(month)}: ${t.paid_days} paid days of ${t.days_in_month}`}>
        {q.data.days.map((d) => (
          <Tooltip key={d.date} content={d.date > today ? `${longDate(d.date)} — still to come` : `${longDate(d.date)} — ${DAY_STATUS_LABELS[d.status]}${d.leave_type ? ` (${d.leave_type})` : ''}`}>
            {/* Days still to come are outlined, not coloured: no punches yet is not an absence. */}
            <span className={cn('h-7 min-w-1 flex-1 rounded-[3px]', d.date > today ? 'border border-dashed border-border bg-card' : (STRIP_TONE[DAY_STATUS_TONE[d.status]] ?? 'bg-border'), d.date === today && 'ring-2 ring-primary ring-offset-1 ring-offset-card')} />
          </Tooltip>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">{monthLabel(month)}</span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px] ring-2 ring-primary" />
          Today
        </span>
        {LEGEND.map(([tone, label]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={cn('size-2.5 rounded-[2px]', STRIP_TONE[tone])} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A labelled figure in the summary band: the figure leads, the label sits above it. */
function Fact({ label, value, sub }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</div>
      {/* Wraps rather than truncates: a cut-off figure is worse than a second line. */}
      <div className="mt-1 text-lg leading-snug font-semibold break-words num">{value}</div>
      {sub && <div className="text-[13px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Who this is and where they stand today — always on screen above the tabs. */
function Summary({ e }) {
  const { data: lk } = useLookups();
  const month = lk?.today?.slice(0, 7);
  const leave = useQuery({ queryKey: ['emp-leave', e.id], queryFn: () => api.get(`/employees/${e.id}/leave-balances`).then((r) => r.data) });
  const hold = useHold(e.id);
  const att = useQuery({ queryKey: ['emp-attendance', e.id, month], queryFn: () => api.get(`/employees/${e.id}/attendance`, { month }).then((r) => r.data), enabled: !!month });
  const pl = leave.data?.types?.find((t) => t.auto_apply) ?? leave.data?.types?.find((t) => t.closing !== null);
  // The month so far: days still to come are not counted as absences.
  const today = lk?.today;
  const past = att.data?.days.filter((d) => d.date <= today && d.status !== 'NOT_JOINED' && d.status !== 'EXITED') ?? null;
  const paidSoFar = past ? Math.round(past.reduce((a, d) => a + d.day_value, 0) * 100) / 100 : null;
  const lateSoFar = past ? past.filter((d) => d.late_min > 0).length : 0;
  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-start gap-4 px-5 pt-5">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold text-white" style={{ background: `var(--${e.department.colour})` }}>
          {initials(e.name)}
        </span>
        {/* A base width, so on a phone the status chips drop below the name instead of covering it. */}
        <div className="min-w-0 flex-[1_1_14rem]">
          <h1 className="font-display text-[28px] leading-tight font-semibold">{e.name}</h1>
          <div className="mt-0.5 text-sm text-muted-foreground">
            {e.designation} · {e.department.name} · <Mono>{e.code}</Mono>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EmployeeStatusChip status={e.status} />
          {e.last_day && <Chip tone="warning">Last day {longDate(e.last_day)}</Chip>}
          {hold.data?.current && <Chip tone="warning">Salary on hold since {monthLabel(hold.data.current.from_ym)}</Chip>}
          {e.read_only && (
            <Chip tone="muted">
              <Lock className="size-3" /> Read-only after exit
            </Chip>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 px-5 py-5 md:grid-cols-4">
        <Fact label="Pay group" value={e.pay_group.name} sub={`Joined ${longDate(e.joined_on)}`} />
        <Fact label="Monthly gross" value={e.salary ? formatINR(e.salary.monthly_gross) : '—'} sub={e.salary ? (e.salary.mode === 'CTC' ? `CTC ${formatINR(e.salary.amount)} a year` : 'Agreed as gross') : 'No salary yet'} />
        <Fact label={pl ? `${pl.name} left` : 'Leave left'} value={pl ? `${pl.balance} days` : '—'} sub={pl ? `${pl.used_ytd + pl.auto_ytd} taken this leave year` : undefined} />
        <Fact
          label="This month so far"
          value={past ? `${paidSoFar} of ${past.length} days paid` : '—'}
          sub={past ? `${Math.round((past.length - paidSoFar) * 100) / 100} loss of pay · ${lateSoFar} late` : undefined}
        />
      </div>
      {month && e.status !== 'OFFER' && e.status !== 'ACCEPTED' && (
        <div className="border-t bg-muted/40 px-5 py-4">
          <MonthStrip e={e} month={month} today={today} />
        </div>
      )}
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

/** Full screen at its own route — /people/:id?tab=pay&section=tax — never a side panel. */
export default function Profile() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab') ?? 'overview';
  const [tab, movedSection] = TABS.some(([v]) => v === raw) ? [raw] : (MOVED[raw] ?? ['overview']);
  const section = sp.get('section') ?? movedSection;
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

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 text-[13px] text-muted-foreground">
        <Link to="/people" className="hover:text-foreground hover:underline">
          Employees
        </Link>{' '}
        › <span className="font-medium text-foreground">{e.name}</span>
      </nav>
      <Summary e={e} />

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
                <Section id="section-timeline">
                  <TimelineTab e={e} />
                </Section>
              </div>
            )}
          </TabsContent>
          <TabsContent value="time">{tab === 'time' && <AttendanceTab e={e} />}</TabsContent>
          <TabsContent value="pay">
            {tab === 'pay' && (
              <div className="flex flex-col gap-5">
                <div className="sticky top-0 z-20 -mx-1 flex flex-wrap gap-1 rounded-lg border bg-card/95 p-1 shadow-sm backdrop-blur">
                  {PAY_SECTIONS.map(([k, l]) => (
                    <button
                      key={k}
                      onClick={() => document.getElementById(`section-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      className="rounded-md px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
                <Section id="section-payslips">
                  <PayslipsTab e={e} />
                </Section>
                <Section id="section-salary">
                  <SalaryHistoryTab e={e} />
                </Section>
                <Section id="section-tax">
                  <TaxTab e={e} />
                </Section>
                <Section id="section-loans">
                  <LoansTab e={e} />
                </Section>
              </div>
            )}
          </TabsContent>
          <TabsContent value="records">
            {tab === 'records' && (
              <div className="flex flex-col gap-5">
                <Section id="section-documents">
                  <DocumentsTab e={e} />
                </Section>
                <Section id="section-letters">
                  <LettersTab e={e} />
                </Section>
              </div>
            )}
          </TabsContent>
          <TabsContent value="exit">{tab === 'exit' && <ExitTab e={e} />}</TabsContent>
        </div>
      </TabsRoot>
    </div>
  );
}
