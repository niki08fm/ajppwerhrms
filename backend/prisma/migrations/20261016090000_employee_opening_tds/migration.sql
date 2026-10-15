-- TDS deducted in a financial year before the person's payroll ran in AJPWER.
CREATE TABLE "employee_opening_tds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "fy_start" INTEGER NOT NULL,
    "tds_deducted" BIGINT NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_opening_tds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_opening_tds_amount_check" CHECK ("tds_deducted" >= 0)
);

CREATE UNIQUE INDEX "employee_opening_tds_employee_id_fy_start_key" ON "employee_opening_tds"("employee_id", "fy_start");

ALTER TABLE "employee_opening_tds" ADD CONSTRAINT "employee_opening_tds_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
