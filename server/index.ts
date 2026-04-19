import "dotenv/config";
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express, { Router } from "express";
import {
  assertValidWithdrawAmount,
  createDepositPosition,
  listDepositPositions,
  listWithdrawalLedger,
  withdrawDepositAmount
} from "./positions";
import { approveJob, cancelJob, createJob, executeJob, getJob, listApprovals, listExecutionEvents, listJobs } from "./store";
import type { ApprovalLog, JobInput } from "./types";
import { authenticate, refreshAccessToken, registerUser, revokeRefreshToken, type UserRole, verifyToken } from "./auth";
import { getDb, initDb } from "./db";
import { ensureDemoUsersIfEmpty } from "./ensureDemoUsers";
import rateLimit from "express-rate-limit";
import { gatherProtocolInsightsNews } from "./protocolNews";
import { getDailyApySeriesFromCsv, listMarketRatesHistory, maybeAppendMarketRatesSnapshot } from "./marketAprHistory";

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

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "crypto8-orchestrator-api",
    message: "API가 정상 기동 중입니다. 웹 UI는 Render의 crypto8-web(정적) 또는 GitHub Pages URL로 여세요.",
    health: "/api/health",
    version: APP_VERSION
  });
});

app.use(
  cors({
    exposedHeaders: ["X-Request-Id"]
  })
);
app.use(express.json());

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

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const executeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
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
    const authHeader = req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, message: "unauthorized: missing bearer token" });
      return;
    }
    const token = authHeader.replace("Bearer ", "");
    const verified = verifyToken(token);
    if (!verified.ok || !verified.role || !verified.subject) {
      res.status(401).json({ ok: false, message: "unauthorized: invalid token" });
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
  const body = req.body as { username?: string; password?: string };
  if (!body.username || !body.password) {
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
  res.json({ ok: true, accessToken: auth.accessToken, refreshToken: auth.refreshToken, role: auth.role });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const body = req.body as { username?: string; password?: string };
  if (!body.username || !body.password) {
    res.status(400).json({ ok: false, message: "username/password required" });
    return;
  }
  const auth = await authenticate(body.username, body.password);
  if (!auth.ok || !auth.accessToken || !auth.refreshToken || !auth.role) {
    res.status(401).json({ ok: false, message: "invalid credentials" });
    return;
  }
  res.json({ ok: true, accessToken: auth.accessToken, refreshToken: auth.refreshToken, role: auth.role });
});

app.post("/api/auth/refresh", async (req, res) => {
  const body = req.body as { refreshToken?: string };
  if (!body.refreshToken) {
    res.status(400).json({ ok: false, message: "refreshToken required" });
    return;
  }
  const refreshed = await refreshAccessToken(body.refreshToken);
  if (!refreshed.ok || !refreshed.accessToken || !refreshed.role || !refreshed.username) {
    res.status(401).json({ ok: false, message: "invalid refresh token" });
    return;
  }
  res.json({
    ok: true,
    accessToken: refreshed.accessToken,
    role: refreshed.role,
    username: refreshed.username
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const body = req.body as { refreshToken?: string };
  if (!body.refreshToken) {
    res.status(400).json({ ok: false, message: "refreshToken required" });
    return;
  }
  await revokeRefreshToken(body.refreshToken);
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
  const byProtocol = new Map<string, { amountUsd: number; pools: Set<string> }>();
  for (const row of rows) {
    const current = byProtocol.get(row.protocol) ?? { amountUsd: 0, pools: new Set<string>() };
    current.amountUsd += row.allocationUsd;
    current.pools.add(`${row.chain} · ${row.action}`);
    byProtocol.set(row.protocol, current);
  }
  return Array.from(byProtocol.entries()).map(([name, item]) => ({
    name,
    weight: Math.min(1, item.amountUsd / depositUsd),
    pool: Array.from(item.pools).slice(0, 2).join(" / ")
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

  try {
    const username = res.locals.user.username as string;
    const job = await createJob(body as JobInput, username);
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
  const idempotencyKey = req.header("Idempotency-Key") ?? undefined;
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
