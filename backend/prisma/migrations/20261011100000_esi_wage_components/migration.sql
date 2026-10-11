-- Preserve the ESI wage base of every existing salary structure.
ALTER TABLE "salary_component"
ADD COLUMN "counts_as_esi_wages" BOOLEAN NOT NULL DEFAULT true;

-- Yearly payouts were not included in regular ESI wages before this setting.
UPDATE "salary_component"
SET "counts_as_esi_wages" = false
WHERE "frequency" = 'YEARLY';
