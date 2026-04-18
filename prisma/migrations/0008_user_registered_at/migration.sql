-- AlterTable
ALTER TABLE "users" ADD COLUMN "registered_at" TEXT;

CREATE INDEX "users_registered_at_idx" ON "users"("registered_at");
