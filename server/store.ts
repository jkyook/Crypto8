import type {
  ApprovalLog,
  ExecutionEvent,
  ExecutionEventPayloadV1,
  ExecutionJob,
  JobInput,
  RiskLevel
} from "./types";
import type { ExecutionAdapterBundle } from "./executionAdapter";
import { getEffectiveExecutionMode, runExecutionAdapter } from "./executionAdapter";
import { getDb } from "./db";
import { MAX_DEPOSIT_USD } from "./limits";

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

export async function createJob(input: JobInput): Promise<ExecutionJob> {
  if (!Number.isFinite(input.depositUsd) || input.depositUsd <= 0 || input.depositUsd > MAX_DEPOSIT_USD) {
    throw new Error("invalid depositUsd");
  }
  const riskLevel = evaluateRisk(input);
  const job: ExecutionJob = {
    id: `job_${Date.now()}`,
    createdAt: new Date().toISOString(),
    status: "queued",
    input,
    riskLevel
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
      riskLevel: job.riskLevel
    }
  });
  return job;
}

export async function listJobs(): Promise<ExecutionJob[]> {
  const db = getDb();
  const rows = await db.job.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    status: row.status as ExecutionJob["status"],
    input: {
      depositUsd: row.depositUsd,
      isRangeOut: Boolean(row.isRangeOut),
      isDepegAlert: Boolean(row.isDepegAlert),
      hasPendingRelease: Boolean(row.hasPendingRelease)
    },
    riskLevel: row.riskLevel as RiskLevel
  }));
}

export async function getJob(jobId: string): Promise<ExecutionJob | undefined> {
  const db = getDb();
  const row = await db.job.findUnique({ where: { id: jobId } });
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    status: row.status as ExecutionJob["status"],
    input: {
      depositUsd: row.depositUsd,
      isRangeOut: Boolean(row.isRangeOut),
      isDepegAlert: Boolean(row.isDepegAlert),
      hasPendingRelease: Boolean(row.hasPendingRelease)
    },
    riskLevel: row.riskLevel as RiskLevel
  };
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
  retryCount: number
): Promise<{ bundle: ExecutionAdapterBundle; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      const bundle = await runExecutionAdapter(job);
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

export async function listExecutionEvents(jobId?: string): Promise<ExecutionEvent[]> {
  const db = getDb();
  const rows = await db.executionEvent.findMany({
    where: jobId ? { jobId } : undefined,
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
};

export async function executeJob(
  jobId: string,
  idempotencyKey?: string,
  meta?: ExecuteJobMeta
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
    const ran = await runExecutionWithRetry(job, maxAttempts);
    execution = ran.bundle;
    attemptsUsed = ran.attempts;
  } catch (error) {
    const failPayload = snapshotAdapterPayload(meta ?? {}, {
      mode: auditMode,
      adapterResults: [],
      retries: maxAttempts
    });
    await createExecutionEvent({
      id: `evt_${Date.now()}`,
      jobId,
      requestedAt,
      status: "failed",
      message: error instanceof Error ? error.message : "execution adapter failed",
      idempotencyKey,
      payload: failPayload
    });
    return { ok: false, message: "execution adapter failed", job, payload: failPayload };
  }
  await db.job.update({ where: { id: jobId }, data: { status: "executed" } });
  job.status = "executed";
  const okPayload = snapshotAdapterPayload(meta ?? {}, {
    mode: execution.mode,
    adapterResults: execution.adapterResults.map((r) => ({
      protocol: r.protocol,
      chain: r.chain,
      action: r.action,
      allocationUsd: r.allocationUsd,
      txId: r.txId,
      status: r.status
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
    summary: execution.summary,
    payload: okPayload
  });
  return { ok: true, message: "execution accepted", job, txId: execution.txId, summary: execution.summary, payload: okPayload };
}
