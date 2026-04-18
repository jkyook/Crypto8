import { getDb } from "./db";
import {
  MAX_DEPOSIT_USD,
  MAX_POOL_LABEL_CHARS,
  MAX_PRODUCT_NAME_CHARS,
  MAX_PROTOCOL_MIX_ENTRIES,
  MAX_PROTOCOL_NAME_CHARS
} from "./limits";

export type ProtocolMixEntry = { name: string; weight: number; pool?: string };

export function assertValidPositionCreate(input: {
  productName: string;
  amountUsd: number;
  expectedApr: number;
  protocolMix: ProtocolMixEntry[];
}): void {
  const name = input.productName.trim();
  if (!name || name.length > MAX_PRODUCT_NAME_CHARS) {
    throw new Error("invalid productName length");
  }
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0 || input.amountUsd > MAX_DEPOSIT_USD) {
    throw new Error("amountUsd out of range");
  }
  if (!Number.isFinite(input.expectedApr) || input.expectedApr < -0.5 || input.expectedApr > 10) {
    throw new Error("expectedApr out of range");
  }
  if (!Array.isArray(input.protocolMix) || input.protocolMix.length > MAX_PROTOCOL_MIX_ENTRIES) {
    throw new Error("protocolMix too large");
  }
  let weightSum = 0;
  for (const row of input.protocolMix) {
    if (typeof row.name !== "string" || row.name.trim().length === 0 || row.name.length > MAX_PROTOCOL_NAME_CHARS) {
      throw new Error("invalid protocol mix name");
    }
    if (typeof row.weight !== "number" || !Number.isFinite(row.weight) || row.weight < 0 || row.weight > 1) {
      throw new Error("invalid protocol mix weight");
    }
    if (row.pool !== undefined && (typeof row.pool !== "string" || row.pool.length > MAX_POOL_LABEL_CHARS)) {
      throw new Error("invalid pool label");
    }
    weightSum += row.weight;
  }
  if (weightSum > 1.0001) {
    throw new Error("protocol mix weights exceed 100%");
  }
}

export type DepositPositionRow = {
  id: string;
  username: string;
  productName: string;
  amountUsd: number;
  expectedApr: number;
  protocolMix: ProtocolMixEntry[];
  createdAt: string;
};

function parseRow(row: {
  id: string;
  username: string;
  productName: string;
  amountUsd: number;
  expectedApr: number;
  protocolMix: string;
  createdAt: string;
}): DepositPositionRow {
  let protocolMix: ProtocolMixEntry[] = [];
  try {
    protocolMix = JSON.parse(row.protocolMix) as ProtocolMixEntry[];
  } catch {
    protocolMix = [];
  }
  return {
    id: row.id,
    username: row.username,
    productName: row.productName,
    amountUsd: row.amountUsd,
    expectedApr: row.expectedApr,
    protocolMix,
    createdAt: row.createdAt
  };
}

export async function listDepositPositions(username: string): Promise<DepositPositionRow[]> {
  const db = getDb();
  const rows = await db.depositPosition.findMany({
    where: { username },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(parseRow);
}

export async function createDepositPosition(
  username: string,
  input: { productName: string; amountUsd: number; expectedApr: number; protocolMix: ProtocolMixEntry[] }
): Promise<DepositPositionRow> {
  assertValidPositionCreate(input);
  const id = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = new Date().toISOString();
  const db = getDb();
  await db.depositPosition.create({
    data: {
      id,
      username,
      productName: input.productName.trim(),
      amountUsd: input.amountUsd,
      expectedApr: input.expectedApr,
      protocolMix: JSON.stringify(input.protocolMix ?? []),
      createdAt
    }
  });
  const row = await db.depositPosition.findUniqueOrThrow({ where: { id } });
  return parseRow(row);
}

/** 최근 예치부터 amountUsd 만큼 차감(행 삭제 또는 금액 감소). */
export function assertValidWithdrawAmount(amountUsd: number): void {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_DEPOSIT_USD) {
    throw new Error("amountUsd out of range");
  }
}

export type WithdrawalLedgerRow = {
  id: string;
  username: string;
  amountUsd: number;
  createdAt: string;
};

export async function listWithdrawalLedger(username: string): Promise<Omit<WithdrawalLedgerRow, "username">[]> {
  const db = getDb();
  const rows = await db.withdrawalLedger.findMany({
    where: { username },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(({ username: _u, ...rest }) => rest);
}

/** LIFO 인출. 실제 차감된 USD 합계를 반환하고, 0 초과 시 출금 장부에 한 줄 기록한다. */
export async function withdrawDepositAmount(username: string, amountUsd: number): Promise<number> {
  assertValidWithdrawAmount(amountUsd);
  const db = getDb();
  let remaining = amountUsd;
  const rows = await db.depositPosition.findMany({
    where: { username },
    orderBy: { createdAt: "desc" }
  });
  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }
    if (row.amountUsd <= remaining) {
      await db.depositPosition.delete({ where: { id: row.id } });
      remaining -= row.amountUsd;
    } else {
      await db.depositPosition.update({
        where: { id: row.id },
        data: { amountUsd: row.amountUsd - remaining }
      });
      remaining = 0;
    }
  }
  const actual = amountUsd - remaining;
  if (actual > 0) {
    const id = `wd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = new Date().toISOString();
    await db.withdrawalLedger.create({
      data: {
        id,
        username,
        amountUsd: actual,
        createdAt
      }
    });
  }
  return actual;
}
