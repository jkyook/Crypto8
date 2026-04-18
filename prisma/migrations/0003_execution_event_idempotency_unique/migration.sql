DELETE FROM "execution_events"
WHERE "id" IN (
  SELECT e1."id"
  FROM "execution_events" e1
  JOIN "execution_events" e2
    ON e1."job_id" = e2."job_id"
   AND e1."idempotency_key" = e2."idempotency_key"
  WHERE e1."idempotency_key" IS NOT NULL
    AND e1."requested_at" < e2."requested_at"
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_events_job_id_idempotency_key_key"
ON "execution_events" ("job_id", "idempotency_key");
