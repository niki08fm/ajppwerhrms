import { INDIAN_STATES, istDate, savedViewSchema } from '@ajpwer/shared';
import { z } from 'zod';
import { audit, who } from '../utils/audit.js';
import { notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { fromDbDate } from '../utils/dbDates.js';

/** Global search (/ or Cmd-K): people by name and code, straight to a profile. */
export const search = asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 1) return res.json({ data: [] });
  const rows = await prisma.employee.findMany({
    where: { deleted_at: null, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] },
    select: { id: true, code: true, name: true, designation: true, status: true, department: { select: { name: true } } },
    orderBy: { name: 'asc' },
    take: 8,
  });
  res.json({ data: rows });
});

/** Everything a form needs for its dropdowns, in one call. */
export const getLookups = asyncHandler(async (_req, res) => {
  const [departments, payGroups, sites, shifts, structures, projects, ptStates] = await Promise.all([
    prisma.department.findMany({ where: { deleted_at: null }, select: { id: true, name: true, colour: true }, orderBy: { name: 'asc' } }),
    prisma.payGroup.findMany({ where: { deleted_at: null }, select: { id: true, name: true, calendar_method: true, weekly_off: true, structure_id: true }, orderBy: { name: 'asc' } }),
    prisma.site.findMany({ where: { deleted_at: null }, select: { id: true, code: true, name: true, state: true, is_active: true }, orderBy: { name: 'asc' } }),
    prisma.shift.findMany({ where: { deleted_at: null }, select: { id: true, name: true, start_min: true, end_min: true }, orderBy: { start_min: 'asc' } }),
    prisma.salaryStructure.findMany({ where: { deleted_at: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.project.findMany({ where: { deleted_at: null }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
    prisma.ptSlab.findMany({ where: { deleted_at: null }, distinct: ['state'], select: { state: true } }),
  ]);
  res.json({
    data: {
      departments,
      pay_groups: payGroups,
      sites,
      shifts,
      structures,
      projects,
      pt_states: [...new Set([...ptStates.map((p) => p.state), 'Delhi'])].sort(),
      states: INDIAN_STATES,
      today: istDate(new Date()),
    },
  });
});

// ─── Saved views (per user) ─────────────────────────────────────────────────
export const listSavedViews = asyncHandler(async (req, res) => {
  const list = String(req.query.list ?? '');
  const rows = await prisma.savedView.findMany({ where: { user_id: req.admin.id, deleted_at: null, ...(list ? { list } : {}) }, orderBy: { name: 'asc' } });
  res.json({ data: rows });
});

export const saveView = asyncHandler(async (req, res) => {
  const b = savedViewSchema.parse(req.body);
  const v = await prisma.savedView.upsert({
    where: { user_id_list_name: { user_id: req.admin.id, list: b.list, name: b.name } },
    update: { query: b.query, deleted_at: null },
    create: { user_id: req.admin.id, ...b },
  });
  res.status(201).json({ data: v });
});

export const deleteSavedView = asyncHandler(async (req, res) => {
  const v = await prisma.savedView.findFirst({ where: { id: req.params.id, user_id: req.admin.id } });
  if (!v) throw notFound('That saved view');
  await prisma.savedView.update({ where: { id: v.id }, data: { deleted_at: new Date() } });
  res.json({ data: { ok: true } });
});

/** Documents: what is missing or expiring, across everyone. */
export const getDocumentStatus = asyncHandler(async (req, res) => {
  const date = istDate(new Date());
  const soon = new Date(`${date}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 30);
  const people = await prisma.employee.findMany({
    where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'ONBOARDING'] }, ...(req.query.dept ? { department_id: String(req.query.dept) } : {}) },
    select: {
      id: true,
      code: true,
      name: true,
      department: { select: { name: true } },
      identity: { select: { pan_enc: true, aadhaar_enc: true, bank_account_enc: true, uan: true } },
      documents: { where: { deleted_at: null } },
    },
    orderBy: { name: 'asc' },
  });
  const required = ['PAN', 'AADHAAR', 'BANK_PROOF', 'PHOTO'];
  const issues = [];
  const coverage = required.map((t) => ({ doc_type: t, have: 0, total: people.length }));
  for (const p of people) {
    const emp = { id: p.id, code: p.code, name: p.name, department: p.department.name };
    for (const c of coverage) {
      if (p.documents.some((d) => d.doc_type === c.doc_type)) c.have++;
      else issues.push({ employee: emp, kind: 'MISSING', doc_type: c.doc_type, detail: 'Not collected' });
    }
    for (const d of p.documents) {
      if (d.expires_on && d.expires_on < new Date(`${date}T00:00:00Z`)) issues.push({ employee: emp, kind: 'EXPIRED', doc_type: d.doc_type, detail: `Expired ${fromDbDate(d.expires_on)}` });
      else if (d.expires_on && d.expires_on <= soon) issues.push({ employee: emp, kind: 'EXPIRING', doc_type: d.doc_type, detail: `Expires ${fromDbDate(d.expires_on)}` });
      if (!d.verified_at) issues.push({ employee: emp, kind: 'UNVERIFIED', doc_type: d.doc_type, detail: 'Collected, not verified' });
    }
  }
  const type = req.query.type ? String(req.query.type) : null;
  const kind = req.query.kind ? String(req.query.kind) : null;
  const filtered = issues.filter((i) => (!type || i.doc_type === type) && (!kind || i.kind === kind));
  const byKind = ['MISSING', 'EXPIRED', 'EXPIRING', 'UNVERIFIED'].map((k) => ({ kind: k, count: issues.filter((i) => i.kind === k).length }));
  res.json({ data: { coverage, by_kind: byKind, issues: filtered.slice(0, 1000) }, meta: { total: filtered.length, nextCursor: null } });
});

export const verifyDocuments = asyncHandler(async (req, res) => {
  const { ids } = z
    .object({ ids: z.array(z.string().uuid()).min(1).max(1000) })
    .strict()
    .parse(req.body);
  const docs = await prisma.document.findMany({ where: { id: { in: ids }, verified_at: null }, select: { id: true, employee_id: true, doc_type: true } });
  await prisma.$transaction(async (tx) => {
    await tx.document.updateMany({ where: { id: { in: docs.map((d) => d.id) } }, data: { verified_at: new Date() } });
    for (const d of docs) await audit(tx, { ...who(req), action: 'document.verify', entity_type: 'employee', entity_id: d.employee_id, detail: { document_id: d.id, doc_type: d.doc_type } });
  });
  res.json({ data: { verified: docs.length } });
});
