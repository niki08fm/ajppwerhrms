-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('OFFER', 'ACCEPTED', 'ONBOARDING', 'ACTIVE', 'NOTICE', 'EXITED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "PolicyKind" AS ENUM ('ATTENDANCE', 'OVERTIME', 'WEEKOFF_PAY', 'HOLIDAY_PAY', 'HOLIDAY_WORK', 'LATE_PENALTY', 'LEAVE');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CalcType" AS ENUM ('PCT_GROSS', 'PCT_BASIC', 'FIXED', 'BALANCE');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "CalendarMethod" AS ENUM ('FIXED_26', 'FIXED_30', 'ACTUAL', 'WORKING');

-- CreateEnum
CREATE TYPE "SalaryMode" AS ENUM ('CTC', 'GROSS');

-- CreateEnum
CREATE TYPE "PtGenderScope" AS ENUM ('ALL', 'MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "PunchDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PunchMethod" AS ENUM ('FACE', 'MANUAL', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "DayStatus" AS ENUM ('NOT_JOINED', 'EXITED', 'HOLIDAY_WORKED', 'HOLIDAY', 'OFF_WORKED', 'WEEKLY_OFF', 'ON_LEAVE', 'ABSENT', 'MISSING_PUNCH', 'PRESENT', 'HALF_DAY', 'SHORT');

-- CreateEnum
CREATE TYPE "OverrideReason" AS ENUM ('FORGOT_TO_PUNCH', 'DEVICE_DOWN', 'NO_NETWORK', 'SITE_INSTRUCTION', 'LATE_APPROVED', 'DATA_ERROR', 'OTHER');

-- CreateEnum
CREATE TYPE "FaceExceptionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PeriodState" AS ENUM ('DRAFT', 'RUN', 'LOCKED', 'PAID');

-- CreateEnum
CREATE TYPE "PayslipLineKind" AS ENUM ('COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'ADHOC', 'DEDUCTION', 'REIMBURSEMENT', 'EMPLOYER');

-- CreateEnum
CREATE TYPE "AdhocKind" AS ENUM ('EARNING', 'REIMBURSEMENT', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "AdhocTarget" AS ENUM ('EMPLOYEE', 'PAY_GROUP', 'DEPARTMENT', 'ALL');

-- CreateEnum
CREATE TYPE "SettlementState" AS ENUM ('OPEN', 'INCLUDED', 'PAID');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "LetterKind" AS ENUM ('OFFER', 'JOINING', 'REVISION', 'RELIEVING', 'EXPERIENCE', 'SETTLEMENT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_view" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "list" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "saved_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "ip" TEXT,
    "success" BOOLEAN NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "file_key" TEXT,
    "created_by" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "address" TEXT,
    "pan" TEXT,
    "tan" TEXT,
    "pf_code" TEXT,
    "esi_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client" TEXT,
    "contract_value" BIGINT NOT NULL DEFAULT 0,
    "budget_labour" BIGINT NOT NULL DEFAULT 0,
    "material_cost" BIGINT NOT NULL DEFAULT 0,
    "other_cost" BIGINT NOT NULL DEFAULT 0,
    "started_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "radius_m" INTEGER NOT NULL,
    "project_id" UUID,
    "login" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_on" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL DEFAULT 'chart-1',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "start_min" INTEGER NOT NULL,
    "end_min" INTEGER NOT NULL,
    "break_min" INTEGER NOT NULL DEFAULT 0,
    "crosses_midnight" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_key" UUID NOT NULL,
    "kind" "PolicyKind" NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "rules" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structure" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "duplicated_from" UUID,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "salary_structure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_component" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "structure_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "calc_type" "CalcType" NOT NULL,
    "calc_value" DECIMAL(14,6) NOT NULL,
    "frequency" "Frequency" NOT NULL DEFAULT 'MONTHLY',
    "pay_month" INTEGER,
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "counts_as_wages" BOOLEAN NOT NULL DEFAULT false,
    "colour" TEXT NOT NULL DEFAULT 'chart-1',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "salary_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_group" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "calendar_method" "CalendarMethod" NOT NULL,
    "weekly_off" TEXT[],
    "shift_id" UUID NOT NULL,
    "structure_id" UUID NOT NULL,
    "pay_day" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pay_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_group_policy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pay_group_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pay_group_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statutory_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "valid_from" DATE NOT NULL,
    "pf" JSONB NOT NULL,
    "esi" JSONB NOT NULL,
    "gratuity" JSONB NOT NULL,
    "recovery_cap_pct" DECIMAL(9,6) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "statutory_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pt_slab" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state" TEXT NOT NULL,
    "gender_scope" "PtGenderScope" NOT NULL DEFAULT 'ALL',
    "upto_amount" BIGINT,
    "amount" BIGINT NOT NULL,
    "feb_amount" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pt_slab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_regime" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "std_deduction" BIGINT NOT NULL,
    "rebate_limit" BIGINT NOT NULL,
    "rebate_max" BIGINT,
    "marginal_relief" BOOLEAN NOT NULL,
    "allows_80c" BOOLEAN NOT NULL,
    "allows_hra" BOOLEAN NOT NULL,
    "cess_pct" DECIMAL(9,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tax_regime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_slab" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "regime_id" UUID NOT NULL,
    "upto_amount" BIGINT,
    "rate" DECIMAL(9,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tax_slab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dob" DATE,
    "gender" "Gender" NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "blood_group" TEXT,
    "department_id" UUID NOT NULL,
    "designation" TEXT NOT NULL,
    "pay_group_id" UUID NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'OFFER',
    "joined_on" DATE NOT NULL,
    "resigned_on" DATE,
    "last_day" DATE,
    "notice_days" INTEGER NOT NULL DEFAULT 30,
    "notice_served_days" INTEGER,
    "exit_reason" TEXT,
    "activated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_identity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "pan_enc" TEXT,
    "aadhaar_enc" TEXT,
    "aadhaar_masked" TEXT,
    "uan" TEXT,
    "esi_number" TEXT,
    "bank_account_enc" TEXT,
    "bank_last4" TEXT,
    "bank_ifsc" TEXT,
    "bank_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_statutory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "pf_enabled" BOOLEAN NOT NULL DEFAULT true,
    "pf_restrict_to_ceiling" BOOLEAN NOT NULL DEFAULT true,
    "vpf_pct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "esi_enabled" BOOLEAN NOT NULL DEFAULT true,
    "esi_locked_until" DATE,
    "pt_applicable" BOOLEAN NOT NULL DEFAULT true,
    "pt_exempt_reason" TEXT,
    "pt_state" TEXT NOT NULL,
    "tax_regime_code" TEXT NOT NULL DEFAULT 'NEW',
    "decl_80c" BIGINT NOT NULL DEFAULT 0,
    "decl_80d" BIGINT NOT NULL DEFAULT 0,
    "decl_rent_monthly" BIGINT NOT NULL DEFAULT 0,
    "decl_metro" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_statutory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salary" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "mode" "SalaryMode" NOT NULL,
    "amount" BIGINT NOT NULL,
    "monthly_gross" BIGINT NOT NULL,
    "structure_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_salary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_face" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "embedding" BYTEA NOT NULL,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model_version" TEXT NOT NULL,
    "consent_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employee_face_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "mode" "SalaryMode" NOT NULL,
    "amount" BIGINT NOT NULL,
    "monthly_gross" BIGINT NOT NULL,
    "structure_id" UUID NOT NULL,
    "issued_on" DATE NOT NULL,
    "join_by" DATE NOT NULL,
    "valid_till" DATE NOT NULL,
    "accepted_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "task_code" TEXT NOT NULL,
    "done_at" TIMESTAMPTZ(6),
    "done_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "onboarding_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "collected_on" DATE NOT NULL,
    "expires_on" DATE,
    "verified_at" TIMESTAMPTZ(6),
    "file_key" TEXT,
    "file_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "kind" "LetterKind" NOT NULL,
    "ref" TEXT NOT NULL,
    "issued_on" DATE,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "punch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "punched_at" TIMESTAMPTZ(6) NOT NULL,
    "work_date" DATE NOT NULL,
    "direction" "PunchDirection" NOT NULL,
    "site_id" UUID NOT NULL,
    "method" "PunchMethod" NOT NULL,
    "match_score" DECIMAL(9,6),
    "distance_m" INTEGER,
    "device_id" TEXT,
    "client_punched_at" TIMESTAMPTZ(6) NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flag_reason" TEXT,
    "source_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "punch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_override" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "status" "DayStatus" NOT NULL,
    "day_value" DECIMAL(4,2) NOT NULL,
    "worked_min" INTEGER NOT NULL,
    "ot_min" INTEGER NOT NULL,
    "late_min" INTEGER NOT NULL,
    "reason_code" "OverrideReason" NOT NULL,
    "reason_text" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "computed_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "attendance_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_exception" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "claimed_employee_id" UUID,
    "best_match_id" UUID,
    "score" DECIMAL(9,6),
    "reason" TEXT NOT NULL,
    "direction" "PunchDirection",
    "distance_m" INTEGER,
    "snapshot_key" TEXT,
    "status" "FaceExceptionStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason" TEXT,
    "decided_employee_id" UUID,
    "punch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "face_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "leave_type" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "days" DECIMAL(5,2) NOT NULL,
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "leave_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "leave_type" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "accrued" DECIMAL(6,2) NOT NULL,
    "used" DECIMAL(6,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "leave_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_aggregate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "date" DATE NOT NULL,
    "site_id" UUID,
    "present" INTEGER NOT NULL DEFAULT 0,
    "worked_min" INTEGER NOT NULL DEFAULT 0,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "late" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "daily_aggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "period_ym" TEXT NOT NULL,
    "pay_group_id" UUID,
    "state" "PeriodState" NOT NULL DEFAULT 'DRAFT',
    "steps_submitted" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "step_log" JSONB NOT NULL DEFAULT '[]',
    "running_job_id" UUID,
    "run_at" TIMESTAMPTZ(6),
    "run_by" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "payment_ref" TEXT,
    "statutory_rates_id" UUID,
    "settlement_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totals" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payroll_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_exclusion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "period_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payroll_exclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "period_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "gross" BIGINT NOT NULL,
    "salary_gross" BIGINT NOT NULL,
    "adhoc_earnings" BIGINT NOT NULL DEFAULT 0,
    "total_deductions" BIGINT NOT NULL,
    "reimbursements" BIGINT NOT NULL,
    "net" BIGINT NOT NULL,
    "employer_total" BIGINT NOT NULL,
    "ctc_month" BIGINT NOT NULL,
    "pf_wage" BIGINT NOT NULL,
    "esi_applicable" BOOLEAN NOT NULL,
    "paid_days" DECIMAL(5,2) NOT NULL,
    "lop_days" DECIMAL(5,2) NOT NULL,
    "divisor" INTEGER NOT NULL,
    "meta" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "engine_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslip_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payslip_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "PayslipLineKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_amount" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "is_taxable" BOOLEAN NOT NULL,
    "counts_as_wages" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "payslip_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adhoc_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "period_ym" TEXT NOT NULL,
    "kind" "AdhocKind" NOT NULL,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "is_taxable" BOOLEAN NOT NULL,
    "target_type" "AdhocTarget" NOT NULL,
    "target_ids" TEXT[],
    "note" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "adhoc_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "last_day" DATE NOT NULL,
    "period_id" UUID,
    "earnings" JSONB NOT NULL,
    "deductions" JSONB NOT NULL,
    "total_earnings" BIGINT NOT NULL,
    "total_deductions" BIGINT NOT NULL,
    "net" BIGINT NOT NULL,
    "clearance" JSONB NOT NULL DEFAULT '[]',
    "state" "SettlementState" NOT NULL DEFAULT 'OPEN',
    "recoverable_decision" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_on" DATE NOT NULL,
    "instalment" BIGINT NOT NULL,
    "recovered" BIGINT NOT NULL DEFAULT 0,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "advance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "loan_type" TEXT NOT NULL,
    "principal" BIGINT NOT NULL,
    "months" INTEGER NOT NULL,
    "emi" BIGINT NOT NULL,
    "instalments_paid" INTEGER NOT NULL DEFAULT 0,
    "recovered" BIGINT NOT NULL DEFAULT 0,
    "started_on" DATE NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_carry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "period_ym" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_carry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "role_name_key" ON "role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "saved_view_user_id_list_name_key" ON "saved_view"("user_id", "list", "name");

-- CreateIndex
CREATE INDEX "login_attempt_key_at_idx" ON "login_attempt"("key", "at" DESC);

-- CreateIndex
CREATE INDEX "login_attempt_ip_at_idx" ON "login_attempt"("ip", "at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_scope_key_key" ON "idempotency_key"("scope", "key");

-- CreateIndex
CREATE INDEX "job_kind_created_at_idx" ON "job"("kind", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "project_code_key" ON "project"("code");

-- CreateIndex
CREATE UNIQUE INDEX "site_code_key" ON "site"("code");

-- CreateIndex
CREATE UNIQUE INDEX "site_login_key" ON "site"("login");

-- CreateIndex
CREATE UNIQUE INDEX "department_name_key" ON "department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_date_key" ON "holiday"("date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_name_key" ON "shift"("name");

-- CreateIndex
CREATE INDEX "policy_policy_key_valid_from_idx" ON "policy"("policy_key", "valid_from");

-- CreateIndex
CREATE INDEX "policy_kind_idx" ON "policy"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "policy_policy_key_version_key" ON "policy"("policy_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "salary_component_structure_id_seq_key" ON "salary_component"("structure_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "pay_group_name_key" ON "pay_group"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pay_group_policy_pay_group_id_policy_id_key" ON "pay_group_policy"("pay_group_id", "policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "statutory_rates_valid_from_key" ON "statutory_rates"("valid_from");

-- CreateIndex
CREATE INDEX "pt_slab_state_idx" ON "pt_slab"("state");

-- CreateIndex
CREATE UNIQUE INDEX "tax_regime_code_valid_from_key" ON "tax_regime"("code", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "employee_code_key" ON "employee"("code");

-- CreateIndex
CREATE INDEX "employee_pay_group_id_idx" ON "employee"("pay_group_id");

-- CreateIndex
CREATE INDEX "employee_department_id_idx" ON "employee"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_identity_employee_id_key" ON "employee_identity"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_statutory_employee_id_key" ON "employee_statutory"("employee_id");

-- CreateIndex
CREATE INDEX "employee_salary_employee_id_valid_from_idx" ON "employee_salary"("employee_id", "valid_from" DESC);

-- CreateIndex
CREATE INDEX "employee_face_employee_id_idx" ON "employee_face"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "offer_ref_key" ON "offer"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_task_employee_id_task_code_key" ON "onboarding_task"("employee_id", "task_code");

-- CreateIndex
CREATE INDEX "document_employee_id_idx" ON "document"("employee_id");

-- CreateIndex
CREATE INDEX "document_expires_on_idx" ON "document"("expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "letter_ref_key" ON "letter"("ref");

-- CreateIndex
CREATE INDEX "letter_employee_id_idx" ON "letter"("employee_id");

-- CreateIndex
CREATE INDEX "punch_employee_id_work_date_idx" ON "punch"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "punch_site_id_work_date_idx" ON "punch"("site_id", "work_date");

-- CreateIndex
CREATE INDEX "punch_work_date_idx" ON "punch"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "punch_employee_id_site_id_client_punched_at_key" ON "punch"("employee_id", "site_id", "client_punched_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_override_employee_id_work_date_key" ON "attendance_override"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "face_exception_status_occurred_at_idx" ON "face_exception"("status", "occurred_at");

-- CreateIndex
CREATE INDEX "leave_request_employee_id_from_date_idx" ON "leave_request"("employee_id", "from_date");

-- CreateIndex
CREATE INDEX "leave_request_status_idx" ON "leave_request"("status");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balance_employee_id_leave_type_year_key" ON "leave_balance"("employee_id", "leave_type", "year");

-- CreateIndex
CREATE UNIQUE INDEX "daily_aggregate_date_site_id_key" ON "daily_aggregate"("date", "site_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_period_period_ym_key" ON "payroll_period"("period_ym");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_period_payment_ref_key" ON "payroll_period"("payment_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_exclusion_period_id_employee_id_key" ON "payroll_exclusion"("period_id", "employee_id");

-- CreateIndex
CREATE INDEX "payslip_period_id_idx" ON "payslip"("period_id");

-- CreateIndex
CREATE INDEX "payslip_employee_id_period_id_idx" ON "payslip"("employee_id", "period_id");

-- CreateIndex
CREATE INDEX "payslip_period_id_net_idx" ON "payslip"("period_id", "net" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payslip_period_id_employee_id_key" ON "payslip"("period_id", "employee_id");

-- CreateIndex
CREATE INDEX "payslip_line_payslip_id_idx" ON "payslip_line"("payslip_id");

-- CreateIndex
CREATE INDEX "adhoc_item_period_ym_idx" ON "adhoc_item"("period_ym");

-- CreateIndex
CREATE INDEX "settlement_employee_id_idx" ON "settlement"("employee_id");

-- CreateIndex
CREATE INDEX "advance_employee_id_idx" ON "advance"("employee_id");

-- CreateIndex
CREATE INDEX "loan_employee_id_idx" ON "loan"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_carry_employee_id_period_ym_key" ON "recovery_carry"("employee_id", "period_ym");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_at_idx" ON "audit_log"("entity_type", "entity_id", "at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_at_idx" ON "audit_log"("actor", "at" DESC);

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site" ADD CONSTRAINT "site_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_component" ADD CONSTRAINT "salary_component_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "salary_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_group" ADD CONSTRAINT "pay_group_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_group" ADD CONSTRAINT "pay_group_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "salary_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_group_policy" ADD CONSTRAINT "pay_group_policy_pay_group_id_fkey" FOREIGN KEY ("pay_group_id") REFERENCES "pay_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_group_policy" ADD CONSTRAINT "pay_group_policy_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_slab" ADD CONSTRAINT "tax_slab_regime_id_fkey" FOREIGN KEY ("regime_id") REFERENCES "tax_regime"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_pay_group_id_fkey" FOREIGN KEY ("pay_group_id") REFERENCES "pay_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_identity" ADD CONSTRAINT "employee_identity_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_statutory" ADD CONSTRAINT "employee_statutory_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salary" ADD CONSTRAINT "employee_salary_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "salary_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_face" ADD CONSTRAINT "employee_face_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "salary_structure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_task" ADD CONSTRAINT "onboarding_task_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "letter" ADD CONSTRAINT "letter_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch" ADD CONSTRAINT "punch_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch" ADD CONSTRAINT "punch_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_override" ADD CONSTRAINT "attendance_override_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_exception" ADD CONSTRAINT "face_exception_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balance" ADD CONSTRAINT "leave_balance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_period" ADD CONSTRAINT "payroll_period_pay_group_id_fkey" FOREIGN KEY ("pay_group_id") REFERENCES "pay_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_period" ADD CONSTRAINT "payroll_period_statutory_rates_id_fkey" FOREIGN KEY ("statutory_rates_id") REFERENCES "statutory_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_exclusion" ADD CONSTRAINT "payroll_exclusion_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "payroll_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_exclusion" ADD CONSTRAINT "payroll_exclusion_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "payroll_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip" ADD CONSTRAINT "payslip_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslip_line" ADD CONSTRAINT "payslip_line_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "payroll_period"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance" ADD CONSTRAINT "advance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan" ADD CONSTRAINT "loan_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_carry" ADD CONSTRAINT "recovery_carry_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
