-- Salary components: a percentage can be of gross, CTC or basic, and can carry a
-- maximum (never a minimum). Whatever is left of gross is the Special Allowance.
ALTER TYPE "CalcType" ADD VALUE IF NOT EXISTS 'PCT_CTC' BEFORE 'PCT_BASIC';

ALTER TABLE "salary_component" ADD COLUMN "max_amount" BIGINT;

-- A maximum only makes sense on a percentage. Written against the existing enum
-- values, because a value added above cannot be used in the same transaction.
ALTER TABLE "salary_component" ADD CONSTRAINT "salary_component_max_amount_check"
  CHECK ("max_amount" IS NULL OR ("max_amount" > 0 AND "calc_type" NOT IN ('FIXED', 'BALANCE')));

-- PF has one limit, the wage ceiling; the largest contribution follows from it
-- (rate × ceiling). Drop the separate maximum from every stored rates version.
UPDATE "statutory_rates" SET "pf" = "pf" - 'max_contribution' WHERE "pf" ? 'max_contribution';
