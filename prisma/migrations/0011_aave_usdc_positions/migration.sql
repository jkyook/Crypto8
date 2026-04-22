CREATE TABLE "aave_usdc_positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "underlying_address" TEXT NOT NULL,
    "a_token_address" TEXT NOT NULL,
    "amount_raw" TEXT NOT NULL,
    "amount_usd" REAL NOT NULL,
    "deposit_tx_hash" TEXT NOT NULL,
    "withdraw_tx_hash" TEXT,
    "status" TEXT NOT NULL,
    "deposit_position_id" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "aave_usdc_positions_username_fkey" FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "aave_usdc_positions_deposit_tx_hash_key" ON "aave_usdc_positions"("deposit_tx_hash");
CREATE INDEX "aave_usdc_positions_username_created_at_idx" ON "aave_usdc_positions"("username", "created_at");
CREATE INDEX "aave_usdc_positions_wallet_address_chain_idx" ON "aave_usdc_positions"("wallet_address", "chain");
