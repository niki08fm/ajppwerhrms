-- Form 12B: salary and TDS from earlier employers in the same tax year.
ALTER TABLE "employee_statutory"
ADD COLUMN "prev_employer_fy" INTEGER,
ADD COLUMN "prev_employer_income" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "prev_employer_tds" BIGINT NOT NULL DEFAULT 0;
