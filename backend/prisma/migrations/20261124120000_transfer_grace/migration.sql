-- The sending site sets a travel grace on a transfer; the credited travel is capped by it.
ALTER TABLE "site_transfer_request" ADD COLUMN "grace_min" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "site_change" ADD COLUMN "grace_min" INTEGER, ADD COLUMN "transfer_id" UUID;
