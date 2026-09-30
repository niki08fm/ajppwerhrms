import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api } from '@/services/api';
import { initials, longDate } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { Chip, EmployeeStatusChip, ErrorState, SkeletonBlock } from '@/components/states';
import { TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';
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

const TABS = [
  ['overview', 'Overview'],
  ['attendance', 'Attendance'],
  ['pay', 'Pay and statutory'],
  ['tax', 'Income tax'],
  ['salary', 'Salary history'],
  ['payslips', 'Payslips'],
  ['loans', 'Advances and loans'],
  ['documents', 'Documents'],
  ['letters', 'Letters'],
  ['onboarding', 'Onboarding'],
  ['exit', 'Exit'],
  ['timeline', 'Timeline'],
];

/** Full screen at its own route — /people/:id?tab=tax — never a side panel. */
export default function Profile() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'overview';
  const q = useQuery({ queryKey: ['employee', id], queryFn: () => api.get(`/employees/${id}`).then((r) => r.data) });

  if (q.isLoading)
    return (
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-16" />
        <SkeletonBlock className="h-10" />
        <SkeletonBlock className="h-96" />
      </div>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  const setTab = (t) =>
    setSp(
      (p) => {
        const n = new URLSearchParams(p);
        n.set('tab', t);
        return n;
      },
      { replace: true },
    );

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'People', to: '/people' }, { label: e.name }]}
        title={
          <span className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-full text-base font-semibold text-primary-foreground" style={{ background: `var(--${e.department.colour})` }}>
              {initials(e.name)}
            </span>
            <span>
              {e.name}
              <span className="block font-sans text-[13px] font-normal text-muted-foreground">
                {e.designation} · {e.department.name} · <Mono>{e.code}</Mono>
              </span>
            </span>
          </span>
        }
        meta={
          <>
            <EmployeeStatusChip status={e.status} />
            <Chip>{e.pay_group.name}</Chip>
            <Chip>Joined {longDate(e.joined_on)}</Chip>
            {e.last_day && <Chip tone="warning">Last day {longDate(e.last_day)}</Chip>}
            {e.read_only && (
              <Chip tone="muted">
                <Lock className="size-3" /> Read-only after exit
              </Chip>
            )}
          </>
        }
      />

      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList
          tabs={TABS.map(([v, l]) => ({
            value: v,
            label: l,
            badge:
              v === 'onboarding' && e.onboarding.required_left > 0 && e.status !== 'ACTIVE' ? (
                <span className="rounded-full bg-warning/20 px-1.5 text-[10px]">{e.onboarding.required_left}</span>
              ) : undefined,
          }))}
        />

        <div className="pt-4">
          <TabsContent value="overview">
            <OverviewTab e={e} />
          </TabsContent>
          <TabsContent value="attendance">{tab === 'attendance' && <AttendanceTab e={e} />}</TabsContent>
          <TabsContent value="pay">{tab === 'pay' && <PayTab e={e} />}</TabsContent>
          <TabsContent value="tax">{tab === 'tax' && <TaxTab e={e} />}</TabsContent>
          <TabsContent value="salary">{tab === 'salary' && <SalaryHistoryTab e={e} />}</TabsContent>
          <TabsContent value="payslips">{tab === 'payslips' && <PayslipsTab e={e} />}</TabsContent>
          <TabsContent value="loans">{tab === 'loans' && <LoansTab e={e} />}</TabsContent>
          <TabsContent value="documents">{tab === 'documents' && <DocumentsTab e={e} />}</TabsContent>
          <TabsContent value="letters">{tab === 'letters' && <LettersTab e={e} />}</TabsContent>
          <TabsContent value="onboarding">{tab === 'onboarding' && <OnboardingTab e={e} />}</TabsContent>
          <TabsContent value="exit">{tab === 'exit' && <ExitTab e={e} />}</TabsContent>
          <TabsContent value="timeline">{tab === 'timeline' && <TimelineTab e={e} />}</TabsContent>
        </div>
      </TabsRoot>
    </div>
  );
}
