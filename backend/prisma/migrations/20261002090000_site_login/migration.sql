-- Sites: address, tablet login that HR can disable, last sign-in / last seen,
-- a 50–2000 m geofence, and unique names. Permission sites.write → sites.manage.

ALTER TABLE "site" ADD COLUMN "address" TEXT;
ALTER TABLE "site" ADD COLUMN "login_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "site" ADD COLUMN "last_login_at" TIMESTAMPTZ(6);
ALTER TABLE "site" ADD COLUMN "last_seen_at" TIMESTAMPTZ(6);

-- Existing radii outside the new limits are brought inside them, and recorded.
INSERT INTO "audit_log" ("actor", "action", "entity_type", "entity_id", "detail")
SELECT 'system:migration', 'site.update', 'site', "id"::text,
       jsonb_build_object('radius_m', jsonb_build_object('from', "radius_m", 'to', LEAST(GREATEST("radius_m", 50), 2000)), 'reason', 'Geofence limits are now 50–2000 m')
FROM "site" WHERE "radius_m" < 50 OR "radius_m" > 2000;
UPDATE "site" SET "radius_m" = LEAST(GREATEST("radius_m", 50), 2000) WHERE "radius_m" < 50 OR "radius_m" > 2000;
ALTER TABLE "site" ADD CONSTRAINT "site_radius_m_range" CHECK ("radius_m" BETWEEN 50 AND 2000);

-- Duplicate names (ignoring case) get their code appended, and are recorded.
WITH d AS (
  SELECT "id", "name", "code", ROW_NUMBER() OVER (PARTITION BY lower("name") ORDER BY "created_at", "id") AS rn
  FROM "site" WHERE "deleted_at" IS NULL
)
INSERT INTO "audit_log" ("actor", "action", "entity_type", "entity_id", "detail")
SELECT 'system:migration', 'site.update', 'site', "id"::text,
       jsonb_build_object('name', jsonb_build_object('from', "name", 'to', "name" || ' (' || "code" || ')'), 'reason', 'Site names must be unique')
FROM d WHERE rn > 1;
WITH d AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY lower("name") ORDER BY "created_at", "id") AS rn
  FROM "site" WHERE "deleted_at" IS NULL
)
UPDATE "site" s SET "name" = s."name" || ' (' || s."code" || ')' FROM d WHERE d."id" = s."id" AND d.rn > 1;
CREATE UNIQUE INDEX "site_name_lower_key" ON "site" (lower("name")) WHERE "deleted_at" IS NULL;

-- Login IDs are case-insensitive: stored lower-case.
UPDATE "site" SET "login" = lower("login") WHERE "login" <> lower("login");
ALTER TABLE "site" ADD CONSTRAINT "site_login_lower" CHECK ("login" = lower("login"));

UPDATE "role" SET "permissions" = array_replace("permissions", 'sites.write', 'sites.manage') WHERE 'sites.write' = ANY ("permissions");
