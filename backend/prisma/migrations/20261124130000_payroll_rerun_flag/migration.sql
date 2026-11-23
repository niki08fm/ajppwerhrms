-- A generated month whose rules, rates or salaries changed must be regenerated before locking.
ALTER TABLE "payroll_period" ADD COLUMN "rerun_reason" TEXT, ADD COLUMN "rerun_flagged_at" TIMESTAMPTZ(6);
