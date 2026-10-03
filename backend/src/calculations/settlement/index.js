import { daysToHundredths, formatINR, formatYearMonth, mulDiv, OT_BASE_LABELS, serviceLength } from '@ajpwer/shared';
import { describeEncash } from '../leave/index.js';

/**
 * Gratuity, by the pay group's gratuity policy, after min_years of service:
 *   last month's wages × days_per_year × years ÷ divisor, up to max_amount
 * The wages are the policy's base (basic under the Act). Years are completed years, with a
 * part-year over six months counted as a full one (the Act), or completed years only, or pro rata.
 */
export function computeGratuity(joinedOn, lastDay, wages, rules) {
  const service = serviceLength(joinedOn, lastDay);
  const decimal = Math.round(service.decimalYears * 100) / 100;
  const overSix = service.months > 6 || (service.months === 6 && service.days > 0);
  const eligible = decimal >= rules.min_years;
  let warning = null;
  if (!eligible && decimal >= rules.flag_from_years) {
    warning = `Service is ${service.years} years ${service.months} months — short of the ${rules.min_years}-year gratuity threshold. No gratuity is payable on these dates; confirm with HR before settling.`;
  }
  const years = rules.part_year === 'PRO_RATA' ? decimal : service.years + (rules.part_year === 'OVER_SIX_MONTHS' && overSix ? 1 : 0);
  const full = eligible ? mulDiv(wages, daysToHundredths(rules.days_per_year) * Math.round(years * 100), rules.divisor * 100 * 100) : 0;
  const capped = rules.max_amount !== null && full > rules.max_amount;
  return {
    eligible,
    amount: capped ? rules.max_amount : full,
    capped,
    service_years_decimal: decimal,
    service: { years: service.years, months: service.months, days: service.days },
    completed_years: eligible ? years : service.years,
    warning,
  };
}

/** "Last basic × 15 × 8 ÷ 26, capped at ₹20,00,000" */
export function describeGratuity(g, rules) {
  return `Last ${OT_BASE_LABELS[rules.base].toLowerCase()} × ${rules.days_per_year} × ${g.completed_years} ÷ ${rules.divisor}${g.capped ? `, capped at ${formatINR(rules.max_amount)}` : ''}`;
}

const NO_ADJUSTMENTS = { excluded: {}, days: {}, extra: [] };

/** Lines HR can switch off on a settlement. The final month's salary and its statutory deductions stay. */
const switchable = (code) => /^(LEAVE_ENCASH:|LOAN:|ADVANCE:|HELD:)/.test(code) || ['GRATUITY', 'PENDING_REIMB', 'FINAL_REIMB'].includes(code);

/**
 * Full and final settlement. Pure. No asset recovery: AJPWER does not issue assets, and
 * there is no notice period to recover or pay.
 *
 * Leave left is paid as the leave policy says for each type; gratuity follows the gratuity
 * policy (on death the years of service do not matter — the Payment of Gratuity Act); a
 * salary held and not yet paid is paid with it. HR's adjustments come last: a line switched
 * off still shows, struck out with its reason; a day-based line can be given other days; and
 * HR can add its own earnings and deductions. Open required exit tasks block processing.
 */
export function computeSettlement(input) {
  const e = input.employee;
  const reason = input.exit_reason ?? 'RESIGNATION';
  const adj = { ...NO_ADJUSTMENTS, ...(input.adjustments ?? {}) };
  const earnings = [];
  const deductions = [];
  const clearance = [];
  // A day-based line: HR may set other days; the amount follows them.
  const dayLine = (code, computedDays, wages, divisor, line) => {
    const set = adj.days[code];
    const days = set ? set.days : computedDays;
    return { code, ...line(days), days, computed_days: computedDays, days_reason: set?.reason ?? null, amount: mulDiv(wages, daysToHundredths(days), divisor * 100) };
  };

  if (input.final_month) {
    earnings.push({ code: 'FINAL_SALARY', name: 'Salary for the final month', amount: input.final_month.gross, detail: 'Prorated by the part-month rule' });
    if (input.final_month.reimbursements > 0) {
      earnings.push({ code: 'FINAL_REIMB', name: 'Reimbursements in the final month', amount: input.final_month.reimbursements });
    }
  }

  // Salary held in earlier months and not yet paid: it is owed, so the F&F pays it.
  for (const h of input.held_pay ?? []) {
    if (h.amount > 0) earnings.push({ code: `HELD:${h.period_ym}`, name: `Held salary for ${formatYearMonth(h.period_ym)}`, amount: h.amount, detail: h.reason ? `Held: ${h.reason}` : undefined });
  }

  // Leave left on the last day, for each type its policy pays out on exit.
  for (const l of input.leave_payout ?? []) {
    earnings.push(dayLine(`LEAVE_ENCASH:${l.code}`, l.days, l.wages, l.divisor, (d) => ({ name: `Leave encashment — ${l.name}`, detail: describeEncash(d, l.base, l.divisor) })));
  }

  // Gratuity by its policy. On death the five years are waived (Payment of Gratuity Act, s. 4(1)).
  const rules = input.gratuity_rules;
  let gratuity = null;
  if (rules) {
    const waived = reason === 'DEATH';
    gratuity = computeGratuity(e.joined_on, e.last_day, input.gratuity_wages, waived ? { ...rules, min_years: 0, flag_from_years: 0 } : rules);
    if (gratuity.amount > 0) earnings.push({ code: 'GRATUITY', name: 'Gratuity', amount: gratuity.amount, detail: describeGratuity(gratuity, rules) + (waived ? ' — paid on death whatever the years of service' : '') });
  }

  if (input.pending_reimbursements > 0) {
    earnings.push({ code: 'PENDING_REIMB', name: 'Pending reimbursements', amount: input.pending_reimbursements });
  }

  if (input.final_month) {
    for (const s of input.final_month.statutory_lines) {
      if (s.amount > 0) deductions.push({ code: s.code, name: `${s.name} on the final month`, amount: s.amount });
    }
  }

  // At settlement the recovery cap does not apply: the full balance is due.
  for (const l of input.loans_outstanding) if (l.amount > 0) deductions.push({ code: `LOAN:${l.id}`, name: `Loan outstanding — ${l.label}`, amount: l.amount });
  for (const a of input.advances_outstanding) if (a.amount > 0) deductions.push({ code: `ADVANCE:${a.id}`, name: `Advance outstanding — ${a.label}`, amount: a.amount });

  // HR's own lines.
  for (const x of adj.extra) {
    const line = { code: `ADJ:${x.id}`, id: x.id, name: x.name, amount: x.amount, detail: x.reason, added: true };
    (x.kind === 'EARNING' ? earnings : deductions).push(line);
  }

  // Lines HR switched off stay on the statement, struck out, and count for nothing.
  for (const l of [...earnings, ...deductions]) {
    l.switchable = switchable(l.code);
    const off = adj.excluded[l.code];
    if (off && l.switchable) Object.assign(l, { excluded: true, excluded_reason: off.reason });
  }
  const sum = (xs) => xs.filter((l) => !l.excluded).reduce((s, l) => s + l.amount, 0);
  const total_earnings = sum(earnings);
  const total_deductions = sum(deductions);
  const net = total_earnings - total_deductions;
  const service = serviceLength(e.joined_on, e.last_day);

  // Paid separately, it never reaches the bank file, so no account is needed.
  if (!e.has_bank_account) {
    clearance.push(
      input.paid_separately
        ? { code: 'NO_BANK', severity: 'WARNING', message: 'No bank account on file — fine, as it is paid separately' }
        : { code: 'NO_BANK', severity: 'BLOCKING', message: 'No bank account on file. Add one, or process the F&F as paid separately.' },
    );
  }
  if (!input.final_month_attendance_submitted) {
    clearance.push({ code: 'ATTENDANCE_NOT_SUBMITTED', severity: 'BLOCKING', message: "The final month's attendance is not submitted" });
  }
  const open = input.checklist_open ?? [];
  if (open.length) clearance.push({ code: 'EXIT_CHECKLIST', severity: 'BLOCKING', message: `Exit checklist not finished: ${open.map((t) => t.label.toLowerCase()).join('; ')}` });
  if (net < 0) {
    clearance.push({ code: 'NEGATIVE_NET', severity: 'WARNING', message: 'Net is negative — decide whether to write it off or pursue it' });
  }
  if (!rules) clearance.push({ code: 'NO_GRATUITY_POLICY', severity: 'WARNING', message: 'No gratuity policy applies on the last day, so no gratuity is calculated. Attach one to the pay group if gratuity is due.' });
  if (gratuity?.warning) clearance.push({ code: 'GRATUITY_THRESHOLD', severity: 'WARNING', message: gratuity.warning });

  return {
    earnings,
    deductions,
    total_earnings,
    total_deductions,
    net,
    recoverable: net < 0 ? -net : 0,
    payable: net > 0 ? net : 0,
    service: { years: service.years, months: service.months, days: service.days },
    gratuity,
    exit_reason: reason,
    clearance,
    can_pay: !clearance.some((c) => c.severity === 'BLOCKING'),
  };
}
