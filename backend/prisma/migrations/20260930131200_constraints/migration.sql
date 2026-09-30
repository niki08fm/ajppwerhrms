-- ─────────────────────────────────────────────────────────────────────────────
-- Constraints worth enforcing in the database, not just in code (spec §4).
-- ─────────────────────────────────────────────────────────────────────────────

-- Indexes that are not optional -----------------------------------------------

-- Partial, for audit review of manual punches
CREATE INDEX IF NOT EXISTS punch_manual_idx ON punch (work_date) WHERE method IN ('MANUAL', 'EXCEPTION');
CREATE INDEX IF NOT EXISTS employee_status_live_idx ON employee (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS punch_flagged_idx ON punch (work_date) WHERE flagged;

-- Trigram search: "kum" finds "Kumar", case-insensitive substrings
CREATE INDEX IF NOT EXISTS employee_search_idx ON employee USING gin ((name || ' ' || code) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS employee_name_trgm_idx ON employee USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS employee_code_trgm_idx ON employee USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS employee_designation_trgm_idx ON employee USING gin (designation gin_trgm_ops);
CREATE INDEX IF NOT EXISTS employee_phone_trgm_idx ON employee USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS audit_action_trgm_idx ON audit_log USING gin (action gin_trgm_ops);

-- Salary rows for one employee can never overlap in date ------------------------
ALTER TABLE employee_salary
  ADD CONSTRAINT employee_salary_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (deleted_at IS NULL);

ALTER TABLE employee_salary
  ADD CONSTRAINT employee_salary_dates_ordered CHECK (valid_to IS NULL OR valid_to >= valid_from);

ALTER TABLE policy
  ADD CONSTRAINT policy_dates_ordered CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- Weekly off: every element is one of the seven day names ------------------------
ALTER TABLE pay_group
  ADD CONSTRAINT pay_group_weekly_off_valid
  CHECK (weekly_off <@ ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT']::text[]);

-- Money is never negative where it cannot be ------------------------------------
ALTER TABLE employee_salary ADD CONSTRAINT employee_salary_amount_positive CHECK (amount > 0 AND monthly_gross > 0);
ALTER TABLE advance ADD CONSTRAINT advance_amounts_valid CHECK (amount > 0 AND instalment > 0 AND recovered >= 0 AND recovered <= amount);
ALTER TABLE loan ADD CONSTRAINT loan_amounts_valid CHECK (principal > 0 AND emi > 0 AND recovered >= 0 AND recovered <= principal);
ALTER TABLE adhoc_item ADD CONSTRAINT adhoc_amount_positive CHECK (amount > 0);
ALTER TABLE attendance_override ADD CONSTRAINT override_values_valid CHECK (day_value >= 0 AND day_value <= 1 AND worked_min >= 0 AND ot_min >= 0 AND late_min >= 0);
ALTER TABLE site ADD CONSTRAINT site_radius_valid CHECK (radius_m > 0);

-- The punch ledger is append-only ---------------------------------------------------
-- Corrections are separate records layered on top. The retention job (punches older
-- than three years) is the only thing allowed to delete, and it must opt in with
--   SET LOCAL ajpwer.retention = 'on';
CREATE OR REPLACE FUNCTION forbid_punch_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ajpwer.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'punch is append-only: % is not allowed', TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER punch_append_only
  BEFORE UPDATE OR DELETE ON punch
  FOR EACH ROW EXECUTE FUNCTION forbid_punch_mutation();

-- The audit log is insert-only ------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ajpwer.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is insert-only: % is not allowed', TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_insert_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- A payslip in a LOCKED or PAID period is immutable ----------------------------------
CREATE OR REPLACE FUNCTION forbid_locked_payslip_change() RETURNS trigger AS $$
DECLARE
  st text;
  pid uuid;
BEGIN
  IF TG_TABLE_NAME = 'payslip' THEN
    pid := COALESCE(OLD.period_id, NEW.period_id);
  ELSE
    SELECT p.period_id INTO pid FROM payslip p WHERE p.id = COALESCE(OLD.payslip_id, NEW.payslip_id);
  END IF;
  SELECT state::text INTO st FROM payroll_period WHERE id = pid;
  IF st IN ('LOCKED', 'PAID') THEN
    RAISE EXCEPTION 'payslips in a % period cannot be changed', st USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payslip_locked_guard
  BEFORE UPDATE OR DELETE ON payslip
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_payslip_change();

CREATE TRIGGER payslip_line_locked_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payslip_line
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_payslip_change();

-- Least privilege for the application role -----------------------------------------
-- In production, connect the API as a dedicated role (see docs/OPERATIONS.md):
--   CREATE ROLE ajpwer_app LOGIN PASSWORD '...';
-- If that role exists, strip UPDATE and DELETE on the append-only tables from it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ajpwer_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ajpwer_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON punch FROM ajpwer_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON audit_log FROM ajpwer_app';
  END IF;
END $$;
