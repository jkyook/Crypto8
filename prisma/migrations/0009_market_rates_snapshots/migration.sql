-- CreateTable
CREATE TABLE "market_rates_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sampled_at" TEXT NOT NULL,
    "aave" REAL NOT NULL,
    "uniswap" REAL NOT NULL,
    "orca" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "market_rates_snapshots_sampled_at_idx" ON "market_rates_snapshots"("sampled_at");
