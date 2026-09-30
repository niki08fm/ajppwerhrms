import { formatINR } from './money';
import type { CalcType } from './enums';

/** How a salary component's rule reads to a person: "40% of basic, up to ₹10,000". */
export function describeComponentRule(c: { calc_type: CalcType; calc_value: number; max_amount?: number | null }): string {
  const cap = c.max_amount ? `, up to ${formatINR(c.max_amount)}` : '';
  switch (c.calc_type) {
    case 'FIXED':
      return `Fixed ${formatINR(c.calc_value)}`;
    case 'BALANCE':
      return 'Whatever is left of gross';
    case 'PCT_GROSS':
      return `${c.calc_value}% of gross${cap}`;
    case 'PCT_CTC':
      return `${c.calc_value}% of CTC${cap}`;
    case 'PCT_BASIC':
      return `${c.calc_value}% of basic${cap}`;
  }
}
