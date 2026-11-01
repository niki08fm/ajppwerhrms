import { salaryRecord, toComponentDefs } from './rules.service.js';

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
  const components = structureIds.length ? await db.salaryComponent.findMany({
    where: {
      structure_id: {
        in: structureIds
      },
      deleted_at: null
    },
    orderBy: {
      seq: 'asc'
    }
  }) : [];
  const byEmployee = new Map(employeeIds.map(id => [id, []]));
  for (const row of salaries) byEmployee.get(row.employee_id).push(salaryRecord(row));
  const byStructure = new Map(structureIds.map(id => [id, []]));
  for (const row of components) byStructure.get(row.structure_id).push(row);
  const definitions = new Map([...byStructure].map(([id, rows]) => [id, toComponentDefs(rows)]));
  return {
    salaryOn: (id, date) => byEmployee.get(id)?.find(s => s.valid_from <= date && (!s.valid_to || s.valid_to >= date)) ?? null,
    components: id => definitions.get(id) ?? []
  };
}
