-- An offer can go out without a joining date; the date is given when onboarding starts.
ALTER TABLE "employee" ALTER COLUMN "joined_on" DROP NOT NULL;
ALTER TABLE "offer" ALTER COLUMN "join_by" DROP NOT NULL;

-- Only someone on offer or accepted may be without a joining date.
ALTER TABLE "employee" ADD CONSTRAINT "employee_joined_on_required"
  CHECK ("joined_on" IS NOT NULL OR "status" IN ('OFFER', 'ACCEPTED'));

-- A revoked offer stays on record.
ALTER TABLE "offer" ADD COLUMN "revoked_on" DATE;
ALTER TABLE "offer" ADD COLUMN "revoke_reason" TEXT;
ALTER TABLE "offer" ADD COLUMN "revoked_by" TEXT;
