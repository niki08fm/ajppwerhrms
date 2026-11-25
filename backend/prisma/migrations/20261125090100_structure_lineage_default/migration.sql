-- A structure created without a lineage starts its own: it is the first version of itself.
CREATE OR REPLACE FUNCTION salary_structure_default_lineage() RETURNS trigger AS $$
BEGIN
  IF NEW.lineage_id IS NULL THEN
    NEW.lineage_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salary_structure_default_lineage
  BEFORE INSERT ON "salary_structure"
  FOR EACH ROW EXECUTE FUNCTION salary_structure_default_lineage();
