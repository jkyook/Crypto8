import { randomUUID } from "crypto";
import { getDb } from "./db";
import type { PositionRow } from "./intentStore";

type SnapshotVerify = {
  status?: string | null;
  onchainAmountUsd?: number | null;
  onchainRaw?: string | null;
  driftPct?: number | null;
  verifiedAt?: string | null;
  detail?: string | null;
};

export type SnapshotSourceRow = PositionRow & {
  source?: "db" | "wallet_scan";
  verify?: SnapshotVerify | null;
  walletAddress?: string | null;
};

export type OnchainPositionHistoryPoint = {
  t: string;
  currentValueUsd: number;
  pnlUsd: number;
  pendingYieldUsd: number;
  snapshotCount: number;
};

export type OnchainPositionHistoryResponse = {
  ok: true;
  granularity: "hour" | "day";
  poolKey: string;
  points: OnchainPositionHistoryPoint[];
};

type SnapshotBucket = {
  t: string;
  currentValueUsd: number;
  pnlUsd: number;
  pendingYieldUsd: number;
  snapshotCount: number;
};

const SNAPSHOT_PRUNE_EVERY = 20;
const SNAPSHOT_PRUNE_DAYS = 180;
let snapshotWriteCount = 0;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolvePoolKey(row: SnapshotSourceRow): string {
  const fallback = row.poolAddress ?? row.positionToken ?? row.protocolPositionId ?? row.asset;
  return [row.protocol, row.chain, fallback ?? row.asset].map(normalizeKey).join("__");
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readDetailNumber(detail: Record<string, unknown> | null, key: string): number | null {
  if (!detail) return null;
  return readNumber(detail[key]);
}

function resolveCurrentValueUsd(row: SnapshotSourceRow): number {
  return row.currentValueUsd ?? row.verify?.onchainAmountUsd ?? row.amountUsd ?? 0;
}

function resolvePrincipalUsd(row: SnapshotSourceRow): number {
  return row.principalUsd ?? row.amountUsd ?? 0;
}

function resolveUnrealizedPnlUsd(row: SnapshotSourceRow): number {
  if (typeof row.unrealizedPnlUsd === "number" && Number.isFinite(row.unrealizedPnlUsd)) {
    return row.unrealizedPnlUsd;
  }
  return resolveCurrentValueUsd(row) - resolvePrincipalUsd(row);
}

function resolveRealizedPnlUsd(row: SnapshotSourceRow): number {
  return row.realizedPnlUsd ?? 0;
}

function resolvePendingYieldUsd(row: SnapshotSourceRow): number {
  const detail = parseJson(row.onchainDataJson);
  const protocol = row.protocol.toLowerCase();
  if (protocol === "orca") {
    const pending = readDetailNumber(detail, "pendingYieldUsd");
    if (pending != null) return pending;
    const fees0 = readDetailNumber(detail, "feesOwed0Usd") ?? 0;
    const fees1 = readDetailNumber(detail, "feesOwed1Usd") ?? 0;
    return fees0 + fees1;
  }
  if (protocol === "uniswap") {
    const fees0 = readDetailNumber(detail, "feesOwed0Usd") ?? 0;
    const fees1 = readDetailNumber(detail, "feesOwed1Usd") ?? 0;
    return fees0 + fees1;
  }
  return row.feesPaidUsd ?? 0;
}

function resolveCurrentPrice(row: SnapshotSourceRow): number | null {
  const detail = parseJson(row.onchainDataJson);
  return (
    readDetailNumber(detail, "currentPrice") ??
    readDetailNumber(detail, "price") ??
    row.entryPrice ??
    null
  );
}

function resolveRangeLowerPrice(row: SnapshotSourceRow): number | null {
  const detail = parseJson(row.onchainDataJson);
  return readDetailNumber(detail, "rangeLowerPrice") ?? null;
}

function resolveRangeUpperPrice(row: SnapshotSourceRow): number | null {
  const detail = parseJson(row.onchainDataJson);
  return readDetailNumber(detail, "rangeUpperPrice") ?? null;
}

function resolveEstimatedApr(row: SnapshotSourceRow): number | null {
  const detail = parseJson(row.onchainDataJson);
  return (
    row.netApy ??
    row.expectedApr ??
    readDetailNumber(detail, "estimatedApr") ??
    null
  );
}

function resolveWalletAddress(row: SnapshotSourceRow): string | null {
  return row.walletAddress ?? null;
}

function resolvePositionId(row: SnapshotSourceRow): string | null {
  return row.protocolPositionId ?? row.positionToken ?? null;
}

function buildSnapshotRecord(username: string, row: SnapshotSourceRow, sampledAt: string) {
  const currentValueUsd = resolveCurrentValueUsd(row);
  const principalUsd = resolvePrincipalUsd(row);
  const unrealizedPnlUsd = resolveUnrealizedPnlUsd(row);
  const realizedPnlUsd = resolveRealizedPnlUsd(row);
  const pendingYieldUsd = resolvePendingYieldUsd(row);
  const currentPrice = resolveCurrentPrice(row);
  const rangeLowerPrice = resolveRangeLowerPrice(row);
  const rangeUpperPrice = resolveRangeUpperPrice(row);
  const expectedApr = row.expectedApr ?? null;
  const netApy = resolveEstimatedApr(row);
  const poolKey = resolvePoolKey(row);

  return {
    id: randomUUID(),
    username,
    sampledAt,
    protocol: row.protocol,
    chain: row.chain,
    poolKey,
    poolAddress: row.poolAddress,
    positionToken: row.positionToken,
    asset: row.asset,
    amountUsd: row.amountUsd ?? 0,
    principalUsd,
    currentValueUsd,
    unrealizedPnlUsd,
    realizedPnlUsd,
    feesPaidUsd: row.feesPaidUsd ?? null,
    pendingYieldUsd,
    netApy,
    expectedApr,
    currentPrice,
    rangeLowerPrice,
    rangeUpperPrice,
    walletAddress: resolveWalletAddress(row),
    source: row.source ?? null,
    positionId: resolvePositionId(row),
    onchainDataJson: row.onchainDataJson
  };
}

export async function recordOnchainPositionSnapshots(username: string, rows: SnapshotSourceRow[]): Promise<void> {
  if (!rows.length) {
    return;
  }
  const db = getDb();
  const sampledAt = new Date().toISOString();
  const data = rows.map((row) => buildSnapshotRecord(username, row, sampledAt));
  await db.onchainPositionSnapshot.createMany({ data });
  snapshotWriteCount += data.length;
  if (snapshotWriteCount >= SNAPSHOT_PRUNE_EVERY) {
    snapshotWriteCount = 0;
    const cutoff = new Date(Date.now() - SNAPSHOT_PRUNE_DAYS * 24 * 3600 * 1000).toISOString();
    await db.onchainPositionSnapshot.deleteMany({ where: { sampledAt: { lt: cutoff } } });
  }
}

export async function listOnchainPositionHistory(opts: {
  username: string;
  protocol: string;
  chain: string;
  poolAddress?: string | null;
  positionToken?: string | null;
  asset?: string | null;
  days?: number;
  bucket?: "hour" | "day" | "auto";
}): Promise<OnchainPositionHistoryResponse> {
  const days = Number.isFinite(opts.days ?? NaN) && (opts.days ?? 0) > 0 ? Math.min(Math.floor(opts.days ?? 0), 365) : 30;
  const bucket = opts.bucket ?? "auto";
  const granularity = bucket === "day" || (bucket === "auto" && days > 14) ? "day" : "hour";
  const bucketMs = granularity === "day" ? 86_400_000 : 3_600_000;
  const poolKey = [opts.protocol, opts.chain, opts.poolAddress ?? opts.positionToken ?? opts.asset ?? ""]
    .map(normalizeKey)
    .join("__");
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const db = getDb();
  const rows = await db.onchainPositionSnapshot.findMany({
    where: {
      username: opts.username,
      protocol: opts.protocol,
      chain: opts.chain,
      poolKey,
      sampledAt: { gte: sinceIso }
    },
    orderBy: { sampledAt: "asc" }
  });

  const buckets = new Map<number, SnapshotBucket>();
  for (const row of rows) {
    const ts = new Date(row.sampledAt).getTime();
    if (!Number.isFinite(ts)) continue;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const prev = buckets.get(key);
    const currentValueUsd = row.currentValueUsd ?? row.amountUsd ?? 0;
    const pnlUsd = (row.unrealizedPnlUsd ?? 0) + (row.realizedPnlUsd ?? 0);
    const pendingYieldUsd = row.pendingYieldUsd ?? row.feesPaidUsd ?? 0;
    if (!prev) {
      buckets.set(key, {
        t: new Date(key).toISOString(),
        currentValueUsd,
        pnlUsd,
        pendingYieldUsd,
        snapshotCount: 1
      });
      continue;
    }
    prev.currentValueUsd += currentValueUsd;
    prev.pnlUsd += pnlUsd;
    prev.pendingYieldUsd += pendingYieldUsd;
    prev.snapshotCount += 1;
  }

  const points = [...buckets.values()].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  const hasStoredPnL = points.some((point) => Math.abs(point.pnlUsd) > 0.0001);
  if (!hasStoredPnL && points.length > 0) {
    const baseValue = points[0].currentValueUsd;
    for (const point of points) {
      point.pnlUsd = point.currentValueUsd - baseValue;
    }
  }

  return {
    ok: true,
    granularity,
    poolKey,
    points
  };
}
