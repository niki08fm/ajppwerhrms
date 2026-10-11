import { addDays, firstOfMonth, formatYearMonth, lastOfMonth, parsePolicyRules } from '@ajpwer/shared';
import { Prisma } from '@prisma/client';
import { audit } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';

const start = (row) => fromDbDate(row.valid_from);
const end = (row) => fromDbDate(row.valid_to);
const overlaps = (a, b) => (!a.to || a.to >= b.from) && (!b.to || b.to >= a.from);
const signature = (row) => row ? JSON.stringify([row.id, row.name, row.rules]) : null;
const at = (rows, date) => rows.filter((row) => start(row) <= date && (!end(row) || end(row) >= date)).sort((a, b) => start(b).localeCompare(start(a)) || b.version - a.version)[0];

/** A transaction keeps this lock until its rules-dependent writes commit. */
export async function lockPolicyRulesRead(db) {
  if (typeof db.$transaction !== 'function') await db.$executeRaw`SELECT pg_advisory_xact_lock_shared(20261011, 18)`;
}

/** Payroll first locks its period and then takes the shared rules lock. */
async function lockPolicyHistory(tx, key) {
  await tx.$queryRaw`SELECT id FROM payroll_period WHERE deleted_at IS NULL ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261011, 18)`;
  await tx.$queryRaw`SELECT id FROM policy WHERE policy_key = ${key}::uuid ORDER BY version FOR UPDATE`;
}

async function rowsFor(db, key) {
  return db.policy.findMany({ where: { policy_key: key, deleted_at: null }, orderBy: { version: 'asc' }, include: { pay_groups: { where: { deleted_at: null, pay_group: { deleted_at: null } }, include: { pay_group: { select: { id: true, name: true } } } } } });
}

/** Keep historical links: detaching a policy must not evade frozen payroll. */
async function protectionContext(db, keys) {
  const [links, slips, settlements] = await Promise.all([
    db.payGroupPolicy.findMany({ where: { policy: { policy_key: { in: keys } } }, select: { pay_group_id: true, deleted_at: true, pay_group: { select: { deleted_at: true } }, policy: { select: { policy_key: true, deleted_at: true } } } }),
    db.payslip.findMany({ where: { deleted_at: null, period: { deleted_at: null, state: { in: ['LOCKED', 'PAID'] } } }, select: { meta: true, employee: { select: { pay_group_id: true } }, period: { select: { period_ym: true, state: true } } } }),
    db.settlement.findMany({ where: { deleted_at: null, OR: [{ state: 'PAID' }, { state: 'INCLUDED' }, { paid_separately: { not: Prisma.DbNull } }] }, select: { state: true, last_day: true, paid_separately: true, employee: { select: { pay_group_id: true } }, period: { select: { state: true, period_ym: true, steps_submitted: true, deleted_at: true } } } }),
  ]);
  const groups = new Map(keys.map((key) => [key, new Set()]));
  const attached = new Set();
  for (const link of links) {
    groups.get(link.policy.policy_key)?.add(link.pay_group_id);
    if (!link.deleted_at && !link.policy.deleted_at && !link.pay_group.deleted_at) attached.add(link.policy.policy_key);
  }
  const ranges = slips.map((slip) => {
    const ym = slip.meta?.final_month_ym ?? slip.period.period_ym;
    return { group: slip.meta?.pay_group?.id ?? slip.employee.pay_group_id, from: firstOfMonth(ym), to: lastOfMonth(ym), reason: `This change could affect ${slip.period.state.toLowerCase()} payroll for ${formatYearMonth(slip.period.period_ym)}. Unlock that payroll before changing this policy history.` };
  });
  for (const settlement of settlements) {
    const period = settlement.period;
    const frozen = settlement.state === 'PAID' || !!settlement.paid_separately || (settlement.state === 'INCLUDED' && period && !period.deleted_at && (period.state !== 'DRAFT' || period.steps_submitted.includes(4)));
    if (!frozen) continue;
    const ym = fromDbDate(settlement.last_day).slice(0, 7);
    ranges.push({ group: settlement.employee.pay_group_id, from: firstOfMonth(ym), to: lastOfMonth(ym), reason: settlement.state === 'PAID' || settlement.paid_separately ? 'This change could affect a paid full and final settlement. Publish a later policy version instead.' : 'This change could affect a finalized full and final settlement. Reopen its payroll F&F step before changing this policy history.' });
  }
  return { groups, attached, ranges };
}

function familyRanges(context, key, kind) {
  const groups = context.groups.get(key);
  return context.ranges.filter((range) => groups?.has(range.group)).map((range) => ({
    ...range,
    // Leave can carry from earlier years. Sandwich attendance reads a week on
    // either side of the month, so its boundary rules also affect frozen pay.
    from: kind === 'LEAVE' ? '0001-01-01' : kind === 'GRATUITY' ? range.from : addDays(range.from, -7),
    to: kind === 'LEAVE' || kind === 'GRATUITY' ? range.to : addDays(range.to, 7),
  }));
}

function changedRanges(before, after) {
  const boundaries = [...new Set([...before, ...after].flatMap((row) => [start(row), ...(end(row) ? [addDays(end(row), 1)] : [])]))].sort();
  return boundaries.flatMap((from, index) => signature(at(before, from)) === signature(at(after, from)) ? [] : [{ from, to: boundaries[index + 1] ? addDays(boundaries[index + 1], -1) : null }]);
}

function assertAllowed(context, key, before, after) {
  const changed = changedRanges(before, after);
  const frozen = familyRanges(context, key, before[0]?.kind ?? after[0]?.kind).find((range) => changed.some((interval) => overlaps(interval, range)));
  if (frozen) throw new AppError('POLICY_PROTECTED', frozen.reason, 409);
}

function deletionResult(rows, id) {
  // Removing the first version intentionally leaves its earlier coverage empty.
  const index = rows.findIndex((row) => row.id === id);
  return rows.filter((row) => row.id !== id).map((row) => index > 0 && row.id === rows[index - 1].id ? { ...row, valid_to: rows[index].valid_to } : row);
}

function restoredLinks(before, after, id) {
  const index = before.findIndex((row) => row.id === id);
  if (index <= 0) return [];
  const prior = after.find((row) => row.id === before[index - 1].id);
  const attached = new Set(prior.pay_groups?.map((link) => link.pay_group_id));
  return (before[index].pay_groups ?? []).filter((link) => !attached.has(link.pay_group_id)).map((link) => ({ policy_id: prior.id, pay_group_id: link.pay_group_id, from: start(prior), to: end(prior) }));
}

function assertRestoredLinksAllowed(context, key, kind, links) {
  const frozen = familyRanges(context, key, kind).find((range) => links.some((link) => link.pay_group_id === range.group && overlaps(link, range)));
  if (frozen) throw new AppError('POLICY_PROTECTED', frozen.reason, 409);
}

export async function policyHistoryProtection(db, rows) {
  const keys = [...new Set(rows.map((row) => row.policy_key))];
  if (!keys.length) return new Map();
  const context = await protectionContext(db, keys);
  return new Map(rows.map((row) => {
    const family = rows.filter((item) => item.policy_key === row.policy_key).sort((a, b) => a.version - b.version);
    const protectedRange = familyRanges(context, row.policy_key, row.kind).find((range) => overlaps({ from: start(row), to: end(row) }, range));
    let deletionReason = protectedRange?.reason ?? null;
    if (!deletionReason && family.length === 1 && context.attached.has(row.policy_key)) deletionReason = 'Remove this policy from its pay groups before deleting its only version.';
    if (!deletionReason) {
      try {
        const after = deletionResult(family, row.id);
        assertAllowed(context, row.policy_key, family, after);
        assertRestoredLinksAllowed(context, row.policy_key, row.kind, restoredLinks(family, after, row.id));
      }
      catch (error) { deletionReason = error.message; }
    }
    return [row.id, { can_edit: !protectedRange, can_delete: !deletionReason, protection_reason: protectedRange?.reason ?? null, deletion_reason: deletionReason }];
  }));
}

function auditRow(row) {
  return { id: row.id, policy_key: row.policy_key, version: row.version, name: row.name, valid_from: start(row), valid_to: end(row), rules: row.rules };
}

async function saveChangedRows(tx, before, after) {
  const deleted = before.filter((row) => !after.some((next) => next.id === row.id));
  for (const row of deleted) {
    await tx.policy.update({ where: { id: row.id }, data: { deleted_at: new Date(), status: 'RETIRED' } });
    await tx.payGroupPolicy.updateMany({ where: { policy_id: row.id, deleted_at: null }, data: { deleted_at: new Date() } });
  }
  for (const row of after) {
    const old = before.find((item) => item.id === row.id);
    if (!old || JSON.stringify(auditRow(old)) === JSON.stringify(auditRow(row))) continue;
    await tx.policy.update({ where: { id: row.id }, data: { name: row.name, rules: row.rules, valid_from: row.valid_from, valid_to: row.valid_to } });
  }
}

export async function editPolicyVersion(tx, key, version, body, who) {
  await lockPolicyHistory(tx, key);
  const before = await rowsFor(tx, key);
  const index = before.findIndex((row) => row.version === version);
  if (index < 0) throw notFound('That policy version');
  const previous = before[index];
  const validFrom = body.valid_from ?? start(previous);
  if ((before[index - 1] && validFrom <= start(before[index - 1])) || (before[index + 1] && validFrom >= start(before[index + 1]))) {
    throw new AppError('VALIDATION', 'The effective date must stay after the previous version and before the following version.', 422, 'valid_from');
  }
  if (end(previous) && validFrom > end(previous)) throw new AppError('VALIDATION', 'The effective date cannot be after this version’s end date.', 422, 'valid_from');
  const rules = Object.hasOwn(body, 'rules') ? parsePolicyRules(previous.kind, body.rules) : previous.rules;
  const after = before.map((row) => row.id === previous.id ? { ...row, name: body.name ?? row.name, rules, valid_from: toDbDate(validFrom) }
    : validFrom !== start(previous) && row.id === before[index - 1]?.id ? { ...row, valid_to: toDbDate(addDays(validFrom, -1)) } : row);
  const context = await protectionContext(tx, [key]);
  assertAllowed(context, key, before, after);
  await saveChangedRows(tx, before, after);
  const updated = await tx.policy.findUniqueOrThrow({ where: { id: previous.id }, include: { pay_groups: { where: { deleted_at: null }, include: { pay_group: { select: { id: true, name: true } } } } } });
  await audit(tx, { ...who, action: 'policy.edit', entity_type: 'policy', entity_id: previous.id, detail: { before: auditRow(previous), after: auditRow(updated), neighbors: after.filter((row) => row.id !== previous.id && end(row) !== end(before.find((old) => old.id === row.id))).map(auditRow) } });
  return updated;
}

export async function removePolicyVersion(tx, key, version, who) {
  await lockPolicyHistory(tx, key);
  const before = await rowsFor(tx, key);
  const previous = before.find((row) => row.version === version);
  if (!previous) throw notFound('That policy version');
  const context = await protectionContext(tx, [key]);
  const after = deletionResult(before, previous.id);
  assertAllowed(context, key, before, after);
  if (before.length === 1 && context.attached.has(key)) throw new AppError('POLICY_ATTACHED', 'Remove this policy from its pay groups before deleting its only version.', 409);
  const restored = restoredLinks(before, after, previous.id);
  assertRestoredLinksAllowed(context, key, previous.kind, restored);
  await saveChangedRows(tx, before, after);
  for (const link of restored) await tx.payGroupPolicy.upsert({ where: { pay_group_id_policy_id: { pay_group_id: link.pay_group_id, policy_id: link.policy_id } }, update: { deleted_at: null }, create: { pay_group_id: link.pay_group_id, policy_id: link.policy_id } });
  await audit(tx, { ...who, action: 'policy.delete', entity_type: 'policy', entity_id: previous.id, detail: { before: auditRow(previous), neighbors: after.filter((row) => end(row) !== end(before.find((old) => old.id === row.id))).map(auditRow), restored_links: restored.map(({ policy_id, pay_group_id }) => ({ policy_id, pay_group_id })) } });
  return { id: previous.id, policy_key: key, version, deleted: true };
}

export async function publishPolicyVersion(tx, key, body, who) {
  await lockPolicyHistory(tx, key);
  const before = await rowsFor(tx, key);
  if (!before.length) throw notFound('That policy');
  const latest = before.at(-1);
  if (body.valid_from <= start(latest)) throw new AppError('VALIDATION', `The new version must start after the current one (${start(latest)}).`, 422, 'valid_from');
  const rules = parsePolicyRules(latest.kind, body.rules);
  const highest = await tx.policy.aggregate({ where: { policy_key: key }, _max: { version: true } });
  const next = { id: 'new', policy_key: key, kind: latest.kind, version: highest._max.version + 1, name: body.name ?? latest.name, valid_from: toDbDate(body.valid_from), valid_to: null, rules };
  const after = [...before.map((row) => row.id === latest.id ? { ...row, valid_to: toDbDate(addDays(body.valid_from, -1)) } : row), next];
  assertAllowed(await protectionContext(tx, [key]), key, before, after);
  await saveChangedRows(tx, before, after.filter((row) => row.id !== 'new'));
  const { id: _id, ...values } = next;
  const created = await tx.policy.create({ data: { ...values, created_by: who.actor } });
  for (const link of latest.pay_groups.filter((item) => item.pay_group)) await tx.payGroupPolicy.create({ data: { pay_group_id: link.pay_group_id, policy_id: created.id } });
  await audit(tx, { ...who, action: 'policy.version', entity_type: 'policy', entity_id: created.id, detail: { policy_key: key, from_version: latest.version, to_version: created.version, closed_on: addDays(body.valid_from, -1), valid_from: body.valid_from, old_rules: latest.rules, new_rules: rules, pay_groups: latest.pay_groups.map((link) => link.pay_group_id) } });
  return created;
}
