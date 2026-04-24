import { PrismaClient } from "@prisma/client";
import { hydrateRuntimeModeOverride } from "./runtimeMode";

let prisma: PrismaClient | null = null;

export async function initDb(): Promise<void> {
  if (prisma) {
    return;
  }
  prisma = new PrismaClient();
  await prisma.$connect();

  async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
    if (!rows.some((row) => row.name === column)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
    }
  }

  // ── 레거시 user_wallets 테이블 (스키마 밖 생성) ──────────────────────────
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      chain TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(username, wallet_address)
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_user_wallets_username ON user_wallets(username)"
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS runtime_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await ensureColumn("jobs", "requested_by", "TEXT");
  await ensureColumn("jobs", "source_asset", "TEXT");
  await ensureColumn("jobs", "product_network", "TEXT");
  await ensureColumn("jobs", "product_subtype", "TEXT");
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "jobs_requested_by_created_at_idx" ON "jobs"("requested_by", "created_at")`
  );

  // ── Migration 0012: Intent / Execution / Position 모델 ───────────────────
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "deposit_intents" (
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
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "deposit_intents_username_created_at_idx" ON "deposit_intents"("username", "created_at")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "deposit_intents_job_id_idx" ON "deposit_intents"("job_id")`
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "executions" (
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
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "executions_intent_id_idx" ON "executions"("intent_id")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "executions_tx_hash_idx" ON "executions"("tx_hash")`
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "positions" (
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
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "positions_execution_id_key" ON "positions"("execution_id")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "positions_username_opened_at_idx" ON "positions"("username", "opened_at")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "positions_protocol_chain_idx" ON "positions"("protocol", "chain")`
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "onchain_position_snapshots" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "username" TEXT NOT NULL,
      "sampled_at" TEXT NOT NULL,
      "protocol" TEXT NOT NULL,
      "chain" TEXT NOT NULL,
      "pool_key" TEXT NOT NULL,
      "pool_address" TEXT,
      "position_token" TEXT,
      "asset" TEXT NOT NULL,
      "amount_usd" REAL NOT NULL,
      "principal_usd" REAL,
      "current_value_usd" REAL,
      "unrealized_pnl_usd" REAL,
      "realized_pnl_usd" REAL,
      "fees_paid_usd" REAL,
      "pending_yield_usd" REAL,
      "net_apy" REAL,
      "expected_apr" REAL,
      "current_price" REAL,
      "range_lower_price" REAL,
      "range_upper_price" REAL,
      "wallet_address" TEXT,
      "source" TEXT,
      "position_id" TEXT,
      "onchain_data_json" TEXT,
      CONSTRAINT "onchain_position_snapshots_username_fkey"
        FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "onchain_position_snapshots_username_sampled_at_idx" ON "onchain_position_snapshots"("username", "sampled_at")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "onchain_position_snapshots_username_protocol_chain_pool_key_sampled_at_idx" ON "onchain_position_snapshots"("username", "protocol", "chain", "pool_key", "sampled_at")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "onchain_position_snapshots_username_protocol_chain_position_token_sampled_at_idx" ON "onchain_position_snapshots"("username", "protocol", "chain", "position_token", "sampled_at")`
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "withdrawal_intents" (
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
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "withdrawal_intents_username_created_at_idx" ON "withdrawal_intents"("username", "created_at")`
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "withdrawal_executions" (
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
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "withdrawal_executions_intent_id_idx" ON "withdrawal_executions"("intent_id")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "withdrawal_executions_tx_hash_idx" ON "withdrawal_executions"("tx_hash")`
  );

  await hydrateRuntimeModeOverride(prisma);
}

export function getDb(): PrismaClient {
  if (!prisma) {
    throw new Error("DB not initialized");
  }
  return prisma;
}
