CREATE TYPE "FaceRegistrationAuthorizationStatus" AS ENUM ('APPROVED', 'USED', 'REVOKED');

CREATE TABLE face_registration_authorization (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL,
  status "FaceRegistrationAuthorizationStatus" NOT NULL DEFAULT 'APPROVED',
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  used_at TIMESTAMPTZ(6),
  used_site_id UUID,
  revoked_by TEXT,
  revoked_at TIMESTAMPTZ(6),
  CONSTRAINT face_registration_authorization_pkey PRIMARY KEY (id),
  CONSTRAINT face_registration_authorization_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT face_registration_authorization_used_site_id_fkey FOREIGN KEY (used_site_id) REFERENCES site(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT face_registration_authorization_expiry CHECK (expires_at > approved_at),
  CONSTRAINT face_registration_authorization_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  CONSTRAINT face_registration_authorization_used CHECK ((status = 'USED') = (used_at IS NOT NULL AND used_site_id IS NOT NULL)),
  CONSTRAINT face_registration_authorization_revoked CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE INDEX face_registration_authorization_employee_id_approved_at_idx ON face_registration_authorization(employee_id, approved_at);
-- Expired approvals are closed under the employee lock before another is issued.
CREATE UNIQUE INDEX face_registration_authorization_one_approved_employee ON face_registration_authorization(employee_id) WHERE status = 'APPROVED';

ALTER TABLE punch_session ADD COLUMN face_registration_authorization_id UUID;
ALTER TABLE punch_session ADD CONSTRAINT punch_session_face_registration_authorization_id_fkey FOREIGN KEY (face_registration_authorization_id) REFERENCES face_registration_authorization(id) ON DELETE RESTRICT ON UPDATE CASCADE;
