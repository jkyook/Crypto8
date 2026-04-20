import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { getDb } from "./db";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

export type UserRole = "orchestrator" | "security" | "viewer";

/**
 * `JWT_SECRET`은 서버 기동 시 필수. 운영 환경에서 기본값이 쓰이는 사고를 막으려고
 *  - NODE_ENV=production: 미설정 시 즉시 종료
 *  - 그 외(개발/테스트): 안전한 임시 키를 한 번 생성해 사용(경고 로그)
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret && secret.length >= 16 && secret !== "dev-jwt-secret-change-me") {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set (>=16 chars, non-default) in production");
  }
  // 개발 환경: 기동마다 바뀌어도 괜찮은 임시 비밀키
  const generated = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[auth] JWT_SECRET 미설정 또는 기본값 감지 → 개발용 임시 비밀키로 기동합니다. (프로덕션 전 반드시 환경변수로 설정하세요)"
  );
  return generated;
}

const JWT_SECRET = resolveJwtSecret();
/** 예: `15m`, `8h`, `7d` — 짧으면 입금 등 API 호출 시 갱신이 잦아집니다. */
const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN ?? "15m";
const REFRESH_EXPIRES_DAYS = 7;
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;

type WalletLoginChallenge = {
  walletAddress: string;
  message: string;
  expiresAt: number;
};

const walletLoginChallenges = new Map<string, WalletLoginChallenge>();

/** bcrypt cost factor. 최신 권장(2024~)은 12 이상. 환경변수로 조정 가능. */
const BCRYPT_ROUNDS = (() => {
  const raw = Number(process.env.BCRYPT_ROUNDS);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 15) {
    return Math.floor(raw);
  }
  return 12;
})();

/**
 * 사용자 입력 비밀번호 복잡도 검증.
 * 길이 8~200은 기존 정책 유지, 최소 2가지 문자 클래스(영문/숫자/특수) 이상을 요구해
 *  흔한 `password`·`12345678` 같은 계정 탈취 시도를 줄인다.
 */
function isAcceptablePassword(password: string): boolean {
  if (password.length < 8 || password.length > 200) {
    return false;
  }
  const classes = [/[a-zA-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  return classes >= 2;
}

function signAccessToken(username: string, role: UserRole): string {
  return jwt.sign({ sub: username, role, tokenType: "access" }, JWT_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isValidSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(address)) {
    return false;
  }
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function buildWalletChallengeMessage(walletAddress: string, nonce: string, expiresAt: number): string {
  return [
    "Crypto8 wallet login",
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`
  ].join("\n");
}

export function createWalletLoginChallenge(walletAddress: string): { ok: boolean; message?: string; nonce?: string; expiresAt?: string } {
  const address = walletAddress.trim();
  if (!isValidSolanaAddress(address)) {
    return { ok: false, message: "wallet address invalid" };
  }
  const nonce = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + WALLET_CHALLENGE_TTL_MS;
  const message = buildWalletChallengeMessage(address, nonce, expiresAt);
  walletLoginChallenges.set(nonce, { walletAddress: address, message, expiresAt });
  return { ok: true, nonce, message, expiresAt: new Date(expiresAt).toISOString() };
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
  if (!isAcceptablePassword(password)) {
    return { ok: false, message: "password too weak (8+ chars, 2+ char classes)" };
  }
  const db = getDb();
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
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

export async function authenticateWallet(
  walletAddress: string,
  nonce: string,
  signatureBase64: string
): Promise<{ ok: boolean; username?: string; role?: UserRole; accessToken?: string; refreshToken?: string; message?: string }> {
  const address = walletAddress.trim();
  if (!isValidSolanaAddress(address)) {
    return { ok: false, message: "wallet address invalid" };
  }
  const challenge = walletLoginChallenges.get(nonce);
  walletLoginChallenges.delete(nonce);
  if (!challenge || challenge.walletAddress !== address) {
    return { ok: false, message: "wallet challenge invalid" };
  }
  if (challenge.expiresAt < Date.now()) {
    return { ok: false, message: "wallet challenge expired" };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    return { ok: false, message: "wallet signature invalid" };
  }
  if (signature.length !== 64) {
    return { ok: false, message: "wallet signature invalid" };
  }
  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(challenge.message),
    new Uint8Array(signature),
    new PublicKey(address).toBytes()
  );
  if (!verified) {
    return { ok: false, message: "wallet signature verification failed" };
  }
  const username = `wallet_${address.slice(0, 8)}_${address.slice(-6)}`;
  const db = getDb();
  const existing = await db.user.findUnique({ where: { username } });
  if (!existing) {
    await db.user.create({
      data: {
        username,
        passwordHash: bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS),
        role: "viewer",
        registeredAt: new Date().toISOString()
      }
    });
  }
  const user = existing ?? (await db.user.findUniqueOrThrow({ where: { username } }));
  return {
    ok: true,
    username: user.username,
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
