-- Gratuity becomes a policy attached to each pay group. The next migration moves the
-- rates over; a new enum value cannot be used in the migration that adds it.
ALTER TYPE "PolicyKind" ADD VALUE 'GRATUITY';
