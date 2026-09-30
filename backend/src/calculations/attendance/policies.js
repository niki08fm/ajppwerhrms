import { DEFAULT_ATTENDANCE_RULES } from '@ajpwer/shared';

/**
 * Which version of a policy kind applies on a date. Among the attached
 * policies of that kind covering the date, the one with the later valid_from wins.
 */
export function pickPolicy(policies, kind, date) {
  let best = null;
  for (const p of policies) {
    if (p.kind !== kind) continue;
    if (p.valid_from > date) continue;
    if (p.valid_to !== null && p.valid_to < date) continue;
    if (!best || p.valid_from > best.valid_from || (p.valid_from === best.valid_from && p.version > best.version)) best = p;
  }
  return best;
}

export function resolvePolicies(policies, date) {
  const used = {};
  const get = (kind) => {
    const p = pickPolicy(policies, kind, date);
    if (!p) return null;
    used[kind] = { id: p.id, version: p.version };
    return p.rules;
  };
  const attendance = get('ATTENDANCE');
  return {
    attendance: attendance ?? DEFAULT_ATTENDANCE_RULES,
    attendance_defaulted: !attendance,
    overtime: get('OVERTIME'),
    weekoff_pay: get('WEEKOFF_PAY'),
    holiday_pay: get('HOLIDAY_PAY'),
    holiday_work: get('HOLIDAY_WORK'),
    late_penalty: get('LATE_PENALTY'),
    used,
  };
}

/** Two attached policies of one kind with different keys overlapping in date — warn on attach. */
export function findOverlaps(policies) {
  const out = [];
  for (let i = 0; i < policies.length; i++) {
    for (let j = i + 1; j < policies.length; j++) {
      const a = policies[i];
      const b = policies[j];
      if (a.kind !== b.kind || a.policy_key === b.policy_key) continue;
      const from = a.valid_from > b.valid_from ? a.valid_from : b.valid_from;
      const aTo = a.valid_to ?? '9999-12-31';
      const bTo = b.valid_to ?? '9999-12-31';
      const to = aTo < bTo ? aTo : bTo;
      if (from <= to) out.push({ kind: a.kind, a: a.name, b: b.name, from, to: to === '9999-12-31' ? null : to });
    }
  }
  return out;
}
