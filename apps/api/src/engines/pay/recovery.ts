import type { Paise } from '@ajpwer/shared';

export interface RecoveryItem {
  /** CARRY first, then LOAN, then ADVANCE */
  type: 'CARRY' | 'LOAN' | 'ADVANCE';
  ref_id: string | null;
  label: string;
  due: Paise;
}

export interface RecoveryResult {
  cap: Paise;
  total_due: Paise;
  total_recovered: Paise;
  /** Written to recovery_carry and taken next month */
  carry_forward: Paise;
  items: (RecoveryItem & { recovered: Paise })[];
}

const ORDER: Record<RecoveryItem['type'], number> = { CARRY: 0, LOAN: 1, ADVANCE: 2 };

/**
 * Loan EMIs and advance instalments are capped (default 40% of gross minus
 * statutory). The excess carries into next month rather than zeroing take-home.
 */
export function applyRecoveryCap(items: RecoveryItem[], cap: Paise): RecoveryResult {
  const sorted = [...items].sort((a, b) => ORDER[a.type] - ORDER[b.type]);
  let remaining = Math.max(0, cap);
  const out: RecoveryResult['items'] = [];
  let total_due = 0;
  for (const it of sorted) {
    total_due += it.due;
    const recovered = Math.min(it.due, remaining);
    remaining -= recovered;
    out.push({ ...it, recovered });
  }
  const total_recovered = out.reduce((s, i) => s + i.recovered, 0);
  return { cap, total_due, total_recovered, carry_forward: total_due - total_recovered, items: out };
}
