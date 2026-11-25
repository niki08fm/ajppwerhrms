-- Salary structure versions. Each structure becomes a lineage of dated versions: one row per
-- version, sharing the first version's id as lineage_id. The first version applies from the
-- start (valid_from null); each later version from the 1st of a month, until the next begins.
ALTER TABLE "salary_structure" ADD COLUMN "lineage_id" UUID;
ALTER TABLE "salary_structure" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "salary_structure" ADD COLUMN "valid_from" DATE;

UPDATE "salary_structure" SET "lineage_id" = "id";
ALTER TABLE "salary_structure" ALTER COLUMN "lineage_id" SET NOT NULL;

CREATE INDEX "salary_structure_lineage_id_version_idx" ON "salary_structure"("lineage_id", "version");

-- One live row per version number and per start date in a lineage: versions cannot overlap.
CREATE UNIQUE INDEX "salary_structure_live_version_key" ON "salary_structure"("lineage_id", "version") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "salary_structure_live_start_key" ON "salary_structure"("lineage_id", "valid_from") WHERE "deleted_at" IS NULL AND "valid_from" IS NOT NULL;
CREATE UNIQUE INDEX "salary_structure_one_first_key" ON "salary_structure"("lineage_id") WHERE "deleted_at" IS NULL AND "valid_from" IS NULL;
-- Later versions start on the 1st of a month.
ALTER TABLE "salary_structure" ADD CONSTRAINT "salary_structure_month_start" CHECK ("valid_from" IS NULL OR EXTRACT(DAY FROM "valid_from") = 1);
