import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

export async function initDb(): Promise<void> {
  if (prisma) {
    return;
  }
  prisma = new PrismaClient();
  await prisma.$connect();
}

export function getDb(): PrismaClient {
  if (!prisma) {
    throw new Error("DB not initialized");
  }
  return prisma;
}
