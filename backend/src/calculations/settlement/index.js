import { clampMin0, daysToHundredths, mulDiv, serviceLength } from '@ajpwer/shared';

/**
 * Gratuity after min_years of continuous service:
 *   last basic × 15 × completed years ÷ 26
 * Completed years round to the nearest whole year; a part-year over six months counts as a full year.
 */
export function computeGratuity(joinedOn, lastDay, lastBasic, rates) {
  const service = serviceLength(joinedOn, lastDay);
  const decimal = Math.round(service.decimalYears * 100) / 100;
  const overSix = service.months > 6 || (service.months === 6 && service.days > 0);
  const completed_years = service.years + (overSix ? 1 : 0);
  const eligible = service.years >= rates.min_years;
  let warning = null;
  if (!eligible && decimal >= rates.flag_from_years) {
    warning = `Service is ${service.years} years ${service.months} months — within six months of the ${rates.min_years}-year gratuity threshold. No gratuity is payable on these dates; confirm with HR before settling.`;
  }
  const amount = eligible ? mulDiv(lastBasic, daysToHundredths(rates.days_per_year) * completed_years, rates.divisor * 100) : 0;
  return {
    eligible,
    amount,
    service_years_decimal: decimal,
    service: { years: service.years, months: service.months, days: service.days },
    completed_years: eligible ? completed_years : service.years,
    warning,
  };
}

/** Full and final settlement. Pure. No asset recovery: AJPWER does not issue assets. */
export function computeSettlement(input) {
  const e = input.employee;
  const earnings = [];
  const deductions = [];

  if (input.final_month) {
    earnings.push({ code: 'FINAL_SALARY', name: 'Salary for the final month', amount: input.final_month.gross, detail: 'Prorated by the part-month rule' });
    if (input.final_month.reimbursements > 0) {
      earnings.push({ code: 'FINAL_REIMB', name: 'Reimbursements in the final month', amount: input.final_month.reimbursements });
    }
  }

  const leaveAmt = mulDiv(input.monthly_gross, daysToHundredths(input.encashable_leave_days), 26 * 100);
  if (leaveAmt > 0) {
    earnings.push({ code: 'LEAVE_ENCASH', name: 'Leave encashment', amount: leaveAmt, detail: `${input.encashable_leave_days} days × monthly gross ÷ 26` });
  }

  const gratuity = computeGratuity(e.joined_on, e.last_day, input.last_basic, input.gratuity_rates);
  if (gratuity.amount > 0) {
    earnings.push({
      code: 'GRATUITY',
      name: 'Gratuity',
      amount: gratuity.amount,
      detail: `Last basic × ${input.gratuity_rates.days_per_year} × ${gratuity.completed_years} ÷ ${input.gratuity_rates.divisor}`,
    });
  }

  if (input.pending_reimbursements > 0) {
    earnings.push({ code: 'PENDING_REIMB', name: 'Pending reimbursements', amount: input.pending_reimbursements });
  }

  if (input.final_month) {
    for (const s of input.final_month.statutory_lines) {
      if (s.amount > 0) deductions.push({ code: s.code, name: `${s.name} on the final month`, amount: s.amount });
    }
  }

  const shortfallDays = clampMin0(e.notice_days - e.notice_served_days);
  if (shortfallDays > 0) {
    deductions.push({
      code: 'NOTICE_SHORTFALL',
      name: 'Notice shortfall',
      amount: mulDiv(input.monthly_gross, shortfallDays, 30),
      detail: `${shortfallDays} days × monthly gross ÷ 30`,
    });
  }

  // At settlement the recovery cap does not apply: the full balance is due.
  for (const l of input.loans_outstanding) if (l.amount > 0) deductions.push({ code: `LOAN:${l.id}`, name: `Loan outstanding — ${l.label}`, amount: l.amount });
  for (const a of input.advances_outstanding) if (a.amount > 0) deductions.push({ code: `ADVANCE:${a.id}`, name: `Advance outstanding — ${a.label}`, amount: a.amount });

  const total_earnings = earnings.reduce((s, l) => s + l.amount, 0);
  const total_deductions = deductions.reduce((s, l) => s + l.amount, 0);
  const net = total_earnings - total_deductions;

  const clearance = [];
  if (!e.has_bank_account) clearance.push({ code: 'NO_BANK', severity: 'BLOCKING', message: 'No bank account on file' });
  if (!input.final_month_attendance_submitted) {
    clearance.push({ code: 'ATTENDANCE_NOT_SUBMITTED', severity: 'BLOCKING', message: "The final month's attendance is not submitted" });
  }
  if (net < 0) {
    clearance.push({ code: 'NEGATIVE_NET', severity: 'WARNING', message: 'Net is negative — decide whether to write it off or pursue it' });
  }
  if (gratuity.warning) clearance.push({ code: 'GRATUITY_THRESHOLD', severity: 'WARNING', message: gratuity.warning });

  return {
    earnings,
    deductions,
    total_earnings,
    total_deductions,
    net,
    recoverable: net < 0 ? -net : 0,
    payable: net > 0 ? net : 0,
    gratuity,
    clearance,
    can_pay: !clearance.some((c) => c.severity === 'BLOCKING'),
  };
}
