CREATE TABLE IF NOT EXISTS "execution_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "job_id" TEXT NOT NULL,
  "requested_at" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "idempotency_key" TEXT,
  "tx_id" TEXT,
  "summary" TEXT,
  CONSTRAINT "execution_events_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs" ("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "execution_events_job_id_requested_at_idx"
ON "execution_events" ("job_id", "requested_at");
