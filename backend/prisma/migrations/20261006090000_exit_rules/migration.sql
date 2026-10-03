-- Exit rules become a policy attached to each pay group.
ALTER TYPE "PolicyKind" ADD VALUE 'EXIT';

-- HR's changes to a settlement, each with its reason.
ALTER TABLE "settlement" ADD COLUMN "adjustments" JSONB NOT NULL DEFAULT '{}';

-- The exit checklist, ticked off task by task.
CREATE TABLE "exit_task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "task_code" TEXT NOT NULL,
    "done_at" TIMESTAMPTZ(6),
    "done_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "exit_task_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exit_task_employee_id_task_code_key" ON "exit_task"("employee_id", "task_code");

ALTER TABLE "exit_task" ADD CONSTRAINT "exit_task_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
