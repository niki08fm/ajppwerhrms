import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Copy, Lock, Plus } from 'lucide-react';
import { describeComponentRule, formatINR } from '@ajpwer/shared';
import { api } from '@/services/api';
import { Money, PageHeader, ProportionBar } from '@/components/bits';
import { Chip, EmptyState, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

export const ruleOf = describeComponentRule;

export default function Structures() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['structures'], queryFn: () => api.get('/structures').then((r) => r.data) });
  return (
    <div>
      <PageHeader
        title="Salary structures"
        description="Component templates. A structure has no date of its own: attach it to a pay group, and the month you choose there is when that group is paid on it. Structures are never edited in place; duplicate and edit makes a new one, and the people on the original stay on it until their pay group moves."
        actions={
          <Button onClick={() => nav('/setup/structures/new')}>
            <Plus /> New structure
          </Button>
        }
      />

      {q.isLoading ? (
        <SkeletonBlock className="h-80" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <Card>
          <EmptyState
            title="No structures yet"
            body="Build one: Basic, HRA and any allowances. Whatever is left of gross becomes the Special Allowance."
            action={<Button onClick={() => nav('/setup/structures/new')}>Build a structure</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {q.data.map((s) => (
            <Card key={s.id}>
              <CardHeader
                title={s.name}
                description={
                  s.pay_groups.length
                    ? `Pay groups: ${s.pay_groups.map((g) => g.name).join(', ')} · ${s.people} ${s.people === 1 ? 'person' : 'people'} paid on it`
                    : s.people
                      ? `${s.people} ${s.people === 1 ? 'person' : 'people'} paid on it · not attached to a pay group`
                      : 'Not attached to a pay group yet'
                }
                actions={
                  <>
                    {s.immutable && (
                      <Chip tone="muted">
                        <Lock className="size-3" /> In use
                      </Chip>
                    )}
                    <Button variant="outline" size="sm" onClick={() => nav(`/setup/structures/new?from=${s.id}`)}>
                      <Copy /> Duplicate and edit
                    </Button>
                  </>
                }
              />

              <CardBody className="flex flex-col gap-3">
                <ProportionBar parts={s.sample.monthly.map((c, i) => ({ label: c.name, value: c.amount, colour: s.components.filter((x) => x.frequency === 'MONTHLY')[i]?.colour }))} />
                <table className="w-full text-[13px]">
                  <thead className="text-left text-[12px] text-muted-foreground">
                    <tr>
                      <th className="py-1">Component</th>
                      <th>Rule</th>
                      <th>Tax</th>
                      <th>PF base</th>
                      <th className="text-right">At {formatINR(s.sample.gross)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.components.map((c) => {
                      const amt = (c.frequency === 'MONTHLY' ? s.sample.monthly : s.sample.yearly).find((x) => x.name === c.name)?.amount ?? 0;
                      return (
                        <tr key={c.seq} className="border-t">
                          <td className="py-1">
                            {c.name}
                            {c.frequency === 'YEARLY' && <span className="text-[11px] text-muted-foreground"> (yearly, month {c.pay_month})</span>}
                          </td>
                          <td className="text-muted-foreground">{ruleOf(c)}</td>
                          <td>{c.is_taxable ? 'Taxable' : 'Exempt'}</td>
                          <td>{c.counts_as_wages ? <Chip tone="info">PF base</Chip> : ''}</td>
                          <td className="text-right">
                            <Money value={amt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {s.validation.warnings.map((w) => (
                  <Notice key={w} tone="warning">
                    {w}
                  </Notice>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  Sample at {formatINR(s.sample.gross)} a month{s.components.some((c) => c.calc_type === 'PCT_CTC') ? `, a CTC of ${formatINR(s.sample.annual_ctc)} a year` : ''}. Whatever is left of
                  gross is the Special Allowance.
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
