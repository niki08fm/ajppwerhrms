-- A held salary released into a later month is paid as its own payslip line. On its own:
-- a value added to an enum cannot be used in the same transaction.
ALTER TYPE "PayslipLineKind" ADD VALUE 'HELD';
