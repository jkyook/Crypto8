import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const seedUsers = [
  { username: "orchestrator_admin", password: "orchestrator123", role: "orchestrator" },
  { username: "security_admin", password: "security123", role: "security" },
  { username: "viewer_admin", password: "viewer123", role: "viewer" }
] as const;

async function main(): Promise<void> {
  for (const user of seedUsers) {
    const existing = await prisma.user.findUnique({ where: { username: user.username } });
    if (existing) {
      continue;
    }
    const passwordHash = bcrypt.hashSync(user.password, 10);
    await prisma.user.create({
      data: {
        username: user.username,
        passwordHash,
        role: user.role
      }
    });
  }
}

main()
  .catch((error) => {
    console.error("prisma seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
