-- Face v2: server-side YuNet + SFace + MiniFASNet (face/INTEGRATION.md §2).

CREATE TYPE "FaceTemplateKind" AS ENUM ('REGISTERED', 'ROLLING');
CREATE TYPE "PunchSessionPurpose" AS ENUM ('PUNCH', 'REGISTER');
CREATE TYPE "PunchSessionStatus" AS ENUM ('ACTIVE', 'IDENTIFIED', 'BLOCKED', 'DONE');
CREATE TYPE "SiteChangeStatus" AS ENUM ('PENDING', 'COUNTED', 'NOT_COUNTED');

-- Templates: every existing one came from face-api in the browser. Kept, never matched:
-- each person registers once more; until then their punches go through the manual request.
ALTER TABLE "employee_face" ADD COLUMN "kind" "FaceTemplateKind" NOT NULL DEFAULT 'REGISTERED';
ALTER TABLE "employee_face" ADD COLUMN "site_id" UUID;
ALTER TABLE "employee_face" ADD COLUMN "score" DECIMAL(9,6);
ALTER TABLE "employee_face" ADD COLUMN "live_score" DECIMAL(9,6);
UPDATE "employee_face" SET "model_version" = 'faceapi-v1';
CREATE INDEX "employee_face_model_version_idx" ON "employee_face"("model_version");

ALTER TABLE "punch" ADD COLUMN "session_id" UUID;
CREATE UNIQUE INDEX "punch_session_id_key" ON "punch"("session_id");

ALTER TABLE "face_exception" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'NOT_RECOGNISED';
ALTER TABLE "face_exception" ADD COLUMN "crop_keys" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "face_exception" ADD COLUMN "claimed_name" TEXT;
ALTER TABLE "face_exception" ADD COLUMN "session_id" UUID;

CREATE TABLE "punch_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "purpose" "PunchSessionPurpose" NOT NULL DEFAULT 'PUNCH',
    "status" "PunchSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "tries" INTEGER NOT NULL DEFAULT 0,
    "employee_id" UUID,
    "state" JSONB NOT NULL,
    "crop_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "punch_id" UUID,
    "face_exception_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    CONSTRAINT "punch_session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "punch_session_site_id_created_at_idx" ON "punch_session"("site_id", "created_at");
CREATE INDEX "punch_session_status_created_at_idx" ON "punch_session"("status", "created_at");

CREATE TABLE "punch_attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "purpose" "PunchSessionPurpose" NOT NULL,
    "outcome" TEXT NOT NULL,
    "code" TEXT,
    "counts_as_try" BOOLEAN NOT NULL DEFAULT false,
    "tries_after" INTEGER NOT NULL,
    "employee_id" UUID,
    "score" DECIMAL(9,6),
    "second_score" DECIMAL(9,6),
    "live_score" DECIMAL(9,6),
    "yaw_front" DECIMAL(6,1),
    "yaw_turn" DECIMAL(6,1),
    "challenge" TEXT,
    "quality" JSONB,
    "service_ms" INTEGER,
    "resolution" TEXT,
    "reply" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    CONSTRAINT "punch_attempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "punch_attempt_session_id_request_id_key" ON "punch_attempt"("session_id", "request_id");
CREATE INDEX "punch_attempt_created_at_idx" ON "punch_attempt"("created_at");
CREATE INDEX "punch_attempt_site_id_created_at_idx" ON "punch_attempt"("site_id", "created_at");
ALTER TABLE "punch_attempt" ADD CONSTRAINT "punch_attempt_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "punch_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "site_change" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "from_site_id" UUID NOT NULL,
    "to_site_id" UUID NOT NULL,
    "out_punch_id" UUID NOT NULL,
    "in_punch_id" UUID,
    "left_at" TIMESTAMPTZ(6) NOT NULL,
    "arrived_at" TIMESTAMPTZ(6),
    "travel_min" INTEGER,
    "status" "SiteChangeStatus" NOT NULL DEFAULT 'PENDING',
    "hr_travel_min" INTEGER,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    CONSTRAINT "site_change_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "site_change_travel_valid" CHECK ("travel_min" IS NULL OR "travel_min" >= 0),
    CONSTRAINT "site_change_hr_travel_valid" CHECK ("hr_travel_min" IS NULL OR ("hr_travel_min" >= 0 AND "hr_travel_min" <= 1440))
);
CREATE INDEX "site_change_employee_id_work_date_idx" ON "site_change"("employee_id", "work_date");
CREATE INDEX "site_change_status_created_at_idx" ON "site_change"("status", "created_at");
