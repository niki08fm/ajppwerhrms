-- Salary structures are selected on employee salary revisions and offers.
-- Preserve those references and the structures themselves; only remove the
-- pay group's former default so group changes cannot propagate salary changes.
ALTER TABLE "pay_group" DROP CONSTRAINT "pay_group_structure_id_fkey";
ALTER TABLE "pay_group" DROP COLUMN "structure_id";
