import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '@/services/api';
import { useKeysetList, useListParams } from '@/hooks';
import { istTime } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { DataTable, Pager } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { EmptyState, ErrorState, NoMatches, SkeletonRows } from '@/components/states';
import { Card } from '@/components/ui/card';

const LABELS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.site_login': 'Tablet signed in',
  'auth.site_login_failed': 'Tablet sign-in failed',
  'geofence.rejected': 'Rejected outside the geofence',
  'pii.read': 'Identity data read',
  'pii.write': 'Identity data changed',
  'employee.create': 'Employee added',
  'employee.update': 'Details changed',
  'employee.pay_group_change': 'Pay group changed',
  'employee.activate': 'Activated',
  'employee.resign': 'Put on notice',
  'salary.revise': 'Salary revised',
  'salary.restate': 'Salary restated',
  'statutory.update': 'Statutory setup changed',
  'attendance.override': 'Attendance corrected',
  'attendance.override.revert': 'Correction reverted',
  'offer.issue': 'Offer issued',
  'offer.accept': 'Offer accepted',
  'onboarding.start': 'Onboarding started',
  'onboarding.done': 'Checklist step done',
  'face.enrol': 'Face enrolled',
  'face.delete': 'Face deleted',
  'letter.issue': 'Letter issued',
  'payroll.run': 'Payroll run',
  'payroll.rerun': 'Payroll rerun',
  'payroll.lock': 'Payroll locked',
  'payroll.unlock': 'Payroll unlocked',
  'payroll.mark_paid': 'Payroll marked paid',
  'payroll.unmark_paid': 'Payroll unmarked paid',
  'payroll.back_to_steps': 'Payroll taken back to steps',
  'payroll.step.submit': 'Payroll step submitted',
  'payroll.step.reopen': 'Payroll step reopened',
  'payroll.hold_back': 'Held back from payroll',
  'policy.create': 'Policy created',
  'policy.version': 'Policy version published',
  'structure.create': 'Salary structure created',
  'site.create': 'Site created',
  'site.password_rotate': 'Site password rotated',
};

export const actionLabel = (a) => LABELS[a] ?? a.replace(/[._]/g, ' ');

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Old and new values, readable. */
export function AuditDetail({ detail }) {
  const changes = detail.changes ?? null;
  if (changes && Object.keys(changes).length) {
    return (
      <ul className="mt-0.5 text-[12px] text-muted-foreground">
        {Object.entries(changes).map(([k, v]) => (
          <li key={k}>
            {k.replace(/_/g, ' ')}: <span className="line-through">{fmt(v.from)}</span> → <span className="text-foreground">{fmt(v.to)}</span>
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(detail).filter(([k]) => !['employee_id'].includes(k));
  if (!entries.length) return null;
  return (
    <details className="mt-0.5 text-[12px] text-muted-foreground">
      <summary className="cursor-pointer select-none">Details</summary>
      <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{JSON.stringify(Object.fromEntries(entries), null, 2)}</pre>
    </details>
  );
}

export default function Audit() {
  const lp = useListParams({ sort: '-at' });
  const nav = useNavigate();
  const facets = useQuery({ queryKey: ['audit-facets'], queryFn: () => api.get('/audit/facets').then((r) => r.data) });
  const list = useKeysetList(['audit'], '/audit', lp.apiParams);
  const filters = useMemo(
    () => [
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
      { key: 'actor', label: 'Actor', options: (facets.data?.actors ?? []).map((a) => ({ value: a, label: a })) },
      { key: 'action', label: 'Action', options: (facets.data?.actions ?? []).map((a) => ({ value: a, label: a })) },
      { key: 'entity', label: 'Entity', options: (facets.data?.entities ?? []).map((a) => ({ value: a, label: a.replace(/_/g, ' ') })) },
    ],
    [facets.data],
  );
  const cols = [
    { id: 'at', header: 'Time (IST)', sortKey: 'at', width: 140, sticky: true, cell: (r) => <span className="num">{istTime(r.at, true)}</span> },
    { id: 'actor', header: 'Actor', cell: (r) => r.actor },
    { id: 'action', header: 'Action', cell: (r) => <span className="font-medium">{actionLabel(r.action)}</span> },
    {
      id: 'entity',
      header: 'Entity',
      cell: (r) => {
        const emp = (r.entity_type === 'employee' && r.entity_id) || r.detail.employee_id;
        return emp ? (
          <button className="text-primary hover:underline" onClick={() => nav(`/people/${emp}?tab=timeline`)}>
            {r.entity_type.replace(/_/g, ' ')}
          </button>
        ) : (
          r.entity_type.replace(/_/g, ' ')
        );
      },
    },
    {
      id: 'detail',
      header: 'Detail',
      cell: (r) => (
        <div className="max-w-[520px] whitespace-normal">
          <AuditDetail detail={r.detail} />
        </div>
      ),
    },
    { id: 'ip', header: 'IP', cell: (r) => <Mono className="text-muted-foreground">{r.ip ?? '—'}</Mono> },
  ];
  const filtered = !!lp.q || Object.keys(lp.filters).length > 0;
  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Insert-only. Every payroll transition, correction, salary and statutory change, policy version, login, geofence rejection and read of identity data."
      />
      <Card>
        <ListToolbar
          q={lp.q}
          onQ={(q) => lp.set({ q })}
          placeholder="Search action or actor"
          searching="action, actor and entity id"
          filters={filters}
          values={lp.filters}
          onFilter={(k, v) => lp.set({ [k]: v })}
          onClear={lp.clearFilters}
          list="audit"
          searchParams={lp.searchParams}
          onApplyView={(q) => nav(`/audit?${q}`)}
          exportPath={`/audit/export${qs(lp.apiParams)}`}
          exportName="audit-log.csv"
          total={list.total}
        />

        {list.isLoading ? (
          <SkeletonRows rows={12} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !list.rows.length ? (
          filtered ? (
            <NoMatches onClear={lp.clearFilters} />
          ) : (
            <EmptyState title="Nothing logged yet" body="Entries appear as people use the system." />
          )
        ) : (
          <DataTable columns={cols} rows={list.rows} rowId={(r) => r.id} sort={lp.sort} onSort={lp.toggleSort} fetching={list.isFetching && !list.isLoading} />
        )}
        <Pager
          shown={list.rows.length}
          total={list.total}
          page={list.page}
          hasPrev={list.hasPrev}
          hasNext={list.hasNext}
          onPrev={list.prev}
          onNext={list.next}
          limit={lp.limit}
          onLimit={(n) => lp.set({ limit: String(n) })}
        />
      </Card>
    </div>
  );
}
