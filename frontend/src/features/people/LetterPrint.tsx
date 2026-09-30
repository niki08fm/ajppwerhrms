import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { longDate } from '@/lib/utils';
import { Money } from '@/components/bits';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';

interface Snapshot {
  company: { name: string; address: string | null } | null;
  employee: { code: string; name: string; designation: string; department: string; joined_on: string; last_day?: string | null; address?: string | null };
  offer?: { ref: string; mode: string; amount: number; join_by: string; valid_till: string };
  pay_group: string;
  salary: { mode: string; amount: number; monthly_gross: number; annual_ctc: number; components: { name: string; amount: number }[]; yearly: { name: string; amount: number }[]; employer_pf: number; employer_esi: number; take_home: number } | null;
  generated_on: string;
}

/** Printed from the letter's frozen snapshot — what was actually stated, not today's figures. */
export default function LetterPrint() {
  const { employeeId, letterId } = useParams();
  const q = useQuery({ queryKey: ['letter', letterId], queryFn: () => api.get<{ data: { kind: string; ref: string; issued_on: string | null; snapshot: Snapshot } }>(`/employees/${employeeId}/letters/${letterId}`).then((r) => r.data) });
  if (q.isLoading) return <SkeletonBlock className="m-6 h-96" />;
  if (q.isError) return <ErrorState error={q.error} />;
  const { kind, ref, issued_on, snapshot: s } = q.data!;
  const first = s.employee.name.split(' ')[0];
  const date = longDate(issued_on ?? s.generated_on);
  const salaryTable = s.salary && (
    <table className="my-4 w-full border text-[13px]">
      <thead>
        <tr className="border-b bg-muted/40">
          <th className="px-3 py-1.5 text-left">Component</th>
          <th className="px-3 py-1.5 text-right">Monthly</th>
          <th className="px-3 py-1.5 text-right">Annual</th>
        </tr>
      </thead>
      <tbody>
        {s.salary.components.map((c) => (
          <tr key={c.name} className="border-b">
            <td className="px-3 py-1">{c.name}</td>
            <td className="px-3 py-1 text-right">
              <Money value={c.amount} />
            </td>
            <td className="px-3 py-1 text-right">
              <Money value={c.amount * 12} />
            </td>
          </tr>
        ))}
        <tr className="border-b font-semibold">
          <td className="px-3 py-1">Gross salary</td>
          <td className="px-3 py-1 text-right">
            <Money value={s.salary.monthly_gross} />
          </td>
          <td className="px-3 py-1 text-right">
            <Money value={s.salary.monthly_gross * 12} />
          </td>
        </tr>
        {s.salary.yearly.map((c) => (
          <tr key={c.name} className="border-b">
            <td className="px-3 py-1">{c.name} (annual)</td>
            <td className="px-3 py-1 text-right">—</td>
            <td className="px-3 py-1 text-right">
              <Money value={c.amount} />
            </td>
          </tr>
        ))}
        <tr className="border-b">
          <td className="px-3 py-1">Employer PF, EDLI and admin</td>
          <td className="px-3 py-1 text-right">
            <Money value={s.salary.employer_pf} />
          </td>
          <td className="px-3 py-1 text-right">
            <Money value={s.salary.employer_pf * 12} />
          </td>
        </tr>
        {s.salary.employer_esi > 0 && (
          <tr className="border-b">
            <td className="px-3 py-1">Employer ESI</td>
            <td className="px-3 py-1 text-right">
              <Money value={s.salary.employer_esi} />
            </td>
            <td className="px-3 py-1 text-right">
              <Money value={s.salary.employer_esi * 12} />
            </td>
          </tr>
        )}
        <tr className="font-semibold">
          <td className="px-3 py-1">Cost to company</td>
          <td />
          <td className="px-3 py-1 text-right">
            <Money value={s.salary.annual_ctc} />
          </td>
        </tr>
      </tbody>
    </table>
  );
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="no-print mb-4 flex justify-end">
        <Button onClick={() => window.print()}>
          <Printer /> Print
        </Button>
      </div>
      <article className="print-area rounded-lg border bg-card p-10 font-serif text-[14px] leading-relaxed">
        <header className="mb-8 border-b pb-4">
          <div className="font-display text-2xl font-semibold">{s.company?.name ?? 'AJ Power Engineering'}</div>
          <div className="text-[12px] text-muted-foreground">{s.company?.address}</div>
        </header>
        <div className="mb-6 flex justify-between text-[13px]">
          <span>Ref: {ref}</span>
          <span>{date}</span>
        </div>
        <p>
          {s.employee.name}
          {s.employee.address && (
            <>
              <br />
              {s.employee.address}
            </>
          )}
        </p>
        {kind === 'OFFER' && (
          <>
            <h2 className="my-6 text-center font-display text-lg font-semibold">Offer of employment</h2>
            <p>Dear {first},</p>
            <p className="mt-3">
              We are pleased to offer you the position of <strong>{s.employee.designation}</strong> in our {s.employee.department} department, in the {s.pay_group} pay group, with an expected joining date of <strong>{longDate(s.offer?.join_by ?? s.employee.joined_on)}</strong>.
            </p>
            <p className="mt-3">
              Your remuneration is {s.salary?.mode === 'CTC' ? 'an annual cost to company' : 'a monthly gross salary'} of <strong><Money value={s.offer?.amount ?? s.salary?.amount} /></strong>, made up as follows:
            </p>
            {salaryTable}
            <p>Statutory deductions — provident fund, ESI where applicable, professional tax and income tax — are made as the law requires. Please confirm your acceptance by {longDate(s.offer?.valid_till ?? s.generated_on)}.</p>
          </>
        )}
        {kind === 'JOINING' && (
          <>
            <h2 className="my-6 text-center font-display text-lg font-semibold">Appointment letter</h2>
            <p>Dear {first},</p>
            <p className="mt-3">
              This confirms your appointment as <strong>{s.employee.designation}</strong> with effect from <strong>{longDate(s.employee.joined_on)}</strong>, employee code {s.employee.code}. Your attendance is recorded by face punch at our sites; your working rules — calendar, weekly off, shift and policies — are those of the {s.pay_group} pay group.
            </p>
            {salaryTable}
          </>
        )}
        {kind === 'REVISION' && (
          <>
            <h2 className="my-6 text-center font-display text-lg font-semibold">Revision of salary</h2>
            <p>Dear {first},</p>
            <p className="mt-3">We are pleased to inform you that your salary has been revised. Your revised remuneration is set out below.</p>
            {salaryTable}
          </>
        )}
        {(kind === 'RELIEVING' || kind === 'EXPERIENCE') && (
          <>
            <h2 className="my-6 text-center font-display text-lg font-semibold">{kind === 'RELIEVING' ? 'Relieving letter' : 'Experience certificate'}</h2>
            <p className="mt-3">
              This is to certify that {s.employee.name} (employee code {s.employee.code}) was employed with us as {s.employee.designation} in the {s.employee.department} department from {longDate(s.employee.joined_on)} to {longDate(s.employee.last_day ?? s.generated_on)}
              {kind === 'RELIEVING' ? ', and has been relieved of their duties with effect from the close of that day.' : '.'}
            </p>
            <p className="mt-3">We wish them well in their future endeavours.</p>
          </>
        )}
        <div className="mt-16">
          <p>For {s.company?.name ?? 'AJ Power Engineering'}</p>
          <p className="mt-12">Authorised signatory</p>
        </div>
      </article>
    </div>
  );
}
