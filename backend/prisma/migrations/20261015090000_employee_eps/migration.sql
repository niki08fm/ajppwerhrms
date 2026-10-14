-- Keep existing pension allocation unless HR explicitly disables EPS.
ALTER TABLE "employee_statutory"
ADD COLUMN "eps_enabled" BOOLEAN NOT NULL DEFAULT true;
