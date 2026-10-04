import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { Mono } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Menu } from '@/components/ui/overlay';

const KINDS = [
  ['JOINING', 'Joining letter'],
  ['REVISION', 'Salary revision letter'],
  ['RELIEVING', 'Relieving letter'],
  ['EXPERIENCE', 'Experience letter'],
];

export const letterName = (k) => (k === 'OFFER' ? 'Offer letter' : k === 'SETTLEMENT' ? 'Settlement statement' : (KINDS.find((x) => x[0] === k)?.[1] ?? k));

export function LettersTab({ e }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['letters', e.id], queryFn: () => api.get(`/employees/${e.id}/letters`).then((r) => r.data) });
  const issue = useMutation({
    mutationFn: (kind) => api.post(`/employees/${e.id}/letters`, { kind, issue: true }),
    onSuccess: (r) => {
      toast.success('Letter issued. Its figures are frozen as of today.');
      qc.invalidateQueries({ queryKey: ['letters', e.id] });
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      window.open(`/print/letter/${e.id}/${r.data.id}`, '_blank');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card>
      <CardHeader
        title="Letters"
        description="Each letter keeps the figures it stated, so it reprints exactly as issued."
        actions={
          <Menu
            trigger={
              <Button size="sm" loading={issue.isPending}>
                New letter
              </Button>
            }
            items={KINDS.map(([k, l]) => ({ label: l, onSelect: () => issue.mutate(k), disabled: (k === 'RELIEVING' || k === 'EXPERIENCE') && !e.last_day }))}
          />
        }
      />

      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState title="No letters issued" body="The offer letter appears here once an offer is issued. Issue the joining letter during onboarding." />
      ) : (
        <div className="overflow-x-auto"><table className="data-table w-full">
          <thead>
            <tr>
              <th>Letter</th>
              <th>Based on</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((l) => (
              <tr key={l.id}>
                <td>{letterName(l.kind)}</td>
                <td className="text-[13px] text-muted-foreground">
                  <Mono>{l.ref}</Mono> · {l.issued_on ? `issued ${l.issued_on}` : <Chip tone="warning">Draft</Chip>}
                </td>
                <td className="text-right">
                  <Button size="sm" variant="outline" onClick={() => window.open(`/print/letter/${e.id}/${l.id}`, '_blank')}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Card>
  );
}
