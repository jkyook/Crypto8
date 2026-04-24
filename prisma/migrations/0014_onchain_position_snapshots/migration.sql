-- CreateTable
CREATE TABLE "onchain_position_snapshots" (
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
    CONSTRAINT "onchain_position_snapshots_username_fkey" FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "onchain_position_snapshots_username_sampled_at_idx" ON "onchain_position_snapshots"("username", "sampled_at");

-- CreateIndex
CREATE INDEX "onchain_position_snapshots_username_protocol_chain_pool_key_sampled_at_idx" ON "onchain_position_snapshots"("username", "protocol", "chain", "pool_key", "sampled_at");

-- CreateIndex
CREATE INDEX "onchain_position_snapshots_username_protocol_chain_position_token_sampled_at_idx" ON "onchain_position_snapshots"("username", "protocol", "chain", "position_token", "sampled_at");
