import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

export async function initDb(): Promise<void> {
  if (prisma) {
    return;
  }
  prisma = new PrismaClient();
  await prisma.$connect();
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
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_user_wallets_username ON user_wallets(username)");
}

export function getDb(): PrismaClient {
  if (!prisma) {
    throw new Error("DB not initialized");
  }
  return prisma;
}
