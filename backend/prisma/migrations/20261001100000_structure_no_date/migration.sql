-- A salary structure has no date of its own: it applies to the people of
-- whichever pay group it is attached to, from the month chosen when it is
-- attached (recorded on each person's salary history).
ALTER TABLE "salary_structure" DROP COLUMN "valid_from";
