import "dotenv/config";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express, { Router, type CookieOptions } from "express";
import {
  assertValidWithdrawAmount,
  createDepositPosition,
  listDepositPositions,
  listWithdrawalLedger,
  withdrawProtocolExposureAmount,
  withdrawProductDepositAmount,
  withdrawDepositAmount
} from "./positions";
import { approveJob, cancelJob, createJob, executeJob, getJob, listApprovals, listExecutionEvents, listJobs } from "./store";
import type { ApprovalLog, JobInput } from "./types";
import { authenticate, authenticateWallet, refreshAccessToken, registerUser, revokeRefreshToken, type UserRole, verifyToken } from "./auth";
import { getDb, initDb } from "./db";
import { ensureDemoUsersIfEmpty } from "./ensureDemoUsers";
import rateLimit from "express-rate-limit";
import { gatherProtocolInsightsNews } from "./protocolNews";
import { getDailyApySeriesFromCsv, getPoolApySeriesFromCsv, listMarketRatesHistory, maybeAppendMarketRatesSnapshot } from "./marketAprHistory";
import { listAccountAssets } from "./accountAssets";
import { estimateProtocolFees, type FeeEstimateInputRow } from "./feeEstimator";
import { getMarketPriceSnapshot } from "./marketPricing";
import { linkUserWallet, listUserWallets } from "./userWallets";

const app = express();
const port = Number(process.env.PORT ?? 8787);
/** Render 등 리버스 프록시 뒤에서 올바른 클라이언트 IP·프로토콜 인식 */
app.set("trust proxy", 1);

const __serverDir = dirname(fileURLToPath(import.meta.url));
function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(__serverDir, "../package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const APP_VERSION = readPackageVersion();
const ACCESS_COOKIE_NAME = "access_token";
const REFRESH_COOKIE_NAME = "refresh_token";
const CSRF_COOKIE_NAME = "csrf_token";
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function resolveSameSite(): CookieOptions["sameSite"] {
  const raw = (process.env.AUTH_COOKIE_SAME_SITE ?? "strict").toLowerCase();
  if (raw === "none") return "none";
  if (raw === "lax") return "lax";
  return "strict";
}

const COOKIE_SECURE = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
const COOKIE_SAME_SITE = resolveSameSite();

function baseCookieOptions(httpOnly: boolean): CookieOptions {
  return {
    httpOnly,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAME_SITE,
    path: "/"
  };
}

function parseCookies(req: express.Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(";").reduce<Record<string, string>>((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(value);
    } catch {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function issueCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

function setAuthCookies(res: express.Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, baseCookieOptions(true));
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(true),
    maxAge: REFRESH_COOKIE_MAX_AGE_MS
  });
  res.cookie(CSRF_COOKIE_NAME, issueCsrfToken(), {
    ...baseCookieOptions(false),
    maxAge: REFRESH_COOKIE_MAX_AGE_MS
  });
}

function setAccessAndCsrfCookies(res: express.Response, accessToken: string): void {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, baseCookieOptions(true));
  res.cookie(CSRF_COOKIE_NAME, issueCsrfToken(), {
    ...baseCookieOptions(false),
    maxAge: REFRESH_COOKIE_MAX_AGE_MS
  });
}

function clearAuthCookies(res: express.Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, baseCookieOptions(true));
  res.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions(true));
  res.clearCookie(CSRF_COOKIE_NAME, baseCookieOptions(false));
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function verifyCsrfToken(req: express.Request): boolean {
  if (!isUnsafeMethod(req.method)) return true;
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE_NAME];
  const headerToken = req.header("X-CSRF-Token");
  if (!cookieToken || !headerToken) return false;
  return safeTokenEqual(cookieToken, headerToken);
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "crypto8-orchestrator-api",
    message: "API가 정상 기동 중입니다. 웹 UI는 Render의 crypto8-web(정적) 또는 GitHub Pages URL로 여세요.",
    health: "/api/health",
    version: APP_VERSION
  });
});

/**
 * CORS 화이트리스트.
 * `CORS_ALLOWED_ORIGINS` 콤마구분(예: `http://localhost:5173,https://crypto8.example.com`).
 * 미설정이면 개발 편의를 위해 localhost/127.0.0.1 (모든 포트) 허용. 프로덕션에서는 명시 권장.
 */
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const isLocalhostOrigin = (origin: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(
  cors({
    origin: (origin, callback) => {
      // same-origin / curl / 서버사이드 호출은 origin이 비어 있음 → 허용
      if (!origin) return callback(null, true);
      if (CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      if (CORS_ALLOWED_ORIGINS.length === 0 && isLocalhostOrigin(origin)) {
        // 운영자가 명시 안 한 환경에서는 로컬 호스트만 허용(브라우저 외 호출은 위에서 통과)
        return callback(null, true);
      }
      return callback(new Error(`origin not allowed: ${origin}`));
    },
    credentials: true,
    exposedHeaders: ["X-Request-Id"]
  })
);
// JSON 본문 크기 제한: 기본 100kb는 LP 데이터 등에는 충분. 한도 명시로 메모리 폭주 방지.
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
  const incoming = req.headers["x-request-id"];
  const rid = typeof incoming === "string" && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
  res.setHeader("X-Request-Id", rid);
  (res.locals as Record<string, string>).requestId = rid;
  (req as express.Request & { requestId: string }).requestId = rid;
  const started = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "http",
        requestId: rid,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started
      })
    );
  });
  next();
});

/** Rate limiter 상수 모음. 운영 중 튜닝 시 한 곳만 보면 됨. */
const RATE_LIMITS = {
  authWindowMs: 60 * 1000,
  authMax: 30,
  executeWindowMs: 60 * 1000,
  executeMax: 20,
  registerWindowMs: 15 * 60 * 1000,
  registerMax: 12
} as const;

const authLimiter = rateLimit({
  windowMs: RATE_LIMITS.authWindowMs,
  max: RATE_LIMITS.authMax,
  standardHeaders: true,
  legacyHeaders: false
});

const executeLimiter = rateLimit({
  windowMs: RATE_LIMITS.executeWindowMs,
  max: RATE_LIMITS.executeMax,
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: RATE_LIMITS.registerWindowMs,
  max: RATE_LIMITS.registerMax,
  standardHeaders: true,
  legacyHeaders: false
});

async function fetchCurrentAprs(): Promise<{ aave: number; uniswap: number; orca: number; updatedAt: string }> {
  const fallback = { aave: 0.045, uniswap: 0.085, orca: 0.072, updatedAt: new Date().toISOString() };
  try {
    const response = await fetch("https://yields.llama.fi/pools");
    if (!response.ok) {
      return fallback;
    }
    const data = (await response.json()) as {
      data?: Array<{
        project?: string;
        chain?: string;
        apy?: number | null;
      }>;
    };
    const pools = data.data ?? [];
    const avgApy = (projectNames: string[], chainNames: string[]): number => {
      const matched = pools.filter((pool) => {
        const project = (pool.project ?? "").toLowerCase();
        const chain = (pool.chain ?? "").toLowerCase();
        return (
          projectNames.some((name) => project.includes(name)) &&
          chainNames.some((name) => chain.includes(name)) &&
          typeof pool.apy === "number" &&
          Number.isFinite(pool.apy)
        );
      });
      if (matched.length === 0) {
        return 0;
      }
      const sum = matched.reduce((acc, pool) => acc + (pool.apy ?? 0), 0);
      return sum / matched.length / 100;
    };

    const aave = avgApy(["aave"], ["arbitrum", "base"]) || fallback.aave;
    const uniswap = avgApy(["uniswap"], ["arbitrum"]) || fallback.uniswap;
    const orca = avgApy(["orca"], ["solana"]) || fallback.orca;

    return { aave, uniswap, orca, updatedAt: new Date().toISOString() };
  } catch {
    return fallback;
  }
}

function requireAuth(allowedRoles: UserRole[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const cookies = parseCookies(req);
    const cookieToken = cookies[ACCESS_COOKIE_NAME];
    const authHeader = req.header("Authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : undefined;
    const token = cookieToken ?? bearerToken;
    if (!token) {
      res.status(401).json({ ok: false, message: "unauthorized: missing session cookie" });
      return;
    }
    const verified = verifyToken(token);
    if (!verified.ok || !verified.role || !verified.subject) {
      res.status(401).json({ ok: false, message: "unauthorized: invalid token" });
      return;
    }
    if (cookieToken && !verifyCsrfToken(req)) {
      res.status(403).json({ ok: false, message: "forbidden: csrf token mismatch" });
      return;
    }
    if (!allowedRoles.includes(verified.role)) {
      res.status(403).json({ ok: false, message: "forbidden: insufficient role" });
      return;
    }
    res.locals.user = { username: verified.subject, role: verified.role };
    next();
  };
}

const adminRouter = Router();
adminRouter.get("/self-registrations", requireAuth(["orchestrator"]), async (_req, res) => {
  const db = getDb();
  const rows = await db.user.findMany({
    where: { registeredAt: { not: null } },
    select: { username: true, role: true, registeredAt: true },
    orderBy: { registeredAt: "desc" }
  });
  res.json({ ok: true, registrations: rows });
});
app.use("/api/admin", adminRouter);

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  const body = req.body as { username?: unknown; password?: unknown };
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    res.status(400).json({ ok: false, message: "username/password required" });
    return;
  }
  const trimmed = body.username.trim();
  const reg = await registerUser(trimmed, body.password);
  if (!reg.ok) {
    const code = reg.message;
    const status =
      code === "username taken"
        ? 409
        : code === "username length invalid" || code === "username format invalid" || code === "password length invalid"
          ? 400
          : 400;
    res.status(status).json({ ok: false, message: reg.message ?? "register failed" });
    return;
  }
  const auth = await authenticate(trimmed, body.password);
  if (!auth.ok || !auth.accessToken || !auth.refreshToken || !auth.role) {
    res.status(500).json({ ok: false, message: "register succeeded but login failed" });
    return;
  }
  setAuthCookies(res, auth.accessToken, auth.refreshToken);
  res.json({ ok: true, role: auth.role, username: trimmed });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const body = req.body as { username?: unknown; password?: unknown };
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    res.status(400).json({ ok: false, message: "username/password required" });
    return;
  }
  const username = body.username.trim();
  if (username.length === 0 || username.length > 64 || body.password.length === 0 || body.password.length > 200) {
    res.status(400).json({ ok: false, message: "username/password length invalid" });
    return;
  }
  const auth = await authenticate(username, body.password);
  if (!auth.ok || !auth.accessToken || !auth.refreshToken || !auth.role) {
    res.status(401).json({ ok: false, message: "invalid credentials" });
    return;
  }
  setAuthCookies(res, auth.accessToken, auth.refreshToken);
  res.json({ ok: true, role: auth.role, username });
});

app.post("/api/auth/wallet", authLimiter, async (req, res) => {
  const body = req.body as { walletAddress?: unknown };
  if (typeof body.walletAddress !== "string") {
    res.status(400).json({ ok: false, message: "walletAddress required" });
    return;
  }
  const auth = await authenticateWallet(body.walletAddress);
  if (!auth.ok || !auth.accessToken || !auth.refreshToken || !auth.role || !auth.username) {
    res.status(400).json({ ok: false, message: auth.message ?? "wallet login failed" });
    return;
  }
  await linkUserWallet(auth.username, body.walletAddress);
  setAuthCookies(res, auth.accessToken, auth.refreshToken);
  res.json({ ok: true, role: auth.role, username: auth.username });
});

app.post("/api/auth/refresh", async (req, res) => {
  const refreshToken = parseCookies(req)[REFRESH_COOKIE_NAME];
  if (!refreshToken || refreshToken.length > 256) {
    clearAuthCookies(res);
    res.status(401).json({ ok: false, message: "invalid refresh token" });
    return;
  }
  if (!verifyCsrfToken(req)) {
    res.status(403).json({ ok: false, message: "forbidden: csrf token mismatch" });
    return;
  }
  const refreshed = await refreshAccessToken(refreshToken);
  if (!refreshed.ok || !refreshed.accessToken || !refreshed.role || !refreshed.username) {
    clearAuthCookies(res);
    res.status(401).json({ ok: false, message: "invalid refresh token" });
    return;
  }
  setAccessAndCsrfCookies(res, refreshed.accessToken);
  res.json({
    ok: true,
    role: refreshed.role,
    username: refreshed.username
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const refreshToken = parseCookies(req)[REFRESH_COOKIE_NAME];
  if (refreshToken && !verifyCsrfToken(req)) {
    res.status(403).json({ ok: false, message: "forbidden: csrf token mismatch" });
    return;
  }
  if (refreshToken && refreshToken.length <= 256) {
    await revokeRefreshToken(refreshToken);
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

const WHITEPAPER_PDF_PATH = join(__serverDir, "assets/whitepaper-option-l2.pdf");

app.get("/api/whitepaper.pdf", (_req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="defi-yield-portfolio-report.pdf"');
  res.sendFile(WHITEPAPER_PDF_PATH, (err) => {
    if (err) {
      console.error(JSON.stringify({ level: "error", msg: "whitepaper_send", error: String(err) }));
      if (!res.headersSent) {
        res.status(404).type("application/json").json({ ok: false, error: "whitepaper_not_found" });
      }
    }
  });
});

app.get("/api/account/assets", requireAuth(["orchestrator", "security", "viewer"]), async (_req, res) => {
  const username = res.locals.user.username as string;
  const role = res.locals.user.role as UserRole;
  res.json({ ok: true, assets: await listAccountAssets(username, role) });
});

app.get("/api/account/wallets", requireAuth(["orchestrator", "security", "viewer"]), async (_req, res) => {
  const username = res.locals.user.username as string;
  res.json({ ok: true, wallets: await listUserWallets(username) });
});

app.post("/api/account/wallets", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = req.body as { walletAddress?: unknown; chain?: unknown; provider?: unknown };
  if (typeof body.walletAddress !== "string") {
    res.status(400).json({ ok: false, message: "walletAddress required" });
    return;
  }
  const username = res.locals.user.username as string;
  const chain = typeof body.chain === "string" && body.chain.trim() ? body.chain.trim() : "Solana";
  const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "phantom";
  const wallet = await linkUserWallet(username, body.walletAddress, chain, provider);
  res.json({ ok: true, wallet });
});

app.get("/api/market/prices", async (_req, res) => {
  res.json({ ok: true, ...(await getMarketPriceSnapshot()) });
});

app.post("/api/orchestrator/fee-estimate", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { rows?: unknown };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const parsed = rows
    .map((row): FeeEstimateInputRow | null => {
      const r = row as Partial<FeeEstimateInputRow>;
      if (
        typeof r.protocol !== "string" ||
        typeof r.chain !== "string" ||
        typeof r.action !== "string" ||
        typeof r.allocationUsd !== "number" ||
        !Number.isFinite(r.allocationUsd) ||
        r.allocationUsd < 0
      ) {
        return null;
      }
      return {
        protocol: r.protocol,
        chain: r.chain,
        action: r.action,
        allocationUsd: r.allocationUsd
      };
    })
    .filter((row): row is FeeEstimateInputRow => row !== null)
    .slice(0, 20);
  if (parsed.length === 0) {
    res.status(400).json({ ok: false, message: "fee estimate rows required" });
    return;
  }
  res.json({ ok: true, ...(await estimateProtocolFees(parsed)) });
});

app.get("/api/health", async (_req, res) => {
  let database: "ok" | "error" = "error";
  try {
    const db = getDb();
    await db.$queryRaw`SELECT 1`;
    database = "ok";
  } catch {
    database = "error";
  }
  const requested = process.env.EXECUTION_MODE === "live" ? "live" : "dry-run";
  const liveConfirmed = process.env.LIVE_EXECUTION_CONFIRM === "YES";
  const executionMode = requested === "live" && liveConfirmed ? "live" : "dry-run";
  res.json({
    ok: database === "ok",
    service: "crypto8-orchestrator-api",
    version: APP_VERSION,
    database,
    executionMode,
    uptimeSec: Math.floor(process.uptime())
  });
});

app.get("/api/market/rates", async (_req, res) => {
  const rates = await fetchCurrentAprs();
  try {
    await maybeAppendMarketRatesSnapshot(rates, false);
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "market_rates_snapshot_append_failed", error: String(err) }));
  }
  res.json({ ok: true, rates });
});

app.get("/api/market/rates/history", async (req, res) => {
  const hoursRaw = Number(req.query.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(Math.floor(hoursRaw), 45 * 24) : 168;
  const b = typeof req.query.bucket === "string" ? req.query.bucket : "auto";
  const bucket = b === "hour" || b === "day" || b === "auto" ? b : "auto";
  try {
    const { granularity, points } = await listMarketRatesHistory({ hours, bucket });
    res.json({ ok: true, hours, granularity, points });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "market_rates_history_failed", error: String(err) }));
    res.status(500).json({ ok: false, message: "history query failed" });
  }
});

/** MG_HanTo `apy_history.csv` 동일 스키마: 일자별 Aave(Arb+Base)·Uniswap(Arb)·Orca(Sol) 평균 APY. */
app.get("/api/market/apy-history-csv", (req, res) => {
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 90;
  const out = getDailyApySeriesFromCsv(days);
  res.json({
    ok: out.ok,
    source: out.source,
    granularity: "day" as const,
    days,
    message: out.message,
    points: out.points
  });
});

/** 선택 상품 풀 라벨 기준: 일자별 풀 APY와 합성 APY 계산용 원천 데이터. */
app.get("/api/market/pool-apy-history-csv", (req, res) => {
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 90;
  const rawPool = req.query.pool;
  const pools = (Array.isArray(rawPool) ? rawPool : typeof rawPool === "string" ? [rawPool] : [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
    .slice(0, 8);
  if (pools.length === 0) {
    res.status(400).json({ ok: false, message: "pool query is required", granularity: "day", series: [], points: [] });
    return;
  }
  const out = getPoolApySeriesFromCsv(days, pools);
  res.json({
    ok: out.ok,
    source: out.source,
    granularity: "day" as const,
    days,
    message: out.message,
    series: out.series,
    points: out.points
  });
});

app.get("/api/runtime/info", (_req, res) => {
  const requested = process.env.EXECUTION_MODE === "live" ? "live" : "dry-run";
  const liveConfirmed = process.env.LIVE_EXECUTION_CONFIRM === "YES";
  const executionMode = requested === "live" && liveConfirmed ? "live" : "dry-run";
  res.json({
    ok: true,
    executionMode,
    executionModeRequested: requested,
    liveExecutionConfirmed: liveConfirmed,
    walletUiPolicy: "phantom-solana",
    serverExecutionNote:
      "Phantom signMessage in the browser records user intent only. Protocol movements are performed by server-side adapters according to EXECUTION_MODE."
  });
});

function stripUsername<T extends { username: string }>(row: T): Omit<T, "username"> {
  const { username: _u, ...rest } = row;
  return rest;
}

function buildProtocolMixFromExecutionPayload(
  payload: Awaited<ReturnType<typeof executeJob>>["payload"],
  depositUsd: number
): { name: string; weight: number; pool?: string }[] {
  const rows = payload?.adapterResults?.filter((item) => item.allocationUsd > 0) ?? [];
  if (rows.length === 0 || depositUsd <= 0) {
    return [
      { name: "Aave", weight: 0.35, pool: "Aave v3 USDC" },
      { name: "Uniswap", weight: 0.4, pool: "Uniswap LP route" },
      { name: "Orca", weight: 0.2, pool: "Orca Whirlpool" },
      { name: "Cash", weight: 0.05, pool: "USDC buffer" }
    ];
  }
  return rows.map((row) => ({
    name: row.protocol,
    weight: Math.min(1, row.allocationUsd / depositUsd),
    pool: `${row.chain} · ${row.action}`
  }));
}

async function recordExecutionPositionIfNeeded(args: {
  username: string;
  job: Awaited<ReturnType<typeof getJob>>;
  result: Awaited<ReturnType<typeof executeJob>>;
  positionId?: string;
}): Promise<void> {
  if (!args.job || args.positionId || args.result.message !== "execution accepted") {
    return;
  }
  const depositUsd = args.job.input.depositUsd;
  if (!Number.isFinite(depositUsd) || depositUsd <= 0) {
    return;
  }
  const mode = args.result.payload?.mode ?? "dry-run";
  const protocolMix = buildProtocolMixFromExecutionPayload(args.result.payload, depositUsd);
  await createDepositPosition(args.username, {
    productName: `${mode === "live" ? "Server execution" : "Dry-run execution"} ${args.job.id.slice(-6)}`,
    amountUsd: depositUsd,
    expectedApr: 0.08,
    protocolMix
  });
}

app.get("/api/portfolio/positions", requireAuth(["orchestrator", "security", "viewer"]), async (_req, res) => {
  const username = res.locals.user.username as string;
  const rows = await listDepositPositions(username);
  res.json({
    ok: true,
    positions: rows.map((row) => stripUsername(row))
  });
});

app.get("/api/portfolio/withdrawals", requireAuth(["orchestrator", "security", "viewer"]), async (_req, res) => {
  const username = res.locals.user.username as string;
  const withdrawals = await listWithdrawalLedger(username);
  res.json({ ok: true, withdrawals });
});

app.post("/api/portfolio/positions", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = req.body as {
    productName?: string;
    amountUsd?: unknown;
    expectedApr?: unknown;
    protocolMix?: unknown;
  };
  const username = res.locals.user.username as string;
  if (typeof body.productName !== "string" || typeof body.amountUsd !== "number" || typeof body.expectedApr !== "number") {
    res.status(400).json({ ok: false, message: "productName, amountUsd, expectedApr required" });
    return;
  }
  if (!Array.isArray(body.protocolMix)) {
    res.status(400).json({ ok: false, message: "protocolMix must be an array" });
    return;
  }
  try {
    const created = await createDepositPosition(username, {
      productName: body.productName,
      amountUsd: body.amountUsd,
      expectedApr: body.expectedApr,
      protocolMix: body.protocolMix as { name: string; weight: number; pool?: string }[]
    });
    res.json({ ok: true, position: stripUsername(created) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : "create failed" });
  }
});

app.post("/api/portfolio/withdraw", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = req.body as { amountUsd?: unknown };
  const username = res.locals.user.username as string;
  if (typeof body.amountUsd !== "number") {
    res.status(400).json({ ok: false, message: "amountUsd required" });
    return;
  }
  try {
    assertValidWithdrawAmount(body.amountUsd);
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : "invalid amount" });
    return;
  }
  const withdrawnUsd = await withdrawDepositAmount(username, body.amountUsd);
  res.json({ ok: true, withdrawnUsd });
});

app.post("/api/portfolio/withdraw-product", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = req.body as { amountUsd?: unknown; productName?: unknown };
  const username = res.locals.user.username as string;
  if (typeof body.amountUsd !== "number") {
    res.status(400).json({ ok: false, message: "amountUsd required" });
    return;
  }
  if (typeof body.productName !== "string" || body.productName.trim().length === 0) {
    res.status(400).json({ ok: false, message: "productName required" });
    return;
  }
  try {
    assertValidWithdrawAmount(body.amountUsd);
    const withdrawnUsd = await withdrawProductDepositAmount(username, body.productName, body.amountUsd);
    res.json({ ok: true, withdrawnUsd });
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : "withdraw failed" });
  }
});

app.post("/api/portfolio/withdraw-protocol", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = req.body as { amountUsd?: unknown; protocol?: unknown; chain?: unknown; pool?: unknown };
  const username = res.locals.user.username as string;
  if (typeof body.amountUsd !== "number") {
    res.status(400).json({ ok: false, message: "amountUsd required" });
    return;
  }
  if (typeof body.protocol !== "string" || body.protocol.trim().length === 0) {
    res.status(400).json({ ok: false, message: "protocol required" });
    return;
  }
  try {
    assertValidWithdrawAmount(body.amountUsd);
    const withdrawnUsd = await withdrawProtocolExposureAmount(username, body.amountUsd, {
      protocol: body.protocol,
      chain: typeof body.chain === "string" ? body.chain : undefined,
      pool: typeof body.pool === "string" ? body.pool : undefined
    });
    res.json({ ok: true, withdrawnUsd });
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : "withdraw failed" });
  }
});

app.get("/api/insights/news", async (req, res) => {
  const protocolParam = req.query.protocol;
  const protocol =
    typeof protocolParam === "string" ? protocolParam : Array.isArray(protocolParam) ? String(protocolParam[0] ?? "") : "";
  if (!protocol) {
    res.status(400).json({ ok: false, message: "protocol query is required" });
    return;
  }
  const bundle = await gatherProtocolInsightsNews(protocol);
  res.json({ ok: true, items: bundle.items, digest: bundle.digest, scannedSources: bundle.scannedSources });
});

app.post("/api/orchestrator/jobs", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = req.body as Partial<JobInput>;
  if (
    typeof body.depositUsd !== "number" ||
    typeof body.isRangeOut !== "boolean" ||
    typeof body.isDepegAlert !== "boolean" ||
    typeof body.hasPendingRelease !== "boolean"
  ) {
    res.status(400).json({ ok: false, message: "invalid input" });
    return;
  }
  const sourceAsset =
    body.sourceAsset === "USDC" || body.sourceAsset === "USDT" || body.sourceAsset === "ETH" || body.sourceAsset === "SOL"
      ? body.sourceAsset
      : "USDC";

  try {
    const username = res.locals.user.username as string;
    const role = res.locals.user.role as UserRole;
    const fundingAsset = (await listAccountAssets(username, role)).find((asset) => asset.symbol === sourceAsset);
    if (!fundingAsset || fundingAsset.usdValue < body.depositUsd) {
      res.status(400).json({
        ok: false,
        message: `insufficient ${sourceAsset} balance for deposit`,
        availableUsd: fundingAsset?.usdValue ?? 0
      });
      return;
    }
    const job = await createJob({ ...(body as JobInput), sourceAsset }, username);
    res.json({ ok: true, job });
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : "job create failed" });
  }
});

app.get("/api/orchestrator/jobs", requireAuth(["orchestrator", "security", "viewer"]), async (_req, res) => {
  const username = res.locals.user.username as string;
  const role = res.locals.user.role as string;
  res.json({ ok: true, jobs: await listJobs({ username, role }) });
});

function jobReadableByUser(job: { requestedBy?: string | null }, username: string, role: string): boolean {
  if (role === "security") {
    return true;
  }
  if (job.requestedBy) {
    return job.requestedBy === username;
  }
  return false;
}

app.get("/api/orchestrator/jobs/:jobId", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const jobIdParam = req.params.jobId;
  const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
  const job = await getJob(jobId);
  if (!job) {
    res.status(404).json({ ok: false, message: "job not found" });
    return;
  }
  const username = res.locals.user.username as string;
  const role = res.locals.user.role as string;
  if (!jobReadableByUser(job, username, role)) {
    res.status(404).json({ ok: false, message: "job not found" });
    return;
  }
  res.json({ ok: true, job });
});

app.post("/api/orchestrator/jobs/:jobId/cancel", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const jobIdParam = req.params.jobId;
  const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
  const username = res.locals.user.username as string;
  const role = res.locals.user.role as string;
  try {
    const job = await cancelJob(jobId, { username, role });
    res.json({ ok: true, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "job cancel failed";
    res.status(message.includes("not found") ? 404 : 400).json({ ok: false, message });
  }
});

app.post("/api/security/approve", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const body = req.body as {
    jobId?: string;
    approver?: string;
    ttlHours?: number;
    decision?: ApprovalLog["decision"];
    reason?: string;
  };
  if (!body.jobId || !body.ttlHours || !body.decision || !body.reason) {
    res.status(400).json({ ok: false, message: "missing required fields" });
    return;
  }
  const job = await getJob(body.jobId);
  if (!job) {
    res.status(404).json({ ok: false, message: "job not found" });
    return;
  }
  const username = res.locals.user.username as string;
  const role = res.locals.user.role as string;
  if (!jobReadableByUser(job, username, role)) {
    res.status(404).json({ ok: false, message: "job not found" });
    return;
  }

  const approval = await approveJob({
    jobId: body.jobId,
    approver: username,
    ttlHours: body.ttlHours,
    decision: body.decision,
    reason: body.reason
  });
  res.json({ ok: true, approval });
});

app.get("/api/security/approvals", requireAuth(["orchestrator", "security", "viewer"]), async (_req, res) => {
  res.json({ ok: true, approvals: await listApprovals() });
});

app.get("/api/orchestrator/execution-events", requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
  const username = res.locals.user.username as string;
  const role = res.locals.user.role as string;
  res.json({ ok: true, events: await listExecutionEvents(jobId, { username, role }) });
});

app.post("/api/orchestrator/execute/:jobId", executeLimiter, requireAuth(["orchestrator", "security", "viewer"]), async (req, res) => {
  const jobIdParam = req.params.jobId;
  const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
  const idempotencyKey = req.header("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 160) {
    res.status(400).json({ ok: false, message: "Idempotency-Key header required for execution requests" });
    return;
  }
  const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
    correlationId?: unknown;
    positionId?: unknown;
    requestedMode?: unknown;
  };
  const headerCorr = req.headers["x-correlation-id"];
  const correlationId =
    typeof body.correlationId === "string"
      ? body.correlationId
      : typeof headerCorr === "string"
        ? headerCorr
        : undefined;
  const positionId = typeof body.positionId === "string" ? body.positionId : undefined;
  const requestedMode = body.requestedMode === "live" || body.requestedMode === "dry-run" ? body.requestedMode : undefined;
  const username = res.locals.user.username as string;
  const role = res.locals.user.role as string;
  const result = await executeJob(jobId, idempotencyKey, { correlationId, positionId, requestedMode }, { username, role });
  const requestId = typeof (res.locals as Record<string, unknown>).requestId === "string" ? (res.locals as Record<string, string>).requestId : undefined;
  if (!result.ok) {
    const forbidden = typeof result.message === "string" && result.message.startsWith("forbidden:");
    res.status(forbidden ? 403 : 400).json({ ...result, requestId });
    return;
  }
  try {
    await recordExecutionPositionIfNeeded({ username, job: result.job, result, positionId });
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", msg: "execution_position_record_failed", jobId, error: String(error) }));
  }
  res.json({ ...result, requestId });
});

/** 모든 라우트 등록 직후(부트스트랩·listen 전)에 두어 경로 누락을 방지합니다. */
app.use((req, res) => {
  res.status(404).json({ ok: false, message: `not found: ${req.method} ${req.path}` });
});

const DB_INIT_TIMEOUT_MS = 25_000;

async function bootstrap(): Promise<void> {
  try {
    mkdirSync(join(__serverDir, "data"), { recursive: true });
  } catch (err) {
    console.error("[bootstrap] server/data 디렉터리 생성 실패:", err);
  }

  try {
    await Promise.race([
      initDb(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`initDb가 ${DB_INIT_TIMEOUT_MS}ms 안에 끝나지 않았습니다. DATABASE_URL·SQLite 경로를 확인하세요.`));
        }, DB_INIT_TIMEOUT_MS);
      })
    ]);
  } catch (err) {
    console.error("[bootstrap] DB 초기화 실패:", err);
    process.exit(1);
  }

  try {
    await ensureDemoUsersIfEmpty();
  } catch (err) {
    console.error("[bootstrap] 데모 사용자 시드 실패:", err);
    process.exit(1);
  }

  try {
    const seedRates = await fetchCurrentAprs();
    await maybeAppendMarketRatesSnapshot(seedRates, true);
  } catch (err) {
    console.warn("[bootstrap] 초기 시장 APR 스냅샷 저장 생략:", err);
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`Crypto8 API listening on http://0.0.0.0:${port} (PORT=${port})`);
  });
}

void bootstrap();
