-- Gratuity moves from the company-wide statutory rates to a policy attached to each pay
-- group. Each statutory rates row becomes one version of a "Gratuity" policy with the same
-- dates and figures (basic, a part-year over six months counted as a year, no ceiling, as
-- before), attached to every pay group, so settlements come out the same until HR publishes
-- their own.
WITH k AS MATERIALIZED (
  SELECT gen_random_uuid() AS policy_key
), v AS (
  SELECT
    valid_from,
    LEAD(valid_from) OVER (ORDER BY valid_from) - 1 AS valid_to,
    ROW_NUMBER() OVER (ORDER BY valid_from) AS version,
    gratuity
  FROM "statutory_rates"
  WHERE deleted_at IS NULL
), created AS (
  INSERT INTO "policy" (policy_key, kind, name, version, valid_from, valid_to, rules, created_by)
  SELECT
    k.policy_key,
    'GRATUITY',
    'Gratuity',
    v.version,
    v.valid_from,
    v.valid_to,
    jsonb_build_object(
      'min_years', v.gratuity -> 'min_years',
      'flag_from_years', v.gratuity -> 'flag_from_years',
      'days_per_year', v.gratuity -> 'days_per_year',
      'divisor', v.gratuity -> 'divisor',
      'base', 'BASIC',
      'part_year', 'OVER_SIX_MONTHS',
      'max_amount', NULL
    ),
    'migration'
  FROM v CROSS JOIN k
  RETURNING id
)
INSERT INTO "pay_group_policy" (pay_group_id, policy_id)
SELECT g.id, created.id FROM "pay_group" g CROSS JOIN created WHERE g.deleted_at IS NULL;

ALTER TABLE "statutory_rates" DROP COLUMN "gratuity";

-- Late penalties are removed: lateness is flagged for HR, never deducted. Their policies
-- and attachments are retired, never deleted (payroll runs may have used them).
UPDATE "pay_group_policy" SET deleted_at = now()
WHERE deleted_at IS NULL AND policy_id IN (SELECT id FROM "policy" WHERE kind = 'LATE_PENALTY');
UPDATE "policy" SET deleted_at = now(), status = 'RETIRED'
WHERE deleted_at IS NULL AND kind = 'LATE_PENALTY';
