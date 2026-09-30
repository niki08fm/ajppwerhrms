/**
 * Professional tax is a table lookup by the employee's PT state (never the
 * company's or the site's), with gender-scoped slabs where the statute has them
 * (Maharashtra) and a February amount where the state charges extra.
 */
export function computePt(input, slabs) {
  if (!input.pt_applicable) return { amount: 0, state: input.pt_state, basis: 'EXEMPT' };
  const stateSlabs = slabs.filter((s) => s.state === input.pt_state);
  if (stateSlabs.length === 0) return { amount: 0, state: input.pt_state, basis: 'NO_PT_STATE' };

  const gendered = stateSlabs.filter((s) => s.gender_scope === input.gender);
  const applicable = (gendered.length > 0 ? gendered : stateSlabs.filter((s) => s.gender_scope === 'ALL')).sort(
    (a, b) => (a.upto_amount ?? Number.MAX_SAFE_INTEGER) - (b.upto_amount ?? Number.MAX_SAFE_INTEGER),
  );
  // A state with only gender-specific slabs and a gender not listed (OTHER): use the male table as the default statute.
  const table = applicable.length > 0 ? applicable : stateSlabs.filter((s) => s.gender_scope === 'MALE');

  const slab = table.find((s) => s.upto_amount === null || input.gross <= s.upto_amount);
  if (!slab) return { amount: 0, state: input.pt_state, basis: 'NIL_SLAB' };
  const amount = input.month === 2 && slab.feb_amount !== null ? slab.feb_amount : slab.amount;
  return { amount, state: input.pt_state, basis: amount === 0 ? 'NIL_SLAB' : 'CHARGED' };
}
