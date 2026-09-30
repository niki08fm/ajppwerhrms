const ORDER = { CARRY: 0, LOAN: 1, ADVANCE: 2 };

/**
 * Loan EMIs and advance instalments are capped (default 40% of gross minus
 * statutory). The excess carries into next month rather than zeroing take-home.
 */
export function applyRecoveryCap(items, cap) {
  const sorted = [...items].sort((a, b) => ORDER[a.type] - ORDER[b.type]);
  let remaining = Math.max(0, cap);
  const out = [];
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
