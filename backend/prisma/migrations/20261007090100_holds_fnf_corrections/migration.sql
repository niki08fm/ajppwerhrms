-- Salary holds. A held month is calculated as usual (payslip, PF, ESI, TDS) and kept out of
-- the bank file; each held month's net is a held_pay row until it is paid, once.
CREATE TYPE "HeldPayState" AS ENUM ('HELD', 'QUEUED', 'PAID', 'PAID_SEPARATELY');

CREATE TABLE "salary_hold" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "from_ym" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by" TEXT,
    "release_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "salary_hold_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "held_pay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hold_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_ym" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "state" "HeldPayState" NOT NULL DEFAULT 'HELD',
    "pay_ym" TEXT,
    "settlement_id" UUID,
    "paid_on" DATE,
    "payment_ref" TEXT,
    "released_by" TEXT,
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    CONSTRAINT "held_pay_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "salary_hold_employee_id_idx" ON "salary_hold"("employee_id");
CREATE INDEX "held_pay_state_idx" ON "held_pay"("state");
CREATE UNIQUE INDEX "held_pay_employee_id_period_ym_key" ON "held_pay"("employee_id", "period_ym");

ALTER TABLE "salary_hold" ADD CONSTRAINT "salary_hold_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "held_pay" ADD CONSTRAINT "held_pay_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "salary_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "held_pay" ADD CONSTRAINT "held_pay_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "held_pay" ADD CONSTRAINT "held_pay_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An F&F can be paid outside payroll: recorded in its month's payroll, never in a bank file.
ALTER TABLE "settlement" ADD COLUMN "paid_separately" JSONB;

-- HR corrects a day by its times; late minutes, half or full day and overtime follow from them.
ALTER TABLE "attendance_override" ADD COLUMN "in_min" INTEGER,
ADD COLUMN "out_min" INTEGER;

-- No notice period: an exit is recorded with its kind and last working day.
ALTER TABLE "employee" DROP COLUMN "notice_days",
DROP COLUMN "notice_served_days";

-- No exit policy. Any that exist are retired and taken off their pay groups; the enum value
-- stays so the old rows still read.
UPDATE "pay_group_policy" SET "deleted_at" = CURRENT_TIMESTAMP
WHERE "deleted_at" IS NULL AND "policy_id" IN (SELECT "id" FROM "policy" WHERE "kind" = 'EXIT');
UPDATE "policy" SET "deleted_at" = CURRENT_TIMESTAMP WHERE "deleted_at" IS NULL AND "kind" = 'EXIT';
