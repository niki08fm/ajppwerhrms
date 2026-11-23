-- Loan and advance types with their limits; loans and advances may name their type.
CREATE TYPE "LoanTypeKind" AS ENUM ('LOAN', 'ADVANCE');
CREATE TYPE "RecoveryMethod" AS ENUM ('EQUAL_INSTALMENTS', 'FIXED_AMOUNT', 'PCT_OF_GROSS');

CREATE TABLE "loan_advance_type" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "kind" "LoanTypeKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "max_gross_multiple" DECIMAL(6,2),
    "max_amount" BIGINT,
    "max_instalments" INTEGER NOT NULL,
    "recovery_method" "RecoveryMethod" NOT NULL DEFAULT 'EQUAL_INSTALMENTS',
    "recovery_pct" DECIMAL(6,2),
    "max_instalment_pct" DECIMAL(6,2),
    "min_service_months" INTEGER NOT NULL DEFAULT 0,
    "one_at_a_time" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "loan_advance_type_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loan_advance_type_instalments" CHECK ("max_instalments" BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "loan_advance_type_live_name" ON "loan_advance_type"(lower("name")) WHERE "deleted_at" IS NULL;

ALTER TABLE "loan" ADD COLUMN "type_id" UUID REFERENCES "loan_advance_type"("id");
ALTER TABLE "advance" ADD COLUMN "type_id" UUID REFERENCES "loan_advance_type"("id");
