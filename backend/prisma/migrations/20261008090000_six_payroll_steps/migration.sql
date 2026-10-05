-- Payroll now has five reviewed steps and a sixth, generating:
--   1 attendance, 2 joiners and exits, 3 held salary, 4 F&F, 5 adhoc, 6 generate.
-- Before: 1 attendance, 2 joiners and exits (with F&F), 3 issues, 4 adhoc, 5 run.
-- F&F used to be decided in step 2, so a month past the old step 3 has its F&F step done too.
UPDATE payroll_period p
SET steps_submitted = COALESCE((
  SELECT array_agg(DISTINCT m ORDER BY m)
  FROM unnest(p.steps_submitted) AS s(x)
  CROSS JOIN LATERAL unnest(CASE x WHEN 3 THEN ARRAY[3, 4] WHEN 4 THEN ARRAY[5] WHEN 5 THEN ARRAY[6] ELSE ARRAY[x] END) AS m
), '{}')
WHERE cardinality(p.steps_submitted) > 0;
