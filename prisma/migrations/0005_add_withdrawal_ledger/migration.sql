-- CreateTable
CREATE TABLE "withdrawal_ledger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "amount_usd" REAL NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "withdrawal_ledger_username_fkey" FOREIGN KEY ("username") REFERENCES "users" ("username") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "withdrawal_ledger_username_created_at_idx" ON "withdrawal_ledger"("username", "created_at");
