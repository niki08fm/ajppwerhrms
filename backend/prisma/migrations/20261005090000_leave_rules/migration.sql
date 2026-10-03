-- Leave paid out at the end of the leave year is its own payslip line.
ALTER TYPE "PayslipLineKind" ADD VALUE 'LEAVE' AFTER 'OFFDAY';

-- Days HR adds to or takes from a leave balance: opening balances and corrections.
CREATE TABLE "leave_adjustment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "leave_type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "leave_adjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leave_adjustment_employee_id_date_idx" ON "leave_adjustment"("employee_id", "date");

ALTER TABLE "leave_adjustment" ADD CONSTRAINT "leave_adjustment_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leave_adjustment" ADD CONSTRAINT "leave_adjustment_days_not_zero" CHECK ("days" <> 0);
