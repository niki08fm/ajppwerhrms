-- Issues and held salaries become separate payroll steps (3 and 4), so F&F, adhoc and
-- generate move to 5, 6 and 7. A month that had submitted the old combined step 3 has
-- submitted both new steps. The step log is renumbered the same way.
UPDATE "payroll_period" p
SET "steps_submitted" = COALESCE((
      SELECT array_agg(DISTINCT m ORDER BY m)
      FROM unnest(p."steps_submitted") AS s
      CROSS JOIN LATERAL unnest(CASE WHEN s = 3 THEN ARRAY[3, 4] WHEN s >= 4 THEN ARRAY[s + 1] ELSE ARRAY[s] END) AS m
    ), ARRAY[]::INTEGER[]),
    "step_log" = COALESCE((
      SELECT jsonb_agg(CASE WHEN (e->>'step')::int >= 4 THEN jsonb_set(e, '{step}', to_jsonb((e->>'step')::int + 1)) ELSE e END ORDER BY o)
      FROM jsonb_array_elements(p."step_log") WITH ORDINALITY AS t(e, o)
    ), '[]'::jsonb);
