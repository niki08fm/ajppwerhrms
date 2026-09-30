import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Copy, Lock, Plus } from 'lucide-react';
import { describeComponentRule, formatINR, type CalcType } from '@ajpwer/shared';
import { api } from '@/lib/api';
import { Money, PageHeader, ProportionBar } from '@/components/bits';
import { Chip, EmptyState, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

export interface Component {
  id?: string;
  seq: number;
  name: string;
  calc_type: CalcType;
  calc_value: number;
  /** Cap on a percentage component, in paise; null for none */
  max_amount: number | null;
  frequency: 'MONTHLY' | 'YEARLY';
  pay_month: number | null;
  is_taxable: boolean;
  counts_as_wages: boolean;
  colour: string;
}
export interface Structure {
  id: string;
  name: string;
  valid_from: string;
  duplicated_from: string | null;
  components: Component[];
  pay_groups: { id: string; name: string }[];
  immutable: boolean;
  sample: { gross: number; annual_ctc: number; monthly: { name: string; amount: number }[]; yearly: { name: string; amount: number }[]; over_budget: boolean };
  validation: { errors: string[]; warnings: string[] };
}

export const ruleOf = describeComponentRule;

export default function Structures() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['structures'], queryFn: () => api.get<{ data: Structure[] }>('/structures').then((r) => r.data) });
  return (
    <div>
      <PageHeader
        title="Salary structures"
        description="Component templates. Structures are never edited in place: duplicate and edit creates a new one with its own effective date. A structure referenced by a salary or payslip is immutable."
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
      ) : !q.data!.length ? (
        <Card>
          <EmptyState title="No structures yet" body="Build one: Basic, HRA and any allowances. Whatever is left of gross becomes the Special Allowance." action={<Button onClick={() => nav('/setup/structures/new')}>Build a structure</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {q.data!.map((s) => (
            <Card key={s.id}>
              <CardHeader
                title={s.name}
                description={`From ${s.valid_from}${s.pay_groups.length ? ` · used by ${s.pay_groups.map((g) => g.name).join(', ')}` : ''}`}
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
                  Sample at {formatINR(s.sample.gross)} a month{s.components.some((c) => c.calc_type === 'PCT_CTC') ? `, a CTC of ${formatINR(s.sample.annual_ctc)} a year` : ''}. Whatever is left of gross is the Special Allowance.
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
