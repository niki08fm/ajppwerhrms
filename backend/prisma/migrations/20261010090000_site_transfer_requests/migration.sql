CREATE TYPE "SiteTransferStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "site_transfer_request" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "employee_id" UUID NOT NULL,
  "from_site_id" UUID NOT NULL,
  "to_site_id" UUID NOT NULL,
  "departure_date" DATE NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "SiteTransferStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by" TEXT NOT NULL,
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "updated_at" TIMESTAMPTZ(6),
  CONSTRAINT "site_transfer_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_transfer_different_sites" CHECK (from_site_id <> to_site_id),
  CONSTRAINT "site_transfer_request_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "site_transfer_request_from_site_id_fkey" FOREIGN KEY (from_site_id) REFERENCES site(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "site_transfer_request_to_site_id_fkey" FOREIGN KEY (to_site_id) REFERENCES site(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "site_transfer_request_from_site_id_requested_at_idx" ON site_transfer_request(from_site_id, requested_at DESC);
CREATE INDEX "site_transfer_request_status_requested_at_idx" ON site_transfer_request(status, requested_at);
-- A retry, another tablet or another departure date cannot create two open requests for one person.
CREATE UNIQUE INDEX "site_transfer_request_one_pending_employee" ON site_transfer_request(employee_id) WHERE status = 'PENDING';
