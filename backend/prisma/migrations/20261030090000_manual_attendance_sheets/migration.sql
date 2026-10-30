CREATE TYPE "ManualAttendanceSheetStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

CREATE TABLE "manual_attendance_sheet" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id" UUID NOT NULL,
  "work_date" DATE NOT NULL,
  "client_request_id" UUID NOT NULL,
  "request_hash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "ManualAttendanceSheetStatus" NOT NULL DEFAULT 'PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "submitted_by" TEXT NOT NULL,
  "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "updated_at" TIMESTAMPTZ(6),
  CONSTRAINT "manual_attendance_sheet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manual_sheet_version" CHECK (version > 0),
  CONSTRAINT "manual_sheet_deadline" CHECK (expires_at = submitted_at + INTERVAL '72 hours'),
  CONSTRAINT "manual_attendance_sheet_site_id_fkey" FOREIGN KEY (site_id) REFERENCES site(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "manual_attendance_sheet_site_id_client_request_id_key" ON manual_attendance_sheet(site_id, client_request_id);
CREATE INDEX "manual_attendance_sheet_site_id_submitted_at_idx" ON manual_attendance_sheet(site_id, submitted_at DESC);
CREATE INDEX "manual_attendance_sheet_status_expires_at_idx" ON manual_attendance_sheet(status, expires_at);

CREATE TABLE "manual_attendance_sheet_row" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "sheet_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "original_in_min" INTEGER NOT NULL,
  "original_out_min" INTEGER NOT NULL,
  "in_min" INTEGER NOT NULL,
  "out_min" INTEGER NOT NULL,
  "included" BOOLEAN NOT NULL DEFAULT TRUE,
  "note" TEXT,
  "punch_in_id" UUID,
  "punch_out_id" UUID,
  CONSTRAINT "manual_attendance_sheet_row_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manual_sheet_row_times" CHECK (in_min BETWEEN 0 AND 1439 AND out_min > in_min AND out_min <= 2879 AND out_min - in_min <= 1440),
  CONSTRAINT "manual_sheet_original_times" CHECK (original_in_min BETWEEN 0 AND 1439 AND original_out_min > original_in_min AND original_out_min <= 2879 AND original_out_min - original_in_min <= 1440),
  CONSTRAINT "manual_sheet_exclusion_note" CHECK (included OR length(trim(coalesce(note, ''))) >= 3),
  CONSTRAINT "manual_attendance_sheet_row_sheet_id_fkey" FOREIGN KEY (sheet_id) REFERENCES manual_attendance_sheet(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "manual_attendance_sheet_row_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "manual_attendance_sheet_row_sheet_id_employee_id_key" ON manual_attendance_sheet_row(sheet_id, employee_id);
CREATE UNIQUE INDEX "manual_attendance_sheet_row_sheet_id_seq_key" ON manual_attendance_sheet_row(sheet_id, seq);
CREATE INDEX "manual_attendance_sheet_row_employee_id_idx" ON manual_attendance_sheet_row(employee_id);
