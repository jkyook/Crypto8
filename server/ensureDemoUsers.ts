import bcrypt from "bcryptjs";
import { getDb } from "./db";

const DEMO_USERS = [
  { username: "orchestrator_admin", password: "orchestrator123", role: "orchestrator" },
  { username: "security_admin", password: "security123", role: "security" },
  { username: "viewer_admin", password: "viewer123", role: "viewer" }
] as const;

/** `users`가 비어 있으면 prisma/seed.ts와 동일한 데모 계정을 넣습니다(로컬·첫 기동 편의). */
export async function ensureDemoUsersIfEmpty(): Promise<void> {
  const db = getDb();
  const count = await db.user.count();
  if (count > 0) {
    return;
  }
  console.warn("[bootstrap] users 테이블이 비어 있어 데모 계정을 자동 생성합니다. (prisma db seed 와 동일)");
  for (const user of DEMO_USERS) {
    const passwordHash = bcrypt.hashSync(user.password, 10);
    await db.user.upsert({
      where: { username: user.username },
      create: {
        username: user.username,
        passwordHash,
        role: user.role
      },
      update: {
        passwordHash,
        role: user.role
      }
    });
  }
}
