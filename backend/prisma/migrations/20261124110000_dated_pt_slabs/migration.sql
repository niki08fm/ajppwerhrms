-- A state's PT slabs are versioned by date; existing slabs apply from the start.
ALTER TABLE "pt_slab" ADD COLUMN "valid_from" DATE NOT NULL DEFAULT '2000-01-01'::date;
DROP INDEX IF EXISTS "pt_slab_state_idx";
CREATE INDEX "pt_slab_state_valid_from_idx" ON "pt_slab"("state", "valid_from");
