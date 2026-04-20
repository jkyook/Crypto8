import type {
  ApprovalLog,
  ExecutionEvent,
  ExecutionEventPayloadV1,
  ExecutionJob,
  JobInput,
  JobListScope,
  RiskLevel
} from "./types";
import type { ExecutionAdapterBundle } from "./executionAdapter";
import type { ExecutionMode } from "./adapters/types";
import { getEffectiveExecutionMode, runExecutionAdapter } from "./executionAdapter";
import { getDb } from "./db";
import { MAX_DEPOSIT_USD } from "./limits";
import {
  createDepositIntentsFromAdapterResults,
  createExecution,
  updateDepositIntentStatus
} from "./intentStore";

function evaluateRisk(input: JobInput): RiskLevel {
  if (input.isDepegAlert) {
    return "Critical";
  }
  if (input.isRangeOut) {
    return "High";
  }
  if (input.hasPendingRelease) {
    return "Medium";
  }
  return "Low";
}

function rowToExecutionJob(row: {
  id: string;
  createdAt: string;
  status: string;
  depositUsd: number;
  isRangeOut: number;
  isDepegAlert: number;
  hasPendingRelease: number;
  riskLevel: string;
  sourceAsset?: string | null;
  productNetwork?: string | null;
  productSubtype?: string | null;
  requestedBy: string | null;
}): ExecutionJob {
  const sourceAsset =
    row.sourceAsset === "USDC" || row.sourceAsset === "USDT" || row.sourceAsset === "ETH" || row.sourceAsset === "SOL"
      ? row.sourceAsset
      : undefined;
  const productNetwork =
    row.productNetwork === "Ethereum" ||
    row.productNetwork === "Arbitrum" ||
    row.productNetwork === "Base" ||
    row.productNetwork === "Solana" ||
    row.productNetwork === "Multi"
      ? row.productNetwork
      : undefined;
  const productSubtype =
    row.productSubtype === "multi-stable" ||
    row.productSubtype === "multi-balanced" ||
    row.productSubtype === "arb-stable" ||
    row.productSubtype === "base-stable" ||
    row.productSubtype === "sol-stable" ||
    row.productSubtype === "eth-stable" ||
    row.productSubtype === "eth-bluechip"
      ? row.productSubtype
      : undefined;
  return {
    id: row.id,
    createdAt: row.createdAt,
    status: row.status as ExecutionJob["status"],
    input: {
      depositUsd: row.depositUsd,
      isRangeOut: Boolean(row.isRangeOut),
      isDepegAlert: Boolean(row.isDepegAlert),
      hasPendingRelease: Boolean(row.hasPendingRelease),
      sourceAsset,
      productNetwork,
      productSubtype
    },
    riskLevel: row.riskLevel as RiskLevel,
    requestedBy: row.requestedBy
  };
}

export async function createJob(input: JobInput, requestedBy: string): Promise<ExecutionJob> {
  if (!Number.isFinite(input.depositUsd) || input.depositUsd <= 0 || input.depositUsd > MAX_DEPOSIT_USD) {
    throw new Error("invalid depositUsd");
  }
  const riskLevel = evaluateRisk(input);
  const job: ExecutionJob = {
    id: `job_${Date.now()}`,
    createdAt: new Date().toISOString(),
    status: "queued",
    input,
    riskLevel,
    requestedBy
  };
  const db = getDb();
  await db.job.create({
    data: {
      id: job.id,
      createdAt: job.createdAt,
      status: job.status,
      depositUsd: input.depositUsd,
      isRangeOut: input.isRangeOut ? 1 : 0,
      isDepegAlert: input.isDepegAlert ? 1 : 0,
      hasPendingRelease: input.hasPendingRelease ? 1 : 0,
      riskLevel: job.riskLevel,
      sourceAsset: input.sourceAsset,
      productNetwork: input.productNetwork,
      productSubtype: input.productSubtype,
      requestedBy
    }
  });
  return job;
}

export async function listJobs(scope: JobListScope): Promise<ExecutionJob[]> {
  const db = getDb();
  const where = scope.role === "security" ? {} : { requestedBy: scope.username };
  const rows = await db.job.findMany({ where, orderBy: { createdAt: "desc" } });
  return rows.map(rowToExecutionJob);
}

export async function getJob(jobId: string): Promise<ExecutionJob | undefined> {
  const db = getDb();
  const row = await db.job.findUnique({ where: { id: jobId } });
  if (!row) {
    return undefined;
  }
  return rowToExecutionJob(row);
}

export async function cancelJob(jobId: string, auth: JobListScope): Promise<ExecutionJob> {
  const job = await getJob(jobId);
  if (!job) {
    throw new Error("job not found");
  }
  if (auth.role !== "security" && job.requestedBy !== auth.username) {
    throw new Error("job not found");
  }
  if (job.status === "executed") {
    throw new Error("executed job cannot be cancelled");
  }
  const db = getDb();
  const updated = await db.job.update({ where: { id: jobId }, data: { status: "cancelled" } });
  return rowToExecutionJob(updated);
}

export async function approveJob(args: {
  jobId: string;
  approver: string;
  ttlHours: number;
  decision: ApprovalLog["decision"];
  reason: string;
}): Promise<ApprovalLog> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.ttlHours * 60 * 60 * 1000);
  const log: ApprovalLog = {
    id: `approval_${Date.now()}`,
    jobId: args.jobId,
    approver: args.approver,
    approvedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    decision: args.decision,
    reason: args.reason
  };
  const db = getDb();
  await db.approval.create({
    data: {
      id: log.id,
      jobId: log.jobId,
      approver: log.approver,
      approvedAt: log.approvedAt,
      expiresAt: log.expiresAt,
      decision: log.decision,
      reason: log.reason
    }
  });
  return log;
}

export async function getLatestApproval(jobId: string): Promise<ApprovalLog | undefined> {
  const db = getDb();
  const row = await db.approval.findFirst({
    where: { jobId },
    orderBy: { approvedAt: "desc" }
  });
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    jobId: row.jobId,
    approver: row.approver,
    approvedAt: row.approvedAt,
    expiresAt: row.expiresAt,
    decision: row.decision as ApprovalLog["decision"],
    reason: row.reason
  };
}

function parsePayloadJson(raw: string | null | undefined): ExecutionEventPayloadV1 | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as ExecutionEventPayloadV1;
    if (parsed && parsed.v === 1) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function snapshotAdapterPayload(
  meta: { correlationId?: string; positionId?: string },
  partial: Omit<ExecutionEventPayloadV1, "v"> & { mode: ExecutionEventPayloadV1["mode"] }
): ExecutionEventPayloadV1 {
  return { v: 1, correlationId: meta.correlationId, positionId: meta.positionId, ...partial };
}

export async function listApprovals(): Promise<ApprovalLog[]> {
  const db = getDb();
  const rows = await db.approval.findMany({ orderBy: { approvedAt: "desc" } });
  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    approver: row.approver,
    approvedAt: row.approvedAt,
    expiresAt: row.expiresAt,
    decision: row.decision as ApprovalLog["decision"],
    reason: row.reason
  }));
}

async function createExecutionEvent(event: ExecutionEvent): Promise<void> {
  const db = getDb();
  try {
    await db.executionEvent.create({
      data: {
        id: event.id,
        jobId: event.jobId,
        requestedAt: event.requestedAt,
        status: event.status,
        message: event.message,
        idempotencyKey: event.idempotencyKey,
        txId: event.txId,
        summary: event.summary,
        payloadJson: event.payload ? JSON.stringify(event.payload) : undefined
      }
    });
  } catch (error) {
    // unique(jobId, idempotencyKey) 충돌은 중복 실행 요청으로 간주
    console.warn("execution event insert skipped:", error);
  }
}

async function findIdempotentEvent(jobId: string, idempotencyKey?: string): Promise<ExecutionEvent | null> {
  if (!idempotencyKey) {
    return null;
  }
  const db = getDb();
  const row = await db.executionEvent.findFirst({
    where: { jobId, idempotencyKey },
    orderBy: { requestedAt: "desc" }
  });
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    jobId: row.jobId,
    requestedAt: row.requestedAt,
    status: row.status as ExecutionEvent["status"],
    message: row.message,
    idempotencyKey: row.idempotencyKey ?? undefined,
    txId: row.txId ?? undefined,
    summary: row.summary ?? undefined,
    payload: parsePayloadJson(row.payloadJson)
  };
}

async function runExecutionWithRetry(
  job: ExecutionJob,
  retryCount: number,
  requestedMode?: ExecutionMode
): Promise<{ bundle: ExecutionAdapterBundle; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      const bundle = await runExecutionAdapter(job, requestedMode);
      return { bundle, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) {
        const backoffMs = attempt * 300;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastError;
}

export async function listExecutionEvents(jobId: string | undefined, scope: JobListScope): Promise<ExecutionEvent[]> {
  const db = getDb();
  if (jobId) {
    const job = await getJob(jobId);
    if (!job) {
      return [];
    }
    if (scope.role !== "security") {
      if (job.requestedBy && job.requestedBy !== scope.username) {
        return [];
      }
      if (!job.requestedBy) {
        return [];
      }
    }
    const rows = await db.executionEvent.findMany({
      where: { jobId },
      orderBy: { requestedAt: "desc" }
    });
    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      requestedAt: row.requestedAt,
      status: row.status as ExecutionEvent["status"],
      message: row.message,
      idempotencyKey: row.idempotencyKey ?? undefined,
      txId: row.txId ?? undefined,
      summary: row.summary ?? undefined,
      payload: parsePayloadJson(row.payloadJson)
    }));
  }

  const rows =
    scope.role === "security"
      ? await db.executionEvent.findMany({
          orderBy: { requestedAt: "desc" }
        })
      : await db.executionEvent.findMany({
          where: { job: { requestedBy: scope.username } },
          orderBy: { requestedAt: "desc" }
        });
  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    requestedAt: row.requestedAt,
    status: row.status as ExecutionEvent["status"],
    message: row.message,
    idempotencyKey: row.idempotencyKey ?? undefined,
    txId: row.txId ?? undefined,
    summary: row.summary ?? undefined,
    payload: parsePayloadJson(row.payloadJson)
  }));
}

export type ExecuteJobMeta = {
  correlationId?: string;
  positionId?: string;
  requestedMode?: ExecutionMode;
};

export async function executeJob(
  jobId: string,
  idempotencyKey?: string,
  meta?: ExecuteJobMeta,
  auth?: JobListScope
): Promise<{
  ok: boolean;
  message: string;
  job?: ExecutionJob;
  txId?: string;
  summary?: string;
  payload?: ExecutionEventPayloadV1;
}> {
  const db = getDb();
  const job = await getJob(jobId);
  if (!job) {
    return { ok: false, message: "job not found" };
  }
  if (auth && job.requestedBy && job.requestedBy !== auth.username) {
    return { ok: false, message: "forbidden: job belongs to another user" };
  }
  const existingIdempotent = await findIdempotentEvent(jobId, idempotencyKey);
  if (existingIdempotent) {
    return {
      ok: existingIdempotent.status === "accepted" || existingIdempotent.status === "skipped",
      message: `idempotent replay: ${existingIdempotent.message}`,
      job,
      txId: existingIdempotent.txId,
      summary: existingIdempotent.summary,
      payload: existingIdempotent.payload
    };
  }
  const requestedAt = new Date().toISOString();
  const auditMode = getEffectiveExecutionMode();
  if (job.status === "executed") {
    const latest = await db.executionEvent.findFirst({
      where: { jobId, status: "accepted" },
      orderBy: { requestedAt: "desc" }
    });
    const replayPayload = snapshotAdapterPayload(meta ?? {}, {
      mode: auditMode,
      adapterResults: latest?.payloadJson ? parsePayloadJson(latest.payloadJson)?.adapterResults : undefined
    });
    await createExecutionEvent({
      id: `evt_${Date.now()}`,
      jobId,
      requestedAt,
      status: "skipped",
      message: "already executed - idempotent skip",
      idempotencyKey,
      txId: latest?.txId ?? undefined,
      summary: latest?.summary ?? undefined,
      payload: replayPayload
    });
    return {
      ok: true,
      message: "already executed - idempotent skip",
      job,
      txId: latest?.txId ?? undefined,
      summary: latest?.summary ?? undefined,
      payload: replayPayload
    };
  }
  if (job.status === "cancelled") {
    return {
      ok: false,
      message: "job is cancelled",
      job
    };
  }
  if (job.riskLevel === "Critical") {
    await db.job.update({ where: { id: jobId }, data: { status: "blocked" } });
    job.status = "blocked";
    const blockedPayload = snapshotAdapterPayload(meta ?? {}, { mode: auditMode, adapterResults: [] });
    await createExecutionEvent({
      id: `evt_${Date.now()}`,
      jobId,
      requestedAt,
      status: "blocked",
      message: "critical risk level blocks execution",
      idempotencyKey,
      payload: blockedPayload
    });
    return { ok: false, message: "critical risk level blocks execution", job, payload: blockedPayload };
  }

  const retryCount = Number(process.env.EXECUTION_RETRY_COUNT ?? "3");
  const maxAttempts = Number.isFinite(retryCount) ? Math.max(1, retryCount) : 3;
  let execution: ExecutionAdapterBundle;
  let attemptsUsed = maxAttempts;
  try {
    const ran = await runExecutionWithRetry(job, maxAttempts, meta?.requestedMode);
    execution = ran.bundle;
    attemptsUsed = ran.attempts;
  } catch (error) {
    const errorMessage = error instanceof Error
      ? `[${error.name}] ${error.message}`
      : `execution adapter error: ${String(error)}`;
    const failPayload = snapshotAdapterPayload(meta ?? {}, {
      mode: auditMode,
      adapterResults: [],
      retries: maxAttempts,
      errorMessage
    });
    await createExecutionEvent({
      id: `evt_${Date.now()}`,
      jobId,
      requestedAt,
      status: "failed",
      message: errorMessage,
      idempotencyKey,
      payload: failPayload
    });
    return { ok: false, message: errorMessage, job, payload: failPayload };
  }
  await db.job.update({ where: { id: jobId }, data: { status: "executed" } });
  job.status = "executed";

  // ── 새 모델: DepositIntent + Execution 레코드 생성 ───────────────────────
  // 어댑터 결과 중 allocationUsd > 0 인 항목만 기록
  const username = job.requestedBy ?? "unknown";
  try {
    const intents = await createDepositIntentsFromAdapterResults(
      jobId,
      username,
      execution.adapterResults,
      job.input.sourceAsset
    );

    // 각 intent에 대해 어댑터 결과 기반 Execution 레코드 생성
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i];
      const result = execution.adapterResults.find(
        (r) => r.protocol === intent.protocol && r.chain === intent.chain && r.action === intent.action
      );
      if (!result) continue;

      if (result.status === "submitted") {
        await createExecution({
          intentId: intent.id,
          protocol: result.protocol,
          chain: result.chain,
          action: result.action,
          txHash: result.txId,
          status: "submitted",
          idempotencyKey
        });
        await updateDepositIntentStatus(intent.id, "executing");
      } else if (result.status === "failed") {
        await createExecution({
          intentId: intent.id,
          protocol: result.protocol,
          chain: result.chain,
          action: result.action,
          status: "failed",
          errorMessage: result.errorMessage
        });
        await updateDepositIntentStatus(intent.id, "failed");
      } else {
        // dry-run / unsupported / simulated: Execution 레코드를 남기되 status=pending
        await createExecution({
          intentId: intent.id,
          protocol: result.protocol,
          chain: result.chain,
          action: result.action,
          status: "pending",
          errorMessage: result.status === "unsupported" ? result.errorMessage : undefined
        });
      }
    }
  } catch (intentErr) {
    // intent/execution 기록 실패는 non-fatal — 기존 실행 결과는 유지
    console.error("intent store error (non-fatal):", intentErr);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // warnings(unsupported/failed 어댑터)를 summary에 포함
  const warningNote = execution.warnings.length > 0
    ? ` | ⚠ ${execution.warnings.length} unsupported/failed: ${execution.warnings.join("; ")}`
    : "";

  const okPayload = snapshotAdapterPayload(meta ?? {}, {
    mode: execution.mode,
    adapterResults: execution.adapterResults.map((r) => ({
      protocol: r.protocol,
      chain: r.chain,
      action: r.action,
      allocationUsd: r.allocationUsd,
      txId: r.txId,
      status: r.status,
      errorMessage: r.errorMessage
    })),
    retries: attemptsUsed
  });
  await createExecutionEvent({
    id: `evt_${Date.now()}`,
    jobId,
    requestedAt,
    status: "accepted",
    message: "execution accepted",
    idempotencyKey,
    txId: execution.txId,
    summary: (execution.summary ?? "") + warningNote,
    payload: okPayload
  });
  return {
    ok: true,
    message: "execution accepted",
    job,
    txId: execution.txId,
    summary: (execution.summary ?? "") + warningNote,
    payload: okPayload
  };
}
