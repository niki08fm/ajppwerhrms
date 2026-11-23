-- Pay groups use a policy for a window of dates; existing links stay unbounded.
ALTER TABLE "pay_group_policy"
ADD COLUMN "effective_from" DATE,
ADD COLUMN "effective_to" DATE;

-- Which pay group a person was in, by month. No rows: employee.pay_group_id applies.
CREATE TABLE "employee_pay_group" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "pay_group_id" UUID NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_pay_group_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_pay_group_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "employee_pay_group_pay_group_id_fkey" FOREIGN KEY ("pay_group_id") REFERENCES "pay_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "employee_pay_group_dates" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);
CREATE INDEX "employee_pay_group_employee_id_valid_from_idx" ON "employee_pay_group"("employee_id", "valid_from");
