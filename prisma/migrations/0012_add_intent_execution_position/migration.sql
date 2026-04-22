-- Migration 0012: Intent / Execution / Position / WithdrawalIntent / WithdrawalExecution

-- DepositIntent: 예치 의도 (Job → 어댑터 라우팅 결정 후 생성)
CREATE TABLE "deposit_intents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "job_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount_usd" REAL NOT NULL,
    "amount_raw" TEXT,
    "pool_address" TEXT,
    "action" TEXT NOT NULL,
    "quote_snapshot" TEXT,
    "quote_expires_at" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "deposit_intents_job_id_fkey"
        FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "deposit_intents_username_fkey"
        FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "deposit_intents_username_created_at_idx" ON "deposit_intents"("username", "created_at");
CREATE INDEX "deposit_intents_job_id_idx" ON "deposit_intents"("job_id");

-- Execution: 실제 트랜잭션 실행 시도 (하나의 Intent에 여러 retry 가능)
CREATE TABLE "executions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "intent_id" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tx_hash" TEXT,
    "block_number" INTEGER,
    "receipt_json" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "idempotency_key" TEXT,
    "submitted_at" TEXT,
    "confirmed_at" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "executions_intent_id_fkey"
        FOREIGN KEY ("intent_id") REFERENCES "deposit_intents" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "executions_intent_id_idx" ON "executions"("intent_id");
CREATE INDEX "executions_tx_hash_idx" ON "executions"("tx_hash");

-- Position: 온체인 receipt 확인 후 확정된 포지션 (Execution.status="confirmed" 후 생성)
CREATE TABLE "positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "execution_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "pool_address" TEXT,
    "position_token" TEXT,
    "position_raw" TEXT,
    "amount_usd" REAL NOT NULL,
    "deposit_tx_hash" TEXT NOT NULL,
    "last_synced_at" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "opened_at" TEXT NOT NULL,
    "closed_at" TEXT,
    "onchain_data_json" TEXT,
    CONSTRAINT "positions_execution_id_fkey"
        FOREIGN KEY ("execution_id") REFERENCES "executions" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "positions_username_fkey"
        FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "positions_execution_id_key" ON "positions"("execution_id");
CREATE INDEX "positions_username_opened_at_idx" ON "positions"("username", "opened_at");
CREATE INDEX "positions_protocol_chain_idx" ON "positions"("protocol", "chain");

-- WithdrawalIntent: 출금 요청
CREATE TABLE "withdrawal_intents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "amount_usd" REAL NOT NULL,
    "amount_raw" TEXT,
    "is_full_close" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "withdrawal_intents_username_fkey"
        FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "withdrawal_intents_username_created_at_idx" ON "withdrawal_intents"("username", "created_at");

-- WithdrawalExecution: 출금 트랜잭션 및 receipt
CREATE TABLE "withdrawal_executions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "intent_id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "tx_hash" TEXT,
    "block_number" INTEGER,
    "receipt_json" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "amount_returned_usd" REAL,
    "submitted_at" TEXT,
    "confirmed_at" TEXT,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "withdrawal_executions_intent_id_fkey"
        FOREIGN KEY ("intent_id") REFERENCES "withdrawal_intents" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "withdrawal_executions_position_id_fkey"
        FOREIGN KEY ("position_id") REFERENCES "positions" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX "withdrawal_executions_intent_id_idx" ON "withdrawal_executions"("intent_id");
CREATE INDEX "withdrawal_executions_tx_hash_idx" ON "withdrawal_executions"("tx_hash");
