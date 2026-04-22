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
    const parsed = JSON.parse(row.protocolMix);
    protocolMix = Array.isArray(parsed) ? (parsed as ProtocolMixEntry[]) : [];
  } catch (err) {
    // 데이터 손상 가시화: 조용히 빈 배열로 폴백하면 UI 원인 추적이 어렵다.
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "deposit_position_protocolmix_parse_failed",
        positionId: row.id,
        error: String(err)
      })
    );
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

export type ProtocolWithdrawTarget = {
  protocol: string;
  chain?: string;
  pool?: string;
};

export async function listWithdrawalLedger(username: string): Promise<Omit<WithdrawalLedgerRow, "username">[]> {
  const db = getDb();
  const rows = await db.withdrawalLedger.findMany({
    where: { username },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(({ username: _u, ...rest }) => rest);
}

/** 예치 장부와 출금 장부를 모두 비운다. 실제 온체인 포지션 테이블은 건드리지 않는다. */
export async function resetPortfolioLedger(
  username: string
): Promise<{ deletedPositions: number; deletedWithdrawals: number }> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const deletedPositions = await tx.depositPosition.deleteMany({ where: { username } });
    const deletedWithdrawals = await tx.withdrawalLedger.deleteMany({ where: { username } });
    return {
      deletedPositions: deletedPositions.count,
      deletedWithdrawals: deletedWithdrawals.count
    };
  });
}

/** LIFO 인출. 실제 차감된 USD 합계를 반환하고, 0 초과 시 출금 장부에 한 줄 기록한다. */
export async function withdrawDepositAmount(username: string, amountUsd: number): Promise<number> {
  assertValidWithdrawAmount(amountUsd);
  const db = getDb();
  return db.$transaction(async (tx) => {
    let remaining = amountUsd;
    const rows = await tx.depositPosition.findMany({
      where: { username },
      orderBy: { createdAt: "desc" }
    });
    for (const row of rows) {
      if (remaining <= 0) {
        break;
      }
      if (row.amountUsd <= remaining) {
        await tx.depositPosition.delete({ where: { id: row.id } });
        remaining -= row.amountUsd;
      } else {
        await tx.depositPosition.update({
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
      await tx.withdrawalLedger.create({
        data: {
          id,
          username,
          amountUsd: actual,
          createdAt
        }
      });
    }
    return actual;
  });
}

/** 특정 상품명에 해당하는 포지션만 LIFO로 인출한다. 행 내부 풀 비중은 유지되어 상품 풀들이 비율대로 감소한다. */
export async function withdrawProductDepositAmount(username: string, productName: string, amountUsd: number): Promise<number> {
  assertValidWithdrawAmount(amountUsd);
  const name = productName.trim();
  if (!name || name.length > MAX_PRODUCT_NAME_CHARS) {
    throw new Error("invalid productName length");
  }
  const db = getDb();
  return db.$transaction(async (tx) => {
    let remaining = amountUsd;
    const rows = await tx.depositPosition.findMany({
      where: { username, productName: name },
      orderBy: { createdAt: "desc" }
    });
    for (const row of rows) {
      if (remaining <= 0) break;
      if (row.amountUsd <= remaining) {
        await tx.depositPosition.delete({ where: { id: row.id } });
        remaining -= row.amountUsd;
      } else {
        await tx.depositPosition.update({
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
      await tx.withdrawalLedger.create({
        data: {
          id,
          username,
          amountUsd: actual,
          createdAt
        }
      });
    }
    return actual;
  });
}

function inferProtocolChain(protocolName: string, poolLabel?: string): string {
  if (poolLabel) {
    const chainPart = poolLabel.split("·")[0].trim().split("/")[0].trim();
    const lc = chainPart.toLowerCase();
    if (lc.includes("arbitrum")) return "Arbitrum";
    if (lc.includes("base")) return "Base";
    if (lc.includes("solana")) return "Solana";
    if (lc.includes("ethereum")) return "Ethereum";
  }
  const key = protocolName.toLowerCase();
  if (key.includes("orca")) return "Solana";
  if (key.includes("aave")) return "Arbitrum";
  if (key.includes("uniswap")) return "Arbitrum";
  return "Multi";
}

function sameTarget(mix: ProtocolMixEntry, target: ProtocolWithdrawTarget): boolean {
  const protocolOk = mix.name.toLowerCase() === target.protocol.toLowerCase();
  const chainOk = !target.chain || inferProtocolChain(mix.name, mix.pool).toLowerCase() === target.chain.toLowerCase();
  const poolOk = !target.pool || (mix.pool ?? "").trim().toLowerCase() === target.pool.trim().toLowerCase();
  return protocolOk && chainOk && poolOk;
}

function normalizeMixFromAbsoluteAmounts(amounts: Array<{ mix: ProtocolMixEntry; amountUsd: number }>, totalUsd: number): ProtocolMixEntry[] {
  if (totalUsd <= 0) return [];
  return amounts
    .filter((item) => item.amountUsd > 0.000001)
    .map((item) => ({
      ...item.mix,
      weight: item.amountUsd / totalUsd
    }));
}

/**
 * 특정 프로토콜/체인/풀 노출만 LIFO로 차감한다.
 * 다른 풀의 절대 USD 금액은 유지하고, 행 총액 감소분에 맞춰 weight만 재계산한다.
 */
export async function withdrawProtocolExposureAmount(
  username: string,
  amountUsd: number,
  target: ProtocolWithdrawTarget
): Promise<number> {
  assertValidWithdrawAmount(amountUsd);
  if (!target.protocol || target.protocol.trim().length === 0) {
    throw new Error("protocol required");
  }
  const db = getDb();
  return db.$transaction(async (tx) => {
    let remaining = amountUsd;
    const rows = await tx.depositPosition.findMany({
      where: { username },
      orderBy: { createdAt: "desc" }
    });

    for (const raw of rows) {
      if (remaining <= 0) break;
      const row = parseRow(raw);
      const absoluteMix = row.protocolMix.map((mix) => ({
        mix,
        amountUsd: row.amountUsd * mix.weight
      }));
      let rowWithdrawn = 0;

      for (const item of absoluteMix) {
        if (remaining <= 0) break;
        if (!sameTarget(item.mix, target)) continue;
        const take = Math.min(item.amountUsd, remaining);
        item.amountUsd -= take;
        rowWithdrawn += take;
        remaining -= take;
      }

      if (rowWithdrawn <= 0) continue;
      const nextTotal = row.amountUsd - rowWithdrawn;
      if (nextTotal <= 0.000001) {
        await tx.depositPosition.delete({ where: { id: row.id } });
      } else {
        await tx.depositPosition.update({
          where: { id: row.id },
          data: {
            amountUsd: nextTotal,
            protocolMix: JSON.stringify(normalizeMixFromAbsoluteAmounts(absoluteMix, nextTotal))
          }
        });
      }
    }

    const actual = amountUsd - remaining;
    if (actual > 0) {
      const id = `wd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const createdAt = new Date().toISOString();
      await tx.withdrawalLedger.create({
        data: {
          id,
          username,
          amountUsd: actual,
          createdAt
        }
      });
    }
    return actual;
  });
}
