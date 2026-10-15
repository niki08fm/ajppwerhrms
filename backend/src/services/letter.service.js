import { audit } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { asOfDate, markTask } from './employee.service.js';
import { salaryOn } from './rules.service.js';
import { previewSalary } from './salary.service.js';

/**
 * Issue (or draft) a letter for a loaded employee. The snapshot freezes the figures it states,
 * so it reprints exactly as issued. Issuing the joining letter ticks its onboarding step.
 */
export async function issueLetter(db, e, kind, { today, issue = true, actor, ip }) {
  const company = await db.company.findFirst();
  const date = asOfDate(e, today);
  const cur = await salaryOn(db, e.id, kind === 'RELIEVING' || kind === 'EXPERIENCE' ? (fromDbDate(e.last_day) ?? date) : date);
  const preview = cur
    ? await previewSalary(db, {
      mode: cur.mode, amount: cur.amount, structure_id: cur.structure_id, date, gender: e.gender,
      pt_state: e.statutory.pt_state, pt_applicable: e.statutory.pt_applicable,
      pf_enabled: e.statutory.pf_enabled, eps_enabled: e.statutory.eps_enabled ?? true, pf_restrict_to_ceiling: e.statutory.pf_restrict_to_ceiling,
      vpf_pct: Number(e.statutory.vpf_pct), esi_enabled: e.statutory.esi_enabled,
      saved_gross: cur.monthly_gross,
    })
    : null;
  const count = await db.letter.count();
  const ref = `AJPWER/${kind.slice(0, 3)}/${date.slice(0, 4)}/${String(count + 1).padStart(5, '0')}`;
  const snapshot = {
    company: company ? { name: company.name, address: company.address } : null,
    employee: { code: e.code, name: e.name, designation: e.designation, department: e.department.name, joined_on: fromDbDate(e.joined_on), last_day: fromDbDate(e.last_day), address: e.address },
    pay_group: e.pay_group.name,
    salary:
      cur && preview
        ? {
            mode: cur.mode,
            amount: cur.amount,
            monthly_gross: preview.gross,
            annual_ctc: preview.ctc.annual_ctc,
            components: preview.structure.monthly.map((c) => ({ name: c.name, amount: c.amount })),
            yearly: preview.structure.yearly.map((c) => ({ name: c.name, amount: c.amount })),
            employer_pf: preview.ctc.employer_pf,
            employer_esi: preview.ctc.employer_esi,
            take_home: preview.take_home,
          }
        : null,
    generated_on: today,
  };
  const letter = await db.letter.create({ data: { employee_id: e.id, kind, ref, issued_on: issue ? toDbDate(today) : null, snapshot: JSON.parse(JSON.stringify(snapshot)) } });
  if (kind === 'JOINING' && issue) await markTask(db, e.id, 'JOINING_LETTER', actor);
  await audit(db, { actor, ip, action: 'letter.issue', entity_type: 'employee', entity_id: e.id, detail: { kind, ref } });
  return letter;
}
