import bcrypt from "bcryptjs";
import { getDb } from "./db";

const DEMO_USERS = [
  { username: "orchestrator_admin", password: "orchestrator123", role: "orchestrator" },
  { username: "security_admin", password: "security123", role: "security" },
  { username: "viewer_admin", password: "viewer123", role: "viewer" }
] as const;

const BCRYPT_ROUNDS = (() => {
  const raw = Number(process.env.BCRYPT_ROUNDS);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 15) {
    return Math.floor(raw);
  }
  return 12;
})();

/**
 * `users`가 비어 있으면 prisma/seed.ts와 동일한 데모 계정을 넣습니다(로컬·첫 기동 편의).
 * 운영 배포에서도 데모 로그인 경로가 유지되어야 하는 MVP 특성상,
 * `DISABLE_DEMO_USERS=true`(또는 `1`)일 때만 자동 생성을 건너뜁니다.
 */
export async function ensureDemoUsersIfEmpty(): Promise<void> {
  const disabledByFlag = ["1", "true", "yes"].includes((process.env.DISABLE_DEMO_USERS ?? "").toLowerCase());
  if (disabledByFlag) {
    return;
  }
  const db = getDb();
  const count = await db.user.count();
  if (count > 0) {
    return;
  }
  console.warn(
    "[bootstrap] users 테이블이 비어 있어 개발용 데모 계정을 자동 생성합니다. (prisma db seed 와 동일, 운영 배포 전 변경 필수)"
  );
  for (const user of DEMO_USERS) {
    const passwordHash = bcrypt.hashSync(user.password, BCRYPT_ROUNDS);
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
