-- CreateTable
CREATE TABLE "deposit_positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "amount_usd" REAL NOT NULL,
    "expected_apr" REAL NOT NULL,
    "protocol_mix" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "deposit_positions_username_fkey" FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "deposit_positions_username_created_at_idx" ON "deposit_positions"("username", "created_at");
