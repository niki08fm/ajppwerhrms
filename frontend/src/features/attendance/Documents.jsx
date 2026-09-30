import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DOCUMENT_TYPES } from '@ajpwer/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { PageHeader, PersonLink, Stat } from '@/components/bits';
import { DataTable } from '@/components/data-table';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { docLabel } from '../people/tabs/Documents';

const KIND = { MISSING: ['Missing', 'destructive'], EXPIRED: ['Expired', 'destructive'], EXPIRING: ['Expiring in 30 days', 'warning'], UNVERIFIED: ['Not verified', 'info'] };

/** What is missing or expiring, across everyone. */
export default function Documents() {
  const { data: lk } = useLookups();
  const [type, setType] = useState('');
  const [kind, setKind] = useState('');
  const [dept, setDept] = useState('');
  const q = useQuery({
    queryKey: ['documents-overview', type, kind, dept],
    queryFn: () => api.get('/documents', { type, kind, dept }),
  });
  const d = q.data?.data;
  const cols = [
    { id: 'who', header: 'Person', sticky: true, width: 220, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} tab="documents" /> },
    { id: 'dept', header: 'Department', cell: (r) => r.employee.department },
    { id: 'doc', header: 'Document', cell: (r) => docLabel(r.doc_type) },
    { id: 'kind', header: 'Issue', cell: (r) => <Chip tone={KIND[r.kind][1]}>{KIND[r.kind][0]}</Chip> },
    { id: 'detail', header: 'Detail', cell: (r) => r.detail },
  ];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Documents" description="Coverage of the documents every file needs, and what is missing, expired or unverified. Each row opens the person's documents tab." />
      {d && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {d.coverage.map((c) => (
            <Stat
              key={c.doc_type}
              label={docLabel(c.doc_type)}
              value={`${c.total ? Math.round((c.have / c.total) * 100) : 0}%`}
              sub={`${c.have} of ${c.total} collected`}
              tone={c.have < c.total ? 'warning' : 'success'}
            />
          ))}
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {d?.by_kind.map((k) => (
            <button key={k.kind} onClick={() => setKind(kind === k.kind ? '' : k.kind)} className={`rounded-full ${kind === k.kind ? 'ring-2 ring-ring' : ''}`}>
              <Chip tone={KIND[k.kind][1]}>
                {KIND[k.kind][0]} {k.count}
              </Chip>
            </button>
          ))}
          <div className="flex-1" />
          <Select className="w-44" value={type} onChange={(e) => setType(e.target.value)} aria-label="Document type">
            <option value="">All documents</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {docLabel(t)}
              </option>
            ))}
          </Select>
          <Select className="w-44" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {lk?.departments.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </div>
        {q.isLoading ? (
          <SkeletonRows rows={8} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !d.issues.length ? (
          <EmptyState title="Nothing outstanding" body="Every file has what it needs." />
        ) : (
          <DataTable columns={cols} rows={d.issues} rowId={(r) => `${r.employee.id}${r.doc_type}${r.kind}`} maxHeight="60vh" />
        )}
        {q.data && (
          <p className="border-t px-3 py-2 text-[12px] text-muted-foreground num">
            Showing {d.issues.length} of {q.data.meta.total}
          </p>
        )}
      </Card>
    </div>
  );
}
