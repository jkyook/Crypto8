-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "requested_by" TEXT;

CREATE INDEX "jobs_requested_by_created_at_idx" ON "jobs"("requested_by", "created_at");
