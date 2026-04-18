-- CreateTable
CREATE TABLE "users" (
    "username" TEXT NOT NULL PRIMARY KEY,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "created_at" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "deposit_usd" REAL NOT NULL,
    "is_range_out" INTEGER NOT NULL,
    "is_depeg_alert" INTEGER NOT NULL,
    "has_pending_release" INTEGER NOT NULL,
    "risk_level" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "job_id" TEXT NOT NULL,
    "approver" TEXT NOT NULL,
    "approved_at" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    CONSTRAINT "approvals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    "revoked" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_token_hash_key" ON "refresh_sessions"("token_hash");

