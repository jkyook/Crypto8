import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { getDb } from "./db";

export type UserRole = "orchestrator" | "security" | "viewer";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-jwt-secret-change-me";
/** 예: `15m`, `8h`, `7d` — 짧으면 입금 등 API 호출 시 갱신이 잦아집니다. */
const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN ?? "15m";
const REFRESH_EXPIRES_DAYS = 7;

function signAccessToken(username: string, role: UserRole): string {
  return jwt.sign({ sub: username, role, tokenType: "access" }, JWT_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueRefreshToken(username: string): Promise<string> {
  const db = getDb();
  const refreshToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.refreshSession.create({
    data: {
      id: `rt_${Date.now()}`,
      username,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      revoked: 0
    }
  });
  return refreshToken;
}

/** 일반 이용자 가입. 역할은 항상 `viewer`(예치·인출·예치 실행 동일 API). */
export async function registerUser(username: string, password: string): Promise<{ ok: boolean; message?: string }> {
  const u = username.trim();
  if (u.length < 3 || u.length > 64) {
    return { ok: false, message: "username length invalid" };
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(u)) {
    return { ok: false, message: "username format invalid" };
  }
  if (password.length < 8 || password.length > 200) {
    return { ok: false, message: "password length invalid" };
  }
  const db = getDb();
  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    await db.user.create({
      data: {
        username: u,
        passwordHash,
        role: "viewer",
        registeredAt: new Date().toISOString()
      }
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, message: "username taken" };
    }
    throw e;
  }
  return { ok: true };
}

export async function authenticate(
  username: string,
  password: string
): Promise<{ ok: boolean; role?: UserRole; accessToken?: string; refreshToken?: string }> {
  const db = getDb();
  const user = await db.user.findUnique({ where: { username } });
  if (!user) {
    return { ok: false };
  }
  const matched = bcrypt.compareSync(password, user.passwordHash);
  if (!matched) {
    return { ok: false };
  }
  return {
    ok: true,
    role: user.role,
    accessToken: signAccessToken(user.username, user.role),
    refreshToken: await issueRefreshToken(user.username)
  };
}

export function verifyToken(token: string): { ok: boolean; role?: UserRole; subject?: string } {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; role: UserRole; tokenType?: string };
    if (payload.tokenType !== "access") {
      return { ok: false };
    }
    return { ok: true, role: payload.role, subject: payload.sub };
  } catch (_error) {
    return { ok: false };
  }
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{ ok: boolean; accessToken?: string; role?: UserRole; username?: string }> {
  const db = getDb();
  const session = await db.refreshSession.findUnique({
    where: { tokenHash: hashToken(refreshToken) }
  });
  if (!session) {
    return { ok: false };
  }
  if (session.revoked || new Date(session.expiresAt).getTime() <= Date.now()) {
    return { ok: false };
  }
  const user = await db.user.findUnique({ where: { username: session.username } });
  if (!user) {
    return { ok: false };
  }
  return {
    ok: true,
    accessToken: signAccessToken(user.username, user.role),
    role: user.role,
    username: user.username
  };
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const db = getDb();
  await db.refreshSession.updateMany({
    where: { tokenHash: hashToken(refreshToken) },
    data: { revoked: 1 }
  });
}
