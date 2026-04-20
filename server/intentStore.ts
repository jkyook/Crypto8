/**
 * intentStore.ts
 *
 * DepositIntent / Execution / Position / WithdrawalIntent / WithdrawalExecution
 * CRUD 및 상태 전이 함수.
 *
 * 핵심 원칙:
 *  - Position은 Execution.status = "confirmed" 인 경우에만 생성된다.
 *  - DB 포지션은 캐시이며, 원천 데이터는 온체인 조회로 보정한다.
 *  - receipt 없이 Position 생성 금지.
 */
import { randomUUID } from "crypto";
import { getDb } from "./db";
import type { AdapterExecutionResult } from "./adapters/types";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────

export type DepositIntentRow = {
  id: string;
  jobId: string;
  username: string;
  protocol: string;
  chain: string;
  asset: string;
  amountUsd: number;
  amountRaw: string | null;
  poolAddress: string | null;
  action: string;
  quoteSnapshot: string | null;
  quoteExpiresAt: string | null;
  status: "draft" | "approved" | "executing" | "completed" | "cancelled" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type ExecutionRow = {
  id: string;
  intentId: string;
  protocol: string;
  chain: string;
  action: string;
  txHash: string | null;
  blockNumber: number | null;
  receiptJson: string | null;
  status: "pending" | "submitted" | "confirmed" | "failed";
  errorMessage: string | null;
  idempotencyKey: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
};

export type PositionRow = {
  id: string;
  executionId: string;
  username: string;
  protocol: string;
  chain: string;
  asset: string;
  poolAddress: string | null;
  positionToken: string | null;
  positionRaw: string | null;
  amountUsd: number;
  depositTxHash: string;
  lastSyncedAt: string | null;
  status: "active" | "closed" | "liquidated";
  openedAt: string;
  closedAt: string | null;
  onchainDataJson: string | null;
};

export type WithdrawalIntentRow = {
  id: string;
  username: string;
  positionId: string;
  amountUsd: number;
  amountRaw: string | null;
  isFullClose: number;
  status: "draft" | "executing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type WithdrawalExecutionRow = {
  id: string;
  intentId: string;
  positionId: string;
  protocol: string;
  chain: string;
  action: string;
  txHash: string | null;
  blockNumber: number | null;
  receiptJson: string | null;
  status: "pending" | "submitted" | "confirmed" | "failed";
  errorMessage: string | null;
  amountReturnedUsd: number | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
};

// ─────────────────────────────────────────────
//  DepositIntent CRUD
// ─────────────────────────────────────────────

/**
 * Job 실행 결과(어댑터 결과 배열)에서 DepositIntent 레코드를 일괄 생성.
 * dry-run / unsupported 결과도 기록하되 status="draft"로 저장.
 */
export async function createDepositIntentsFromAdapterResults(
  jobId: string,
  username: string,
  adapterResults: AdapterExecutionResult[],
  assetOverride?: string
): Promise<DepositIntentRow[]> {
  const db = getDb();
  const now = new Date().toISOString();
  const rows: DepositIntentRow[] = [];

  for (const result of adapterResults) {
    if (result.allocationUsd <= 0) continue;

    const id = `di_${randomUUID()}`;
    const asset = assetOverride ?? inferAsset(result);

    await db.$executeRawUnsafe(
      `INSERT INTO deposit_intents
        (id, job_id, username, protocol, chain, asset, amount_usd, action, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, jobId, username, result.protocol, result.chain, asset,
      result.allocationUsd, result.action, "draft", now, now
    );

    rows.push({
      id, jobId, username,
      protocol: result.protocol,
      chain: result.chain,
      asset,
      amountUsd: result.allocationUsd,
      amountRaw: null,
      poolAddress: null,
      action: result.action,
      quoteSnapshot: null,
      quoteExpiresAt: null,
      status: "draft",
      createdAt: now,
      updatedAt: now
    });
  }

  return rows;
}

export async function listDepositIntentsByJob(jobId: string): Promise<DepositIntentRow[]> {
  const db = getDb();
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM deposit_intents WHERE job_id = ? ORDER BY created_at ASC`,
    jobId
  );
  return rows.map(mapDepositIntentRow);
}

export async function listDepositIntentsByUser(username: string): Promise<DepositIntentRow[]> {
  const db = getDb();
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM deposit_intents WHERE username = ? ORDER BY created_at DESC LIMIT 100`,
    username
  );
  return rows.map(mapDepositIntentRow);
}

export async function updateDepositIntentStatus(
  intentId: string,
  status: DepositIntentRow["status"]
): Promise<void> {
  const db = getDb();
  await db.$executeRawUnsafe(
    `UPDATE deposit_intents SET status = ?, updated_at = ? WHERE id = ?`,
    status, new Date().toISOString(), intentId
  );
}

// ─────────────────────────────────────────────
//  Execution CRUD
// ─────────────────────────────────────────────

export async function createExecution(params: {
  intentId: string;
  protocol: string;
  chain: string;
  action: string;
  txHash?: string;
  status?: ExecutionRow["status"];
  errorMessage?: string;
  idempotencyKey?: string;
}): Promise<ExecutionRow> {
  const db = getDb();
  const id = `ex_${randomUUID()}`;
  const now = new Date().toISOString();
  const status = params.status ?? (params.txHash ? "submitted" : "pending");
  const submittedAt = status === "submitted" ? now : null;

  await db.$executeRawUnsafe(
    `INSERT INTO executions
      (id, intent_id, protocol, chain, action, tx_hash, status, error_message, idempotency_key, submitted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, params.intentId, params.protocol, params.chain, params.action,
    params.txHash ?? null, status,
    params.errorMessage ?? null, params.idempotencyKey ?? null,
    submittedAt, now
  );

  return {
    id, intentId: params.intentId,
    protocol: params.protocol, chain: params.chain, action: params.action,
    txHash: params.txHash ?? null,
    blockNumber: null, receiptJson: null,
    status,
    errorMessage: params.errorMessage ?? null,
    idempotencyKey: params.idempotencyKey ?? null,
    submittedAt, confirmedAt: null, createdAt: now
  };
}

export async function updateExecutionConfirmed(params: {
  executionId: string;
  txHash: string;
  blockNumber?: number;
  receiptJson: string;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.$executeRawUnsafe(
    `UPDATE executions
     SET status = 'confirmed', tx_hash = ?, block_number = ?, receipt_json = ?, confirmed_at = ?
     WHERE id = ?`,
    params.txHash,
    params.blockNumber ?? null,
    params.receiptJson,
    now,
    params.executionId
  );
}

export async function updateExecutionFailed(params: {
  executionId: string;
  errorMessage: string;
}): Promise<void> {
  const db = getDb();
  await db.$executeRawUnsafe(
    `UPDATE executions SET status = 'failed', error_message = ? WHERE id = ?`,
    params.errorMessage, params.executionId
  );
}

export async function getExecution(executionId: string): Promise<ExecutionRow | null> {
  const db = getDb();
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM executions WHERE id = ? LIMIT 1`,
    executionId
  );
  return rows.length > 0 ? mapExecutionRow(rows[0]) : null;
}

// ─────────────────────────────────────────────
//  Position CRUD
// ─────────────────────────────────────────────

/**
 * Position 생성 — 반드시 confirmed Execution에서만 호출해야 한다.
 * receiptJson 이 없으면 오류.
 */
export async function createPositionFromExecution(params: {
  execution: ExecutionRow;
  username: string;
  asset: string;
  amountUsd: number;
  poolAddress?: string;
  positionToken?: string;
  positionRaw?: string;
  onchainDataJson?: string;
}): Promise<PositionRow> {
  if (params.execution.status !== "confirmed") {
    throw new Error(
      `Cannot create Position from non-confirmed Execution ${params.execution.id} (status=${params.execution.status})`
    );
  }
  if (!params.execution.txHash) {
    throw new Error(`Execution ${params.execution.id} has no txHash — receipt required`);
  }

  const db = getDb();
  const id = `pos_${randomUUID()}`;
  const now = new Date().toISOString();

  await db.$executeRawUnsafe(
    `INSERT INTO positions
      (id, execution_id, username, protocol, chain, asset, pool_address,
       position_token, position_raw, amount_usd, deposit_tx_hash,
       last_synced_at, status, opened_at, onchain_data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    id, params.execution.id, params.username,
    params.execution.protocol, params.execution.chain,
    params.asset,
    params.poolAddress ?? null,
    params.positionToken ?? null,
    params.positionRaw ?? null,
    params.amountUsd,
    params.execution.txHash,
    now, now,
    params.onchainDataJson ?? null
  );

  return {
    id,
    executionId: params.execution.id,
    username: params.username,
    protocol: params.execution.protocol,
    chain: params.execution.chain,
    asset: params.asset,
    poolAddress: params.poolAddress ?? null,
    positionToken: params.positionToken ?? null,
    positionRaw: params.positionRaw ?? null,
    amountUsd: params.amountUsd,
    depositTxHash: params.execution.txHash,
    lastSyncedAt: now,
    status: "active",
    openedAt: now,
    closedAt: null,
    onchainDataJson: params.onchainDataJson ?? null
  };
}

export async function listPositionsByUser(username: string): Promise<PositionRow[]> {
  const db = getDb();
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM positions WHERE username = ? AND status = 'active' ORDER BY opened_at DESC`,
    username
  );
  return rows.map(mapPositionRow);
}

export async function getPositionById(positionId: string): Promise<PositionRow | null> {
  const db = getDb();
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM positions WHERE id = ? LIMIT 1`,
    positionId
  );
  return rows.length > 0 ? mapPositionRow(rows[0]) : null;
}

export async function updatePositionOnchainData(
  positionId: string,
  onchainDataJson: string
): Promise<void> {
  const db = getDb();
  await db.$executeRawUnsafe(
    `UPDATE positions SET onchain_data_json = ?, last_synced_at = ? WHERE id = ?`,
    onchainDataJson, new Date().toISOString(), positionId
  );
}

export async function closePosition(
  positionId: string,
  withdrawTxHash: string
): Promise<void> {
  const db = getDb();
  await db.$executeRawUnsafe(
    `UPDATE positions SET status = 'closed', closed_at = ? WHERE id = ?`,
    new Date().toISOString(), positionId
  );
}

// ─────────────────────────────────────────────
//  WithdrawalIntent CRUD
// ─────────────────────────────────────────────

export async function createWithdrawalIntent(params: {
  username: string;
  positionId: string;
  amountUsd: number;
  isFullClose: boolean;
}): Promise<WithdrawalIntentRow> {
  const db = getDb();
  const id = `wi_${randomUUID()}`;
  const now = new Date().toISOString();

  await db.$executeRawUnsafe(
    `INSERT INTO withdrawal_intents
      (id, username, position_id, amount_usd, is_full_close, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    id, params.username, params.positionId,
    params.amountUsd, params.isFullClose ? 1 : 0,
    now, now
  );

  return {
    id, username: params.username, positionId: params.positionId,
    amountUsd: params.amountUsd, amountRaw: null,
    isFullClose: params.isFullClose ? 1 : 0,
    status: "draft", createdAt: now, updatedAt: now
  };
}

export async function createWithdrawalExecution(params: {
  intentId: string;
  positionId: string;
  protocol: string;
  chain: string;
  action: string;
  txHash?: string;
  status?: WithdrawalExecutionRow["status"];
  errorMessage?: string;
}): Promise<WithdrawalExecutionRow> {
  const db = getDb();
  const id = `we_${randomUUID()}`;
  const now = new Date().toISOString();
  const status = params.status ?? (params.txHash ? "submitted" : "pending");

  await db.$executeRawUnsafe(
    `INSERT INTO withdrawal_executions
      (id, intent_id, position_id, protocol, chain, action, tx_hash, status, error_message, submitted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, params.intentId, params.positionId,
    params.protocol, params.chain, params.action,
    params.txHash ?? null, status,
    params.errorMessage ?? null,
    status === "submitted" ? now : null,
    now
  );

  return {
    id, intentId: params.intentId, positionId: params.positionId,
    protocol: params.protocol, chain: params.chain, action: params.action,
    txHash: params.txHash ?? null,
    blockNumber: null, receiptJson: null,
    status, errorMessage: params.errorMessage ?? null,
    amountReturnedUsd: null, submittedAt: null, confirmedAt: null, createdAt: now
  };
}

export async function updateWithdrawalExecutionConfirmed(params: {
  withdrawalExecutionId: string;
  txHash: string;
  blockNumber?: number;
  receiptJson: string;
  amountReturnedUsd?: number;
}): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.$executeRawUnsafe(
    `UPDATE withdrawal_executions
     SET status = 'confirmed', tx_hash = ?, block_number = ?, receipt_json = ?,
         amount_returned_usd = ?, confirmed_at = ?
     WHERE id = ?`,
    params.txHash, params.blockNumber ?? null, params.receiptJson,
    params.amountReturnedUsd ?? null, now,
    params.withdrawalExecutionId
  );
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function inferAsset(result: AdapterExecutionResult): string {
  const action = result.action.toLowerCase();
  if (action.includes("weth")) return "WETH";
  if (action.includes("eth-usdc") || action.includes("weth-usdc")) return "ETH+USDC";
  if (action.includes("sol-usdc")) return "SOL+USDC";
  if (action.includes("usdc-usdt") || action.includes("usdt")) return "USDC+USDT";
  if (action.includes("sol")) return "SOL";
  if (action.includes("usdc")) return "USDC";
  return "USDC";
}

function mapDepositIntentRow(r: Record<string, unknown>): DepositIntentRow {
  return {
    id: r["id"] as string,
    jobId: r["job_id"] as string,
    username: r["username"] as string,
    protocol: r["protocol"] as string,
    chain: r["chain"] as string,
    asset: r["asset"] as string,
    amountUsd: r["amount_usd"] as number,
    amountRaw: (r["amount_raw"] ?? null) as string | null,
    poolAddress: (r["pool_address"] ?? null) as string | null,
    action: r["action"] as string,
    quoteSnapshot: (r["quote_snapshot"] ?? null) as string | null,
    quoteExpiresAt: (r["quote_expires_at"] ?? null) as string | null,
    status: r["status"] as DepositIntentRow["status"],
    createdAt: r["created_at"] as string,
    updatedAt: r["updated_at"] as string
  };
}

function mapExecutionRow(r: Record<string, unknown>): ExecutionRow {
  return {
    id: r["id"] as string,
    intentId: r["intent_id"] as string,
    protocol: r["protocol"] as string,
    chain: r["chain"] as string,
    action: r["action"] as string,
    txHash: (r["tx_hash"] ?? null) as string | null,
    blockNumber: (r["block_number"] ?? null) as number | null,
    receiptJson: (r["receipt_json"] ?? null) as string | null,
    status: r["status"] as ExecutionRow["status"],
    errorMessage: (r["error_message"] ?? null) as string | null,
    idempotencyKey: (r["idempotency_key"] ?? null) as string | null,
    submittedAt: (r["submitted_at"] ?? null) as string | null,
    confirmedAt: (r["confirmed_at"] ?? null) as string | null,
    createdAt: r["created_at"] as string
  };
}

function mapPositionRow(r: Record<string, unknown>): PositionRow {
  return {
    id: r["id"] as string,
    executionId: r["execution_id"] as string,
    username: r["username"] as string,
    protocol: r["protocol"] as string,
    chain: r["chain"] as string,
    asset: r["asset"] as string,
    poolAddress: (r["pool_address"] ?? null) as string | null,
    positionToken: (r["position_token"] ?? null) as string | null,
    positionRaw: (r["position_raw"] ?? null) as string | null,
    amountUsd: r["amount_usd"] as number,
    depositTxHash: r["deposit_tx_hash"] as string,
    lastSyncedAt: (r["last_synced_at"] ?? null) as string | null,
    status: r["status"] as PositionRow["status"],
    openedAt: r["opened_at"] as string,
    closedAt: (r["closed_at"] ?? null) as string | null,
    onchainDataJson: (r["onchain_data_json"] ?? null) as string | null
  };
}
