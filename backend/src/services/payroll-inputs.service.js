import { salaryRecord, toComponentDefs } from './rules.service.js';
import { versionOn, withWindows } from './structure-versions.service.js';

/** Two reads for the whole roster instead of salary/component queries for every payslip. */
export async function payrollSalaryInputs(db, employeeIds) {
  const salaries = employeeIds.length ? await db.employeeSalary.findMany({
    where: {
      employee_id: {
        in: employeeIds
      },
      deleted_at: null
    },
    select: {
      id: true,
      employee_id: true,
      mode: true,
      amount: true,
      monthly_gross: true,
      structure_id: true,
      valid_from: true,
      valid_to: true
    },
    orderBy: {
      valid_from: 'desc'
    }
  }) : [];
  const structureIds = [...new Set(salaries.map(s => s.structure_id))];
  // Each structure's versions: a salary uses the version in force on the date it is read for.
  const pointed = structureIds.length ? await db.salaryStructure.findMany({ where: { id: { in: structureIds } }, select: { id: true, lineage_id: true } }) : [];
  const lineageOf = new Map(pointed.map(r => [r.id, r.lineage_id]));
  const lineages = [...new Set(pointed.map(r => r.lineage_id))];
  const versionRows = lineages.length ? await db.salaryStructure.findMany({ where: { lineage_id: { in: lineages }, deleted_at: null } }) : [];
  const versionsByLineage = new Map(lineages.map(id => [id, withWindows(versionRows.filter(r => r.lineage_id === id))]));
  const versionIds = versionRows.map(r => r.id);
  const components = versionIds.length ? await db.salaryComponent.findMany({
    where: {
      structure_id: {
        in: versionIds
      },
      deleted_at: null
    },
    orderBy: {
      seq: 'asc'
    }
  }) : [];
  const byEmployee = new Map(employeeIds.map(id => [id, []]));
  for (const row of salaries) byEmployee.get(row.employee_id).push(salaryRecord(row));
  const byVersion = new Map(versionIds.map(id => [id, []]));
  for (const row of components) byVersion.get(row.structure_id).push(row);
  const definitions = new Map([...byVersion].map(([id, rows]) => [id, toComponentDefs(rows)]));
  return {
    salaryOn: (id, date) => byEmployee.get(id)?.find(s => s.valid_from <= date && (!s.valid_to || s.valid_to >= date)) ?? null,
    components: (id, date) => {
      const version = versionOn(versionsByLineage.get(lineageOf.get(id)) ?? [], date);
      return definitions.get(version?.id ?? id) ?? [];
    }
  };
}
